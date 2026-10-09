import type { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'

/**
 * Gemini + 后台鉴权的共用小工具。
 *
 * 为什么单独抽一个文件：
 *   app/api/news/rewrite/route.ts 与 app/api/ai/draw/route.ts 里各写了一份几乎
 *   一样的「Bearer 校验 + 超时 fetch + JSON 兜底」。这次新增的 AI 创作接口要是
 *   再抄第三份，以后想调超时时间就得改三个地方。
 *   → 新接口一律从这里 import；那两个老路由保持原样不动（线上已跑通，没必要碰）。
 */

export const GEMINI_ENDPOINT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`

type GeminiApiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> }
    finishReason?: string
  }>
  promptFeedback?: { blockReason?: string }
}

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

export function getGeminiConfig() {
  return {
    key: process.env.GEMINI_API_KEY || '',
    // 与 news/rewrite 用同一个模型，可用 GEMINI_MODEL 覆盖
    model: process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
  }
}

export type GeminiTextResult =
  | { ok: true; text: string; truncated: boolean; finishReason: string }
  | { ok: false; status: number; error: string }

/**
 * 调一次 Gemini，返回模型原文（不解析）。
 *
 * jsonMode = true 时带上 responseMimeType: application/json，能挡掉绝大多数
 * 「模型自己包了一层 markdown 代码块」的脏输出；万一模型不听话，调用处还有修理兜底。
 */
export async function callGeminiText(opts: {
  prompt: string
  temperature?: number
  timeoutMs?: number
  maxOutputTokens?: number
  jsonMode?: boolean
}): Promise<GeminiTextResult> {
  const { key, model } = getGeminiConfig()
  if (!key) return { ok: false, status: 500, error: 'Missing env: GEMINI_API_KEY' }

  const generationConfig: Record<string, unknown> = {
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.7,
  }
  if (opts.maxOutputTokens) generationConfig.maxOutputTokens = opts.maxOutputTokens
  if (opts.jsonMode) generationConfig.responseMimeType = 'application/json'

  const timeoutMs = opts.timeoutMs ?? 20000

  let resp: Response
  try {
    resp = await fetchWithTimeout(
      GEMINI_ENDPOINT(model),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
          generationConfig,
        }),
      },
      timeoutMs
    )
  } catch (e: any) {
    if (isAbortError(e)) {
      return {
        ok: false,
        status: 504,
        error: `AI 超时（超过 ${Math.round(timeoutMs / 1000)} 秒没回应），请重试一次，或把篇幅调短`,
      }
    }
    return {
      ok: false,
      status: 502,
      error: isNetworkFetchError(e) ? describeNetworkError(e) : e?.message || 'AI 请求失败',
    }
  }

  if (!resp.ok) {
    const raw = await resp.text().catch(() => '')
    return { ok: false, status: 502, error: `Gemini ${resp.status}: ${raw.slice(0, 300) || '无返回内容'}` }
  }

  const data = (await resp.json().catch(() => ({}))) as GeminiApiResponse
  const cand = data?.candidates?.[0]
  const text = cand?.content?.parts?.map((p) => p?.text || '').join('') || ''
  const finishReason = String(cand?.finishReason || '')

  if (!text.trim()) {
    const blocked = data?.promptFeedback?.blockReason
    return {
      ok: false,
      status: 502,
      error: blocked
        ? `内容被模型安全策略拦下了（${blocked}），换个题材或构思再试`
        : `模型返回了空内容${finishReason ? `（${finishReason}）` : ''}`,
    }
  }

  return { ok: true, text, truncated: finishReason === 'MAX_TOKENS', finishReason }
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
