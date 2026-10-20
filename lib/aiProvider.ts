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
import {
  describeNetworkError,
  describeProviderError,
  fetchWithTimeout,
  isAbortError,
  isNetworkFetchError,
  logProviderError,
  parseProviderError,
  safeParseModelJson,
  type ProviderErrorKind,
} from './aiGemini'

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

/* ---------------- 候选模型链 + 冷却表 ---------------- */

/**
 * 把「一串模型写法」拆成候选列表。
 *
 * `AI_MODEL_FALLBACK` 以前只认一个值 —— 于是 Google 那把 Key 下的两个额度池一起干了之后，
 * 站长就真的没路可走了（2026-10-10 那屏红字）。现在它接受逗号 / 换行 / 分号分隔的一串：
 *
 *   AI_MODEL_FALLBACK=gemini-3.5-flash, deepseek:deepseek-chat
 *
 * 单值写法照旧能用（向后兼容）。顺带把重复项去掉 —— 同一个模型写两遍不叫兜底。
 * 跨供应商才是真正的「不同额度池」：`provider:model` 的写法见文件头注释。
 */
export function parseModelChain(raw: string | null | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const piece of String(raw || '').split(/[,\n;]/)) {
    const spec = piece.trim()
    if (!spec || seen.has(spec)) continue
    seen.add(spec)
    out.push(spec)
  }
  return out
}

/**
 * 「这个模型刚挂了，先别问它」的记忆。
 *
 * 为什么要记：每次点击都从头再问一遍已经挂掉的模型，代价是实打实的 ——
 * 429 本身还在继续吃 RPM 计数（等于自己给自己加限流），站长还要多等两个网络来回。
 *
 * ⚠️ 作用域：**单进程内存**。`npm run dev` 只有一个进程，效果最好；
 *    线上 Serverless 每个实例各记各的，属于「尽力而为」，不是分布式锁。
 */
const COOLDOWNS = new Map<string, { until: number; reason: ProviderErrorKind }>()

/** 还要冷却多少毫秒（0 = 现在就能用） */
export function cooldownLeftMs(spec: string): number {
  const hit = COOLDOWNS.get(spec)
  if (!hit) return 0
  const left = hit.until - Date.now()
  if (left <= 0) {
    COOLDOWNS.delete(spec)
    return 0
  }
  return left
}

/**
 * 冷却多久：对面给了时间就听它的（封顶 30 分钟），没给就按原因给个保守值。
 *
 * 三类才进冷却：rate / quota / server。
 *   · rate、quota 是「别问了」，重复问还会继续吃 RPM 计数（等于自己给自己加限流）；
 *   · server（5xx / 网络断 / 超时）是「现在问了也白等」—— 这一条是实测补的：
 *     线上 gemini-3.8-flash 连回两次 503/超时，如果不记冷却，用户每次点「生成摘要」
 *     都要先陪它耗 20 秒才轮到兜底模型，体感就是「点了半天没反应」。
 *   · 404 / 400 / 401 这种「配置错了」**不记** —— 否则站长改完 .env.local 还得干等冷却过去。
 */
function markCooldown(spec: string, kind: ProviderErrorKind, retryAfterMs: number) {
  if (kind !== 'rate' && kind !== 'quota' && kind !== 'server') return
  const fallback = kind === 'quota' ? 60_000 : kind === 'server' ? 45_000 : 15_000
  const ms = Math.min(Math.max(retryAfterMs || fallback, 5_000), 30 * 60 * 1000)
  COOLDOWNS.set(spec, { until: Date.now() + ms, reason: kind })
  console.log(`[ai-provider] ${spec} 进入冷却 ${Math.round(ms / 1000)}s（${kind}）`)
}

/** 冷却快照 —— `/api/ai/status` 自检页和 describeAiRouting 用 */
export function snapshotCooldowns(specs: string[] = []) {
  const now = Date.now()
  const wanted = specs.length ? specs : [...COOLDOWNS.keys()]
  return wanted.map((spec) => {
    const hit = COOLDOWNS.get(spec)
    return { spec, leftMs: hit ? Math.max(0, hit.until - now) : 0, reason: hit?.reason || '' }
  })
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
  /**
   * 供应商随机种子。只对明确支持的 Gemini / OpenAI 直连透传；
   * Anthropic / OpenRouter 不传（它们没有这个参数）。
   * 供应商若因 seed 返回 400，callOnce() 会自动去掉 seed 重试一次，不计入业务重试。
   */
  seed?: number
  /**
   * 「所有候选模型都没成，而其中某个只是被限流」时，最多愿意原地等多少毫秒再打一次它。
   *
   * 为什么需要它：同一把 Key 下的模型是各自独立的额度池，看起来「全挂」其实常常只是 RPM
   * 限流（对面会回 `retryDelay: "20s"`）。等 20 秒再打一次，成功率远高于逼站长自己盯着屏幕重试。
   * 0（默认）= 不等，立刻把错误抛出去 —— 写正文这种长任务就该这样，别把 60 秒预算耗在等待上。
   */
  autoWaitMs?: number
  /**
   * 整条候选链的时间上限（含 autoWait 的等待）。默认等于 `timeoutMs`。
   *
   * 为什么要单独一个：候选链有 N 个模型、后面还可能「等一会儿再试一次」，
   * 光靠单个模型的 timeout 拦不住总时长 —— 真跑起来就是 20+20+20+8 越过 maxDuration=60，
   * 前端一直转圈直到超时白屏（比直接报错更让人抓狂）。
   */
  totalBudgetMs?: number
  /**
   * 无视冷却表，硬着头皮也去问这个模型。
   *
   * 只有一个场景需要它：「真调一次」自检。站长刚改完 .env.local 想立刻验证，
   * 结果被自己上一次失败留下的冷却挡回去（回一句「还在冷却」），会以为改了没用。
   */
  ignoreCooldown?: boolean
}

export type CallTextResult =
  | { ok: true; text: string; model: string; provider: AiProviderName; ms: number; truncated: boolean; attempts: number }
  | {
      ok: false
      status: number
      error: string
      model: string
      provider: AiProviderName | null
      /** 结构化原因 —— 前端据此决定「等一会儿自动重试」还是「直接报错」 */
      kind: ProviderErrorKind
      /** 对面建议的等待毫秒数（限流时是「多久后重试」） */
      retryAfterMs: number
      /** true = 换来换去都失败但原因属于「一会儿再说」，值得自动重试一次 */
      retryable: boolean
      /** 这一轮实际试过的模型写法，报错和日志都用它 */
      tried: string[]
    }

type RawResult =
  | { ok: true; text: string; truncated: boolean }
  | {
      ok: false
      status: number
      error: string
      retryable: boolean
      /** 网络层断线（压根没跟对面说上话），不是对方回的错 */
      network?: boolean
      /** rate / quota / auth / notfound / badrequest / server / unknown —— 选下一个模型、进冷却、报错收敛都靠它 */
      kind: ProviderErrorKind
      /** 对面建议的等待毫秒数；0 = 没说 */
      retryAfterMs: number
    }

/**
 * 重试等待序列（对面没说「几秒后再来」时的默认值）。
 *
 * 以前这里还有个 `RETRYABLE_STATUS(s)`：`429/5xx` 就当「可以重试」。
 * 现在不用状态码判断了 —— 重试与否看 `parseProviderError()` 给出的 `kind`
 * （404 / 400 这种重试一万次也一样，而 429 里「日额度用尽」也不该重试）。
 */
const RETRY_WAITS_MS = [1200, 3500]
/** 对面说「N 秒后再来」时最多等多久 —— 再长就顶爆 maxDuration 了，不如快点把错误交出去 */
const RETRY_WAIT_CEIL_MS = 10_000

/** 网络抖动重试前的等待：抖一下就断的失败，没必要等一两秒 */
const NETWORK_RETRY_WAIT_MS = 500
/** 只有「失败来得这么快」才算网络抖动 —— 慢失败说明对面真的在忙，再等一遍只是白等 */
const NETWORK_RETRY_FAST_MS = 12_000
/** 重试也得给模型留出够写出一篇稿子的时间 */
const NETWORK_RETRY_MIN_TIMEOUT_MS = 15_000

/**
 * 三个协议共用的失败收尾：解析结构 → 写日志 → 拼一句人话。
 *
 * 为什么值得抽出来：以前三处各写一份，于是「429 到底是限流还是额度用尽」这个判断
 * 散在三个地方、而且都没真正解析 details —— 现在只有这一份判据。
 */
function failFromResponse(target: ResolvedTarget, resp: Response, raw: string): RawResult {
  const parsed = parseProviderError(resp.status, raw, resp.headers)
  logProviderError(target.label, target.model, resp.status, parsed)
  return {
    ok: false,
    // 真实状态码原样往上带：调用方（和前端）要按 429 / 404 / 5xx 分头处理
    status: resp.status,
    error: describeProviderError(target.label, resp.status, raw, { headers: resp.headers, model: target.model }),
    kind: parsed.kind,
    retryAfterMs: parsed.retryAfterMs,
    // 限流和 5xx 值得重试；404 / 400 是配置写错了，重试一万次也一样
    retryable: parsed.kind === 'rate' || parsed.kind === 'server',
  }
}

/* ---------------- 协议一：Gemini 原生 ---------------- */

async function callGeminiProtocol(target: ResolvedTarget, o: CallTextOptions): Promise<RawResult> {
  const url = `${target.baseUrl}/models/${encodeURIComponent(target.model)}:generateContent`
  const generationConfig: Record<string, unknown> = { temperature: o.temperature ?? 0.7 }
  if (o.maxOutputTokens) generationConfig.maxOutputTokens = o.maxOutputTokens
  if (o.jsonMode) generationConfig.responseMimeType = 'application/json'
  // 同 Seed 复现：Gemini 原生支持 generationConfig.seed
  if (typeof o.seed === 'number') generationConfig.seed = o.seed
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
    return failFromResponse(target, resp, raw)
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
      kind: 'server',
      retryAfterMs: 0,
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
  // OpenRouter / DeepSeek 等兼容层对 seed 的支持不一致：只在 OpenAI 直连时透传
  if (typeof o.seed === 'number' && target.provider === 'openai') body.seed = o.seed

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
    return failFromResponse(target, resp, raw)
  }

  const data: any = await resp.json().catch(() => ({}))
  const choice = data?.choices?.[0]
  const text = choice?.message?.content ?? ''
  if (!String(text).trim()) {
    return { ok: false, status: 502, error: `模型返回了空内容（finish_reason=${choice?.finish_reason || '未知'}）`, retryable: false, kind: 'server', retryAfterMs: 0 }
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
    return failFromResponse(target, resp, raw)
  }

  const data: any = await resp.json().catch(() => ({}))
  const text = (data?.content || [])
    .filter((c: any) => c?.type === 'text')
    .map((c: any) => c.text || '')
    .join('')
  if (!String(text).trim()) {
    return { ok: false, status: 502, error: `模型返回了空内容（stop_reason=${data?.stop_reason || '未知'}）`, retryable: false, kind: 'server', retryAfterMs: 0 }
  }
  return { ok: true, text, truncated: data?.stop_reason === 'max_tokens' }
}

/* ---------------- 对外主函数 ---------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function callOnce(target: ResolvedTarget, o: CallTextOptions): Promise<RawResult> {
  const retries = typeof o.retries === 'number' ? o.retries : 1
  const baseTimeoutMs = o.timeoutMs ?? 55000
  let opts = o
  let last: RawResult = { ok: false, status: 500, error: '未知错误', retryable: false, kind: 'unknown', retryAfterMs: 0 }
  // 调用方给的 retries 是业务上的判断（写正文明确传 0：怕重试把 60 秒预算吃光）。
  // 但「网络层没跟对面说上话就断了」跟「模型写得慢」完全是两回事 —— 前者几秒就抛，
  // 不重试的话站长点一下「生成」，撞上五秒的 TLS 抖动就只能收获一句 fetch failed。
  // 所以这里自带一次快速重试，而且不占用调用方的 retry 配额。
  let networkRetryLeft = 1
  // seed 不被供应商接受时，去掉 seed 再试一次；只做一次，且不占业务重试配额
  let seedDropped = false
  // 快速重试靠 `attempt -= 1` 实现（不占调用方配额），所以日志不能用 attempt 当次数
  let requestNo = 0

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      // 对面说了「N 秒后再来」就听它的：拿 1.2 秒去重试一个 20 秒起步的限流，只是白送一次失败。
      // 但也不能真等 10 分钟 —— 那就越过 maxDuration 了，宁可快点把错误交出去。
      const asked = last.ok === false && last.kind === 'rate' ? last.retryAfterMs : 0
      const wait = asked > 0 ? Math.min(asked, RETRY_WAIT_CEIL_MS) : RETRY_WAITS_MS[Math.min(attempt - 1, RETRY_WAITS_MS.length - 1)]
      await sleep(wait)
    }
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
      // 某些兼容端点会直接把 seed 当非法参数回 400：去掉 seed 保留正文，
      // 不能因为一个可选参数让整篇稿子生不出来。
      if (
        r.status === 400 &&
        typeof opts.seed === 'number' &&
        !seedDropped &&
        (target.provider === 'gemini' || target.provider === 'openai')
      ) {
        seedDropped = true
        opts = { ...opts, seed: undefined }
        console.log(`[ai-provider] ${target.label}/${target.model} 不接受 seed（400），去掉 seed 重试一次`)
        attempt -= 1
        continue
      }
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
          kind: 'server',
          retryAfterMs: 0,
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
        kind: 'server',
        retryAfterMs: 0,
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
 * 失败信息收敛成「一句人话」。
 *
 * 以前是把两次失败直接拼起来（`主模型 X 失败：… ｜ 兜底模型 Y 也失败：…`），
 * 而两个模型同时 429 时这两句几乎一模一样 —— 站长看到的就是一屏红字、信息量为零
 * （2026-10-10 截图）。现在：
 *   · 全是同一类原因 → 只说一句，并列出都试过谁
 *   · 原因各不相同 → 只报最该先处理的那一条（配置错 > 额度 > 限流 > 服务抖动）
 */
const KIND_PRIORITY: Record<ProviderErrorKind, number> = {
  auth: 0, // 配置错了，必须先修，别的都白搭
  quota: 1, // 换模型立刻见效
  notfound: 2,
  badrequest: 3,
  rate: 4, // 等一会儿就好
  server: 5,
  unknown: 6,
}

type Failure = {
  spec: string
  status: number
  error: string
  kind: ProviderErrorKind
  retryAfterMs: number
  /** true = 这条不是「刚问过它失败了」，而是「它还在冷却期，压根没问」（提示语要说清楚） */
  cold?: boolean
}

const secs = (ms: number) => Math.max(1, Math.round(ms / 1000))

function composeFailure(tried: Failure[]) {
  const first = tried[0]
  if (!first) {
    return {
      status: 500,
      error: '没有可用的模型：检查 .env.local 里的 AI_*_MODEL（和对应的 API Key）',
      kind: 'unknown' as ProviderErrorKind,
      retryAfterMs: 0,
      retryable: false,
    }
  }
  const names = tried.map((t) => t.spec).join('、')

  if (tried.length > 1 && tried.every((t) => t.kind === first.kind)) {
    if (first.kind === 'rate') {
      // 「全都还在冷却」和「全都刚被限流」是两件事，话得说准
      if (tried.every((t) => t.cold)) {
        const soonest = Math.min(...tried.map((t) => t.retryAfterMs || 0))
        return {
          status: 429,
          error: `${names} 都刚失败过，还在冷却：最快 ${secs(soonest)} 秒后可以再点`,
          kind: first.kind,
          retryAfterMs: soonest,
          retryable: true,
        }
      }
      const wait = first.retryAfterMs > 0 ? `约 ${secs(first.retryAfterMs)} 秒后恢复` : '缓十几秒'
      return {
        status: 429,
        error: `${names} 都在限流：${wait}再点一次就行`,
        kind: first.kind,
        retryAfterMs: first.retryAfterMs,
        retryable: true,
      }
    }
    if (first.kind === 'quota') {
      return {
        status: 429,
        error: `${names} 的免费额度都用完了：换个模型立刻能写（AI_*_MODEL 或 AI_MODEL_FALLBACK）`,
        kind: first.kind,
        retryAfterMs: first.retryAfterMs,
        retryable: false,
      }
    }
  }

  const worst = [...tried].sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind])[0]
  return {
    status: worst.status,
    // 试了不止一个就把名单缀上 —— 一眼看出「不是没配兜底，是兜底也倒了」
    error: tried.length > 1 ? `${worst.error}（都已试过：${names}）` : worst.error,
    kind: worst.kind,
    retryAfterMs: worst.retryAfterMs,
    retryable: worst.kind === 'rate' || worst.kind === 'server',
  }
}

/** 两个「值得等」的失败里，留等待时间更短的那个（等得越短越划算） */
function topWait(cur: Failure | null, next: Failure): Failure | null {
  if (!cur) return next
  return next.retryAfterMs < cur.retryAfterMs ? next : cur
}

/**
 * 调用一次文本生成 —— 全站 AI 功能统一走这里。
/**
 * 调用一次文本生成 —— 全站 AI 功能统一走这里。
 *
 * 主模型失败时按 `AI_MODEL_FALLBACK`（可以是逗号分隔的**一串**）依次兜底，
 * 失败的模型再进冷却表，短时间内不重复问它。
 *
 * 时间预算纪律：第一个候选吃满调用方给的 `timeoutMs`，后面的每个最多 20 秒；
 * 剩余时间不够一次有意义的尝试时宁可停下 —— 慢失败比失败更糟，站长会一直盯着转圈。
 */
export async function callText(o: CallTextOptions): Promise<CallTextResult> {
  const primarySpec = (o.model || resolveModelSpec(o.task || 'util')).trim()
  const fallbackRaw = o.fallbackModel === null ? '' : o.fallbackModel || process.env.AI_MODEL_FALLBACK || ''
  const fallbackChain = parseModelChain(fallbackRaw)
  // 去重：主模型和兜底写成同一个 = 没配兜底，别自己骗自己
  const chain = [primarySpec, ...fallbackChain].filter((s, i, arr) => Boolean(s) && arr.indexOf(s) === i)
  if (fallbackChain.includes(primarySpec)) {
    console.log(`[ai-provider] AI_MODEL_FALLBACK 里有和主模型相同的项（${primarySpec}），已跳过 —— 换成别的模型才叫兜底`)
  }

  const startedAt = Date.now()
  // 主模型吃满 timeoutMs；后面的候选只能花「总预算里剩下的」
  const budgetMs = o.timeoutMs ?? 55_000
  const totalBudgetMs = Math.max(o.totalBudgetMs ?? budgetMs, 10_000)
  const tried: Failure[] = []
  let provider: AiProviderName | null = null
  let attempts = 0
  let waitAndRetry: Failure | null = null

  for (let i = 0; i < chain.length; i++) {
    const spec = chain[i]
    const resolved = resolveTarget(spec)
    if (resolved.ok === false) {
      console.log(`[ai-provider] 跳过 ${spec}：${resolved.error}`)
      tried.push({ spec, status: 500, error: resolved.error, kind: 'auth', retryAfterMs: 0 })
      continue
    }
    provider = resolved.target.provider

    // 刚挂过的模型先别问 —— 429 本身还在吃限流计数，重复问它等于自己给自己加限流
    const left = o.ignoreCooldown ? 0 : cooldownLeftMs(spec)
    if (left > 0) {
      console.log(`[ai-provider] 跳过 ${spec}：还在冷却（剩 ${secs(left)}s）`)
      const cold: Failure = {
        spec,
        status: 429,
        error: `${spec} 刚失败过，还在冷却（剩 ${secs(left)} 秒）`,
        kind: 'rate',
        retryAfterMs: left,
        cold: true,
      }
      tried.push(cold)
      waitAndRetry = topWait(waitAndRetry, cold)
      continue
    }

    const elapsed = Date.now() - startedAt
    let perAttempt =
      i === 0 ? Math.min(budgetMs, totalBudgetMs) : Math.min(20_000, totalBudgetMs - elapsed - 2_000)
    if (i > 0 && perAttempt < 8_000) {
      console.log(`[ai-provider] 时间预算不够了（已用 ${secs(elapsed)}s / 共 ${secs(totalBudgetMs)}s），放弃后面的候选：${chain.slice(i).join('、')}`)
      break
    }
    perAttempt = Math.max(5_000, perAttempt)

    attempts += 1
    const r = await callOnce(resolved.target, {
      ...o,
      timeoutMs: perAttempt,
      // 除了第一个，其余都是「保命」用的，不给重试
      retries: i === 0 ? o.retries : 0,
    })

    if (r.ok === true) {
      if (i > 0) console.log(`[ai-provider] 兜底成功：${spec}（第 ${attempts} 个候选）`)
      return {
        ok: true,
        text: r.text,
        model: resolved.target.model,
        provider: resolved.target.provider,
        ms: Date.now() - startedAt,
        truncated: r.truncated,
        attempts,
      }
    }

    const fail: Failure = { spec, status: r.status, error: r.error, kind: r.kind, retryAfterMs: r.retryAfterMs }
    tried.push(fail)
    markCooldown(spec, r.kind, r.retryAfterMs)
    if (fail.kind === 'rate' && fail.retryAfterMs > 0) waitAndRetry = topWait(waitAndRetry, fail)
    if (i === 0 && chain.length > 1) {
      console.log(`[ai-provider] ${resolved.target.label}/${resolved.target.model} 失败（${r.kind}），继续试后面的候选`)
    }
  }

  // 全都挂了 —— 但如果里面有一条只是「等一会儿就好」，而调用方愿意等，那就等一次。
  // 这一步才是「同一把 Key 的两个额度池一起被打满」的正解：
  // 换模型没用（池子一样是空的），但时间能解决。
  const autoWaitMs = o.autoWaitMs ?? 0
  if (waitAndRetry && autoWaitMs > 0 && waitAndRetry.retryAfterMs <= autoWaitMs) {
    const waitMs = waitAndRetry.retryAfterMs
    const elapsed = Date.now() - startedAt
    // 等待 + 重试都得从总预算里扣，扣不出一次有意义的尝试就别等了
    const retryTimeout = Math.min(20_000, totalBudgetMs - elapsed - waitMs - 1_000)
    if (retryTimeout < 8_000) {
      console.log(
        `[ai-provider] 想等 ${secs(waitMs)}s 再试 ${waitAndRetry.spec}，但预算不够（已用 ${secs(elapsed)}s / 共 ${secs(totalBudgetMs)}s），直接报错`
      )
    } else {
      console.log(`[ai-provider] 所有候选都没成，等 ${secs(waitMs)}s 再试一次 ${waitAndRetry.spec}`)
      await sleep(waitMs)
      const resolved = resolveTarget(waitAndRetry.spec)
      if (resolved.ok === true) {
        attempts += 1
        const r = await callOnce(resolved.target, { ...o, retries: 0, timeoutMs: retryTimeout })
        if (r.ok === true) {
          return {
            ok: true,
            text: r.text,
            model: resolved.target.model,
            provider: resolved.target.provider,
            ms: Date.now() - startedAt,
            truncated: r.truncated,
            attempts,
          }
        }
        const fail: Failure = {
          spec: waitAndRetry.spec,
          status: r.status,
          error: r.error,
          kind: r.kind,
          retryAfterMs: r.retryAfterMs,
        }
        tried.push(fail)
        markCooldown(fail.spec, fail.kind, fail.retryAfterMs)
      }
    }
  }

  const failure = composeFailure(tried)
  return {
    ok: false,
    status: failure.status,
    error: failure.error,
    model: tried[tried.length - 1]?.spec || primarySpec,
    provider,
    kind: failure.kind,
    retryAfterMs: failure.retryAfterMs,
    retryable: failure.retryable,
    tried: tried.map((t) => t.spec),
  }
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

/**
 * 当前每个任务会用哪个模型 —— 后台「AI 自检」和排查配置用。
 *
 * 顺便把兜底链和冷却状态一起给出来：出问题时站长最先想知道的就是
 * 「我以为配了兜底，到底配上了没有 / 现在有几个池子是干的」。
 */
export function describeAiRouting() {
  const tasks: AiTask[] = ['story', 'revise', 'translate', 'util']
  const fallbackChain = parseModelChain(process.env.AI_MODEL_FALLBACK)
  // 冷却快照（当前记录过的所有模型），下面按 spec 查
  const cooldowns = snapshotCooldowns()
  const rows = tasks.map((t) => {
    const spec = resolveModelSpec(t)
    const r = resolveTarget(spec)
    const hit = cooldowns.find((c) => c.spec === spec)
    if (r.ok === true) {
      return {
        task: t,
        spec,
        ok: true as const,
        provider: r.target.label,
        protocol: r.target.protocol,
        model: r.target.model,
        /** 还在冷却就填「剩 N 秒」，否则空串 */
        cooldown: hit && hit.leftMs > 0 ? `剩 ${Math.ceil(hit.leftMs / 1000)} 秒（${hit.reason}）` : '',
        error: '',
      }
    }
    return {
      task: t,
      spec,
      ok: false as const,
      provider: '',
      protocol: '' as string,
      model: '',
      cooldown: '',
      error: r.error,
    }
  })
  const fallback = fallbackChain.map((spec) => {
    const r = resolveTarget(spec)
    const hit = cooldowns.find((c) => c.spec === spec)
    return {
      spec,
      ok: r.ok === true,
      label: r.ok === true ? r.target.label : '',
      model: r.ok === true ? r.target.model : '',
      cooldown: hit && hit.leftMs > 0 ? `剩 ${Math.ceil(hit.leftMs / 1000)} 秒（${hit.reason}）` : '',
      error: r.ok === true ? '' : r.error,
    }
  })
  return { tasks: rows, fallback }
}