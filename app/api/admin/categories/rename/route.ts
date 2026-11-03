import type { NextRequest } from 'next/server'
import { getSupabaseWriteClient } from '@/lib/supabaseAdmin'
import { getBearer, jsonResponse, requireAdmin } from '@/lib/aiGemini'
import { notifyFrontendRevalidate } from '@/lib/revalidateFrontend'
import {
  FALLBACK_CATEGORY,
  articleCategoryList,
  categoryKey,
  normalizeCategoryName,
  renameCategoryInList,
} from '@/lib/categoryNames'

export const runtime = 'nodejs'

/** 读文章的翻页大小（PostgREST 一次最多给 1000 行）。 */
const PAGE = 1000

/**
 * 给「话题矩阵」里的一个话题改名 —— 矩阵那一行 + 所有简报的 `categories[]`
 * 一起改。
 *
 * 为什么不能只改矩阵（前端 `update categories set name = ...` 那种）：
 *   前台页签的真源是矩阵，但文章身上还写着旧名字。前台会把「文章里有、
 *   矩阵里没有」的名字当成孤儿话题补在页签最后（见 ComeBrief
 *   `lib/categories.ts` 的 `categoryTabs`）—— 站长在后台从此管不到它，
 *   点进去却还是一堆文章。这与 categories/delete 里记的是同一类坑。
 *
 * 为什么不干脆「删掉旧的、再建个新的」：
 *   删话题会把名下所有文章并进兜底话题 `Other`（见 categories/delete），
 *   一百多篇文章的主话题一次全丢。改名就是要保住这些文章。
 *
 * 写库身份、回读校验、前台刷新，三件事与 delete / reorder 完全同款：
 *   · `getSupabaseWriteClient()` —— 有 service role 用它，没配就退回站长的登录票；
 *   · 每条写入都 `.select()` 回读 —— RLS 拦下的 UPDATE 是「200 但 0 行」；
 *   · 改完 `notifyFrontendRevalidate()` —— 前台 ISR 最多等一分钟。
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (auth.ok === false) return auth.response

  const write = getSupabaseWriteClient(getBearer(req))
  if (!write.ok) {
    console.log('[categories:rename] 没有可用的写库凭据', write.env)
    return jsonResponse({ error: write.error || 'missing env', env: write.env }, 500)
  }
  const client = write.client

  let body: any = null
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'invalid json' }, 400)
  }

  const fromInput = normalizeCategoryName(body?.from)
  const to = normalizeCategoryName(body?.to)
  if (!fromInput) return jsonResponse({ error: 'from（原话题名）不能为空' }, 400)
  if (!to) return jsonResponse({ error: 'to（新话题名）不能为空' }, 400)
  if (categoryKey(fromInput) === categoryKey(to)) {
    return jsonResponse({ error: '新名字和旧名字一样，不用改' }, 400)
  }
  if (categoryKey(fromInput) === categoryKey(FALLBACK_CATEGORY)) {
    return jsonResponse({ error: `「${FALLBACK_CATEGORY}」是兜底话题，不能改名` }, 400)
  }
  if (categoryKey(to) === categoryKey(FALLBACK_CATEGORY)) {
    return jsonResponse({ error: `不能改名成「${FALLBACK_CATEGORY}」—— 它是兜底收容所` }, 400)
  }

  // 1) 找到矩阵里那条记录（忽略大小写，保留库里的原始写法去精确更新，
  //    不用 ilike：`%` / `_` 在话题名里会被当通配符）。
  const { data: existing, error: readError } = await client.from('categories').select('name')
  if (readError) {
    console.log('[categories:rename] 读现有话题失败 ——', readError.message)
    return jsonResponse({ error: readError.message, via: write.via }, 500)
  }

  const rows = (existing || []) as any[]
  const row = rows.find((item) => categoryKey(item?.name) === categoryKey(fromInput))
  if (!row) {
    return jsonResponse(
      { error: `话题矩阵里没有「${fromInput}」，刷新页面看看它是不是已经被删/改名了` },
      404
    )
  }
  const storedName = String(row.name)

  const clash = rows.find(
    (item) =>
      categoryKey(item?.name) === categoryKey(to) &&
      categoryKey(item?.name) !== categoryKey(storedName)
  )
  if (clash) {
    return jsonResponse(
      {
        error: `矩阵里已经有「${clash.name}」了：要合并两个话题，请先把其中一批简报改成另一个话题，再把空出来的那个删掉。`,
        existing: String(clash.name),
      },
      409
    )
  }

  // 2) 先改矩阵那一行。回读校验：0 行 = 被 RLS 拦下了，必须报错。
  const { data: renamedRows, error: renameError } = await client
    .from('categories')
    .update({ name: to })
    .eq('name', storedName)
    .select('name')

  if (renameError) {
    console.log('[categories:rename] 改矩阵失败 ——', renameError.message)
    return jsonResponse({ error: renameError.message, via: write.via }, 500)
  }
  if (!renamedRows || renamedRows.length === 0) {
    console.log('[categories:rename] 改矩阵 0 行 ——', storedName)
    return jsonResponse(
      { error: `「${storedName}」没有改成「${to}」（0 行受影响，写权限被 RLS 拦下了）`, via: write.via },
      500
    )
  }

  // 3) 再把所有简报身上的旧名字换掉（逐篇、保留原位）。
  //    主话题位（数组第一项 / 旧列 category）必须一起换，否则前台卡片的
  //    主话题还会显示旧名字。
  type ArticleUpdate = { id: string; next: string[] }
  const updates: ArticleUpdate[] = []
  let categoriesAvailable = true

  for (let from = 0; ; from += PAGE) {
    let res: any = await client
      .from('articles')
      .select('id, category, categories')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)

    if (res.error && /categories/i.test(String(res.error.message || ''))) {
      // 45 号迁移还没跑（部署顺序反了）时退回单值读取：改名仍然要能用。
      categoriesAvailable = false
      res = await client
        .from('articles')
        .select('id, category')
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1)
    }

    if (res.error) {
      console.log('[categories:rename] 读文章话题失败 ——', res.error.message)
      return jsonResponse(
        {
          error: `矩阵已改名，但读文章失败（${res.error.message}）；旧名字还留在文章里，重试一次即可`,
          via: write.via,
        },
        500
      )
    }

    const articleRows = (res.data || []) as any[]
    for (const article of articleRows) {
      const list = articleCategoryList(article)
      const next = renameCategoryInList(list, storedName, to)
      if (!next) continue
      if (next.length === 0) next.push(FALLBACK_CATEGORY)
      updates.push({ id: String(article.id), next })
    }
    if (articleRows.length < PAGE) break
  }

  // 4) 逐篇落库。任何一条失败都中止并说清楚 —— 矩阵已经改了，
  //    再往下走只会让文章与矩阵对不上（前台会出现孤儿页签）。
  let updated = 0
  for (const item of updates) {
    const next = item.next
    const payload: Record<string, unknown> = { category: next[0] }
    if (categoriesAvailable) payload.categories = next

    const { data: changed, error } = await client
      .from('articles')
      .update(payload)
      .eq('id', item.id)
      .select('id')

    if (error) {
      console.log('[categories:rename] 改文章失败 ——', item.id, error.message)
      return jsonResponse(
        { error: `矩阵已改名，但改这篇文章时失败（${item.id}）：${error.message}`, via: write.via, updated },
        500
      )
    }
    if (!changed || changed.length === 0) {
      console.log('[categories:rename] 改文章 0 行 ——', item.id)
      return jsonResponse(
        {
          error: `矩阵已改名，但文章 ${item.id} 的 0 行受影响（写权限被 RLS 拦下了）`,
          via: write.via,
          updated,
        },
        500
      )
    }
    updated += 1
  }

  const frontend = await notifyFrontendRevalidate('categories:rename')

  console.log('[categories:rename] ok', {
    from: storedName,
    to,
    updated,
    via: write.via,
    userId: auth.userId,
    frontend,
  })
  return jsonResponse({ ok: true, from: storedName, to, updated, via: write.via, frontend })
}

