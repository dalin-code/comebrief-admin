/**
 * 一个够用的 RSS / Atom 解析器（纯函数、零依赖、离线可断言）。
 *
 * 为什么不用 xml2js / fast-xml-parser：我们只读三种源里的四个字段（title / link /
 * pubDate / description），而 `package.json` 里连一个 XML 依赖都没有 —— 为四行字段
 * 引一棵解析树，CI 就多一个可能被投毒的包。这里用正则足够，因为**输入是源的格式，
 * 不是任意 XML**：Google Trends / Reddit / KYM 的 feed 都规整，且字段名固定。
 *
 * 必须认得的三种写法（历史事故都来自这里）：
 *   ① `<title><![CDATA[Taylor Swift]]></title>` —— CDATA 不剥掉，标题里会带方括号；
 *   ② `<ht:approx_traffic>200+</ht:approx_traffic>` —— 带命名空间的字段（Google Trends）；
 *   ③ Atom：`<entry>` + `<link href="…"/>` 自闭合 —— Reddit 的 `.rss` 是 RSS 2.0，
 *      但 PopCrave 之类换主题后会变成 Atom，混着来会静默解析出 0 条。
 */

export type RssEntry = {
  title: string
  link?: string
  description?: string
  /** 原文日期（未解析），下游自己 `new Date()` */
  publishedAt?: string
  /** 额外字段：`ht:approx_traffic`、`ht:news_item_title` 之类 */
  extra: Record<string, string>
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
}

const fromCodePoint = (code: number, fallback: string): string => {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback
  try {
    return String.fromCodePoint(code)
  } catch {
    return fallback
  }
}

/** `&amp;` / `&#39;` / `&#x2019;` 三种都解开（Google 的标题里三种都有）。 */
export function decodeEntities(input: string): string {
  return String(input ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (whole, hex: string) => fromCodePoint(parseInt(hex, 16), whole))
    .replace(/&#(\d+);/g, (whole, dec: string) => fromCodePoint(parseInt(dec, 10), whole))
    .replace(/&([a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
}

/** 去标签 + 去 CDATA + 解实体 + 压空白。标题里常见的 `<b>` 高亮就这么处理。 */
export function stripHtml(input: string): string {
  return decodeEntities(
    String(input ?? '')
      .replace(/<!\[CDATA\[/g, '')
      .replace(/\]\]>/g, '')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim()
}

/** 取第一个匹配的标签内容；`tag` 里可以带冒号（`ht:approx_traffic`）。 */
function pickTag(block: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, 'i')
  const match = block.match(pattern)
  return match ? stripHtml(match[1]) : ''
}

/** Atom 的 `<link rel="alternate" href="…"/>`；RSS 2.0 是 `<link>…</link>`。 */
function pickLink(block: string): string {
  const href = block.match(/<link[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i)
  if (href) return decodeEntities(href[1]).trim()
  return pickTag(block, 'link')
}

/** 一堆可能承载时间的标签名，按优先级取第一个非空的。 */
const DATE_TAGS = ['pubDate', 'published', 'updated', 'dc:date', 'date']

/** 额外字段（Google Trends 的 `ht:` 命名空间），只收集一层标签名。 */
function pickExtra(block: string, tags: string[]): Record<string, string> {
  const extra: Record<string, string> = {}
  for (const tag of tags) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, 'i')
    const match = block.match(pattern)
    if (match) {
      const value = stripHtml(match[1])
      if (value) extra[tag] = value
    }
  }
  return extra
}

/**
 * 解析一份 feed，最多返回 `limit` 条。
 *
 * 认不出任何 `<item>` / `<entry>` 时返回空数组（**不抛异常**）：
 * 上游换主题、返回一页 HTML、被 CDN 拦截，都会走到这里 —— 采集层要的是
 * 「这个源今天没数据」，而不是整个 `/trends` 接口 500。
 */
export function parseRss(xml: string, limit = 40, extraTags: string[] = []): RssEntry[] {
  const text = String(xml ?? '')
  if (!text.trim()) return []

  const isAtom = /<entry[\s>]/i.test(text) && !/<item[\s>]/i.test(text)
  const blockPattern = isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi
  const blocks = text.match(blockPattern) || []

  const entries: RssEntry[] = []
  for (const block of blocks) {
    const title = pickTag(block, 'title')
    if (!title) continue

    let publishedAt = ''
    for (const tag of DATE_TAGS) {
      publishedAt = pickTag(block, tag)
      if (publishedAt) break
    }

    const description =
      pickTag(block, 'description') || pickTag(block, 'summary') || pickTag(block, 'content')

    entries.push({
      title,
      link: pickLink(block) || undefined,
      description: description || undefined,
      publishedAt: publishedAt || undefined,
      extra: pickExtra(block, extraTags),
    })
    if (entries.length >= limit) break
  }
  return entries
}

/** `200+` / `1,200` / `5K` → 数字；认不出返回 0。 */
export function parseTraffic(raw: string): number {
  const text = String(raw ?? '').replace(/,/g, '').trim().toLowerCase()
  const match = text.match(/([\d.]+)\s*([kmb])?/)
  if (!match) return 0
  const base = Number(match[1])
  if (!Number.isFinite(base)) return 0
  const unit = match[2]
  if (unit === 'k') return Math.round(base * 1_000)
  if (unit === 'm') return Math.round(base * 1_000_000)
  if (unit === 'b') return Math.round(base * 1_000_000_000)
  return Math.round(base)
}
