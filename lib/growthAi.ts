/**
 * 增长物料的 AI 提示词 + 输出归一化（纯函数，可被 CI 断言）。
 *
 * 三条边界，写在这里而不是散在路由里：
 *   ① **只接受数据，不接受提示词**。路由的入参是标题 / 正文 / 分类这些事实，
 *      提示词本身在代码里 —— 否则「改文案要能 diff、能回滚」这条就废了。
 *   ② **不许编事实**。GEO 摘要与 FAQ 会被 AI 搜索引擎当答案引用，编一个
 *      「78% 的人…」比不写更糟：它会被原样念给用户听。提示词明确要求
 *      「只用给定材料，材料不足就换一个能答的问题」，而不是硬凑。
 *   ③ **长度在提示词里说、在代码里切**。模型对「60 字符」的执行率大概七成，
 *      剩下的由 `clampGrowthFields()` 兜底，再由 `growthFieldIssues()` 报给人 ——
 *      三层各管一段，谁都不假装自己够了。
 */

import {
  GROWTH_LIMITS,
  SOCIAL_PLATFORMS,
  clampGrowthFields,
  countWords,
  growthFieldIssues,
  normalizeSocialCopies,
  normalizeTargetEntities,
  parseFaqList,
  type GrowthContentFields,
  type GrowthFaqItem,
  type SocialCopyKey,
} from './growth'
import { blockingTextIssues, describeTextIssues, fixArticleAgreement, inspectEnglishText } from './textQuality'

/* ------------------------------------------------------------------ *
 * 1. 任务
 * ------------------------------------------------------------------ */

/** 五个可独立勾选的任务 —— 后台面板按它分组，路由按它裁剪输出。 */
export const GROWTH_TASKS = ['seo', 'tldr', 'faq', 'entities', 'social'] as const

export type GrowthTask = (typeof GROWTH_TASKS)[number]

export const GROWTH_TASK_LABELS: Record<GrowthTask, string> = {
  seo: 'SEO 标题 + 描述',
  tldr: 'TL;DR 摘要',
  faq: 'GEO 问答',
  entities: '目标实体',
  social: '社媒文案',
}

export const GROWTH_TASK_HINTS: Record<GrowthTask, string> = {
  seo: '写进 <title> 与 meta description 的两句文案，SERP 上会原样显示。',
  tldr: '正文前的 Quick Summary 卡片，也是 AI 搜索最爱引用的那一段。',
  faq: '手风琴 + FAQPage 结构化数据，一次只回答一个具体问题。',
  entities: '这篇内容「关于什么」，供运营参考，不上页面。',
  social: 'Reddit / TikTok / Pinterest / X 各一份，复制即用。',
}

/**
 * 归一化任务列表：认不出的丢掉，一个都没有时当「全都要」。
 *
 * 「什么都没给 = 全都要」是后台「一键生成」的默认行为；而给了但全认不出
 * （前端传了旧键名）时也走这条，宁可多写几项，也不要静默什么都不生成。
 */
export function normalizeGrowthTasks(value: unknown): GrowthTask[] {
  const list = Array.isArray(value) ? value : []
  const wanted = new Set<string>()
  for (let i = 0; i < list.length; i += 1) {
    const key = String(list[i] ?? '').trim().toLowerCase()
    if ((GROWTH_TASKS as readonly string[]).includes(key)) wanted.add(key)
  }
  if (wanted.size === 0) return [...GROWTH_TASKS]
  return GROWTH_TASKS.filter((task) => wanted.has(task))
}

/* ------------------------------------------------------------------ *
 * 2. 入参
 * ------------------------------------------------------------------ */

export type GrowthAiScope = 'content' | 'page'

export type GrowthAiInput = {
  /** content = 单篇详情页；page = 列表 / 聚合 / 分类页 */
  scope: GrowthAiScope
  title: string
  /** 分类或话题（quiz: Career；brief: Tech）。列表页放页面名。 */
  category?: string
  /** 已有的摘要 / 导语（文章 excerpt、列表页导语） */
  summary?: string
  /** 正文纯文本；路由层已截到安全长度 */
  body?: string
  /** 页面路径，例如 `/quizzes/topic/career` */
  pagePath?: string
  /** 详情页正式地址（社媒文案里仍要写 {url} 占位，这里只当上下文） */
  url?: string
  /** 品牌后缀，默认 ComeBrief */
  brandSuffix?: string
  /** 运营钉住、必须出现的短语（最多 5 个） */
  focusKeywords?: string[]
}

/* ------------------------------------------------------------------ *
 * 3. 提示词
 * ------------------------------------------------------------------ */

/**
 * 稳定的「我是谁、我怎么写」—— 放 system，配合 `callText` 的缓存。
 *
 * 刻意写成风格约束而不是需求文档：模型对「不要做什么」的遵守率远高于
 * 「要做得好一点」。「不许编事实」放在第一条，因为它的代价最高 ——
 * 一句编出来的统计会被 AI 搜索原样引用，事后没人能撤回。
 */
export function buildGrowthSystemPrompt(): string {
  return [
    'You are the SEO and distribution editor for ComeBrief, a small independent site of free quizzes, short stories, and news briefs.',
    'Readers arrive from Google and from social feeds. There is no sign-up wall and no paywall; results are instant.',
    '',
    'Voice: plain, specific, calm. Write like a careful editor, not a growth marketer.',
    'Never use hype words (unlock, discover, dive in, game-changer, mind-blowing), never write in ALL CAPS, and never promise a result the page does not deliver.',
    '',
    'Hard rules, in order of importance:',
    '1. Never invent facts. Use only the material given in the user message. If it is too thin for a question, choose a different question you can answer from it. Never invent statistics, percentages, dates, names, or quotes.',
    '2. The site is English-only. Write natural US English, no translationese.',
    '3. Never invent a URL. When social copy needs a link, write the literal placeholder {url} and nothing else.',
    '4. No emoji, except at most one in the TikTok caption.',
    '5. Output JSON only. No markdown fences, no commentary before or after.',
  ].join('\n')
}

/**
 * 各任务的硬长度，与 UI 计数器、归一化用的是同一组数字（`GROWTH_LIMITS`）。
 *
 * 只列**本次要的**任务：把没勾的预算也贴上去，模型会把它当成「也写一点吧」
 * 的邀请，多出来的键只能被丢掉 —— 白花 token，还让 schema 显得自相矛盾。
 */
function budgetBlock(scope: GrowthAiScope, brandSuffix: string, tasks: GrowthTask[]): string {
  const lines: string[] = []
  if (tasks.includes('seo')) {
    lines.push(
      `seo_title: ${GROWTH_LIMITS.seoTitle.min}-${GROWTH_LIMITS.seoTitle.max} characters INCLUDING the brand suffix " | ${brandSuffix}". Front-load the primary search phrase. No clickbait, no trailing period.`,
      `seo_description: ${GROWTH_LIMITS.seoDescription.min}-${GROWTH_LIMITS.seoDescription.max} characters. One clause of concrete value, one clause of scope (what is on the page). No "click here", no "learn more".`
    )
  }
  if (tasks.includes('tldr')) {
    lines.push(
      `ai_tldr_summary: ${GROWTH_LIMITS.tldr.minWords}-${GROWTH_LIMITS.tldr.maxWords} words. Third person, encyclopedic, begins with the subject instead of "This page". No second-person "you".`
    )
  }
  if (tasks.includes('faq')) {
    lines.push(
      `geo_faq_list: ${GROWTH_LIMITS.faq.min}-${GROWTH_LIMITS.faq.max} pairs. Each question must read like a real search query and end with "?". Each answer: one direct sentence first, at most one supporting sentence, max ${GROWTH_LIMITS.faq.answerMax} characters.`
    )
  }
  if (tasks.includes('entities')) {
    lines.push(
      `target_entities: ${GROWTH_LIMITS.targetEntities.min}-${GROWTH_LIMITS.targetEntities.max} canonical names (brands, people, concepts, places). Title case, no hashtags.`
    )
  }
  if (scope === 'page') {
    lines.push(
      'This is a listing / hub page: describe the collection and what a visitor can do there, not one single item.'
    )
  } else {
    lines.push('This is one detail page: describe that one item and what the reader gets from it.')
  }
  return lines.join('\n')
}

/** 六个社媒键的写法差异，按平台而不是按字段堆一遍（同一平台的字段共享语气）。 */
function socialBlock(): string {
  const lines = ['social_copies: platform-native copy, one string per key.']
  for (let i = 0; i < SOCIAL_PLATFORMS.length; i += 1) {
    const platform = SOCIAL_PLATFORMS[i]
    const tone =
      platform.key === 'reddit'
        ? 'first-person self-post tone; earn the link with one line of your own result, post the {url} once'
        : platform.key === 'tiktok'
          ? 'the first sentence is the hook spoken in the first two seconds'
          : platform.key === 'pinterest'
            ? 'keyword-rich and literal; Pinterest is a search engine, not a feed'
            : 'one post, no thread, must still fit with the link'
    for (let j = 0; j < platform.fields.length; j += 1) {
      const field = platform.fields[j]
      lines.push(
        `- ${field.key} (${platform.label}, aim for ${field.target} characters, hard limit ${field.limit}): ${tone}.`
      )
    }
  }
  return lines.join('\n')
}

/**
 * 每次变化的那一半：事实 + 预算 + 输出结构。
 *
 * `schema` 只列本次要的键 —— 否则模型会顺手把没勾选的任务也写出来，而面板上
 * 那些输入框并不在编辑状态，多出来的值会被静默丢掉（在站长眼里就是「生成完
 * 什么都没变」）。
 */
export function buildGrowthUserPrompt(input: GrowthAiInput, tasks: GrowthTask[]): string {
  const brandSuffix = (input.brandSuffix || 'ComeBrief').trim()
  const facts: string[] = [`scope: ${input.scope}`, `page title: ${input.title.trim()}`]
  if (input.category) facts.push(`category / topic: ${input.category.trim()}`)
  if (input.pagePath) facts.push(`page path: ${input.pagePath.trim()}`)
  if (input.url) facts.push(`canonical URL (context only; still write {url} in copy): ${input.url.trim()}`)
  if (input.focusKeywords?.length) facts.push(`must-include phrases: ${input.focusKeywords.join(', ')}`)
  if (input.summary) facts.push(`existing summary:\n${input.summary.trim()}`)
  if (input.body) facts.push(`source text:\n"""\n${input.body.trim()}\n"""`)
  else facts.push('source text: (none provided. Stay generic and do not invent specifics)')

  const fields: string[] = []
  if (tasks.includes('seo')) fields.push('  "seo_title": "string"', '  "seo_description": "string"')
  if (tasks.includes('tldr')) fields.push('  "ai_tldr_summary": "string"')
  if (tasks.includes('faq')) fields.push('  "geo_faq_list": [{ "question": "string", "answer": "string" }]')
  if (tasks.includes('entities')) fields.push('  "target_entities": ["string"]')
  if (tasks.includes('social')) {
    const keys: string[] = []
    for (let i = 0; i < SOCIAL_PLATFORMS.length; i += 1) {
      for (let j = 0; j < SOCIAL_PLATFORMS[i].fields.length; j += 1) {
        keys.push(`"${SOCIAL_PLATFORMS[i].fields[j].key}": "string"`)
      }
    }
    fields.push(`  "social_copies": { ${keys.join(', ')} }`)
  }

  // 只要 seo 时不贴平台预算：一段用不上的「TikTok 前两秒」只会稀释预算，
  // 也会让模型觉得「顺手写几条社媒也行」。
  const platformSection = tasks.includes('social') ? ['', '## Platform budgets', socialBlock()] : []

  return [
    'Write the growth assets for the page described below.',
    '',
    '## Facts',
    facts.join('\n'),
    '',
    '## Length budgets',
    budgetBlock(input.scope, brandSuffix, tasks),
    ...platformSection,
    '',
    '## Output',
    'Return one JSON object with exactly these keys (no others):',
    '{',
    fields.join(',\n'),
    '}',
    '',
    `The brand suffix for seo_title is " | ${brandSuffix}".`,
  ].join('\n')
}

/* ------------------------------------------------------------------ *
 * 4. 输出归一化
 * ------------------------------------------------------------------ */

const EMPTY_FIELDS: GrowthContentFields = {
  seo_title: '',
  seo_description: '',
  target_entities: [],
  ai_tldr_summary: '',
  geo_faq_list: [],
  social_copies: {},
  is_noindex: false,
}

const asObject = (value: unknown): any =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as any) : {}

/** 模型偶尔把结果包一层（`{result:{…}}` / `{data:{…}}` / `{assets:{…}}`）。 */
function unwrap(value: unknown): any {
  const raw = asObject(value)
  const candidates = [asObject(raw.result), asObject(raw.data), asObject(raw.assets)]
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i]
    if (candidate.seo_title || candidate.ai_tldr_summary || candidate.geo_faq_list || candidate.social_copies) {
      return candidate
    }
  }
  return raw
}

function pickText(raw: any, keys: string[]): string {
  for (let i = 0; i < keys.length; i += 1) {
    const value = raw[keys[i]]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** 英文机械语法（a/an、重复词…）在归一化这一步就修，别留给人肉找。 */
const polish = (text: string) => (text ? fixArticleAgreement(text).trim() : '')

export type GrowthAiNormalizeResult = {
  /** 只包含本次请求的任务对应的键。 */
  fields: Partial<GrowthContentFields>
  /** 给人看的提示（超长被切、问答不足、语法问题…），不阻断保存。 */
  warnings: string[]
}

/**
 * 把模型输出变成可入库的字段。
 *
 * 顺序是刻意的：**认键（容错别名）→ 修语法 → 硬切长度 → 体检**。
 * 先切再修的话，`a hour` 会被切成半截，规则就永远修不上了。
 */
export function normalizeGrowthAiResult(value: unknown, tasks: GrowthTask[]): GrowthAiNormalizeResult {
  const raw = unwrap(value)
  const warnings: string[] = []
  const merged: GrowthContentFields = { ...EMPTY_FIELDS }
  const out: Partial<GrowthContentFields> = {}

  if (tasks.includes('seo')) {
    merged.seo_title = polish(pickText(raw, ['seo_title', 'title']))
    merged.seo_description = polish(pickText(raw, ['seo_description', 'description', 'meta_description']))
  }
  if (tasks.includes('tldr')) {
    merged.ai_tldr_summary = polish(
      pickText(raw, ['ai_tldr_summary', 'tldr', 'tldr_summary', 'quick_summary', 'summary'])
    )
  }
  if (tasks.includes('faq')) {
    merged.geo_faq_list = parseFaqList(raw.geo_faq_list ?? raw.faq ?? raw.faqs ?? raw.geo_faq ?? []).map(
      (item: GrowthFaqItem) => ({ question: polish(item.question), answer: polish(item.answer) })
    )
  }
  if (tasks.includes('entities')) {
    merged.target_entities = normalizeTargetEntities(
      raw.target_entities ?? raw.entities ?? raw.key_entities ?? []
    )
  }
  if (tasks.includes('social')) {
    const copies = normalizeSocialCopies(raw.social_copies ?? raw.social ?? raw.copies ?? {})
    const polished: Record<string, string> = {}
    const keys = Object.keys(copies) as SocialCopyKey[]
    for (let i = 0; i < keys.length; i += 1) polished[keys[i]] = polish(copies[keys[i]] || '')
    merged.social_copies = normalizeSocialCopies(polished)
  }

  const clamped = clampGrowthFields(merged)

  if (tasks.includes('seo')) {
    out.seo_title = clamped.seo_title
    out.seo_description = clamped.seo_description
    if (!clamped.seo_title) warnings.push('模型没给出 seo_title')
    if (!clamped.seo_description) warnings.push('模型没给出 seo_description')
  }
  if (tasks.includes('tldr')) {
    out.ai_tldr_summary = clamped.ai_tldr_summary
    if (!clamped.ai_tldr_summary) warnings.push('模型没给出 TL;DR')
  }
  if (tasks.includes('faq')) {
    out.geo_faq_list = clamped.geo_faq_list
    if (clamped.geo_faq_list.length === 0) warnings.push('模型没给出可用的问答')
  }
  if (tasks.includes('entities')) out.target_entities = clamped.target_entities
  if (tasks.includes('social')) {
    out.social_copies = clamped.social_copies
    if (Object.keys(clamped.social_copies).length === 0) warnings.push('模型没给出社媒文案')
  }

  // 长度 / 数量问题按字段报回去（只报本次要的字段，别拿没生成的东西吓人）
  const issues = growthFieldIssues(clamped).filter((issue) => {
    if (issue.field === 'seo_title' || issue.field === 'seo_description') return tasks.includes('seo')
    if (issue.field === 'ai_tldr_summary') return tasks.includes('tldr')
    if (issue.field === 'geo_faq_list') return tasks.includes('faq')
    if (issue.field === 'target_entities') return tasks.includes('entities')
    return tasks.includes('social')
  })
  for (let i = 0; i < issues.length; i += 1) warnings.push(issues[i].message)

  // TL;DR 的 45–60 是「词」不是「字符」：clampText 按词边界切字符数，极端情况下
  // 仍可能多出一两个词（一长串没有空格的短词），这里再确认一次。
  if (tasks.includes('tldr')) {
    const words = countWords(clamped.ai_tldr_summary)
    if (words > GROWTH_LIMITS.tldr.maxWords) {
      warnings.push(`TL;DR 仍是 ${words} 词（上限 ${GROWTH_LIMITS.tldr.maxWords}），建议人手删一句`)
    }
  }

  // 英文语法闸：只报不拦 —— 这是 AI 草案，人看过再保存。
  const english = [
    clamped.seo_title,
    clamped.seo_description,
    clamped.ai_tldr_summary,
    ...clamped.geo_faq_list.map((item) => `${item.question} ${item.answer}`),
    ...Object.values(clamped.social_copies),
  ]
    .filter(Boolean)
    .join('\n')
  const blockers = blockingTextIssues(english)
  if (blockers.length > 0) {
    warnings.push(`英文语法：${describeTextIssues(blockers)}`)
  } else {
    const soft = inspectEnglishText(english).length
    if (soft > 0) warnings.push(`英文语法有 ${soft} 处小提示，保存前扫一眼`)
  }

  return { fields: out, warnings }
}
