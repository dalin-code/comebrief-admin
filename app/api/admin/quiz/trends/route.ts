import type { NextRequest } from 'next/server'
import { jsonResponse, requireAdmin } from '@/lib/aiGemini'
import {
  dedupeTrends,
  filterTrends,
  mergeRoundRobin,
  normalizeGeo,
  normalizeWindow,
  sortTrends,
  trendId,
  trendSourceDef,
  TREND_SOURCES,
  type TrendFetchResult,
  type TrendItem,
  type TrendSourceId,
} from '@/lib/quizTrends'
import { fetchTrendSources } from '@/lib/quizTrends/sources'
import { extractHotWords } from '@/lib/quizLexicon'

export const runtime = 'nodejs'
export const maxDuration = 30

/**
 * 趋势采集：8 个公开源 + 人工粘贴 → 去重 / 过滤 / 轮转合并 → 热词表。
 *
 * 为什么是 POST 而不是 GET：要传源开关、地区、时间窗与粘贴文本，GET 的 URL
 * 长度放不下，而且这类请求**必须**带登录票（不能让别人拿我们的出口 IP 刷源）。
 *
 * 三条硬约束（验收标准）：
 *   ① 单个源失败**不清空**整页：`Promise.allSettled` + 每源 8 秒超时；
 *   ② 全部失败且没有人工粘贴时返回 **424**（Failed Dependency）而不是空列表 ——
 *      「今天什么都没发生」和「我们的采集全挂了」对使用者是两件事；
 *   ③ 合并用轮转：任何单个源占比 ≤ 50%，否则 60 条里 55 条是搜索词。
 */

/** 10 分钟进程内缓存：同一地区反复点「刷新」不该把 8 个源再打一遍。 */
const CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_LIMIT = 12

type CacheEntry = { at: number; payload: TrendFetchResult; terms: ReturnType<typeof extractHotWords> }
const cache = new Map<string, CacheEntry>()

const cacheGet = (key: string): CacheEntry | null => {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return hit
}

const cacheSet = (key: string, entry: CacheEntry) => {
  cache.set(key, entry)
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (!oldest) break
    cache.delete(oldest)
  }
}

/** 人工粘贴：一行一条，也接受逗号 / 分号分隔；`标题 | https://…` 里的链接会被留下。 */
function parseManualTrends(raw: unknown, geo: TrendFetchResult['geo']): TrendItem[] {
  const text = String(raw ?? '').trim()
  if (!text) return []
  return text
    .split(/[\n;]+/)
    .map((line) => line.replace(/^[-*•\d.\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 30)
    .map((line) => {
      const [titlePart, urlPart] = line.split('|').map((part) => part.trim())
      const title = titlePart.slice(0, 120)
      return {
        id: trendId('manual', title),
        title,
        source: 'manual' as TrendSourceId,
        url: urlPart && /^https?:\/\//i.test(urlPart) ? urlPart : undefined,
        geo,
        note: 'pasted by the editor',
      }
    })
}

const pickSources = (raw: unknown): TrendSourceId[] => {
  const list = Array.isArray(raw) ? raw.map((value) => String(value).trim()) : []
  const known = new Set(TREND_SOURCES.map((source) => source.id))
  const picked = list.filter((value): value is TrendSourceId => known.has(value as TrendSourceId))
  if (picked.length) return picked
  return TREND_SOURCES.filter((source) => source.defaultOn && source.id !== 'manual').map((source) => source.id)
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdmin(req)
    if (auth.ok === false) return auth.response

    const body = await req.json().catch(() => ({}))
    const geo = normalizeGeo(body?.geo)
    const window = normalizeWindow(body?.window)
    const sources = pickSources(body?.sources)
    const manual = String(body?.manual ?? '')
    const pinned = (Array.isArray(body?.pinned) ? body.pinned : [])
      .map((value: unknown) => String(value ?? '').trim())
      .filter(Boolean)
      .slice(0, 12)

    const key = JSON.stringify({ geo, window, sources, manual: manual.slice(0, 400), pinned })
    const cached = cacheGet(key)
    if (cached) return jsonResponse({ ok: true, ...cached.payload, terms: cached.terms, cached: true })

    const outcomes = await fetchTrendSources({ geo, window, sources })
    const manualItems = parseManualTrends(manual, geo)

    const groups = [
      ...outcomes.map((outcome) => ({ source: outcome.source, items: outcome.items })),
      { source: 'manual' as TrendSourceId, items: manualItems },
    ]
    const merged = mergeRoundRobin(groups, 60)
    const filtered = filterTrends(merged, window)
    const items = sortTrends(dedupeTrends(filtered.items)).slice(0, 60)

    const statuses = outcomes.map((outcome) => ({
      ...outcome.status,
      label: trendSourceDef(outcome.source)?.label || outcome.source,
    }))
    if (manualItems.length) {
      statuses.push({
        id: 'manual',
        label: trendSourceDef('manual')?.label || 'Manual paste',
        ok: true,
        count: manualItems.length,
        ms: 0,
      })
    }

    if (!items.length) {
      const allFailed = outcomes.length > 0 && outcomes.every((outcome) => !outcome.status.ok)
      return jsonResponse(
        {
          ok: false,
          error: allFailed
            ? '8 个源全部失败：先检查本机网络 / 代理，或直接用「人工粘贴」'
            : '采集到的条目都被过滤掉了（敏感 / 非英文 / 超出时间窗）：试试放宽时间窗或加几条人工粘贴',
          sources: statuses,
          filtered: filtered.filtered,
        },
        allFailed ? 424 : 200
      )
    }

    const payload: TrendFetchResult = {
      items,
      sources: statuses,
      geo,
      window,
      fetchedAt: new Date().toISOString(),
      cached: false,
      filtered: filtered.filtered,
    }
    const terms = extractHotWords(items, { pinned })
    cacheSet(key, { at: Date.now(), payload, terms })

    return jsonResponse({ ok: true, ...payload, terms, cached: false })
  } catch (error: any) {
    console.error('[quiz/trends] 失败：', error)
    return jsonResponse({ error: `采集失败：${String(error?.message || error).slice(0, 120)}` }, 500)
  }
}
