/**
 * 传统机器翻译（MT）适配器层 —— 翻译任务的「最后一道救命绳」。
 *
 * 为什么单独一个文件：
 *   `lib/aiProvider.ts` 那一层是「LLM 文本生成」—— 能母语化重写，但会 429 / 限流 / 生病。
 *   翻译这条路现在的设计是**分层**的：
 *     ① 首选 LLM 母语化重写（Gemini / OpenRouter Claude / DeepSeek，由 aiProvider 的候选链负责）；
 *     ② 只有整条 LLM 链都倒下时，才降级到这里 —— 用专业翻译 API 出一版「忠实但可能带翻译腔」
 *        的英文。总比给站长一个红框强。
 *   两层的职责、配置、冷却、报错各不相同，混在一个文件里会互相污染，所以拆开。
 *
 * ⚠️ 为什么 MT 只当兜底、不直出（产品红线）：
 *   现有翻译是「母语化重写」，红线是「读者不能感觉这是翻译」。而 DeepL/Google 这类是**忠实型
 *   机翻**，不会重组句子、不会本地化比喻，产出有明显翻译腔。所以它只配当救命绳，
 *   真正上线前应该重译一遍（响应里会带 `degraded: true` 提醒）。
 *
 * 四家都是「一次 HTTP 就回」的同步 API（毫秒级），各自的端点 / 鉴权 / 语言码都不一样，
 * 这里全部收口，对外只暴露一个 `translateWithMt()`。
 *
 * 配置（都在 .env.local，缺 Key 的引擎会被自动跳过，不会报错卡住）：
 *   AI_TRANSLATE_MT_FALLBACK=deepl, libretranslate   ← 按这个顺序降级
 *   DEEPL_API_KEY                                       免费版端点按 Key 后缀自动判（:fx → api-free）
 *   GOOGLE_TRANSLATE_API_KEY                            Cloud Translation v2（API Key 就能用）
 *   AZURE_TRANSLATOR_KEY + AZURE_TRANSLATOR_REGION      Microsoft Translator v3
 *   LIBRETRANSLATE_URL（+ 可选 LIBRETRANSLATE_API_KEY）  自建实例地址
 */

import {
  describeNetworkError,
  describeProviderError,
  extractProviderMessage,
  isNetworkFetchError,
  parseProviderError,
  type ParsedProviderError,
  type ProviderErrorKind,
} from './aiGemini'

export type MtProviderName = 'deepl' | 'google' | 'microsoft' | 'libretranslate'

export type MtTarget = {
  provider: MtProviderName
  key: string
  baseUrl: string
  label: string
  /** 环境变量里的原始写法，报错和日志都用它 */
  spec: string
  /** Microsoft 需要 */
  region?: string
}

type MtProviderConf = {
  keyEnv: string
  label: string
  /** Microsoft 的 Ocp-Apim-Subscription-Region，必填 */
  requiresRegion?: boolean
  /** LibreTranslate 自建实例可以不设 api_key */
  keyOptional?: boolean
}

const MT_PROVIDERS: Record<MtProviderName, MtProviderConf> = {
  deepl: { keyEnv: 'DEEPL_API_KEY', label: 'DeepL' },
  google: { keyEnv: 'GOOGLE_TRANSLATE_API_KEY', label: 'Google 翻译' },
  microsoft: { keyEnv: 'AZURE_TRANSLATOR_KEY', label: 'Microsoft 翻译', requiresRegion: true },
  libretranslate: { keyEnv: 'LIBRETRANSLATE_API_KEY', label: 'LibreTranslate', keyOptional: true },
}

/** 让人少记几个名字：azure 和 microsoft 是一回事，libre 是 libretranslate 的简写 */
const MT_ALIASES: Record<string, MtProviderName> = {
  deepl: 'deepl',
  google: 'google',
  'google-translate': 'google',
  'google_translate': 'google',
  microsoft: 'microsoft',
  azure: 'microsoft',
  'azure-translator': 'microsoft',
  libretranslate: 'libretranslate',
  libre: 'libretranslate',
}

const stripSlash = (s: string) => s.replace(/\/+$/, '')


/**
 * 把环境变量里的一个写法解析成可调用的目标。
 * 跟 aiProvider 的 `resolveTarget()` 一样的契约：**不抛异常**，缺配置就返回一句人话。
 */
export function resolveMtTarget(spec: string): { ok: true; target: MtTarget } | { ok: false; error: string } {
  const raw = String(spec || '').trim()
  if (!raw) return { ok: false, error: '没有配置翻译引擎' }

  const name = MT_ALIASES[raw.toLowerCase()]
  if (!name) {
    return { ok: false, error: `不认识的翻译引擎「${raw}」（可选：deepl / google / microsoft / libretranslate）` }
  }
  const conf = MT_PROVIDERS[name]

  // LibreTranslate：自建地址才是必填项，Key 可有可无
  if (name === 'libretranslate') {
    const url = stripSlash((process.env.LIBRETRANSLATE_URL || '').trim())
    if (!url) return { ok: false, error: '要调用 LibreTranslate 需要环境变量 LIBRETRANSLATE_URL（你自建的地址）' }
    return {
      ok: true,
      target: {
        provider: name,
        key: (process.env.LIBRETRANSLATE_API_KEY || '').trim(),
        baseUrl: url,
        label: conf.label,
        spec: raw,
      },
    }
  }

  const key = (process.env[conf.keyEnv] || '').trim()
  if (!key) return { ok: false, error: `要调用 ${conf.label} 需要环境变量 ${conf.keyEnv}，但它是空的` }

  if (name === 'deepl') {
    // DeepL 免费版和 Pro 是两个域名。官方约定：免费版 Key 以 `:fx` 结尾。
    // 也能用 DEEPL_API_URL 手动指定（比如走代理 / 私有网关）。
    const auto = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com'
    const baseUrl = stripSlash((process.env.DEEPL_API_URL || auto).trim())
    return { ok: true, target: { provider: name, key, baseUrl, label: conf.label, spec: raw } }
  }

  if (name === 'google') {
    return {
      ok: true,
      target: {
        provider: name,
        key,
        baseUrl: 'https://translation.googleapis.com/language/translate/v2',
        label: conf.label,
        spec: raw,
      },
    }
  }

  // Microsoft
  const region = (process.env.AZURE_TRANSLATOR_REGION || '').trim()
  if (!region) return { ok: false, error: '要调用 Microsoft 翻译需要环境变量 AZURE_TRANSLATOR_REGION（如 eastasia）' }
  return {
    ok: true,
    target: {
      provider: name,
      key,
      baseUrl: 'https://api.cognitive.microsofttranslator.com',
      label: conf.label,
      spec: raw,
      region,
    },
  }
}

/**
 * 把「一串引擎写法」拆成候选列表（跟 aiProvider 的 parseModelChain 一个规矩：
 * 逗号 / 换行 / 分号分隔，去掉重复项）。
 *
 *   AI_TRANSLATE_MT_FALLBACK=deepl, libretranslate
 */
export function parseMtChain(raw: string | null | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const piece of String(raw || '').split(/[,\n;]/)) {
    const spec = piece.trim()
    if (!spec) continue
    const k = spec.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(spec)
  }
  return out
}

/* ---------------- 冷却表（跟 aiProvider 同规则，但互不干扰） ---------------- */

const MT_COOLDOWNS = new Map<string, { until: number; reason: ProviderErrorKind }>()

export function mtCooldownLeftMs(spec: string): number {
  const hit = MT_COOLDOWNS.get(spec)
  if (!hit) return 0
  const left = hit.until - Date.now()
  if (left <= 0) {
    MT_COOLDOWNS.delete(spec)
    return 0
  }
  return left
}

/** rate / quota / 5xx 才进冷却；404 / 401 这种「配置错了」不记（改完配置该立刻能试） */
function markMtCooldown(spec: string, kind: ProviderErrorKind, retryAfterMs: number) {
  if (kind !== 'rate' && kind !== 'quota' && kind !== 'server') return
  const fallback = kind === 'quota' ? 60_000 : kind === 'server' ? 45_000 : 15_000
  const ms = Math.min(Math.max(retryAfterMs || fallback, 5_000), 30 * 60 * 1000)
  MT_COOLDOWNS.set(spec, { until: Date.now() + ms, reason: kind })
  console.log(`[mt-provider] ${spec} 进入冷却 ${Math.round(ms / 1000)}s（${kind}）`)
}

export function snapshotMtCooldowns(specs: string[] = []) {
  const now = Date.now()
  const wanted = specs.length ? specs : [...MT_COOLDOWNS.keys()]
  return wanted.map((spec) => {
    const hit = MT_COOLDOWNS.get(spec)
    return { spec, leftMs: hit ? Math.max(0, hit.until - now) : 0, reason: hit?.reason || '' }
  })
}

/* ---------------- 语言码：每家写法不一样，这里收口 ---------------- */

/**
 * 我们内部只用 'zh' / 'en' 这种 ISO-639-1 写法，各家在出门前各自翻译一遍：
 *   DeepL          大写，且中文目标要注明简繁（ZH / EN-US）
 *   Microsoft      中文要 zh-Hans，否则有时会挑到繁体
 *   Google / Libre 直接用 zh / en
 */
export function langFor(provider: MtProviderName, lang: string): string {
  const l = String(lang || '').toLowerCase()
  if (provider === 'deepl') {
    if (l.startsWith('zh')) return 'ZH'
    if (l.startsWith('en')) return 'EN-US'
    return String(lang).toUpperCase()
  }
  if (provider === 'microsoft') {
    if (l.startsWith('zh')) return 'zh-Hans'
    return l.startsWith('en') ? 'en' : String(lang)
  }
  if (l.startsWith('zh')) return 'zh'
  if (l.startsWith('en')) return 'en'
  return l || String(lang)
}

/* ---------------- 回包解析：把四家的真实形状统一成一个 text ---------------- */

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
}

/** Google 在 format=html 时会把实体再转义一遍（<p> → &lt;p&gt;），用之前要还原 */
export function decodeEntities(s: string): string {
  return String(s || '').replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITY_MAP[m] || m)
}

export type MtRawResult =
  | { ok: true; text: string }
  | { ok: false; status: number; error: string; kind: ProviderErrorKind; retryAfterMs: number; retryable: boolean }

/**
 * 从各家成功回包里挖出译文。
 * 单独抽出来是为了能离线断言 —— 这些形状是各家的硬约定，钉住它们才敢睡觉：
 *   DeepL   { translations: [{ text }] }
 *   Google  { data: { translations: [{ translatedText }] } }
 *   MS      [ { translations: [ { text } ] } ]
 *   Libre   { translatedText }
 */
export function extractMtText(provider: MtProviderName, json: unknown): string {
  const j = json as Record<string, any>
  if (provider === 'deepl') return String(j?.translations?.[0]?.text || '')
  if (provider === 'google') return decodeEntities(String(j?.data?.translations?.[0]?.translatedText || ''))
  if (provider === 'microsoft') return String(j?.[0]?.translations?.[0]?.text || '')
  return String(j?.translatedText || '')
}

/** 每家的失败回包都是「HTTP 状态码 + 一段 JSON」，统一成一种错误描述 */
export function parseMtError(status: number, raw: string, headers?: Headers): ParsedProviderError {
  // DeepL 用 456 表示「额度用尽」（不是 429），得单独认一下，否则会被当成普通 4xx
  if (status === 456) {
    return { kind: 'quota', retryAfterMs: 0, code: 'QUOTA_EXCEEDED', detail: extractProviderMessage(raw) }
  }
  return parseProviderError(status, raw, headers)
}

/** MT 版的「说人话」—— 口径跟 aiProvider 完全一致，直接复用 describeProviderError */
export function describeMtError(label: string, status: number, raw: string, headers?: Headers): string {
  // DeepL 用 456 表示「额度用尽」，describeProviderError 认不出这个码，单独说一句
  if (status === 456) return `${label} 的免费额度用完了（DeepL 报 456）：换一家引擎或等下个月`
  return describeProviderError(label, status, raw, { headers })
}


/* ---------------- 真正发请求：四家各一段，都返回归一化后的 MtRawResult ---------------- */

export type MtCallOptions = {
  text: string
  /** 内部写法：'zh' */
  sourceLang?: string
  /** 内部写法：'en' */
  targetLang: string
  format?: 'text' | 'html'
  /** 上下文（DeepL 用来消歧，最多 4096 字），别的引擎忽略 */
  context?: string
  timeoutMs?: number
  /** 测试注入用；生产留空走全局 fetch */
  fetchImpl?: typeof fetch
}

/** 带超时的 fetch —— 不直接用 aiGemini 的 fetchWithTimeout，是因为要能把 fake fetch 注进来测 */
async function fetchMt(url: string, init: RequestInit, ms: number, fetchImpl: typeof fetch) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal, cache: 'no-store' })
  } finally {
    clearTimeout(timer)
  }
}

/** 把一次 HTTP 回包变成 MtRawResult（成功取文本，失败说人话） */
async function readMtResponse(provider: MtProviderName, label: string, spec: string, res: Response): Promise<MtRawResult> {
  const rawText = await res.text().catch(() => '')
  if (res.ok) {
    let json: unknown = null
    try {
      json = rawText ? JSON.parse(rawText) : null
    } catch {
      /* 下面按「空译文」处理 */
    }
    const text = extractMtText(provider, json)
    if (!text.trim()) {
      return {
        ok: false,
        status: res.status,
        error: `${label} 回了 200，但里面没有译文（可能是源语言判错了）`,
        kind: 'unknown',
        retryAfterMs: 0,
        retryable: true,
      }
    }
    return { ok: true, text }
  }
  const parsed = parseMtError(res.status, rawText, res.headers)
  console.log(`[mt-provider] ${spec} 失败 status=${res.status} kind=${parsed.kind} ｜ ${rawText.slice(0, 300)}`)
  return {
    ok: false,
    status: res.status,
    error: describeMtError(label, res.status, rawText, res.headers),
    kind: parsed.kind,
    retryAfterMs: parsed.retryAfterMs,
    // auth / notfound / badrequest 是「配置问题」，重试没意义；其余可以再试
    retryable: parsed.kind !== 'auth' && parsed.kind !== 'notfound' && parsed.kind !== 'badrequest',
  }
}

async function callMtOnce(target: MtTarget, o: MtCallOptions): Promise<MtRawResult> {
  const fetcher = o.fetchImpl ?? fetch
  const ms = o.timeoutMs ?? 6000
  const fmt = o.format ?? 'text'
  const source = o.sourceLang ? langFor(target.provider, o.sourceLang) : ''
  const to = langFor(target.provider, o.targetLang)
  const { provider, label, spec, key, baseUrl } = target

  try {
    if (provider === 'deepl') {
      // DeepL 只吃 form-urlencoded；tag_handling=html 才能保住 <p> 这些标签
      const form = new URLSearchParams()
      form.set('text', o.text)
      form.set('target_lang', to)
      if (source) form.set('source_lang', source)
      if (fmt === 'html') form.set('tag_handling', 'html')
      if (o.context) form.set('context', o.context.slice(0, 4096))
      form.set('preserve_formatting', '1')
      const res = await fetchMt(
        `${baseUrl}/v2/translate`,
        { method: 'POST', headers: { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() },
        ms,
        fetcher,
      )
      return await readMtResponse(provider, label, spec, res)
    }

    if (provider === 'google') {
      // v2 只要 API Key 就能用，不需要 Service Account
      const body: Record<string, unknown> = { q: o.text, target: to, format: fmt === 'html' ? 'html' : 'text' }
      if (source) body.source = source
      const res = await fetchMt(
        `${baseUrl}?key=${encodeURIComponent(key)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        ms,
        fetcher,
      )
      return await readMtResponse(provider, label, spec, res)
    }

    if (provider === 'microsoft') {
      const qs = new URLSearchParams({ 'api-version': '3.0', to })
      if (source) qs.set('from', source)
      if (fmt === 'html') qs.set('textType', 'html')
      const res = await fetchMt(
        `${baseUrl}/translate?${qs.toString()}`,
        {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': key,
            'Ocp-Apim-Subscription-Region': target.region || '',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify([{ Text: o.text }]),
        },
        ms,
        fetcher,
      )
      return await readMtResponse(provider, label, spec, res)
    }

    // LibreTranslate（自建）
    const body: Record<string, unknown> = { q: o.text, target: to, format: fmt === 'html' ? 'html' : 'text', source: source || 'auto' }
    if (key) body.api_key = key
    const res = await fetchMt(
      `${baseUrl}/translate`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      ms,
      fetcher,
    )
    return await readMtResponse(provider, label, spec, res)
  } catch (e: unknown) {
    // 网络层：超时 / DNS / 被墙。跟 aiProvider 用同一套判断，日志格式也一致
    console.log(`[mt-provider] ${spec} 网络异常`, isNetworkFetchError(e) ? describeNetworkError(e) : String((e as Error)?.message || e))
    return {
      ok: false,
      status: 0,
      error: describeNetworkError(e),
      kind: 'server',
      retryAfterMs: 0,
      retryable: true,
    }
  }
}


/* ---------------- 对外主函数 ---------------- */

export type MtTranslateInput = {
  text: string
  sourceLang?: string
  targetLang?: string
  format?: 'text' | 'html'
  context?: string
  /** 不传就读 AI_TRANSLATE_MT_FALLBACK；单测可传单个引擎 */
  chain?: string
  timeoutMs?: number
  /** 这段兜底总共允许多少毫秒（路由会把剩余预算传进来） */
  totalBudgetMs?: number
  /** 探活用：无视冷却直接打 */
  ignoreCooldown?: boolean
  /** 测试注入用 */
  fetchImpl?: typeof fetch
}

export type MtTranslateResult =
  | { ok: true; text: string; provider: MtProviderName; label: string; spec: string; ms: number; tried: string[] }
  | {
      ok: false
      status: number
      error: string
      kind: ProviderErrorKind
      retryAfterMs: number
      retryable: boolean
      tried: string[]
    }

/**
 * 按顺序把 text 交给 MT 链，第一个成功的就返回。
 * 返回结构刻意跟 aiProvider 的 CallTextResult 对齐（ok/text/kind/retryAfterMs/tried），
 * 这样路由层用同一套姿势处理「LLM 失败」和「MT 失败」。
 */
export async function translateWithMt(o: MtTranslateInput): Promise<MtTranslateResult> {
  const chain = parseMtChain(o.chain ?? process.env.AI_TRANSLATE_MT_FALLBACK)
  const tried: string[] = []
  if (!chain.length) {
    return {
      ok: false,
      status: 500,
      error: '没有配置翻译兜底引擎（AI_TRANSLATE_MT_FALLBACK 是空的）',
      kind: 'unknown',
      retryAfterMs: 0,
      retryable: false,
      tried,
    }
  }

  const startedAt = Date.now()
  const budget = Math.max(o.totalBudgetMs ?? 8000, 1500)
  let last: Extract<MtRawResult, { ok: false }> | null = null

  for (const spec of chain) {
    const resolved = resolveMtTarget(spec)
    if (resolved.ok === false) {
      console.log(`[mt-provider] 跳过 ${spec}：${resolved.error}`)
      tried.push(spec)
      continue
    }
    if (!o.ignoreCooldown) {
      const left = mtCooldownLeftMs(spec)
      if (left > 0) {
        console.log(`[mt-provider] 跳过 ${spec}：冷却中，还剩 ${Math.round(left / 1000)}s`)
        tried.push(spec)
        continue
      }
    }
    const per = Math.min(o.timeoutMs ?? 6000, budget - (Date.now() - startedAt))
    if (per < 1000) {
      console.log(`[mt-provider] 时间不够了，放弃后面的引擎（只剩 ${per}ms）`)
      break
    }
    const t0 = Date.now()
    const r = await callMtOnce(resolved.target, {
      text: o.text,
      sourceLang: o.sourceLang,
      targetLang: o.targetLang || 'en',
      format: o.format,
      context: o.context,
      timeoutMs: per,
      fetchImpl: o.fetchImpl,
    })
    tried.push(spec)
    if (r.ok === true) {
      const ms = Date.now() - t0
      console.log(`[mt-provider] ${spec} 成功（${ms}ms，${r.text.length} 字符）`)
      return {
        ok: true,
        text: r.text,
        provider: resolved.target.provider,
        label: resolved.target.label,
        spec,
        ms,
        tried,
      }
    }
    markMtCooldown(spec, r.kind, r.retryAfterMs)
    last = r
  }

  const totalMs = Math.round((Date.now() - startedAt) / 1000)
  if (!last) {
    return {
      ok: false,
      status: 503,
      error: `翻译兜底一个引擎都没跑起来（${totalMs}s）。检查 AI_TRANSLATE_MT_FALLBACK 和各家的 Key / URL。`,
      kind: 'unknown',
      retryAfterMs: 0,
      retryable: true,
      tried,
    }
  }
  return {
    ok: false,
    status: last.status,
    error: last.error,
    kind: last.kind,
    retryAfterMs: last.retryAfterMs,
    retryable: last.retryable,
    tried,
  }
}

/* ---------------- 给 /api/ai/status 和后台健康卡片看的现状 ---------------- */

export function describeMtRouting() {
  const chain = parseMtChain(process.env.AI_TRANSLATE_MT_FALLBACK)
  const cooldowns = snapshotMtCooldowns(chain)
  const rows = chain.map((spec) => {
    const r = resolveMtTarget(spec)
    const cd = cooldowns.find((c) => c.spec === spec)
    const cooling = cd && cd.leftMs > 0 ? `冷却中，还剩 ${Math.ceil(cd.leftMs / 1000)}s（${cd.reason}）` : ''
    return {
      spec,
      ok: r.ok === true,
      label: r.ok === true ? r.target.label : '',
      baseUrl: r.ok === true ? r.target.baseUrl : '',
      cooling,
      error: r.ok === true ? '' : r.error,
    }
  })
  return { enabled: chain.length > 0, chain, rows }
}

/** 真打一发（翻「你好」两个字）来验活 —— 健康卡片用 */
export async function probeMt(spec: string, timeoutMs = 15000) {
  const t0 = Date.now()
  const r = await translateWithMt({
    text: '你好',
    sourceLang: 'zh',
    targetLang: 'en',
    chain: spec,
    timeoutMs,
    totalBudgetMs: timeoutMs,
    ignoreCooldown: true,
  })
  const ms = Date.now() - t0
  if (r.ok === true) return { spec, ok: true, ms, provider: r.provider, label: r.label, sample: r.text }
  return { spec, ok: false, ms, status: r.status, kind: r.kind, error: r.error }
}
