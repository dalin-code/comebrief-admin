/**
 * 多供应商文本生成统一入口（P1）。
 *
 * 为什么要有这一层：
 *   以前所有 AI 调用都写死「Gemini 直连 + GEMINI_MODEL 一个模型」。
 *   想换模型只能改代码；想换供应商（Claude / DeepSeek / GLM / Kimi）根本没法接。
 *   这里把「调哪个模型」变成**环境变量**，代码只认任务名（story / revise / translate / util）。
 *
 * 支持的三种协议：
 *   1. gemini            —— Google 原生 generateContent（支持 systemInstruction）
 *   2. openai-compat     —— /chat/completions（OpenAI、DeepSeek、智谱、Moonshot、OpenRouter 全兼容）
 *   3. anthropic         —— /messages（Claude，system 块带 cache_control 做提示缓存）
 *
 * 模型写法（环境变量里填这个）：
 *   gemini-3.8-flash                              ← 不写前缀，按名字推断（gemini-* 走 Gemini）
 *   gemini:gemini-3.8-flash                       ← 显式指定供应商
 *   openrouter:anthropic/claude-sonnet-5.5        ← 带斜杠的一律走 OpenRouter
 *   deepseek:deepseek-chat
 *   zhipu:glm-4.6
 *   anthropic:claude-sonnet-5.5
 *
 * 按任务分配模型（都不设就回落到 GEMINI_MODEL）：
 *   AI_STORY_MODEL      写正文（最该用贵模型的地方）
 *   AI_REVISE_MODEL     自评 / 重写
 *   AI_TRANSLATE_MODEL  中译英
 *   AI_UTIL_MODEL       摘要、标签这类杂活（便宜模型即可）
 *
 * 提示缓存（Prompt Caching）：
 *   - Anthropic / OpenRouter(Claude)：system 块自动打 cache_control。写作宪法几乎不变，
 *     第二遍之后输入成本能降一大截。
 *   - Gemini：前缀相同即隐式命中，无需额外参数。
 *   - OpenAI：前缀 ≥1024 token 自动命中。
 */
import { describeNetworkError, fetchWithTimeout, isAbortError, isNetworkFetchError, safeParseModelJson } from './aiGemini'

export type AiProviderName = 'gemini' | 'openrouter' | 'anthropic' | 'openai' | 'deepseek' | 'zhipu' | 'moonshot'

type Protocol = 'gemini' | 'openai' | 'anthropic'

const PROVIDERS: Record<AiProviderName, { baseUrl: string; keyEnv: string; protocol: Protocol; label: string }> = {
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', keyEnv: 'GEMINI_API_KEY', protocol: 'gemini', label: 'Gemini 直连' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', protocol: 'openai', label: 'OpenRouter' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_API_KEY', protocol: 'anthropic', label: 'Anthropic' },
  openai: { baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', protocol: 'openai', label: 'OpenAI' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY', protocol: 'openai', label: 'DeepSeek' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyEnv: 'ZHIPU_API_KEY', protocol: 'openai', label: '智谱 GLM' },
  moonshot: { baseUrl: 'https://api.moonshot.cn/v1', keyEnv: 'MOONSHOT_API_KEY', protocol: 'openai', label: 'Moonshot Kimi' },
}

export type AiTask = 'story' | 'revise' | 'translate' | 'util'

const TASK_ENV: Record<AiTask, string> = {
  story: 'AI_STORY_MODEL',
  revise: 'AI_REVISE_MODEL',
  translate: 'AI_TRANSLATE_MODEL',
  util: 'AI_UTIL_MODEL',
}

/** 没配任何环境变量时的默认模型 —— 比原来的 gemini-3-flash-preview 新一代 */
export const DEFAULT_AI_MODEL = 'gemini-3.8-flash'

export type ResolvedTarget = {
  provider: AiProviderName
  protocol: Protocol
  model: string
  key: string
  baseUrl: string
  label: string
  /** 环境变量里的原始写法，报错时给用户看 */
  spec: string
}

/** 从环境变量里找这个任务的模型写法 */
export function resolveModelSpec(task: AiTask): string {
  return (
    process.env[TASK_ENV[task]] ||
    process.env.AI_MODEL ||
    process.env.GEMINI_MODEL ||
    DEFAULT_AI_MODEL
  ).trim()
}

/** 按名字猜供应商 —— 只在没写 `provider:` 前缀时用 */
function inferProvider(model: string): AiProviderName {
  const m = model.toLowerCase()
  if (m.startsWith('gemini')) return 'gemini'
  if (m.includes('/')) return 'openrouter' // 带斜杠的基本都是 OpenRouter 的 slug
  if (m.startsWith('claude')) return 'anthropic'
  if (m.startsWith('deepseek')) return 'deepseek'
  if (m.startsWith('glm')) return 'zhipu'
  if (m.startsWith('kimi') || m.startsWith('moonshot')) return 'moonshot'
  return 'openai'
}

/** 把 `provider:model` 解析成可调用的目标 */
export function resolveTarget(spec: string): { ok: true; target: ResolvedTarget } | { ok: false; error: string } {
  const raw = String(spec || '').trim()
  if (!raw) return { ok: false, error: '没有配置模型（AI_STORY_MODEL / AI_MODEL / GEMINI_MODEL 都是空的）' }

  let provider: AiProviderName
  let model = raw
  const idx = raw.indexOf(':')
  if (idx > 0) {
    const prefix = raw.slice(0, idx).toLowerCase() as AiProviderName
    if (PROVIDERS[prefix]) {
      provider = prefix
      model = raw.slice(idx + 1).trim()
    } else {
      provider = inferProvider(raw)
    }
  } else {
    provider = inferProvider(raw)
  }

  const conf = PROVIDERS[provider]
  const key = process.env[conf.keyEnv] || ''
  if (!key) {
    return { ok: false, error: `要调用 ${conf.label}（${model}）需要环境变量 ${conf.keyEnv}，但它是空的` }
  }
  return {
    ok: true,
    target: { provider, protocol: conf.protocol, model, key, baseUrl: conf.baseUrl, label: conf.label, spec: raw },
  }
}

/* ---------------- 统一入参 / 出参 ---------------- */

export type CallTextOptions = {
  prompt: string
  /** 稳定的「我是谁、我怎么写」放这里（会被缓存）；每次变化的内容放 prompt */
  system?: string
  task?: AiTask
  /** 显式指定模型写法，覆盖环境变量（P0 盲测、P5 对照台用） */
  model?: string
  temperature?: number
  maxOutputTokens?: number
  jsonMode?: boolean
  timeoutMs?: number
  /** 429/503 这类临时故障的重试次数，默认 1；写长篇建议设 0，别把时长预算耗在重试上 */
  retries?: number
  /**
   * 主模型不可用时的兜底模型写法。
   * 不传 → 用环境变量 AI_MODEL_FALLBACK；传 null → 明确禁用兜底（盲测时必须这样，否则样本会串味）
   */
  fallbackModel?: string | null
  /**
   * Gemini 3.x 的「思考预算」（token）。不传则用 Google 的默认值。
   * ⚠️ 写正文时必须显式设 0：思考会占用 maxOutputTokens，实测会出现
   *    「正文只写出两百字就被截断」的怪现象（thinking 吃掉了额度）。
   */
  thinkingBudget?: number
}

export type CallTextResult =
  | { ok: true; text: string; model: string; provider: AiProviderName; ms: number; truncated: boolean; attempts: number }
  | { ok: false; status: number; error: string; model: string; provider: AiProviderName | null }

type RawResult =
  | { ok: true; text: string; truncated: boolean }
  | {
      ok: false
      status: number
      error: string
      retryable: boolean
      /** 网络层断线（压根没跟对面说上话），不是对方回的错 */
      network?: boolean
    }

const RETRYABLE_STATUS = (s: number) => s === 429 || s === 500 || s === 502 || s === 503 || s === 504
const RETRY_WAITS_MS = [1200, 3500]

/** 网络抖动重试前的等待：抖一下就断的失败，没必要等一两秒 */
const NETWORK_RETRY_WAIT_MS = 500
/** 只有「失败来得这么快」才算网络抖动 —— 慢失败说明对面真的在忙，再等一遍只是白等 */
const NETWORK_RETRY_FAST_MS = 12_000
/** 重试也得给模型留出够写出一篇稿子的时间 */
const NETWORK_RETRY_MIN_TIMEOUT_MS = 15_000

/* ---------------- 协议一：Gemini 原生 ---------------- */

async function callGeminiProtocol(target: ResolvedTarget, o: CallTextOptions): Promise<RawResult> {
  const url = `${target.baseUrl}/models/${encodeURIComponent(target.model)}:generateContent`
  const generationConfig: Record<string, unknown> = { temperature: o.temperature ?? 0.7 }
  if (o.maxOutputTokens) generationConfig.maxOutputTokens = o.maxOutputTokens
  if (o.jsonMode) generationConfig.responseMimeType = 'application/json'
  // 写正文时必须关掉思考，否则思考 token 会和正文抢 maxOutputTokens
  if (typeof o.thinkingBudget === 'number') generationConfig.thinkingConfig = { thinkingBudget: o.thinkingBudget }

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: o.prompt }] }],
    generationConfig,
  }
  // systemInstruction 是 Gemini 的「系统提示」——以前这里从没用过，写作规则只能混在 user 里
  if (o.system?.trim()) body.systemInstruction = { parts: [{ text: o.system }] }

  const resp = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': target.key },
      body: JSON.stringify(body),
    } as RequestInit,
    o.timeoutMs ?? 55000
  )

  if (!resp.ok) {
    const raw = await resp.text().catch(() => '')
    return { ok: false, status: resp.status, error: `Gemini ${resp.status}: ${raw.slice(0, 300) || '无返回内容'}`, retryable: RETRYABLE_STATUS(resp.status) }
  }

  const data: any = await resp.json().catch(() => ({}))
  const cand = data?.candidates?.[0]
  // Gemini 3 的思考过程会以 thought:true 的 part 出现 —— 绝不能混进正文
  const text = (cand?.content?.parts || [])
    .filter((p: any) => p && !p.thought)
    .map((p: any) => p.text || '')
    .join('')

  if (!String(text).trim()) {
    const blocked = data?.promptFeedback?.blockReason
    return {
      ok: false,
      status: 502,
      error: blocked ? `内容被模型安全策略拦下了（${blocked}），换个题材或构思再试` : `模型返回了空内容${cand?.finishReason ? `（${cand.finishReason}）` : ''}`,
      retryable: false,
    }
  }
  return { ok: true, text, truncated: cand?.finishReason === 'MAX_TOKENS' }
}

/* ---------------- 协议二：OpenAI 兼容 ---------------- */

async function callOpenAiProtocol(target: ResolvedTarget, o: CallTextOptions): Promise<RawResult> {
  const messages: Array<{ role: string; content: string }> = []
  if (o.system?.trim()) messages.push({ role: 'system', content: o.system })
  messages.push({ role: 'user', content: o.prompt })

  const body: Record<string, unknown> = {
    model: target.model,
    messages,
    temperature: o.temperature ?? 0.7,
  }
  if (o.maxOutputTokens) {
    // OpenAI 自家新模型不认 max_tokens，其它兼容家认 max_tokens
    if (target.provider === 'openai') body.max_completion_tokens = o.maxOutputTokens
    else body.max_tokens = o.maxOutputTokens
  }
  if (o.jsonMode) body.response_format = { type: 'json_object' }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${target.key}`,
  }
  if (target.provider === 'openrouter') {
    headers['HTTP-Referer'] = process.env.NEXT_PUBLIC_SITE_URL || 'https://comebrief.local'
    headers['X-Title'] = process.env.OPENROUTER_APP_NAME || 'ComeBrief Admin'
  }

  const resp = await fetchWithTimeout(
    `${target.baseUrl}/chat/completions`,
    { method: 'POST', headers, body: JSON.stringify(body) } as RequestInit,
    o.timeoutMs ?? 55000
  )

  if (!resp.ok) {
    const raw = await resp.text().catch(() => '')
    return {
      ok: false,
      status: resp.status,
      error: `${target.label} ${resp.status}: ${raw.slice(0, 300) || '无返回内容'}`,
      retryable: RETRYABLE_STATUS(resp.status),
    }
  }

  const data: any = await resp.json().catch(() => ({}))
  const choice = data?.choices?.[0]
  const text = choice?.message?.content ?? ''
  if (!String(text).trim()) {
    return { ok: false, status: 502, error: `模型返回了空内容（finish_reason=${choice?.finish_reason || '未知'}）`, retryable: false }
  }
  return { ok: true, text: String(text), truncated: choice?.finish_reason === 'length' }
}

/* ---------------- 协议三：Anthropic（Claude 原生） ---------------- */

async function callAnthropicProtocol(target: ResolvedTarget, o: CallTextOptions): Promise<RawResult> {
  const system = o.system?.trim()
  const body: Record<string, unknown> = {
    model: target.model,
    max_tokens: o.maxOutputTokens || 8192,
    // Anthropic 的温度上限是 1，别把 0.95 之外的实验值直接传进去
    temperature: Math.min(1, o.temperature ?? 0.7),
    messages: [{ role: 'user', content: o.prompt }],
  }
  if (system) {
    // cache_control：写作宪法基本不变，打在 system 末尾能让后续请求命中提示缓存
    body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
  }

  const resp = await fetchWithTimeout(
    `${target.baseUrl}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': target.key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    } as RequestInit,
    o.timeoutMs ?? 55000
  )

  if (!resp.ok) {
    const raw = await resp.text().catch(() => '')
    return {
      ok: false,
      status: resp.status,
      error: `${target.label} ${resp.status}: ${raw.slice(0, 300) || '无返回内容'}`,
      retryable: RETRYABLE_STATUS(resp.status),
    }
  }

  const data: any = await resp.json().catch(() => ({}))
  const text = (data?.content || [])
    .filter((c: any) => c?.type === 'text')
    .map((c: any) => c.text || '')
    .join('')
  if (!String(text).trim()) {
    return { ok: false, status: 502, error: `模型返回了空内容（stop_reason=${data?.stop_reason || '未知'}）`, retryable: false }
  }
  return { ok: true, text, truncated: data?.stop_reason === 'max_tokens' }
}

/* ---------------- 对外主函数 ---------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function callOnce(target: ResolvedTarget, o: CallTextOptions): Promise<RawResult> {
  const retries = typeof o.retries === 'number' ? o.retries : 1
  const baseTimeoutMs = o.timeoutMs ?? 55000
  let opts = o
  let last: RawResult = { ok: false, status: 500, error: '未知错误', retryable: false }
  // 调用方给的 retries 是业务上的判断（写正文明确传 0：怕重试把 60 秒预算吃光）。
  // 但「网络层没跟对面说上话就断了」跟「模型写得慢」完全是两回事 —— 前者几秒就抛，
  // 不重试的话站长点一下「生成」，撞上五秒的 TLS 抖动就只能收获一句 fetch failed。
  // 所以这里自带一次快速重试，而且不占用调用方的 retry 配额。
  let networkRetryLeft = 1
  // 快速重试靠 `attempt -= 1` 实现（不占调用方配额），所以日志不能用 attempt 当次数
  let requestNo = 0

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_WAITS_MS[Math.min(attempt - 1, RETRY_WAITS_MS.length - 1)])
    requestNo += 1
    const startedAt = Date.now()
    try {
      const r =
        target.protocol === 'gemini'
          ? await callGeminiProtocol(target, opts)
          : target.protocol === 'anthropic'
            ? await callAnthropicProtocol(target, opts)
            : await callOpenAiProtocol(target, opts)
      if (r.ok === true) return r
      last = r
      if (r.retryable === false) return r
    } catch (e: any) {
      const elapsed = Date.now() - startedAt
      if (isAbortError(e)) {
        return {
          ok: false,
          status: 504,
          error: `AI 超时（超过 ${Math.round(baseTimeoutMs / 1000)} 秒没回应），请重试一次，或把篇幅调短`,
          retryable: false,
        }
      }
      const network = isNetworkFetchError(e)
      last = {
        ok: false,
        status: 502,
        // undici 原始报错只有一句 fetch failed，原因（ECONNRESET 之类）藏在 cause 里 —— 得挖出来
        error: network ? describeNetworkError(e) : e?.message || 'AI 请求失败',
        retryable: true,
        network,
      }
      // 终端日志给全量信息（含英文原文），前端提示只给人话
      const cause = e?.cause ? ` ｜ cause=${e.cause.code || ''}: ${e.cause.message || ''}` : ''
      console.log(
        `[ai-provider] ${target.label}/${target.model} 第 ${requestNo} 次请求异常（${elapsed}ms）：${last.error}${cause}`
      )
      if (network && networkRetryLeft > 0 && elapsed < NETWORK_RETRY_FAST_MS) {
        networkRetryLeft -= 1
        await sleep(NETWORK_RETRY_WAIT_MS)
        // 重试只花「省下来的那点时间」：快失败 + 完整 55 秒超时会顶爆 maxDuration=60
        opts = {
          ...o,
          timeoutMs: Math.max(NETWORK_RETRY_MIN_TIMEOUT_MS, baseTimeoutMs - elapsed - NETWORK_RETRY_WAIT_MS),
        }
        attempt -= 1 // 这一次不算调用方的 retry
      }
    }
  }
  return last
}

/**
 * 调用一次文本生成 —— 全站 AI 功能统一走这里。
 *
 * 主模型失败（503/429/404 之类）且配了 AI_MODEL_FALLBACK 时，自动用兜底模型再试一次，
 * 免得 Google 那边一抖动站长就写不了稿。
 */
export async function callText(o: CallTextOptions): Promise<CallTextResult> {
  const spec = (o.model || resolveModelSpec(o.task || 'util')).trim()
  const resolved = resolveTarget(spec)
  if (resolved.ok === false) return { ok: false, status: 500, error: resolved.error, model: spec, provider: null }

  const { target } = resolved
  const startedAt = Date.now()
  const first = await callOnce(target, o)

  if (first.ok === true) {
    return {
      ok: true,
      text: first.text,
      model: target.model,
      provider: target.provider,
      ms: Date.now() - startedAt,
      truncated: first.truncated,
      attempts: 1,
    }
  }

  const fallbackSpec = (o.fallbackModel === null ? '' : o.fallbackModel || process.env.AI_MODEL_FALLBACK || '').trim()
  if (fallbackSpec && fallbackSpec !== spec) {
    const fb = resolveTarget(fallbackSpec)
    if (fb.ok === true) {
      console.log(
        `[ai-provider] ${target.label}/${target.model} 失败（${first.error.slice(0, 80)}），改用兜底 ${fb.target.model}`
      )
      // 兜底是「保命」用的，给它一个更短的超时，别把整条请求的时间预算吃光
      const second = await callOnce(fb.target, { ...o, timeoutMs: Math.min(o.timeoutMs ?? 55000, 20000), retries: 0 })
      if (second.ok === true) {
        return {
          ok: true,
          text: second.text,
          model: fb.target.model,
          provider: fb.target.provider,
          ms: Date.now() - startedAt,
          truncated: second.truncated,
          attempts: 2,
        }
      }
      return {
        ok: false,
        status: second.status,
        error: `主模型 ${target.model} 失败：${first.error} ｜ 兜底模型 ${fb.target.model} 也失败：${second.error}`,
        model: fb.target.model,
        provider: fb.target.provider,
      }
    }
  }

  return { ok: false, status: first.status, error: first.error, model: target.model, provider: target.provider }
}

/** 要求模型返回 JSON 的调用（P3 的「AI 审稿」用这个） */
export async function callTextJson<T = any>(
  o: CallTextOptions
): Promise<{ ok: true; value: T; model: string } | { ok: false; status: number; error: string }> {
  const r = await callText({ ...o, jsonMode: true })
  if (r.ok === false) return { ok: false, status: r.status, error: r.error }
  const parsed = safeParseModelJson(r.text)
  if (parsed.ok === false) return { ok: false, status: 502, error: `模型返回的不是合法 JSON：${r.text.slice(0, 120)}` }
  return { ok: true, value: parsed.value as T, model: r.model }
}

/** 当前每个任务会用哪个模型 —— 给你自己在后台核对配置用 */
export function describeAiRouting() {
  const tasks: AiTask[] = ['story', 'revise', 'translate', 'util']
  return tasks.map((t) => {
    const spec = resolveModelSpec(t)
    const r = resolveTarget(spec)
    if (r.ok === true) return { task: t, spec, ok: true as const, provider: r.target.label, error: '' }
    return { task: t, spec, ok: false as const, provider: '', error: r.error }
  })
}