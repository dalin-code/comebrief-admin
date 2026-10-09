import type { NextRequest } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { jsonResponse, requireAdmin } from '@/lib/aiGemini'

export const runtime = 'nodejs'

/** 位次基准：第 i 个标签 = 这个时间 + i 秒（只当序号用，不代表真实建表时间）。 */
const ORDER_EPOCH = Date.parse('2020-01-01T00:00:00.000Z')

/**
 * 话题矩阵的拖动排序落库。
 *
 * 为什么顺序存在 `categories.created_at` 上，而不是新加一列 `position`：
 *   前台（ComeBrief `lib/categories.ts`）要按站长拖出来的顺序渲染
 *   「All → ROMANCE → AI → …」，两边必须读同一个真源。`categories` 表线上只有
 *   `id / name / created_at` 三列，加列需要动线上表结构；而「谁先谁后」本来就要
 *   一个单调递增的键，`created_at` 正好是现成的那个 —— 于是把它当成**显式的
 *   展示位次**用：第 i 个标签 = 基准 + i 秒。
 *
 *   （实测过：不加这一层，同一天建出来的几个话题 `created_at` 一模一样，
 *   `order by created_at` 每次返回的顺序都能不一样，前台页签会自己跳。）
 *
 * 为什么走服务端而不是像加/删话题那样直接在前端改：
 *   实测匿名键 PATCH 这张表是 **200 但 0 行受影响**（RLS 静默拦下），
 *   服务端拿 service role 才是确定能写的那条路。
 *
 * 基准取一个固定纪元（2020-01-01T00:00:00Z + i 秒），不是「现在」：
 *   · 整组拖过的标签都排在**任何**还没被拖过的行前面（那些行的 created_at
 *     是真实的建表时间，2026 年以后），只拖了一部分时队形也不会乱；
 *   · 刚新建、还没拖过的话题（created_at = now()）永远落在队尾，等着站长自己拖。
 */
export async function POST(req: NextRequest) {
  // 与兄弟路由同一个约定：`requireAdmin` 返回联合类型，用 === false 收窄
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

  const raw = Array.isArray(body?.order) ? body.order : null
  if (!raw || raw.length === 0) return jsonResponse({ error: 'order 必须是非空数组' }, 400)
  if (raw.length > 200) return jsonResponse({ error: 'order 太长了（最多 200 个话题）' }, 400)

  // 归一：去空白项、按首次出现去重、单个名字限长 —— 前端传什么进来都不至于写脏库
  const seen = new Set<string>()
  const order: string[] = []
  for (const item of raw) {
    const name = String(item ?? '').trim().slice(0, 60)
    if (!name || seen.has(name)) continue
    seen.add(name)
    order.push(name)
  }
  if (order.length === 0) return jsonResponse({ error: 'order 里没有有效名字' }, 400)

  const { data: existing, error: readError } = await admin.client.from('categories').select('name')
  if (readError) {
    console.log('[categories:reorder] 读现有话题失败 ——', readError.message)
    return jsonResponse({ error: readError.message }, 500)
  }
  const known = new Set((existing || []).map((row: any) => String(row?.name || '')))

  const base = ORDER_EPOCH
  const applied: string[] = []
  const failed: string[] = []

  for (let i = 0; i < order.length; i++) {
    const name = order[i]
    const createdAt = new Date(base + i * 1000).toISOString()
    if (known.has(name)) {
      const { error } = await admin.client.from('categories').update({ created_at: createdAt }).eq('name', name)
      if (error) failed.push(name)
      else applied.push(name)
    } else {
      // 台上刚敲出来、还没随稿子保存的新话题：顺手落库，位置才守得住
      // （否则它会在保存时以 created_at = now() 落进队尾，把站长刚排好的顺序顶掉）
      const { error } = await admin.client.from('categories').insert([{ name, created_at: createdAt }])
      if (error) failed.push(name)
      else applied.push(name)
    }
  }

  if (failed.length > 0) {
    console.log('[categories:reorder] 失败', failed)
    return jsonResponse(
      { ok: false, error: `以下话题排序没保存成功：${failed.join('、')}`, applied, failed },
      500
    )
  }

  console.log('[categories:reorder] ok', { count: applied.length, userId: auth.userId })
  return jsonResponse({ ok: true, order: applied })
}
