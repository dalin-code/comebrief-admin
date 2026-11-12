/**
 * 8 个趋势源的适配器（只在服务端跑；`parse*` 与 URL 构造是纯函数，CI 可断言）。
 *
 * 每个适配器只做三件事：**拼 URL**、**把响应变成 `TrendItem[]`**、**出错时说人话**。
 * 过滤（敏感词 / 非英文 / 时间窗）不在这里做 —— 那属于 `lib/quizTrends.ts`，
 * 一处做、一处测，避免「同一个源在这里漏了敏感词」。
 *
 * 三条实测经验（2026-11-09 逐个验证）：
 *   ① Reddit 只有 `.rss` 能匿名读；`.json` 一律 403（改 UA 也不行），别再试了；
 *   ② Wikimedia 的「今日」榜单要到 UTC 之后才发布，取昨天最稳（今天的经常 404）；
 *   ③ Google Trends 的 geo 参数必须给具体国家，`GLOBAL` 只能落到 US。
 */

import {
  isEnglishText,
  trendId,
  type TrendGeo,
  type TrendItem,
  type TrendSourceId,
  type TrendSourceStatus,
  type TrendWindow,
} from '../quizTrends'
import { parseRss, parseTraffic } from './rss'

/** 匿名可读的源都要求一个像样的 UA；默认的 undici UA 会被 Reddit / KYM 直接 403。 */
const USER_AGENT = 'SassQuizTrends/1.0 (+https://comebrief.com; quiz authoring)'

/** 单个源 8 秒：8 个源并发，最坏 8 秒而不是 64 秒（接口 maxDuration = 30）。 */
export const SOURCE_TIMEOUT_MS = 8000

async function fetchText(url: string, ms = SOURCE_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/xml, text/xml, application/json, */*' },
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

async function fetchJson<T>(url: string, ms = SOURCE_TIMEOUT_MS): Promise<T> {
  const text = await fetchText(url, ms)
  return JSON.parse(text) as T
}

/** 国家码：`GLOBAL` 落到 us（这些源没有「全球榜」，只能拿最大市场当代理）。 */
const countryCode = (geo: TrendGeo): string => (geo === 'GLOBAL' ? 'us' : geo.toLowerCase())

/** 昨天的 UTC 日期 —— 维基的「今日」榜单常常还没发布。 */
export function wikipediaDate(now = new Date(), daysBack = 1): { year: string; month: string; day: string } {
  const date = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000)
  return {
    year: String(date.getUTCFullYear()),
    month: String(date.getUTCMonth() + 1).padStart(2, '0'),
    day: String(date.getUTCDate()).padStart(2, '0'),
  }
}

/**
 * 维基日榜最多回看几天。
 *
 * 实测（2026-11-09）：当天 / 昨天 / 前天全是 404，**-3 天才 200** ——
 * Wikimedia 的 top-pageviews 数据集有 2–4 天延迟，遇到节假日更久。
 * 所以这个源不是「取某一天」，而是「往回找一个有数据的日子」。
 */
export const WIKIPEDIA_LOOKBACK_DAYS = 5

export type Adapter = {
  id: TrendSourceId
  /** 候选 URL：按顺序试，第一个返回 2xx 的胜出（维基日榜要靠这个跳过空洞） */
  urls: (geo: TrendGeo) => string[]
  parse: (body: string, geo: TrendGeo) => TrendItem[]
}


const rssAdapter = (
  id: TrendSourceId,
  url: (geo: TrendGeo) => string,
  extraTags: string[] = []
): Adapter => ({
  id,
  urls: (geo) => [url(geo)],
  parse: (body, geo) =>
    parseRss(body, 40, extraTags).map((entry) => ({
      id: trendId(id, entry.title),
      title: entry.title,
      source: id,
      url: entry.link,
      publishedAt: entry.publishedAt,
      geo,
      note: entry.description ? entry.description.slice(0, 160) : undefined,
      score: entry.extra['ht:approx_traffic'] ? parseTraffic(entry.extra['ht:approx_traffic']) : undefined,
    })),
})

/* ------------------------------------------------------------------ *
 * JSON 源
 * ------------------------------------------------------------------ */

type WikipediaResponse = {
  items?: Array<{ articles?: Array<{ article?: string; views?: number; rank?: number }> }>
}

const WIKI_SKIP = /^(main_page|special:|wikipedia:|portal:|file:|help:|category:|template:|talk:|draft:|module:)/i

/** 只要前 40 名：日榜 1000 条里后面 900 条是长尾，进提示词只会稀释信号。 */
const WIKI_LIMIT = 40

export function parseWikipedia(body: string, geo: TrendGeo): TrendItem[] {
  const data = JSON.parse(body) as WikipediaResponse
  const articles = data.items?.[0]?.articles ?? []
  const out: TrendItem[] = []
  for (const article of articles) {
    const raw = String(article.article ?? '').trim()
    if (!raw || WIKI_SKIP.test(raw)) continue
    // 以点开头的是 TLD / 域名条目（`.xxx`），不是「大家在关心的事」
    if (raw.startsWith('.')) continue
    let title = raw.replace(/_/g, ' ')
    try {
      title = decodeURIComponent(title)
    } catch {
      // 保留原样：个别条目里有孤立的 %
    }
    if (!title || !isEnglishText(title)) continue
    out.push({
      id: trendId('wikipedia', title),
      title,
      source: 'wikipedia',
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(raw)}`,
      score: Number(article.views) || undefined,
      geo,
    })
    if (out.length >= WIKI_LIMIT) break
  }
  return out
}

type AppleResponse = {
  feed?: { results?: Array<{ name?: string; artistName?: string; url?: string }> }
}

export function parseAppleMusic(body: string, geo: TrendGeo): TrendItem[] {
  const data = JSON.parse(body) as AppleResponse
  const results = data.feed?.results ?? []
  const out: TrendItem[] = []
  results.forEach((entry, index) => {
    const name = String(entry.name ?? '').trim()
    const artist = String(entry.artistName ?? '').trim()
    if (!name) return
    out.push({
      id: trendId('apple-music', `${name} ${artist}`),
      title: artist ? `${name} — ${artist}` : name,
      source: 'apple-music',
      url: entry.url,
      score: Math.max(1, 30 - index),
      geo,
    })
  })
  return out
}

/* ------------------------------------------------------------------ *
 * 8 个源
 * ------------------------------------------------------------------ */

export const TREND_ADAPTERS: Adapter[] = [
  rssAdapter('google-trends', (geo) => `https://trends.google.com/trending/rss?geo=${geo === 'GLOBAL' ? 'US' : geo}`, [
    'ht:approx_traffic',
    'ht:news_item_title',
  ]),
  rssAdapter(
    'google-news',
    (geo) => {
      const code = geo === 'GLOBAL' ? 'US' : geo
      return `https://news.google.com/rss?hl=en-${code}&gl=${code}&ceid=${code}:en`
    }
  ),
  {
    id: 'wikipedia',
    urls: () =>
      // 今天 / 昨天通常还没发布，从「昨天」开始往回找，最多 5 天
      Array.from({ length: WIKIPEDIA_LOOKBACK_DAYS }, (_, index) => {
        const { year, month, day } = wikipediaDate(new Date(), index + 1)
        return `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${year}/${month}/${day}`
      }),
    parse: parseWikipedia,
  },
  rssAdapter('reddit', () => 'https://www.reddit.com/r/popular/hot/.rss?limit=50'),
  rssAdapter('knowyourmeme', () => 'https://knowyourmeme.com/newsfeed.rss'),
  {
    id: 'apple-music',
    urls: (geo) => [
      // 用跳转后的正式域名：`rss.applemarketingtools.com` 会 301 到 `rss.marketingtools.apple.com`，
      // 多一跳就多一秒（实测 3.1s vs 0.6s + 跳转，偶发直接超 8 秒）
      `https://rss.marketingtools.apple.com/api/v2/${countryCode(geo)}/music/most-played/25/songs.json`,
    ],
    parse: parseAppleMusic,
  },
  rssAdapter('popcrave', () => 'https://www.popcrave.com/feed/'),
  rssAdapter('buzzfeed', () => 'https://www.buzzfeed.com/index.xml'),
]

export const adapterFor = (id: TrendSourceId): Adapter | undefined =>
  TREND_ADAPTERS.find((adapter) => adapter.id === id)

export type SourceFetchOutcome = {
  source: TrendSourceId
  items: TrendItem[]
  status: TrendSourceStatus
}

/** 抓一个源，永不抛异常 —— 失败就是「今天这个源没数据」，不让整个接口跟着挂。 */
export async function fetchOneSource(
  adapter: Adapter,
  geo: TrendGeo,
  timeoutMs = SOURCE_TIMEOUT_MS
): Promise<SourceFetchOutcome> {
  const started = Date.now()
  const candidates = adapter.urls(geo).slice(0, 6)

  const attempt = async (): Promise<{ items: TrendItem[]; error: string }> => {
    let lastError = '没有候选地址'
    for (const url of candidates) {
      try {
        const body = await fetchText(url, timeoutMs)
        const items = adapter.parse(body, geo)
        if (!items.length && candidates.length > 1) {
          // 维基的「这一天还没数据」会回 200 + 空榜单：继续试更早的日期
          lastError = '返回空榜单'
          continue
        }
        return { items, error: '' }
      } catch (error: any) {
        lastError = String(error?.name === 'AbortError' ? '超时' : error?.message || '请求失败').slice(0, 80)
      }
    }
    return { items: [], error: lastError }
  }

  let result = await attempt()
  // 网络抖动 / 上游 5xx 重试一次：实测 Apple 的 CDN 偶尔 8 秒不响应（同一秒 curl 却是 3 秒），
  // 反复抓几次还会回 502。404 之类重试也没用，反而白等一个超时，所以不放行。
  if (!result.items.length && /超时|fetch failed|ECONN|EAI_AGAIN|socket|network|HTTP 5\d\d/i.test(result.error)) {
    result = await attempt()
  }

  return {
    source: adapter.id,
    items: result.items,
    status: {
      id: adapter.id,
      label: adapter.id,
      ok: result.items.length > 0,
      count: result.items.length,
      ms: Date.now() - started,
      error: result.items.length ? undefined : result.error,
    },
  }
}

/**
 * 并发抓一批源。
 *
 * 用 `Promise.allSettled` 而不是 `all`：8 个源里挂一个（Reddit 限流是常态）不该
 * 让「今天的热点」整页空掉。每个源自己的超时在 `fetchOneSource` 里，所以
 * 总时长是 8 秒量级，不是 8 × 8 秒。
 */
export async function fetchTrendSources(options: {
  geo: TrendGeo
  window: TrendWindow
  sources: TrendSourceId[]
  timeoutMs?: number
}): Promise<SourceFetchOutcome[]> {
  const adapters = options.sources
    .map((id) => adapterFor(id))
    .filter((adapter): adapter is Adapter => Boolean(adapter))
  if (!adapters.length) return []

  const settled = await Promise.allSettled(
    adapters.map((adapter) => fetchOneSource(adapter, options.geo, options.timeoutMs))
  )

  return settled.map((result, index) => {
    if (result.status === 'fulfilled') return result.value
    const adapter = adapters[index]
    return {
      source: adapter.id,
      items: [],
      status: {
        id: adapter.id,
        label: adapter.id,
        ok: false,
        count: 0,
        ms: 0,
        error: String(result.reason?.message || '未知错误').slice(0, 80),
      },
    }
  })
}
