import type { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * 后台接口的「钥匙 + 网络诊断 + 报错翻译」工具箱。
 *
 * 职责边界（2026-10-10 重新划清）：**这个文件不再直接调模型**。
 *   调模型统一走 lib/aiProvider 的 `callText()`（候选链 / 冷却 / 超时预算都在那儿）。
 *   以前这里有个 `callGeminiText()`，只有摘要路由在用 —— 于是那条路的 429 判断、
 *   换兜底、thinkingBudget 全是另一套逻辑，还拼不出跨供应商的兜底 URL。已删除。
 *
 * 这里留下的是纯粹、无状态的东西：
 *   · requireAdmin / getBearer / jsonResponse —— 后台鉴权那套「三种失败分开说」；
 *   · fetchWithTimeout / isAbortError / isNetworkFetchError / describeNetworkError —— 网络层；
 *   · extractProviderMessage / parseProviderError / describeProviderError / logProviderError —— 错误层；
 *   · parseJsonLoose / safeParseModelJson —— 模型输出的 JSON 兜底；
 *   · stripFences / htmlToPlainText —— 从 storyPrompt 转发（那边保持零依赖，客户端也能用）。
 *
 * 为什么单独抽一个文件：app/api/news/rewrite/route.ts 与 app/api/ai/draw/route.ts 里
 * 各写了一份几乎一样的「Bearer 校验 + 超时 fetch + JSON 兜底」。那两个老路由保持原样不动
 * （线上已跑通），新接口一律从这里 import。
 */

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export const getBearer = (req: NextRequest) => {
  const h = req.headers.get('authorization') || ''
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m?.[1]?.trim() || ''
}

export const fetchWithTimeout = async (url: string, init: RequestInit, ms: number) => {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(id)
  }
}

export const isAbortError = (e: any) =>
  e?.name === 'AbortError' || String(e?.message || '').toLowerCase().includes('aborted')

/**
 * 网络层失败的「认得出来 + 说得清楚」。
 *
 * 为什么需要这两个函数：
 *   Node 的 fetch（undici）只要在收发 HTTP 之前就断了，抛出来的永远是同一句
 *   `TypeError: fetch failed` —— 真正的原因（ECONNRESET / ENOTFOUND / 证书不认……）
 *   藏在 error.cause 里。以前我们把 e.message 直接丢给前端，站长看到的就是一个
 *   莫名其妙的 `fetch failed`：既不知道是自己没网、也不知道该不该重试。
 *   实测（本机 + Google 端点）：断线发生在 TLS 握手阶段，约 5 秒就抛
 *   `fetch failed / ECONNRESET`，请求根本没到 Google —— 这种抖动重试一次几乎必成。
 */
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

/** 是「压根没跟对面说上话」，而不是对面回的错、也不是票的问题 */
export const isNetworkFetchError = (e: any) => {
  if (!e) return false
  const code = String(e?.cause?.code || e?.code || '').toUpperCase()
  if (code.startsWith('UND_ERR')) return true
  if (NETWORK_ERROR_CODES.has(code)) return true
  return e?.name === 'TypeError' && /fetch failed|socket|network/i.test(String(e?.message || ''))
}

/** 把网络失败翻成一句站长看得懂、照着能做的话（英文原文留给终端日志，提示框里放不下） */
export const describeNetworkError = (e: any) => {
  const code = String(e?.cause?.code || e?.code || '').toUpperCase()
  const raw = String(e?.cause?.message || e?.message || 'fetch failed').replace(/\s+/g, ' ').trim().slice(0, 60)
  const HINTS: Record<string, string> = {
    ECONNRESET: '连接被中途掐断（TLS 握手都没建起来，通常是本地网络抖了一下）',
    ECONNREFUSED: '连接被拒绝（多半是代理没开）',
    ECONNABORTED: '连接被中断',
    ENOTFOUND: '域名解析不出来',
    EAI_AGAIN: '域名解析超时',
    ETIMEDOUT: '连接超时',
    EHOSTUNREACH: '主机不可达',
    ENETUNREACH: '网络不可达',
    EPIPE: '连接被对面关掉了',
    UND_ERR_CONNECT_TIMEOUT: '连接超时',
    UND_ERR_SOCKET: '连接被对面关掉了',
    UND_ERR_HEADERS_TIMEOUT: '对面响应太慢',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'HTTPS 证书验不过（代理或安全软件插了一手）',
    SELF_SIGNED_CERT_IN_CHAIN: 'HTTPS 证书是自签的（多半被代理拦了）',
    CERT_HAS_EXPIRED: 'HTTPS 证书过期了',
  }
  const hint = HINTS[code]
  // 认得的 code 就只报 code —— 前端提示框很窄，英文原文没人看得下去；
  // 不认识的才把原文带上，留给排查用。
  const detail = hint ? code : [code, raw].filter(Boolean).join('：')
  return `连不上模型服务：${hint || '网络不通'}（${detail || 'fetch failed'}）—— 检查网络 / 代理后重试一次`
}

/**
 * 从各家错误体里挖出「模型自己说了什么」。
 *
 * 三家协议的错误体恰好都是 `{ error: { message } }`（OpenAI 兼容偶尔是 `{ message }`），
 * 但以前我们直接把整段 JSON 塞进提示框，站长看到的是：
 *   Gemini 429: {"error":{"code":429,"message":"You exceeded your current quota, please check
 *   your plan and billing details. For more information on this error, head to:
 *   https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to:
 *   https://ai.dev/rate-limit. \n* Quota ex...
 * 一屏红字、一句有用的都没有（额度用完该等、该换模型，还是该重试？看不出来）。
 * 这里只负责「把 message 抠出来」，怎么说人话交给 describeProviderError。
 */
export const extractProviderMessage = (raw: string) => {
  const s = String(raw || '').trim()
  if (!s) return ''
  try {
    const j: any = JSON.parse(s)
    const m = j?.error?.message ?? j?.message ?? j?.error
    if (typeof m === 'string' && m.trim()) return m.replace(/\s+/g, ' ').trim()
  } catch {
    /* 不是 JSON（可能是网关的 HTML 错误页）—— 原样兜底 */
  }
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 429 这类错误的「结构化解读」。
 *
 * 为什么不能只看那行 message（这条是被真实故障教出来的）：
 *   Gemini 对**每分钟限流（RPM）**和**每日额度用尽（RPD）**回的正文几乎一模一样 ——
 *   都是 `You exceeded your current quota, please check your plan and billing details…`。
 *   旧代码拿 /quota|billing|free tier|plan/ 去猜，于是每一句 429 都被判成「今天的额度用完了」，
 *   把一个「等 20 秒就好」的限流说成「去换模型 / 等明天」，把站长径直往错的方向指。
 *
 * 真正靠谱的判据（按可信度从高到低）：
 *   ① details[].QuotaFailure.quotaId —— Google 会写死是哪个额度池：
 *      `GenerateRequestsPerDayPerProjectPerModel-FreeTier`   → 每日额度，明天才恢复
 *      `GenerateRequestsPerMinutePerProjectPerModel-…`       → 每分钟限流，缓一下就好
 *   ② details[].RetryInfo.retryDelay（形如 `"23s"`）—— 短（≤2 分钟）说明很快能再试；
 *      长、或对面干脆不说，才像日额度。
 *   ③ 响应头 Retry-After（OpenAI 兼容 / Anthropic 走这个；Anthropic 还有
 *      anthropic-ratelimit-requests-reset，是个 ISO 时间戳）。
 *   ④ 什么线索都没有 → 当「限流」处理。宁可让站长等十几秒再点一次，
 *      也别让他去改 .env.local（那才是真的白折腾）。
 */
export type ProviderErrorKind = 'rate' | 'quota' | 'auth' | 'notfound' | 'badrequest' | 'server' | 'unknown'

export type ParsedProviderError = {
  kind: ProviderErrorKind
  /** 建议等待毫秒数；0 = 对面没说（那就别瞎猜） */
  retryAfterMs: number
  /** quotaId / error.code，日志用（前端不显示） */
  code: string
  /** 抠出来的模型原话（英文，可能很长）—— 只进日志 */
  detail: string
}

/** `"23s"` / `"1.5s"` / `"120"` / ISO 时间戳 → 毫秒（认不出来给 0） */
export const parseRetryDelay = (v: unknown): number => {
  if (v == null) return 0
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.round(v * 1000))
  const s = String(v).trim()
  if (!s) return 0
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i)
  if (!m) {
    // Retry-After 的另一种写法是 HTTP 日期；Anthropic 的重置时间也走这条路
    const at = Date.parse(s)
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0
  }
  const n = Number(m[1])
  const unit = (m[2] || 's').toLowerCase()
  const factor = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000
  return Math.max(0, Math.round(n * factor))
}

/** 超过这个等待时间就别再装作「缓一下就好」了 —— 日额度用尽是几小时起步 */
const RETRY_SOON_MS = 2 * 60 * 1000

export const parseProviderError = (status: number, raw: string, headers?: Headers): ParsedProviderError => {
  const detail = extractProviderMessage(raw)
  let quotaId = ''
  let bodyRetryMs = 0
  try {
    const j: any = JSON.parse(String(raw || '').trim())
    const details = j?.error?.details
    if (Array.isArray(details)) {
      for (const d of details) {
        const t = String(d?.['@type'] || '')
        if (t.includes('QuotaFailure')) {
          const v = Array.isArray(d?.violations) ? d.violations[0] : null
          quotaId = String(v?.quotaId || v?.quotaMetric || quotaId)
        }
        if (t.includes('RetryInfo') && d?.retryDelay) {
          bodyRetryMs = Math.max(bodyRetryMs, parseRetryDelay(d.retryDelay))
        }
      }
    }
    // OpenAI 兼容偶尔把重试时间塞进 body，而不是响应头
    if (!bodyRetryMs && j?.error?.retry_after != null) bodyRetryMs = parseRetryDelay(j.error.retry_after)
  } catch {
    /* 不是 JSON（网关 HTML 错误页之类）—— 只靠状态码和响应头 */
  }

  const retryAfterMs = Math.max(
    bodyRetryMs,
    parseRetryDelay(headers?.get('retry-after')),
    parseRetryDelay(headers?.get('anthropic-ratelimit-requests-reset'))
  )

  if (status === 429) {
    // quotaId 是 Google 自己写的「哪一个额度池」，比任何文本猜测都可信
    const perDay = /perday|per_day|per-day|daily/i.test(quotaId) || /per\s*day|daily/i.test(detail)
    const kind: ProviderErrorKind = perDay ? 'quota' : retryAfterMs > RETRY_SOON_MS ? 'quota' : 'rate'
    return { kind, retryAfterMs, code: quotaId, detail }
  }
  if (status === 401 || status === 403) return { kind: 'auth', retryAfterMs, code: '', detail }
  if (status === 404) return { kind: 'notfound', retryAfterMs, code: '', detail }
  if (status === 400 || status === 422) return { kind: 'badrequest', retryAfterMs, code: '', detail }
  if (status >= 500) return { kind: 'server', retryAfterMs, code: '', detail }
  return { kind: 'unknown', retryAfterMs, code: '', detail }
}

/**
 * 模型服务「回了错」时，把 HTTP 状态翻译成站长看得懂、照着能做的一句话。
 *
 * 长度纪律：提示框只有一行宽，429 那句以前写了 150 个字讲「①②③ 去哪儿改配置」，
 * 结果整块红字糊住编辑区（2026-10-10 站长截图）。现在一句话讲完「是什么 + 怎么办」，
 * 详细的配置步骤留给终端日志和 docs/ai-network-troubleshooting.md。
 */
export const describeProviderError = (
  label: string,
  status: number,
  raw: string,
  opts?: { headers?: Headers; model?: string }
) => {
  const parsed = parseProviderError(status, raw, opts?.headers)
  const { detail } = parsed
  const who = `${label}${opts?.model ? ` ${opts.model}` : ''}`
  /** 「约 20 秒后恢复」/「」——对面没说就不编数字 */
  const wait = parsed.retryAfterMs > 0 ? `约 ${Math.max(1, Math.round(parsed.retryAfterMs / 1000))} 秒后恢复` : ''

  switch (parsed.kind) {
    case 'rate':
      return `${who} 被限流了：${wait ? `${wait}，` : '缓十几秒'}再点一次就行`
    case 'quota':
      // 额度用尽时「等多久」基本等于「等明天」，写在提示里只会让人误判 —— 直接给唯一的出路：换模型
      return `${who} 免费额度用完了：换个模型立刻能写（AI_*_MODEL / AI_MODEL_FALLBACK）`
    case 'auth':
      return `${who} 报 ${status}：API Key 被拒绝了（没权限或填错了），检查 .env.local 里的 Key`
    case 'notfound':
      return `${who} 报 404：这个模型名不存在，或者这把 Key 用不了它`
    case 'badrequest':
      return `${who} 报 ${status}：请求被模型拒绝了${detail ? `（${detail.slice(0, 100)}）` : ''}`
    case 'server':
      return `${who} 报 ${status}：模型服务暂时不稳定，等几秒重试一次`
    default:
      return `${who} 报 ${status}${detail ? `：${detail.slice(0, 120)}` : '：无返回内容'}`
  }
}

/**
 * 失败的「一行日志」—— 英文原文、quotaId 这些东西前端放不下，但排查时全靠它们。
 * 所有协议层（Gemini / OpenAI 兼容 / Anthropic）失败时都调这个，格式保持一致。
 */
export const logProviderError = (
  label: string,
  model: string,
  status: number,
  parsed: ParsedProviderError
) => {
  const bits = [
    `status=${status}`,
    `kind=${parsed.kind}`,
    parsed.retryAfterMs ? `retryAfter=${Math.round(parsed.retryAfterMs / 1000)}s` : '',
    parsed.code ? `quotaId=${parsed.code}` : '',
  ].filter(Boolean)
  console.log(`[ai-provider] ${label}/${model} 失败 ${bits.join(' ')} ｜ ${parsed.detail.slice(0, 220)}`)
}

/**
 * 后台接口统一鉴权 —— 必须是有效的 Supabase 登录态。
 * 失败时返回现成的 Response，调用处直接 `return result.response` 即可。
 *
 * 「不认这张票」其实是三件不同的事，必须分开说。以前一律回 401 unauthorized 的后果：
 * 前端拿着这句话什么也做不了（刷新页面重发的还是同一张票，永远失败），站长也判断不出
 * 到底该重新登录、还是该重试一次。
 *   · 登录过期        → 401，前端可以换一张新票重发
 *   · 票无效 / 是假的  → 401，只能重新登录
 *   · 连不上 Supabase → 503，网络抖一下而已，重试就能好，不该当成「没权限」
 */
export async function requireAdmin(
  req: NextRequest
): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !anonKey) {
    return { ok: false, response: jsonResponse({ error: 'missing supabase env' }, 500) }
  }
  const token = getBearer(req)
  if (!token) {
    console.log('[requireAdmin] 401：请求里没有 Authorization 头')
    return {
      ok: false,
      response: jsonResponse({ error: '未登录：请求里没有 Authorization 头，请刷新页面重新登录' }, 401),
    }
  }

  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  // 连不上 Supabase 属于「暂时性失败」，重试一次再判死 —— 网络抖一下就把站长的稿子卡住太亏
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await authClient.auth.getUser(token)
    if (!error && data?.user) return { ok: true, userId: data.user.id }

    // AuthRetryableFetchError（status 0）= 压根没跟 Supabase 说上话，不是票有问题
    const isNetwork = error?.name === 'AuthRetryableFetchError' || error?.status === 0
    if (isNetwork && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      continue
    }
    if (isNetwork) {
      console.log('[requireAdmin] 503：连不上 Supabase Auth ——', error?.message)
      return {
        ok: false,
        response: jsonResponse({ error: '登录校验暂时失败（连不上 Supabase Auth），请重试一次' }, 503),
      }
    }

    if (/expired/i.test(String(error?.message || ''))) {
      console.log('[requireAdmin] 401：登录已过期 ——', error?.message)
      return { ok: false, response: jsonResponse({ error: '登录已过期，请刷新页面重新登录' }, 401) }
    }
    console.log('[requireAdmin] 401：token 无效 ——', error?.message || '(无 message)')
    return { ok: false, response: jsonResponse({ error: 'unauthorized' }, 401) }
  }

  return { ok: false, response: jsonResponse({ error: 'unauthorized' }, 401) }
}

export const parseJsonLoose = (content: string) => {
  const trimmed = String(content || '').trim()
  const stripped = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/g, '')
    .trim()
  try {
    return JSON.parse(stripped)
  } catch {
    const m = stripped.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('invalid json')
    return JSON.parse(m[0])
  }
}

export const safeParseModelJson = (text: string) => {
  try {
    return { ok: true as const, value: parseJsonLoose(text) }
  } catch (e: any) {
    return { ok: false as const, error: e }
  }
}

/** 去掉 ``` 包裹（模型偶尔还是会自己加上）—— 实现在 storyPrompt 里，这里只做转发，避免两份逻辑 */
export { stripFences } from './storyPrompt'

/** HTML 正文 → 纯文本 —— 实现在 storyPrompt 里（那里保持零依赖，客户端组件也能用） */
export { htmlToPlainText } from './storyPrompt'
