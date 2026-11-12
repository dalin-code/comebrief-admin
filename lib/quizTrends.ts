/**
 * 趋势采集的类型与纯逻辑（这一层**不联网**，所以能被 CI 离线断言）。
 *
 * 采什么、为什么采这些：
 *   我们要的是「海外年轻人此刻在聊什么」，用来出英文测验。可用的公开源里，
 *   TikTok Creative Center / YouTube Trending / X / Instagram 都不给匿名 API
 *   （要么要登录、要么要商业授权），所以用 8 个能匿名读的源组合覆盖同一个信号：
 *
 *   | 源 | 覆盖什么 | 形态 |
 *   |---|---|---|
 *   | google-trends  | 搜索爆发（最像「此刻」）        | RSS（带 ht: 命名空间） |
 *   | google-news    | 新闻头条（事件类）              | RSS |
 *   | wikipedia      | 集体好奇心（谁在查什么）        | JSON（日榜） |
 *   | reddit         | 社区口语（俚语 / 梗）            | Atom / RSS |
 *   | knowyourmeme   | 梗的出生地                      | RSS |
 *   | apple-music    | 听歌口味（艺人 / 歌名）          | JSON |
 *   | popcrave       | 名人 / 饭圈                     | RSS |
 *   | buzzfeed       | 大众趣味（quiz 的邻域）          | RSS |
 *   | manual         | 人工粘贴（兜底，永远可用）        | 文本 |
 *
 * ⚠️ 合规：Google News RSS 的授权是「个人 / 非商业」；我们只读标题、不落库原文、
 *    不重发内容，但仍然把它做成**可关的开关**（默认开）。商用前请关掉或换成付费源，
 *    见 docs/quiz-ai-authoring.md 的「合规」一节。
 */

export type TrendGeo = 'US' | 'GB' | 'CA' | 'AU' | 'GLOBAL'

export const TREND_GEOS: { value: TrendGeo; label: string }[] = [
  { value: 'US', label: 'United States' },
  { value: 'GB', label: 'United Kingdom' },
  { value: 'CA', label: 'Canada' },
  { value: 'AU', label: 'Australia' },
  { value: 'GLOBAL', label: 'Global (US-weighted)' },
]

/** 时间窗只影响「带日期的源」（RSS / 新闻）；Google Trends 本身就是实时榜。 */
export type TrendWindow = '24h' | '7d' | '30d'

export const TREND_WINDOWS: { value: TrendWindow; label: string; ms: number }[] = [
  { value: '24h', label: 'Last 24h', ms: 24 * 60 * 60 * 1000 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
]

export type TrendSourceId =
  | 'google-trends'
  | 'google-news'
  | 'wikipedia'
  | 'reddit'
  | 'knowyourmeme'
  | 'apple-music'
  | 'popcrave'
  | 'buzzfeed'
  | 'manual'

export type TrendSourceDef = {
  id: TrendSourceId
  label: string
  /** 一句话说明「这个源能回答什么问题」，UI 上直接显示 */
  note: string
  /** 合并时的信任权重：搜索爆发 > 集体浏览 > 社区热帖 > 媒体头条 */
  weight: number
  /** 默认是否勾选 */
  defaultOn: boolean
}

export const TREND_SOURCES: TrendSourceDef[] = [
  { id: 'google-trends', label: 'Google Trends', note: '搜索爆发（此刻）', weight: 4, defaultOn: true },
  { id: 'google-news', label: 'Google News', note: '新闻头条（事件）· 非商业授权', weight: 2, defaultOn: true },
  { id: 'wikipedia', label: 'Wikipedia', note: '集体好奇心（日榜浏览量）', weight: 3, defaultOn: true },
  { id: 'reddit', label: 'Reddit', note: '社区口语 / 梗', weight: 3, defaultOn: true },
  { id: 'knowyourmeme', label: 'Know Your Meme', note: '梗的出生地', weight: 3, defaultOn: true },
  { id: 'apple-music', label: 'Apple Music', note: '听歌口味（艺人 / 歌名）', weight: 2, defaultOn: true },
  { id: 'popcrave', label: 'PopCrave', note: '名人 / 饭圈', weight: 1, defaultOn: true },
  { id: 'buzzfeed', label: 'BuzzFeed', note: '大众趣味（quiz 邻域）', weight: 1, defaultOn: true },
  { id: 'manual', label: 'Manual paste', note: '人工粘贴：想测什么就写什么', weight: 5, defaultOn: true },
]

export const trendSourceDef = (id: TrendSourceId): TrendSourceDef | undefined =>
  TREND_SOURCES.find((source) => source.id === id)

export type TrendItem = {
  /** `${source}:${slug(title)}` —— 跨源同题不同 id，合并去重后才谈得上追溯 */
  id: string
  title: string
  source: TrendSourceId
  url?: string
  /** 原文日期（ISO）；Google Trends / Wikipedia 可能没有 */
  publishedAt?: string
  /** 站内热度（Google 搜索量 / 维基浏览量 / Apple 排名），没有就是 undefined */
  score?: number
  geo?: TrendGeo
  /** 一句话背景（RSS description 截断） */
  note?: string
}

export type TrendSourceStatus = {
  id: TrendSourceId
  label: string
  ok: boolean
  count: number
  ms: number
  /** 失败原因（一句人话，不是 stack） */
  error?: string
}

export type TrendFetchResult = {
  items: TrendItem[]
  sources: TrendSourceStatus[]
  geo: TrendGeo
  window: TrendWindow
  fetchedAt: string
  /** 命中进程内缓存时为 true（10 分钟后过期） */
  cached: boolean
  /** 被「敏感 / 非英文」过滤掉的条数 */
  filtered: number
}

/* ------------------------------------------------------------------ *
 * 归一化 / 去重 / 合并
 * ------------------------------------------------------------------ */

export function normalizeGeo(value: unknown): TrendGeo {
  const key = String(value ?? '').trim().toUpperCase()
  const hit = TREND_GEOS.find((geo) => geo.value === key)
  return hit ? hit.value : 'US'
}

export function normalizeWindow(value: unknown): TrendWindow {
  const key = String(value ?? '').trim().toLowerCase()
  const hit = TREND_WINDOWS.find((win) => win.value === key)
  return hit ? hit.value : '24h'
}

export function windowToMs(value: TrendWindow): number {
  return TREND_WINDOWS.find((win) => win.value === value)?.ms ?? TREND_WINDOWS[0].ms
}

/** 标题 → 稳定的短 id（同一标题在任何源里都是同一个键）。 */
export function slugTerm(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

export function trendId(source: TrendSourceId, title: string): string {
  return `${source}:${slugTerm(title) || 'item'}`
}

/** 去重用的标题键：去掉冠词 / 标点 / 后缀括号，避免 "The Bear" 与 "The Bear (TV series)" 并存。 */
export function titleKey(title: string): string {
  return String(title ?? '')
    .toLowerCase()
    .replace(/\((?:tv series|film|song|album|singer|rapper|band|actor|actress)\)/g, '')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * 同名只留一条，优先保留「信息更多」的那条：
 * 分数高 → 有链接 → 有背景 → 源权重高。**不按数组顺序**，否则谁先到就留谁，
 * 结果每天都不一样。
 */
export function dedupeTrends(items: TrendItem[]): TrendItem[] {
  const best = new Map<string, TrendItem>()
  const rank = (item: TrendItem) =>
    (item.score ?? 0) * 1e-6 +
    (item.url ? 1 : 0) * 0.1 +
    (item.note ? 1 : 0) * 0.05 +
    (trendSourceDef(item.source)?.weight ?? 1) * 0.01

  for (const item of items) {
    const key = titleKey(item.title) || item.id
    const current = best.get(key)
    if (!current || rank(item) > rank(current)) best.set(key, item)
  }
  return Array.from(best.values())
}

/**
 * 轮转合并：每个源轮流出一条。
 *
 * 为什么不是「全按分数排序」：Google Trends 的搜索量比 BuzzFeed 的次序高三个数量级，
 * 直接排序的话 60 条里 55 条来自同一个源 —— 生成的卷会全是「搜索词」，没有梗、没有人名。
 * 轮转保证**任何单个源最多占 1/N**（验收标准里写的就是 ≤ 50%）。
 */
export function mergeRoundRobin(groups: Array<{ source: TrendSourceId; items: TrendItem[] }>, cap = 60): TrendItem[] {
  const queues = groups
    .filter((group) => group.items.length > 0)
    .map((group) => ({ source: group.source, items: [...group.items] }))
    .sort((a, b) => (trendSourceDef(b.source)?.weight ?? 1) - (trendSourceDef(a.source)?.weight ?? 1))

  const out: TrendItem[] = []
  let moved = true
  while (out.length < cap && moved) {
    moved = false
    for (const queue of queues) {
      if (out.length >= cap) break
      const next = queue.items.shift()
      if (!next) continue
      out.push(next)
      moved = true
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 敏感内容过滤：给「娱乐测验」用的源，不该把悲剧当素材
 * ------------------------------------------------------------------ */

/**
 * 这些词命中的标题直接丢掉，并且**不进提示词**。
 *
 * 判据不是「不礼貌」，而是「用它出测验会冒犯到人」：
 *   · 政治 / 选举 / 立法 —— 立场风险，且和娱乐无关；
 *   · 灾难 / 伤亡 / 枪击 / 战争 —— 拿悲剧做「你是什么型」是纯冒犯；
 *   · 医疗 / 疫苗 / 疾病 —— 事实上不可靠，且平台审核敏感；
 *   · 性 / 未成年相关的猎奇词 —— 一律不进提示词。
 * 这是**粗筛**：`docs/quiz-ai-authoring.md` 要求人在向导第二步再确认一遍。
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(election\w*|ballot\w*|congress\w*|senat\w*|parliament\w*|impeach\w*|veto\w*|executive order)\b/i,
  /\b(president|prime minister|democrat\w*|republican\w*|governor|white house|supreme court|cabinet)\b/i,
  /\b(trump|biden|harris|putin|zelensky|xi jinping|modi|netanyahu|milei)\b/i,
  // 高频政治人物（维基日榜常客）：名单不可能穷举，所以文档里写明第二步必须人工再看一遍
  /\b(stephen miller|jon ossoff|nancy pelosi|mitch mcconnell|hakeem jeffries|marjorie taylor greene|jd vance|j\.d\. vance|epstein|diddy)\b/i,
  /\b(shooting|gunman|massacre|hostage\w*|bombing|airstrike|war|invasion|genocide|refugee crisis)\b/i,
  /\b(killed|dead|death\w*|dies at|obituary|funeral|suicide|overdose)\b/i,
  /\b(earthquake|hurricane|wildfire|flood|tsunami|tornado|pandemic|outbreak|epidemic)\b/i,
  /\b(cancer|tumor|diagnosis|vaccine\w*|virus|disease|disorder|clinical trial)\b/i,
  /\b(arrested|charged with|convicted|sentenced|indicted|lawsuit|sexual assault|rape|abuse)\b/i,
  // 宗教 / 族群冲突：拿它出娱乐测验是纯冒犯（实测 reddit 会把这些顶上来）
  /\b(jewish|muslim|islam\w*|antisemit\w*|hate crime|synagogue|mosque|sikh|hindu nationalist)\b/i,
  // 非英文源里混进来的同类内容（德语 / 西语 / 葡语）
  /\b(kinderpornografie|pornografie|pornografia|pornographie|nazi\w*|hitler|droga|drogen)\b/i,
  /\b(porn|nsfw|onlyfans|escort|prostitut)\b/i,
  /\b(kill yourself|kys)\b/i,
]

export function isSensitiveText(text: string): boolean {
  const value = String(text ?? '')
  if (!value) return false
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(value))
}

/** 英文里最常见的功能词。非英文标题几乎不可能包含它们 —— 这是最便宜的语言判别。 */
const EN_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'from', 'with',
  'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these',
  'those', 'you', 'your', 'we', 'our', 'they', 'their', 'he', 'she', 'his', 'her', 'him',
  'not', 'no', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'should', 'about',
  'after', 'before', 'over', 'into', 'up', 'down', 'out', 'why', 'how', 'what', 'when',
  'who', 'where', 'who’s', 'vs', 'new', 'top', 'says', 'said', 'more', 'most', 'just',
  'here', 'there', 'than', 'then', 'so', 'if', 'do', 'does', 'did', 'get', 'got', 'make',
])

/**
 * 其他语言的高频虚词 + 新闻高频词。
 *
 * 只收「英文里几乎不出现、或出现了也不会单独构成外语证据」的：
 * `die`(英文动词) / `son` / `con` / `per` / `non` / `al` / `da` 这类两边都有的词一个都不收，
 * 否则「Die Hard 6 confirmed」「Son Heung-min scores twice」会被误杀。
 * 判据是**命中条数**：一条德语新闻标题里出现 3 个以上这些词，它就不可能是英文。
 */
const FOREIGN_HINTS = new Set([
  // 德语
  'der', 'das', 'und', 'mit', 'für', 'von', 'ist', 'nicht', 'ein', 'eine', 'einer', 'einem',
  'eines', 'wegen', 'zu', 'auf', 'dem', 'den', 'des', 'im', 'sich', 'auch', 'als', 'wie', 'aber',
  'oder', 'wenn', 'weil', 'dass', 'wird', 'werden', 'wurde', 'wurden', 'sind', 'hat', 'haben',
  'kann', 'muss', 'nur', 'noch', 'schon', 'mehr', 'über', 'unter', 'vor', 'nach', 'bei', 'aus',
  'durch', 'gegen', 'ohne', 'zum', 'zur', 'vom', 'beim', 'ins', 'ans', 'kein', 'keine',
  'dieser', 'diese', 'dieses', 'hier', 'dort', 'jetzt', 'heute', 'gestern', 'jahr', 'jahre',
  'haus', 'stadt', 'leiche', 'getötet', 'verletzt', 'polizei', 'ermittelt', 'prozess', 'unfall',
  'bitte', 'mein', 'meine', 'meinem', 'meinen', 'dich', 'mich', 'wir', 'ihr', 'ihre', 'einen',
  'gibt', 'geht', 'kommt', 'sagt', 'sagte', 'laut', 'seit', 'dann', 'denn', 'doch', 'sehr', 'viele',
  // 法语
  'les', 'et', 'une', 'pour', 'avec', 'dans', 'sur', 'est', 'pas', 'que', 'qui', 'aux', 'cette',
  'ces', 'sa', 'ses', 'plus', 'mais', 'nous', 'vous', 'ils', 'elles', 'être', 'était',
  // 西语 / 葡语
  'los', 'las', 'por', 'para', 'una', 'del', 'más', 'pero', 'como', 'sus', 'fue',
  'el', 'en', 'de', 'su',
  'com', 'uma', 'não', 'dos', 'das', 'em', 'foi', 'são', 'pelo', 'pela',
  // 意语
  'della', 'che', 'sono', 'gli', 'dei', 'nel', 'alla', 'delle',
])

/** 德语/北欧语的构词后缀：配合「已有外语虚词」一起用，单独出现不算数。 */
const FOREIGN_SUFFIX = /(ung|heit|keit|schaft|straße|platz|jährig\w*|lich|isch)$/i

/** Reddit 里「标题就是子版名」的垃圾条目（`ich_iel`、`me_irl` 反过来的那种）。 */
const SUBREDDIT_SLUG = /^[a-z0-9]{2,}(_[a-z0-9]{2,})+$/

/**
 * 英文源里混进来的非英文标题（Google News 偶尔回本地语言，Reddit 的 r/popular 更常见）。
 *
 * 实测 2026-11-09 漏过一条完整的德语新闻标题
 * （`In einem unbewohnten Haus Leiche von 13-jähriger Lisa Ta …`）——
 * 因为它含 `in`（英语也有），只靠「有没有英文虚词」判不出来。现在的判据是**外语命中计数**：
 *   ⓪ 整条就是一个子版名（`ich_iel`）→ 丢掉；
 *   ① 非拉丁字母占比 ≥ 20% → 外语（中日韩 / 阿拉伯 / 西里尔）；
 *   ② 外语虚词命中 ≥ 3 → 外语（英文标题里不可能堆三个）；
 *   ③ 外语虚词 ≥ 2 且不少于英文虚词 → 外语；
 *   ④ 有外语虚词 + 德语构词后缀（`-ung` / `-jährig` / `-straße`）+ 零英文虚词 → 外语。
 *
 * **其余一律放行。** 第一版还有一条「4 个词以上却没有英文虚词 → 外语」，
 * 实测把 `Taylor Swift announces Eras Tour film`、`Squid Game season 3 first look`
 * 这类完全正常的英文标题也杀了 —— 拿噪声换干净不值。留着的外语条目点一下就排除了，
 * 丢掉的真趋势却回不来。
 *
 * 分词用 `\p{L}`（Unicode 字母）：`policía` 必须是一个词，否则会被切成
 * `polic` + `a`，而 `a` 正好是英文虚词 —— 一条西语标题就这样「洗白」成英文。
 */
export function isEnglishText(text: string): boolean {
  const value = String(text ?? '')
  if (!/[a-z]/i.test(value)) return false
  if (SUBREDDIT_SLUG.test(value.trim().toLowerCase())) return false

  const nonLatin = value.replace(/[a-z0-9\s\p{P}\p{S}]/giu, '')
  if (nonLatin.length / value.length >= 0.2) return false

  const tokens = value.toLowerCase().split(/[^\p{L}\p{N}'’]+/u).filter(Boolean)
  if (!tokens.length) return false

  const englishHits = tokens.filter((token) => EN_STOPWORDS.has(token)).length
  const foreignHits = tokens.filter((token) => FOREIGN_HINTS.has(token)).length
  const suffixHits = tokens.filter((token) => token.length >= 5 && FOREIGN_SUFFIX.test(token)).length

  if (foreignHits >= 3) return false
  if (foreignHits >= 2 && foreignHits >= englishHits) return false
  if (foreignHits >= 1 && englishHits === 0 && suffixHits >= 1) return false
  return true
}

/** 时间窗过滤：没有日期的条目保留（Google Trends 的 pubDate 时有时无）。 */
export function withinWindow(item: TrendItem, window: TrendWindow, now = Date.now()): boolean {
  if (!item.publishedAt) return true
  const time = new Date(item.publishedAt).getTime()
  if (!Number.isFinite(time)) return true
  return now - time <= windowToMs(window)
}

export type FilteredTrends = { items: TrendItem[]; filtered: number }

/** 敏感 / 非英文 / 过期 一次过完，返回丢了多少条（UI 上显示，不静默）。 */
export function filterTrends(items: TrendItem[], window: TrendWindow, now = Date.now()): FilteredTrends {
  const kept: TrendItem[] = []
  let filtered = 0
  for (const item of items) {
    const haystack = `${item.title} ${item.note ?? ''}`
    if (isSensitiveText(haystack) || !isEnglishText(item.title) || !withinWindow(item, window, now)) {
      filtered += 1
      continue
    }
    kept.push(item)
  }
  return { items: kept, filtered }
}

/** 展示顺序：分数高的在前，同分按源权重，再按标题（确定性，便于 diff）。 */
export function sortTrends(items: TrendItem[]): TrendItem[] {
  return [...items].sort((a, b) => {
    const scoreDiff = (b.score ?? 0) - (a.score ?? 0)
    if (scoreDiff) return scoreDiff
    const weightDiff = (trendSourceDef(b.source)?.weight ?? 1) - (trendSourceDef(a.source)?.weight ?? 1)
    if (weightDiff) return weightDiff
    return a.title.localeCompare(b.title)
  })
}
