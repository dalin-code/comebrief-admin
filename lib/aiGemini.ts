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
 * 后台接口统一鉴权 —— 必须是有效的 Supabase 登录态。
 * 失败时返回现成的 Response，调用处直接 `return result.response` 即可。
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
  if (!token) return { ok: false, response: jsonResponse({ error: 'unauthorized' }, 401) }

  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const { data, error } = await authClient.auth.getUser(token)
  if (error || !data?.user) return { ok: false, response: jsonResponse({ error: 'unauthorized' }, 401) }
  return { ok: true, userId: data.user.id }
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
    return { ok: false, status: 502, error: e?.message || 'AI 请求失败' }
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
