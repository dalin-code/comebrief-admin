/**
 * 话题名（后台「话题矩阵」/ `categories.name`）的归一化与改名工具。
 *
 * 纯函数、零依赖 —— 路由、编辑页、测试都 import 这一份，不要再各写一份
 * trim/toLowerCase。线上数据本来就大小写不统一（表里 `SPORTS`、文章里
 * `Sports`，见 lib/revalidateFrontend 与 categories/delete 的注释），
 * 所以「是不是同一个话题」一律走 `categoryKey()` 比，不拿字符串直接 `===`。
 */

/** 话题名长度上限。与 categories 的 create / reorder / delete 三个路由同一口径。 */
export const MAX_CATEGORY_NAME = 60

/** 兜底话题：其他话题被删掉的文章都会并进它，前台整体隐藏（见 ComeBrief lib/categories.ts）。 */
export const FALLBACK_CATEGORY = 'Other'

/**
 * 归一：全角空格 / 制表符 / 连续空白都压成一个半角空格，再去掉首尾。
 *
 * 为什么要压空白：站长手打「Crime  Fiction」和「Crime Fiction」看起来一样，
 * 库里却是两行 —— 前台会多出一个页签，后台矩阵里这两张标签还都点得到。
 */
export function normalizeCategoryName(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u3000\s]+/g, ' ')
    .trim()
    .slice(0, MAX_CATEGORY_NAME)
}

/** 比较用的键：归一化后再小写。 */
export function categoryKey(raw: unknown): string {
  return normalizeCategoryName(raw).toLowerCase()
}

/**
 * 把一篇文章的话题列表里的 `from` 换成 `to`，**保留原位与原有顺序**。
 *
 * 返回 `null` 表示这篇文章压根没提到 `from`（调用方据此跳过，不写库）；
 * 返回数组则表示改写后的完整列表（可能为空数组 —— 由调用方决定要不要补兜底）。
 *
 * 两个细节：
 *   · 保留原位：`categories[0]` 是主话题，前台卡片标题位读的就是它；
 *     如果改用「删掉旧的 push 新的」，被改名的话题会从主话题掉到队尾。
 *   · 顺手去重：`to` 可能本来就在这篇的列表里（比如文章同时写了
 *     `Sports` 和 `Sport`，而 `Sport` 正被改名成 `Sports`），不去重就会
 *     写出 `['Sports','Sports']`，前台计数会重复算两次。
 */
export function renameCategoryInList(
  list: unknown,
  from: string,
  to: string
): string[] | null {
  const source = Array.isArray(list) ? list : String(list ?? '').split(',')
  const wanted = categoryKey(from)
  const target = normalizeCategoryName(to)
  if (!wanted || !target) return null

  const next: string[] = []
  const seen = new Set<string>()
  let hit = false

  for (const item of source) {
    const name = normalizeCategoryName(item)
    if (!name) continue
    const key = categoryKey(name)
    const replaced = key === wanted ? target : name
    const replacedKey = categoryKey(replaced)
    if (key === wanted) hit = true
    if (seen.has(replacedKey)) continue
    seen.add(replacedKey)
    next.push(replaced)
  }

  return hit ? next : null
}

/**
 * 一篇文章「实际带的话题」：`categories[]` ∪ 旧列 `category`。
 *
 * 旧列永远等于数组第一项（保存时双写，见 trends/edit 的 handleSave），
 * 但历史行里可能只写了 `category` 没写数组，所以两边都要看。
 */
export function articleCategoryList(row: {
  categories?: unknown
  category?: unknown
} | null): string[] {
  const list: string[] = []
  const seen = new Set<string>()
  const push = (raw: unknown) => {
    const name = normalizeCategoryName(raw)
    if (!name) return
    const key = categoryKey(name)
    if (seen.has(key)) return
    seen.add(key)
    list.push(name)
  }

  if (Array.isArray(row?.categories)) row?.categories.forEach(push)
  push(row?.category)
  return list
}
