/**
 * 增长与运营中台 · 字段契约（纯逻辑、零网络、可被 CI 断言）
 *
 * 三张内容表（quizzes / stories / articles）与页面配置表（seo_topic_configs）
 * 共用同一套「运营物料」，字段名、长度预算、归一化规则必须只有一份定义 ——
 * 否则后台两个输入框会各算一套字数，AI 提示词又是第三套，最后填出来的东西
 * 在 SERP 上被截断，而谁都不知道该信哪个数字。
 *
 * 配套：
 *   · `ComeBrief/supabase/52_growth_seo_geo.sql` —— 列与默认值（本文件的
 *     `GROWTH_DEFAULT_TEMPLATES` 与 SQL 里的默认行**逐字对应**，改一处要改两处，
 *     `scripts/check-growth.mts` 会在两个仓库都在场时对拍）；
 *   · `ComeBrief/lib/growth.ts` —— 前台读侧；只读不写，缺失一律当「未配置」。
 *
 * 三条口径（写代码前先认这三条，后面全是它的推论）：
 *   ① **标题存绝对标题**。前台 `(public)/layout.tsx` 有
 *      `title.template = "%s | ComeBrief"`，所以非空 seo_title 必须用
 *      `title.absolute` 输出。后台计数器因此按「含品牌后缀的最终字符串」算，
 *      和 View Source 里看到的一字不差。
 *   ② **空 = 未配置**。`''` / `[]` / `{}` 一律不是「填了空值」，而是「没填」，
 *      前台回退到代码里原有的文案。这样历史 80+ 篇内容跑完迁移后输出逐字不变。
 *   ③ **长度是硬约束**。TITLE 60 / DESC 160 不是审美偏好：超过就被 Google
 *      截断或改写，而截断后的句子通常主谓不全。归一化在这里硬切，警告在这里给。
 */

import { QUIZ_TOPICS } from './quizKit'

/* ------------------------------------------------------------------ *
 * 1. 类型
 * ------------------------------------------------------------------ */

/** 内容级物料挂在哪张表上（articles 就是前台 Briefs）。 */
export type GrowthContentTable = 'quizzes' | 'stories' | 'articles'

/** 页面级配置的分类（与 `seo_topic_configs.category_type` 的 CHECK 一致）。 */
export type GrowthCategoryType = 'quiz' | 'story' | 'brief' | 'general'

/** GEO 问答：一组问答就是一屏手风琴 + 一个 FAQPage 条目。 */
export type GrowthFaqItem = { question: string; answer: string }

/** 社媒文案的六个键（与 SQL 里 `social_utm.templates` 的键名一致）。 */
export type SocialCopyKey =
  | 'reddit_title'
  | 'reddit_body'
  | 'tiktok_caption'
  | 'pinterest_title'
  | 'pinterest_description'
  | 'x_post_copy'

export type GrowthSocialCopies = Partial<Record<SocialCopyKey, string>>

/** 三张内容表新增的 7 列 —— 归一化后的形状（不含 null，UI 直接绑）。 */
export type GrowthContentFields = {
  seo_title: string
  seo_description: string
  target_entities: string[]
  ai_tldr_summary: string
  geo_faq_list: GrowthFaqItem[]
  social_copies: GrowthSocialCopies
  is_noindex: boolean
}

/** `seo_topic_configs` 的一行（页面级配置）。 */
export type GrowthTopicConfig = {
  id: string
  slug: string
  page_name: string
  category_type: GrowthCategoryType
  seo_title: string
  seo_description: string
  intro_summary: string
  ai_tldr_summary: string
  geo_faq_list: GrowthFaqItem[]
  og_image_url: string
  is_noindex: boolean
  created_at: string
  updated_at: string
}

/** `seo_global_defaults` 里 `social_utm` 那个 key 的内容。 */
export type GrowthDefaults = {
  brand_suffix: string
  utm_medium: string
  utm_campaign: string
  default_subreddit: string
  default_og_image_url: string
  auto_index_on_save: boolean
  templates: Record<SocialCopyKey, string>
}

/** 内容级 7 列的名字（存库时按它挑字段，报错时按它剔除字段）。 */
export const GROWTH_CONTENT_COLUMNS = [
  'seo_title',
  'seo_description',
  'target_entities',
  'ai_tldr_summary',
  'geo_faq_list',
  'social_copies',
  'is_noindex',
] as const

export type GrowthContentColumn = (typeof GROWTH_CONTENT_COLUMNS)[number]

/* ------------------------------------------------------------------ *
 * 2. 长度预算
 *
 *    `max` 是硬上限（超了会被 SERP 截断），`min` 是「再短就说明没写」的下限。
 *    GitHub / Slack 之外没人会去数像素，所以这里用字符数：英文正文在
 *    Google 上的 600px 大约就是 60 / 160 个字符，够用了。
 * ------------------------------------------------------------------ */

export const GROWTH_LIMITS = {
  seoTitle: { min: 30, max: 60 },
  seoDescription: { min: 120, max: 160 },
  /** TL;DR：45–60 词。按词算而不是按字符 —— 一段 300 字符的中文和英文完全不等价。 */
  tldr: { minWords: 45, maxWords: 60, maxChars: 420 },
  faq: { min: 3, max: 5, questionMax: 120, answerMax: 400 },
  targetEntities: { min: 3, max: 8, itemMax: 40 },
  /** 列表页 H1 下的导语：2–3 句，别写成小作文。 */
  introSummary: { max: 320 },
  pageName: { max: 60 },
} as const

/* ------------------------------------------------------------------ *
 * 3. 路径与 slug
 *
 *    `slugifyText()` 是 `ComeBrief/lib/slug.ts` 的镜像，规则逐条对应：
 *    先删引号族（`What's` → `whats`，而不是 `what-s`），其余非 `[a-z0-9]`
 *    折成 `-`，合并连续 `-`、去掉首尾 `-`。两侧一旦分叉，后台配置的
 *    `/quizzes/topic/pop-culture` 就指不到前台真实存在的话题页。
 * ------------------------------------------------------------------ */

export function slugifyText(input: unknown): string {
  return String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/['\u2018\u2019"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * 把用户/数据库里的任意路径归一成「前台真实路径」：`/` 开头、无尾斜杠、
 * 无查询串与锚点、连续斜杠合并、小写。
 *
 * 传完整 URL 也行（只取路径部分）—— 站长从浏览器地址栏复制时经常带上域名。
 * 空输入返回 `''`（不是 `'/'`）：那是「没给」，不能悄悄变成首页。
 */
export function normalizePagePath(raw: unknown): string {
  const text = String(raw ?? '').trim()
  if (!text) return ''

  // 带域名时只留路径；`?` / `#` 之后都不属于路径。
  const withoutOrigin = text.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
  const pathOnly = withoutOrigin.split(/[?#]/)[0]
  const segments = pathOnly.split('/').filter(Boolean)
  if (segments.length === 0) return '/'
  // 小写：本站所有路由都是小写，`/Quizzes/Topic/Career` 与 `/quizzes/topic/career`
  // 必须落到同一行配置上，否则会出现两份「同一个页面」的配置。
  return `/${segments.join('/')}`.toLowerCase()
}

/** 话题页路径。标签 slugify 之后为空（全中文/全符号）时返回 `''`。 */
export function topicPagePath(label: unknown): string {
  const slug = slugifyText(label)
  return slug ? `/quizzes/topic/${slug}` : ''
}

/** 三张内容表 → 前台路径前缀。少写一个，IndexNow 推的就是 404。 */
const CONTENT_PREFIX: Record<GrowthContentTable, string> = {
  quizzes: 'quizzes',
  stories: 'stories',
  articles: 'briefs',
}

/** 内容详情页路径；`slugOrId` 是 UUID 也照样能拼（前台会 301 到 slug 版）。 */
export function contentPathFor(table: GrowthContentTable, slugOrId: unknown): string {
  const key = String(slugOrId ?? '').trim()
  const prefix = CONTENT_PREFIX[table]
  return key && prefix ? `/${prefix}/${key}` : ''
}

/* ------------------------------------------------------------------ *
 * 4. 页面预置
 *
 *    与 SQL 第 6 节预置的行**一一对应**：4 个 hub 是写死的，分类页从
 *    `QUIZ_TOPICS` 派生（后台的 6 个话题与 `quiz_topics` 表同源，
 *    所以不会出现「配置了但线上 404」的幽灵行）。
 * ------------------------------------------------------------------ */

export type GrowthPagePreset = {
  path: string
  label: string
  category_type: GrowthCategoryType
  /** hub = 聚合页；topic = 分类页。列表分组用。 */
  group: 'hub' | 'topic'
}

export const GROWTH_HUB_PAGES: GrowthPagePreset[] = [
  { path: '/', label: 'Home', category_type: 'general', group: 'hub' },
  { path: '/quizzes', label: 'Quizzes hub', category_type: 'quiz', group: 'hub' },
  { path: '/stories', label: 'Stories hub', category_type: 'story', group: 'hub' },
  { path: '/briefs', label: 'Briefs hub', category_type: 'brief', group: 'hub' },
]

export const GROWTH_TOPIC_PAGES: GrowthPagePreset[] = QUIZ_TOPICS.map((topic) => ({
  path: `/quizzes/topic/${topic.slug}`,
  label: `${topic.name} quizzes`,
  category_type: 'quiz' as GrowthCategoryType,
  group: 'topic' as const,
}))

/** 全部预置页（hub 在前，与后台列表的默认顺序一致）。 */
export const GROWTH_PAGE_PRESETS: GrowthPagePreset[] = [...GROWTH_HUB_PAGES, ...GROWTH_TOPIC_PAGES]

/* ------------------------------------------------------------------ *
 * 5. 社媒平台
 *
 *    `limit` 是平台硬限制，`target` 是「超过就不建议」的软目标（TikTok 允许
 *    2200 字符，但读到 200 字以后的人基本不会点链接）。UI 显示 `len/target`，
 *    超过 `limit` 才标红 —— 两个数字分开，因为它们回答的是两个不同问题。
 * ------------------------------------------------------------------ */

export type SocialPlatformField = {
  key: SocialCopyKey
  label: string
  limit: number
  target: number
  multiline: boolean
  hint: string
}

export type SocialPlatform = {
  key: 'reddit' | 'tiktok' | 'pinterest' | 'x'
  label: string
  /** UTM 的 `utm_source` 用这个值。 */
  utmSource: string
  fields: SocialPlatformField[]
}

export const SOCIAL_PLATFORMS: SocialPlatform[] = [
  {
    key: 'reddit',
    label: 'Reddit',
    utmSource: 'reddit',
    fields: [
      {
        key: 'reddit_title',
        label: '标题',
        limit: 300,
        target: 100,
        multiline: false,
        hint: '自报身份比标题党有效：说清「这是什么 + 花了多久」，不要写「你绝对想不到」。',
      },
      {
        key: 'reddit_body',
        label: '正文',
        limit: 4000,
        target: 600,
        multiline: true,
        hint: '先给一句自己的结果再放链接。任何 subreddit 都会把纯链接当垃圾广告。',
      },
    ],
  },
  {
    key: 'tiktok',
    label: 'TikTok',
    utmSource: 'tiktok',
    fields: [
      {
        key: 'tiktok_caption',
        label: '配文',
        limit: 2200,
        target: 150,
        multiline: true,
        hint: '前三秒决定完播率：文案前半句就是视频的钩子，别把它写成摘要。',
      },
    ],
  },
  {
    key: 'pinterest',
    label: 'Pinterest',
    utmSource: 'pinterest',
    fields: [
      {
        key: 'pinterest_title',
        label: 'Pin 标题',
        limit: 100,
        target: 60,
        multiline: false,
        hint: 'Pinterest 是搜索场：把用户会搜的词写进标题，不要玩悬念。',
      },
      {
        key: 'pinterest_description',
        label: 'Pin 描述',
        limit: 500,
        target: 200,
        multiline: true,
        hint: '描述会被索引：补足语境与关键词，结尾带一句行动号召。',
      },
    ],
  },
  {
    key: 'x',
    label: 'X',
    utmSource: 'x',
    fields: [
      {
        key: 'x_post_copy',
        label: '推文',
        limit: 280,
        target: 260,
        multiline: true,
        hint: '一条说完，别写串。链接按 23 字符折算，留出余量。',
      },
    ],
  },
]

/** 六个键的扁平顺序（归一化与提示词都按它，保证输出顺序稳定）。 */
export const SOCIAL_COPY_KEYS: SocialCopyKey[] = SOCIAL_PLATFORMS.reduce<SocialCopyKey[]>(
  (acc, platform) => {
    for (let i = 0; i < platform.fields.length; i += 1) acc.push(platform.fields[i].key)
    return acc
  },
  []
)

/** 硬上限：归一化时按它切（见 `sliceCopy()` 对占位符的余量处理）。 */
export const SOCIAL_COPY_LIMITS: Record<SocialCopyKey, number> = SOCIAL_PLATFORMS.reduce(
  (acc, platform) => {
    for (let i = 0; i < platform.fields.length; i += 1) acc[platform.fields[i].key] = platform.fields[i].limit
    return acc
  },
  {} as Record<SocialCopyKey, number>
)

/* ------------------------------------------------------------------ *
 * 6. 全局默认值
 *
 *    ⚠️ `GROWTH_DEFAULT_TEMPLATES` 与 `52_growth_seo_geo.sql` 里
 *    `seo_global_defaults.social_utm` 的默认行**逐字一致**。改这里必须同时改
 *    SQL，否则「站长没改过」时后台预填的文案和数据库里的不一样，而他无从分辨
 *    哪个才是真的默认值。`scripts/check-growth.mts` 会在两个仓库都在场时对拍
 *    （CI 里没有 ComeBrief 仓库时会自动跳过这一段）。
 * ------------------------------------------------------------------ */

export const GROWTH_DEFAULT_TEMPLATES: Record<SocialCopyKey, string> = {
  reddit_title: '{title}',
  reddit_body: 'Made this and thought this crowd might enjoy it: {url} — curious what you get.',
  tiktok_caption: 'The 60-second test that actually got me: {title} #quiz #personality',
  pinterest_title: '{title}',
  pinterest_description: 'Free, no sign-up, instant results: {title}',
  x_post_copy: 'Took the {title} quiz — 60 seconds, no sign-up. {url}',
}

/** 数据库里没有这一行（或字段缺失）时的兜底 —— 与 SQL 的默认行完全相同。 */
export const GROWTH_DEFAULTS_FALLBACK: GrowthDefaults = {
  brand_suffix: 'ComeBrief',
  utm_medium: 'social',
  utm_campaign: 'organic',
  default_subreddit: 'r/InternetIsBeautiful',
  default_og_image_url: '',
  auto_index_on_save: true,
  templates: GROWTH_DEFAULT_TEMPLATES,
}

const collapseSpace = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim()

/**
 * 把 `seo_global_defaults.value`（可能是 `{}`、可能是半截）补齐成完整形状。
 *
 * 逐键回落而不是整体回落：站长只改了 `utm_campaign` 时，模板不能一起被打回
 * 出厂值 —— 那会让他以为自己的模板丢了。
 */
export function normalizeGrowthDefaults(value: unknown): GrowthDefaults {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? (value as any) : {}
  const rawTemplates =
    raw.templates && typeof raw.templates === 'object' && !Array.isArray(raw.templates)
      ? (raw.templates as any)
      : {}

  const templates = {} as Record<SocialCopyKey, string>
  for (let i = 0; i < SOCIAL_COPY_KEYS.length; i += 1) {
    const key = SOCIAL_COPY_KEYS[i]
    const candidate = collapseSpace(rawTemplates[key]).slice(0, SOCIAL_COPY_LIMITS[key] * 2)
    templates[key] = candidate || GROWTH_DEFAULT_TEMPLATES[key]
  }

  return {
    brand_suffix: collapseSpace(raw.brand_suffix).slice(0, 40) || GROWTH_DEFAULTS_FALLBACK.brand_suffix,
    utm_medium: collapseSpace(raw.utm_medium).slice(0, 40) || GROWTH_DEFAULTS_FALLBACK.utm_medium,
    utm_campaign: collapseSpace(raw.utm_campaign).slice(0, 60) || GROWTH_DEFAULTS_FALLBACK.utm_campaign,
    default_subreddit:
      collapseSpace(raw.default_subreddit).slice(0, 60) || GROWTH_DEFAULTS_FALLBACK.default_subreddit,
    default_og_image_url: String(raw.default_og_image_url ?? '').trim(),
    // 只有显式 false 才算关：缺字段时应该是「开」（历史行为是保存即推）。
    auto_index_on_save: raw.auto_index_on_save === false ? false : true,
    templates,
  }
}

/**
 * 把 `{title}` / `{url}` / `{brand}` 换成真实值。
 *
 * 变量为空时**保留占位符**：让后台的人看见 `{url}` 而不是一段莫名其妙的空白，
 * 顺便提醒他「这里本该有个链接」。
 */
export function renderTemplate(template: unknown, vars: Record<string, string>): string {
  return String(template ?? '').replace(/\{(title|url|brand)\}/g, (whole, key: string) => {
    const value = String(vars[key] ?? '').trim()
    return value || whole
  })
}

/* ------------------------------------------------------------------ *
 * 7. UTM
 * ------------------------------------------------------------------ */

export type UtmInput = {
  /** 平台名（reddit / tiktok / …），落到 `utm_source` */
  source?: string
  medium?: string
  campaign?: string
  /** 区分同一活动下的不同内容，通常放 slug */
  content?: string
}

/**
 * 给链接带上 UTM。
 *
 * 三条决定：
 *   ① **保留已有参数**。链接可能已经带有 `?ref=…`，重拼查询串会把它丢掉；
 *   ② **只覆盖同名的 utm_ 参数**。其余 `utm_term` 之类原样保留；
 *   ③ **不合法就返回空串**，而不是原样返回 —— 调用方据此显示「这条链接不可用」，
 *      比把一个 `javascript:` 当成分享链接发出去强。
 */
export function buildUtmUrl(rawUrl: unknown, input: UtmInput = {}): string {
  const text = String(rawUrl ?? '').trim()
  if (!text) return ''

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return ''
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''

  const pairs: Array<[string, string | undefined]> = [
    ['utm_source', input.source],
    ['utm_medium', input.medium],
    ['utm_campaign', input.campaign],
    ['utm_content', input.content],
  ]
  for (let i = 0; i < pairs.length; i += 1) {
    const [key, raw] = pairs[i]
    const value = collapseSpace(raw)
    // 空值 = 不改动（不是「删掉」）：站长手工加的 utm_source 不该被默认值冲掉。
    if (value) url.searchParams.set(key, value)
  }

  return url.toString()
}

/* ------------------------------------------------------------------ *
 * 8. 归一化
 *
 *    两层的区别很重要：
 *      · `normalizeGrowthFields()` —— **不丢数据**。只 trim / 合并空白 / 去重 /
 *        按已知键过滤。后台加载与保存都走它，所以人写的东西永远不会被悄悄截短。
 *      · `clampGrowthFields()` —— **按硬上限切**。只给 AI 输出用：模型超长是常态，
 *        宁可切掉尾巴也不能让一段 240 字符的描述进库。
 *    长度超限本身由 `growthFieldIssues()` 报给人，不靠静默截断。
 * ------------------------------------------------------------------ */

const asObject = (value: unknown): any =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as any) : {}

/** jsonb 读出来可能是数组，也可能（历史脏值 / 手工 SQL）是 JSON 字符串。 */
function asJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const text = String(value ?? '').trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 从对象或字符串里取第一个非空值（模型/历史数据用过 q、question、title 三种写法）。 */
function firstText(item: unknown, keys: string[]): string {
  if (typeof item === 'string') return item
  const source = asObject(item)
  for (let i = 0; i < keys.length; i += 1) {
    const value = collapseSpace(source[keys[i]])
    if (value) return value
  }
  return ''
}

const ensureQuestionMark = (question: string) => (question.endsWith('?') ? question : `${question}?`)

/**
 * GEO 问答：容错四种历史形状（`{question,answer}` / `{q,a}` / 纯字符串对 / JSON 字符串），
 * 去掉空项、按问题去重、最多 5 组。
 *
 * 为什么要去重：AI 经常把同一个问题换个语序写两遍（「How long does it take?」/
 * 「How long does it take to finish?」）。两屏几乎一样的手风琴比没有更糟。
 */
export function parseFaqList(value: unknown): GrowthFaqItem[] {
  const raw = asJsonArray(value)
  const out: GrowthFaqItem[] = []
  const seen = new Set<string>()

  for (let i = 0; i < raw.length; i += 1) {
    const question = firstText(raw[i], ['question', 'q', 'title', 'name'])
    const answer = firstText(raw[i], ['answer', 'a', 'body', 'text', 'response'])
    if (!question || !answer) continue

    const key = question.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)

    out.push({
      question: ensureQuestionMark(question.slice(0, GROWTH_LIMITS.faq.questionMax)),
      answer: answer.slice(0, GROWTH_LIMITS.faq.answerMax),
    })
    if (out.length >= GROWTH_LIMITS.faq.max) break
  }

  return out
}

/** 目标实体：接受数组或逗号/换行分隔的字符串，去重（忽略大小写），最多 8 个。 */
export function normalizeTargetEntities(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,，;；\n]/)
      : []

  const out: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < list.length; i += 1) {
    // 去掉行首的 `#`（运营写标签写惯了）与多余空白
    const text = collapseSpace(list[i]).replace(/^#+/, '').slice(0, GROWTH_LIMITS.targetEntities.itemMax)
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= GROWTH_LIMITS.targetEntities.max) break
  }
  return out
}

/**
 * 社媒文案：只保留六个已知键，值必须是字符串（模型偶尔会返回数组或对象）。
 * 这里**不按平台上限切** —— 人可能故意写长 Reddit 正文；超限由 UI 标红。
 */
export function normalizeSocialCopies(value: unknown): GrowthSocialCopies {
  const source = asObject(value)
  const out: GrowthSocialCopies = {}
  for (let i = 0; i < SOCIAL_COPY_KEYS.length; i += 1) {
    const key = SOCIAL_COPY_KEYS[i]
    const raw = source[key]
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (text) out[key] = text
  }
  return out
}

/** 内容行（quizzes / stories / articles）→ 归一化后的 7 个字段。不截断。 */
export function normalizeGrowthFields(row: unknown): GrowthContentFields {
  const source = asObject(row)
  return {
    seo_title: collapseSpace(source.seo_title),
    seo_description: collapseSpace(source.seo_description),
    target_entities: normalizeTargetEntities(source.target_entities),
    ai_tldr_summary: collapseSpace(source.ai_tldr_summary),
    geo_faq_list: parseFaqList(source.geo_faq_list),
    social_copies: normalizeSocialCopies(source.social_copies),
    is_noindex: source.is_noindex === true,
  }
}

/** `seo_topic_configs` 的一行 → 归一化后的形状（缺列/缺表时也能安全调用）。 */
export function normalizeTopicConfig(row: unknown): GrowthTopicConfig {
  const source = asObject(row)
  const type = String(source.category_type || '').trim()
  return {
    id: String(source.id || ''),
    slug: normalizePagePath(source.slug),
    page_name: collapseSpace(source.page_name).slice(0, GROWTH_LIMITS.pageName.max),
    category_type:
      type === 'quiz' || type === 'story' || type === 'brief' || type === 'general'
        ? (type as GrowthCategoryType)
        : 'general',
    seo_title: collapseSpace(source.seo_title),
    seo_description: collapseSpace(source.seo_description),
    intro_summary: collapseSpace(source.intro_summary),
    ai_tldr_summary: collapseSpace(source.ai_tldr_summary),
    geo_faq_list: parseFaqList(source.geo_faq_list),
    og_image_url: String(source.og_image_url ?? '').trim(),
    is_noindex: source.is_noindex === true,
    created_at: String(source.created_at || ''),
    updated_at: String(source.updated_at || ''),
  }
}

export function normalizeTopicConfigList(rows: unknown): GrowthTopicConfig[] {
  const list = Array.isArray(rows) ? rows : []
  const out: GrowthTopicConfig[] = []
  const seen = new Set<string>()
  for (let i = 0; i < list.length; i += 1) {
    const config = normalizeTopicConfig(list[i])
    // slug 归一后可能撞车（数据库里理论上不会：有 unique 约束；但读侧不能假定）
    if (!config.slug || seen.has(config.slug)) continue
    seen.add(config.slug)
    out.push(config)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 9. 长度 / 校验 / 就绪度
 * ------------------------------------------------------------------ */

/** 英文按空格数词，中文按字符折算（1 个汉字 ≈ 1 个词）。只用于 TL;DR 的 45–60 词规则。 */
export function countWords(value: unknown): number {
  const text = collapseSpace(value)
  if (!text) return 0
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length
  const latinWords = text
    .replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length
  return cjk + latinWords
}

export type LengthState = 'empty' | 'short' | 'ok' | 'long'

/**
 * 字数状态 —— 后台所有计数器都走它，保证「60/60 绿、61 红」在标题、描述、
 * 社媒文案上是同一个判断，不会出现一处按 `>=` 一处按 `>`。
 */
export function measureLength(
  value: unknown,
  limits: { min: number; max: number }
): { length: number; state: LengthState; text: string } {
  const length = String(value ?? '').trim().length
  const state: LengthState =
    length === 0 ? 'empty' : length > limits.max ? 'long' : length < limits.min ? 'short' : 'ok'
  return { length, state, text: `${length}/${limits.max}` }
}

export type GrowthFieldIssue = {
  /** 哪个字段（社媒用平台键名，如 `x_post_copy`）。 */
  field: string
  level: 'warn' | 'error'
  message: string
}

/**
 * 保存前的体检。`error` 该挡住保存（超硬上限），`warn` 只提示（还短、还没写满）。
 *
 * 为什么不把 `warn` 也做成阻断：历史上 80+ 篇内容一个运营字段都没有，如果
 * 「没写 TL;DR」就能挡住保存，那站长改一个错别字都改不动。
 */
export function growthFieldIssues(fields: GrowthContentFields): GrowthFieldIssue[] {
  const issues: GrowthFieldIssue[] = []

  const title = measureLength(fields.seo_title, GROWTH_LIMITS.seoTitle)
  if (title.state === 'long') {
    issues.push({
      field: 'seo_title',
      level: 'error',
      message: `标题 ${title.length} 字符，超过 ${GROWTH_LIMITS.seoTitle.max}，SERP 会截断`,
    })
  } else if (title.state === 'short') {
    issues.push({
      field: 'seo_title',
      level: 'warn',
      message: `标题只有 ${title.length} 字符，建议写到 ${GROWTH_LIMITS.seoTitle.min} 以上`,
    })
  }

  const desc = measureLength(fields.seo_description, GROWTH_LIMITS.seoDescription)
  if (desc.state === 'long') {
    issues.push({
      field: 'seo_description',
      level: 'error',
      message: `描述 ${desc.length} 字符，超过 ${GROWTH_LIMITS.seoDescription.max}`,
    })
  } else if (desc.state === 'short') {
    issues.push({
      field: 'seo_description',
      level: 'warn',
      message: `描述只有 ${desc.length} 字符，建议写到 ${GROWTH_LIMITS.seoDescription.min} 以上`,
    })
  }

  const words = countWords(fields.ai_tldr_summary)
  if (fields.ai_tldr_summary && words < GROWTH_LIMITS.tldr.minWords) {
    issues.push({
      field: 'ai_tldr_summary',
      level: 'warn',
      message: `TL;DR 只有 ${words} 词，建议 ${GROWTH_LIMITS.tldr.minWords}–${GROWTH_LIMITS.tldr.maxWords} 词`,
    })
  }
  if (words > GROWTH_LIMITS.tldr.maxWords) {
    issues.push({
      field: 'ai_tldr_summary',
      level: 'warn',
      message: `TL;DR 有 ${words} 词，超过 ${GROWTH_LIMITS.tldr.maxWords} 词`,
    })
  }

  const faqCount = fields.geo_faq_list.length
  if (faqCount > 0 && faqCount < GROWTH_LIMITS.faq.min) {
    issues.push({
      field: 'geo_faq_list',
      level: 'warn',
      message: `只有 ${faqCount} 组问答，建议 ${GROWTH_LIMITS.faq.min}–${GROWTH_LIMITS.faq.max} 组`,
    })
  }

  const entityCount = fields.target_entities.length
  if (entityCount > 0 && entityCount < GROWTH_LIMITS.targetEntities.min) {
    issues.push({
      field: 'target_entities',
      level: 'warn',
      message: `只有 ${entityCount} 个实体，建议 ${GROWTH_LIMITS.targetEntities.min}–${GROWTH_LIMITS.targetEntities.max} 个`,
    })
  }

  for (let i = 0; i < SOCIAL_COPY_KEYS.length; i += 1) {
    const key = SOCIAL_COPY_KEYS[i]
    const text = fields.social_copies[key]
    if (!text) continue
    const limit = SOCIAL_COPY_LIMITS[key]
    // 带占位符时按「渲染后」估算：{url} 最终会变成一条 40–60 字符的链接。
    const estimated = text.length + (/\{url\}/.test(text) ? 40 : 0)
    if (estimated > limit) {
      issues.push({ field: key, level: 'error', message: `${key} 约 ${estimated} 字符，超过平台上限 ${limit}` })
    }
  }

  return issues
}

/**
 * 硬切到上限 —— **只给 AI 输出用**。
 *
 * 切在词边界：模型写出一段 210 字符的描述时，直接 `slice(0,160)` 会留下
 * 「…which is why the resu」这种尾巴。切到最后一个空格，代价是少几个字符，
 * 换来的是一句完整的话。
 */
function clampText(value: unknown, max: number): string {
  const text = collapseSpace(value)
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim()
}

/** 社媒文案的硬切：带占位符时多留 60 字符，避免把 `{url}` 切成 `{ur`。 */
function clampCopy(key: SocialCopyKey, value: unknown): string {
  const text = String(value ?? '').trim()
  if (!text) return ''
  const limit = SOCIAL_COPY_LIMITS[key] || 500
  const room = /\{(title|url|brand)\}/.test(text) ? limit + 60 : limit
  return clampText(text, room)
}

export function clampGrowthFields(fields: GrowthContentFields): GrowthContentFields {
  const copies: GrowthSocialCopies = {}
  for (let i = 0; i < SOCIAL_COPY_KEYS.length; i += 1) {
    const key = SOCIAL_COPY_KEYS[i]
    const value = clampCopy(key, fields.social_copies[key])
    if (value) copies[key] = value
  }

  return {
    seo_title: clampText(fields.seo_title, GROWTH_LIMITS.seoTitle.max),
    seo_description: clampText(fields.seo_description, GROWTH_LIMITS.seoDescription.max),
    target_entities: normalizeTargetEntities(fields.target_entities),
    ai_tldr_summary: clampText(fields.ai_tldr_summary, GROWTH_LIMITS.tldr.maxChars),
    geo_faq_list: parseFaqList(fields.geo_faq_list),
    social_copies: copies,
    is_noindex: fields.is_noindex === true,
  }
}

/** 进度：内容级 6 项（`is_noindex` 是开关，不算「填没填」）。 */
export type GrowthReadiness = {
  filled: number
  total: number
  percent: number
  level: 'empty' | 'partial' | 'ready'
  /** 还没填的项（中文，直接显示在卡片上） */
  missing: string[]
}

function score(readiness: Array<[string, boolean]>): GrowthReadiness {
  const missing: string[] = []
  let filled = 0
  for (let i = 0; i < readiness.length; i += 1) {
    if (readiness[i][1]) filled += 1
    else missing.push(readiness[i][0])
  }
  const total = readiness.length
  return {
    filled,
    total,
    percent: total === 0 ? 0 : Math.round((filled / total) * 100),
    level: filled === 0 ? 'empty' : filled === total ? 'ready' : 'partial',
    missing,
  }
}

export function growthReadiness(fields: GrowthContentFields): GrowthReadiness {
  return score([
    ['SEO 标题', !!fields.seo_title],
    ['Meta 描述', !!fields.seo_description],
    ['TL;DR', !!fields.ai_tldr_summary],
    [`GEO 问答（≥${GROWTH_LIMITS.faq.min} 组）`, fields.geo_faq_list.length >= GROWTH_LIMITS.faq.min],
    [
      `目标实体（≥${GROWTH_LIMITS.targetEntities.min} 个）`,
      fields.target_entities.length >= GROWTH_LIMITS.targetEntities.min,
    ],
    ['社媒文案（≥2 条）', Object.keys(fields.social_copies).length >= 2],
  ])
}

export function pageReadiness(config: GrowthTopicConfig): GrowthReadiness {
  return score([
    ['SEO 标题', !!config.seo_title],
    ['Meta 描述', !!config.seo_description],
    ['页面导语', !!config.intro_summary],
    [`GEO 问答（≥${GROWTH_LIMITS.faq.min} 组）`, config.geo_faq_list.length >= GROWTH_LIMITS.faq.min],
    ['OG 图', !!config.og_image_url],
  ])
}

/* ------------------------------------------------------------------ *
 * 10. 存库 / 报错
 * ------------------------------------------------------------------ */

/**
 * 只挑出「调用方真的给了」的字段。
 *
 * 为什么要挑：编辑器保存的是整篇内容（标题、正文、封面…），把归一化后的
 * 空字符串也一起写回去会把人工填的值覆盖成空。调用方只传改动过的字段即可。
 */
export function growthPayload(fields: Partial<GrowthContentFields>): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (let i = 0; i < GROWTH_CONTENT_COLUMNS.length; i += 1) {
    const column = GROWTH_CONTENT_COLUMNS[i]
    if (!(column in fields)) continue
    const value = (fields as any)[column]
    if (value === undefined) continue
    payload[column] = value
  }
  return payload
}

/**
 * 从 PostgREST 的报错里认出「这一列不存在」，并返回列名。
 *
 * 场景：代码先部署、SQL 后执行。后台已有的保存路径就是这么兜的 ——
 * 认出来 → 剔掉这个字段重试一次，而不是让站长看到一整片红。
 * 返回 `''` 表示「不是缺列的错」，调用方照常报错。
 */
export function missingGrowthColumnFromError(message: unknown): GrowthContentColumn | '' {
  const text = String(message ?? '')
  if (!/PGRST204|schema cache|could not find the .* column|column .* does not exist/i.test(text)) return ''
  for (let i = 0; i < GROWTH_CONTENT_COLUMNS.length; i += 1) {
    const column = GROWTH_CONTENT_COLUMNS[i]
    if (text.includes(column)) return column
  }
  return ''
}



