import type { NextRequest } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { jsonResponse, requireAdmin } from '@/lib/aiGemini'

export const runtime = 'nodejs'

/** 兜底话题：被删话题名下的文章一律并进这里，前台「Other」页签就是它。 */
const FALLBACK_CATEGORY = 'Other'

/** 读文章的翻页大小（PostgREST 一次最多给 1000 行）。 */
const PAGE = 1000

/**
 * 从后台「话题矩阵」里删掉一个话题。
 *
 * 为什么不能像以前那样在前端直接 `.delete()` 了事：
 *   直接删只会把 `articles.category` 留成一个谁也不认识的值 —— 前台页签是按
 *   文章里的分类现算的，于是「后台已经删了，前台还挂着一个页签」。
 *   所以删除必须分两步：**先把名下的文章并进兜底话题 `Other`，再删话题本身**。
 *
 * 为什么走服务端而不是继续留在浏览器里：
 *   第 ① 步要批量 UPDATE `articles`，前台那把票（anon + 登录态）对这类写不可靠
 *   （同 `app/api/admin/categories/reorder/route.ts` 里记的那次实测：匿名 PATCH
 *   是 200 但 0 行受影响，RLS 静默拦下）；服务端拿 service role 才是确定能写的那条路。
 *
 * 为什么必须忽略大小写：
 *   线上 `categories.name` 存的是 `SPORTS`，而文章里写的是 `Sports`。
 *   若按 `= 'SPORTS'` 精确匹配会 0 行命中 —— 删完这 23 篇体育文章全变孤儿，
 *   前台立刻多出一个 `Sport(s)` 页签。这里统一按小写比较，再把命中过的
 *   原始写法逐个精确更新（不敢用 `ilike`：`%` / `_` 在话题名里会被当通配符）。
 *
 * 兜底话题 `Other` 自己不给删：它是所有被删话题的收容所，删了就没地方安置；
 * 而它在前台本来就是「有文章才显示、没文章自动隐藏」（见 ComeBrief 的
 * `lib/categories.ts` 的 `categoryTabs`）。
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (auth.ok === false) return auth.response

  const admin = getSupabaseAdminClient()
  if (!admin.ok) {
    return jsonResponse({ error: admin.error || 'missing env: SUPABASE_SERVICE_ROLE_KEY' }, 500)
  }

  let body: any = null
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'invalid json' }, 400)
  }

  const name = String(body?.name ?? '').trim().slice(0, 60)
  if (!name) return jsonResponse({ error: 'name 不能为空' }, 400)
  if (name.toLowerCase() === FALLBACK_CATEGORY.toLowerCase()) {
    return jsonResponse(
      {
        error: `「${FALLBACK_CATEGORY}」是兜底分类，不能删除 —— 其他话题被删掉的文章都会并进这里；它没有文章时会自动从前台隐藏。`,
      },
      400
    )
  }

  const client = admin.client

  // 1) 找出所有「忽略大小写等于 name」的文章分类写法（例如 Sports / SPORTS 混用）
  const wanted = name.toLowerCase()
  const matched = new Set<string>()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from('articles')
      .select('category')
      .not('category', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)

    if (error) {
      console.log('[categories:delete] 读文章分类失败 ——', error.message)
      return jsonResponse({ error: error.message }, 500)
    }

    const rows = data || []
    for (const row of rows) {
      const value = String((row as any)?.category ?? '').trim()
      if (value && value.toLowerCase() === wanted) matched.add(value)
    }
    if (rows.length < PAGE) break
  }

  // 2) 把它们全部并进兜底话题。任何一条失败都中止（话题先不删，等站长重试）
  let moved = 0
  for (const value of matched) {
    const { error, count } = await client
      .from('articles')
      .update({ category: FALLBACK_CATEGORY }, { count: 'exact' })
      .eq('category', value)

    if (error) {
      console.log('[categories:delete] 迁移文章失败 ——', value, error.message)
      return jsonResponse(
        { error: `把「${value}」的文章并进「${FALLBACK_CATEGORY}」失败：${error.message}` },
        500
      )
    }
    moved += count || 0
  }

  // 3) 兜底话题必须留在矩阵里，被删话题的文章才有地方落（缺了就补一条，非致命）
  const { data: otherRow, error: otherReadError } = await client
    .from('categories')
    .select('name')
    .eq('name', FALLBACK_CATEGORY)
    .limit(1)
  if (otherReadError) {
    console.log('[categories:delete] 兜底话题检查跳过 ——', otherReadError.message)
  } else if (!otherRow || otherRow.length === 0) {
    const { error: otherInsertError } = await client.from('categories').insert([{ name: FALLBACK_CATEGORY }])
    if (otherInsertError) console.log('[categories:delete] 兜底话题补建失败 ——', otherInsertError.message)
  }

  // 4) 删掉话题本身
  const { error: deleteError, count: deleted } = await client
    .from('categories')
    .delete({ count: 'exact' })
    .eq('name', name)
  if (deleteError) {
    console.log('[categories:delete] 删话题失败 ——', deleteError.message)
    return jsonResponse({ error: deleteError.message }, 500)
  }

  console.log('[categories:delete] ok', { name, matched: [...matched], moved, deleted, userId: auth.userId })
  return jsonResponse({ ok: true, name, moved, matched: [...matched], deleted: deleted || 0 })
}
