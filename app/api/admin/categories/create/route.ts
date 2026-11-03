import type { NextRequest } from 'next/server'
import { getSupabaseWriteClient } from '@/lib/supabaseAdmin'
import { getBearer, jsonResponse, requireAdmin } from '@/lib/aiGemini'
import { notifyFrontendRevalidate } from '@/lib/revalidateFrontend'
import { categoryKey, normalizeCategoryName } from '@/lib/categoryNames'

export const runtime = 'nodejs'

/**
 * 在后台「话题矩阵」里新增一个话题 —— **立即落库**。
 *
 * 以前这件事只发生在浏览器里（trends/edit 的 `handleAddNewCatClick` 只
 * `setState`），真正的写库是"碰运气"地挂在文章保存之后（`upsertCategories`）：
 *   · 站长在新建稿里敲了个话题、没保存就返回 → 话题只活在那个标签页里；
 *   · 保存那一步失败 / 被 RLS 静默拦下 → 只 `console.log` 一行，页面上毫无提示。
 * 站长的体感就是「我在 A 加了话题，编辑 B 时看不到我所有的标签」。
 *
 * 现在改成和「删除 / 排序」同一套：服务端 + 写库凭据 + 回读校验 + 敲前台的门。
 * 于是「新建话题」在**任何**一篇简报里点，效果都立刻是全站的。
 *
 * 为什么不复用 `upsertCategories`：那个函数是"保存文章时顺手补一下"的兜底，
 * 它在浏览器里拿的是登录票、失败只打日志；而这里需要的是「失败必须让站长
 * 看见」，所以必须回到服务端、必须有状态码。
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (auth.ok === false) return auth.response

  const write = getSupabaseWriteClient(getBearer(req))
  if (!write.ok) {
    console.log('[categories:create] 没有可用的写库凭据', write.env)
    return jsonResponse({ error: write.error || 'missing env', env: write.env }, 500)
  }
  const client = write.client

  let body: any = null
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'invalid json' }, 400)
  }

  const name = normalizeCategoryName(body?.name)
  if (!name) return jsonResponse({ error: '话题名不能为空' }, 400)

  // 1) 先查重（忽略大小写与多余空白）。
  //    这一步是幂等的关键：站长连点两下「+」、或者两个标签页同时开着，
  //    都不该在库里冒出 `Sports` / `sports` 两个话题 —— 那会变成前台两个页签。
  //    已经存在就当成功返回库里那个写法，让界面去选它，而不是报错。
  const { data: existing, error: readError } = await client.from('categories').select('name')
  if (readError) {
    console.log('[categories:create] 读现有话题失败 ——', readError.message)
    return jsonResponse({ error: readError.message, via: write.via }, 500)
  }

  const wanted = categoryKey(name)
  const dup = (existing || []).find((row: any) => categoryKey(row?.name) === wanted)
  if (dup) {
    const stored = String(dup.name)
    console.log('[categories:create] 已存在，直接返回', { name: stored, via: write.via })
    return jsonResponse({
      ok: true,
      existed: true,
      category: { name: stored },
      via: write.via,
      // 没新建任何东西 → 前台不需要重建
      frontend: { ok: false, skipped: true, error: '话题已存在，无需刷新' },
    })
  }

  // 2) 落库。`created_at` 交给库默认值（now()）：
  //    矩阵按 created_at 升序渲染，被拖过序的那批是「2020-01-01 + i 秒」
  //    （见 categories/reorder），所以新话题自然落在队尾 —— 等站长自己
  //    拖到想要的位置，不会插进他刚排好的队形里。
  //    `.select()` 不能省：RLS 拦下的 INSERT 会返回 200 但 0 行。
  const { data: inserted, error: insertError } = await client
    .from('categories')
    .insert([{ name }])
    .select('id,name,created_at')

  if (insertError) {
    console.log('[categories:create] 写入失败 ——', insertError.message)
    return jsonResponse({ error: insertError.message, via: write.via }, 500)
  }

  const row = inserted?.[0]
  if (!row) {
    console.log('[categories:create] 0 行写入 ——', name)
    return jsonResponse(
      { error: `「${name}」没有写进话题矩阵（0 行受影响，写权限被 RLS 拦下了）`, via: write.via },
      500
    )
  }

  // 3) 前台 `/briefs` 的页签读的就是这张表，顺序也照抄它 —— 顺手敲一下门，
  //    把「最多一分钟」缩到一两百毫秒（没配变量时这行什么都不做，见
  //    lib/revalidateFrontend）。注意：新话题还没有任何文章时，前台
  //    `categoryTabs` 不会给它出页签（点进去会空），这是有意为之。
  const frontend = await notifyFrontendRevalidate('categories:create')

  console.log('[categories:create] ok', { name, id: row.id, via: write.via, userId: auth.userId, frontend })
  return jsonResponse({ ok: true, existed: false, category: row, via: write.via, frontend })
}
