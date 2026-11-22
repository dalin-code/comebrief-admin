/**
 * Quiz Kit —— AI 起草与手写共用的「一卷测验」契约（纯逻辑、零依赖、可被 CI 断言）。
 *
 * 为什么要这一层（2026-11-09）：
 *   参照 `quiz-kit`（/Users/ludalin/Desktop/quiz-kit）的做法 —— 它把「一份测验」定成
 *   一个**可执行的结构**（模板 JSON + 5 条硬规则 + 配平模拟），而不是一段自然语言。
 *   我们要的正是这个：AI 产出的东西必须能被机器判对错，人再复核。
 *
 * 与 `quiz-kit` 的四处有意分歧（都是为了不和现有引擎打架）：
 *   ① **权重不交给 AI。** quiz-kit 让模型直接写每格权重，那样它每天都会写出
 *      「某列全 0」或「15/15/1/1」这类静默故障。这里只让 AI 回答一件事：
 *      **这个选项最像哪个原型**（`primary`），3/1 权重与轮转次权重由
 *      `lib/quizCompile.ts` 确定性地算 —— 同样的答案永远是同样的分布。
 *   ② **平局不另设仲裁题。** quiz-kit 写的是 `tieBreak: most recent`，而
 *      `lib/quizAxes.ts` 的规则是「平局取声明顺序靠前者」；两套并列会让
 *      「枚举说 20%，线上却是 19%」。这里只保留后者。
 *   ③ **matchPct 不给 100%。** 沿用 `MATCH_PCT_CAP = 97`（伪造感太重的实际反馈）。
 *   ④ **分类词表只有一份。** 直接用 `../ComeBrief/supabase/50_quiz_taxonomy.sql` 里
 *      那 6 个话题 + 16 个标签，写库也写这 6 个话题名（2026-11-22 统一之后，
 *      `quizzes.categories` 与 `quiz_topics.name` 是同一套词，不再有「旧词表」）。
 *      前后台同时认这 6 个词，所以换词不会让配色与「相关测验」错位。
 *
 * 这个文件只做三件事：**认得出**（normalize）、**判得准**（validate）、
 * **翻译得过去**（`topicToCategories()`；权重与 id 的落到 `lib/quizCompile.ts`）。
 */

import {
  MAX_NAME_CHARS,
  isAxeColor,
  parseAxePose,
  parseAxeQuadrant,
  type AxeAxes,
  type AxeQuadrant,
  type AXE_POSES,
} from './quizAxes'

/** 一卷「标准卷」的固定形状：4 个原型 × 8 题 × 4 选项。 */
export const KIT_ARCHETYPES = 4
export const KIT_QUESTIONS = 8
export const KIT_OPTIONS = 4

/** 海报上的 stats 最多 4 条（旧版 3 条，第 4 条是 AI 起草新增的喘口气位置）。 */
export const KIT_MAX_STATS = 4
/** 票根 / 卡片上的 pill 最多 4 个，每个 ≤ 18 字（与 axeChecks 的 pills 检查同口径）。 */
export const KIT_MAX_PILLS = 4
export const KIT_MAX_PILL_CHARS = 18
/** 轴端标签的长度上限：地图上那四个字是 `13px` 等宽大写，超过 18 字会绕到格子里。 */
export const KIT_MAX_AXIS_CHARS = 18

/** 题目 / 选项的字数上限：超过这个长度，360px 下选项会占满整屏。 */
export const KIT_MAX_QUESTION_CHARS = 120
export const KIT_MAX_OPTION_CHARS = 90
/** The Read 是一段话（2–3 句），但不要写成小作文。 */
export const KIT_MAX_SUMMARY_CHARS = 320
export const KIT_MAX_HEADLINE_CHARS = 90
export const KIT_MAX_QUOTE_CHARS = 140

/* ------------------------------------------------------------------ *
 * 1. 分类词表：与 50_quiz_taxonomy.sql 逐条对齐
 * ------------------------------------------------------------------ */

export type QuizTopicKey =
  | 'career'
  | 'personality'
  | 'pop-culture'
  | 'relationships'
  | 'lifestyle'
  | 'mindset'

export type QuizTopicDef = {
  key: QuizTopicKey
  /** 前台 /quizzes/topic/<slug> */
  slug: string
  name: string
  blurb: string
  color: string
  /** 旧分类名 / 常见叫法的反查表（大小写不敏感）—— 统一词表后只剩这一张表 */
  aliases: string[]
}

/**
 * 6 个话题。**顺序即优先级**：AI 给的分类词命中多个时取靠前的。
 *
 * 2026-11-22：与前台 `lib/categories.ts` / `quiz_topics` 表统一成同一份词表后，
 * `name` 就是写进 `quizzes.categories` 的值（触发器镜像的 `legacy_name` 也是它），
 * 所以这里**不再维护第二套「旧词」**—— 旧词（Persona / Sports / Social / Future /
 * Subconscious / Trivia & Knowledge…）全部沉到 `aliases` 里，只负责「认得出」。
 */
export const QUIZ_TOPICS: QuizTopicDef[] = [
  {
    key: 'career',
    slug: 'career',
    name: 'Career',
    blurb: 'Work, productivity, leadership, side hustles, and the Sunday-night dread.',
    color: '#0E2A3A',
    aliases: [
      'career',
      'future',
      'work',
      'job',
      'jobs',
      'workplace',
      'leadership',
      'productivity',
      'career & workstyle',
    ],
  },
  {
    key: 'personality',
    slug: 'personality',
    name: 'Personality',
    blurb: 'Archetypes, personas, and the parts of you that answer before you do.',
    color: '#F5C84C',
    aliases: [
      'personality',
      'persona',
      'archetype',
      'archetypes',
      'mbti',
      'psychology',
      'personality & psychology',
    ],
  },
  {
    key: 'pop-culture',
    slug: 'pop-culture',
    name: 'Pop Culture',
    blurb: "Memes, film, sports gossip, and the internet's current obsession.",
    color: '#FF6B3D',
    aliases: [
      'pop culture',
      'pop-culture',
      'sports',
      'sport',
      'entertainment',
      'anime',
      'film',
      'trivia',
      'knowledge',
      'trivia & knowledge',
      'technology',
      'tech',
    ],
  },
  {
    key: 'relationships',
    slug: 'relationships',
    name: 'Relationships',
    blurb: 'Green flags, red flags, and the group chat you call a support system.',
    color: '#CDBBFF',
    aliases: [
      'relationships',
      'relationship',
      'love',
      'love & relationships',
      'social',
      'dating',
      'friendship',
    ],
  },
  {
    key: 'lifestyle',
    slug: 'lifestyle',
    name: 'Lifestyle',
    blurb: 'Cottagecore, Y2K, taste, daily rhythm, or one clean line of minimalism.',
    color: '#E8E0D0',
    aliases: ['lifestyle', 'aesthetics', 'aesthetic', 'lifestyle & aesthetics', 'daily life', 'home'],
  },
  {
    key: 'mindset',
    slug: 'mindset',
    name: 'Mindset',
    blurb: 'Subconscious patterns, big decisions, and how you protect your energy.',
    color: '#0B0A12',
    aliases: ['mindset', 'subconscious', 'mental', 'emotions', 'decision making', 'energy'],
  },
]

/** 6 个展示名，按展示顺序（前台页签 / 后台分类按钮共用这一串）。 */
export const QUIZ_CATEGORY_ORDER: string[] = QUIZ_TOPICS.map((topic) => topic.name)


export type QuizTagKind = 'signal' | 'format' | 'aesthetic'

export type QuizTagDef = { slug: string; name: string; kind: QuizTagKind; aliases: string[] }

/** 16 个标签，与 `50_quiz_taxonomy.sql` 的 quiz_tags 初始数据一致。 */
export const QUIZ_TAGS: QuizTagDef[] = [
  { slug: 'k-pop', name: 'K-Pop', kind: 'signal', aliases: ['kpop', 'k pop'] },
  { slug: 'anime', name: 'Anime & Manga', kind: 'signal', aliases: ['manga', 'anime & manga'] },
  { slug: 'gaming', name: 'Gaming', kind: 'signal', aliases: ['video games', 'videogames'] },
  { slug: 'mbti', name: 'MBTI / Archetypes', kind: 'signal', aliases: ['archetypes', 'mbti'] },
  { slug: 'attachment', name: 'Attachment Style', kind: 'signal', aliases: ['attachment'] },
  { slug: 'booktok', name: 'BookTok', kind: 'signal', aliases: ['books', 'book tok'] },
  { slug: 'flags', name: 'Green / Red Flags', kind: 'signal', aliases: ['red flags', 'green flags'] },
  { slug: 'internet-lore', name: 'Internet Lore', kind: 'signal', aliases: ['memes', 'internet lore'] },
  { slug: 'personality', name: 'Personality', kind: 'format', aliases: [] },
  { slug: 'which', name: 'Which X', kind: 'format', aliases: ['which one'] },
  { slug: 'trivia', name: 'Trivia', kind: 'format', aliases: ['knowledge'] },
  { slug: 'picture', name: 'Picture', kind: 'format', aliases: ['visual'] },
  { slug: 'y2k', name: 'Y2K', kind: 'aesthetic', aliases: [] },
  { slug: 'cyberpunk', name: 'Cyberpunk', kind: 'aesthetic', aliases: [] },
  { slug: 'dark-academia', name: 'Dark Academia', kind: 'aesthetic', aliases: ['academia'] },
  { slug: 'cottagecore', name: 'Cottagecore', kind: 'aesthetic', aliases: ['cottage core'] },
]

const normKey = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9&-]/g, '')
    .replace(/^-+|-+$/g, '')

/** 认一个分类词（key / slug / 展示名 / 旧词别名都行）；认不出返回 null。 */
export function resolveQuizTopic(value: unknown): QuizTopicDef | null {
  const key = normKey(value)
  if (!key) return null
  for (const topic of QUIZ_TOPICS) {
    if (topic.key === key || topic.slug === key) return topic
    if (topic.name && normKey(topic.name) === key) return topic
    if (topic.aliases.some((alias) => normKey(alias) === key)) return topic
  }
  return null
}

/** 认一个标签（slug / 全名 / 别名）；认不出返回 null。 */
export function resolveQuizTag(value: unknown): QuizTagDef | null {
  const key = normKey(value)
  if (!key) return null
  for (const tag of QUIZ_TAGS) {
    if (tag.slug === key || normKey(tag.name) === key) return tag
    if (tag.aliases.some((alias) => normKey(alias) === key)) return tag
  }
  return null
}

/**
 * 话题 → 写进 `quizzes.categories` 的值。
 *
 * 统一词表之后只有一套词：`quiz_topics.name`（`name` 同时是 SQL 里
 * `legacy_name` 的镜像值），所以前台按 `categories[0]` 挑配色 / 聚合话题页，
 * 读到的就是后台分类屏上看到的同一个词。
 */
export function topicToCategories(topic: QuizTopicDef | null): string[] {
  if (!topic) return []
  return [topic.name]
}

/* ------------------------------------------------------------------ *
 * 2. 形状：AI 只回答 primary，权重由 code 算
 * ------------------------------------------------------------------ */

export type KitOption = {
  /** 选项文案（一句人话，不是标签） */
  text: string
  /** 这个选项最像哪个原型（必须是 archetypes[].id 之一） */
  primary: string
  /**
   * 这个动作本身的能量 1–3（结果页 Intensity 仪表）。
   *
   * 是**选项**的属性，和 `primary` 无关：同一题里 3 分权重的选项可以很安静
   * （"关掉手机享受夜晚"），1 分权重的也可以很张扬。缺了就整块仪表不渲染。
   */
  intensity?: number
  /** 多数人不会那么选的那一档（结果页 Bold picks）。每题最多一个。 */
  bold?: boolean
}

export type KitQuestion = {
  /** 场景行（"Monday, 9:03 AM"）；可缺 */
  scene?: string
  title: string
  options: KitOption[]
}

export type KitArchetype = {
  /** 稳定 id（小写字母数字-下划线），权重表的键 */
  id: string
  name: string
  short?: string
  headline?: string
  quote?: string
  /** The Read：2–3 句，讲「为什么你会落到这一档」 */
  summary?: string
  stats?: string[]
  pills?: string[]
  /** 结果页「答案地图」的角（`TL/TR/BL/BR`）。缺了地图退回雷达。 */
  quadrant?: AxeQuadrant
  /** 象限色 `#RRGGBB`（地图色块 / 配比条段色）。按象限选，不按名字选。 */
  color?: string
  /** 吉祥物姿态；缺了前台按 id 哈希挑一张（两个原型可能撞脸）。 */
  pose?: (typeof AXE_POSES)[number]
}

/** 一卷的来源信息 —— 落进 `raw_data.meta`，三个月后还能回答「这卷依据什么」。 */
export type KitMeta = {
  /** 用到的趋势条目 id（`TrendItem.id`） */
  trendIds?: string[]
  /** 用到的热词 */
  terms?: string[]
  /** 选题时的关键词（写题时复用） */
  keywords?: string[]
  /** 采集地区 / 时间窗，例如 US / 24h */
  geo?: string
  window?: string
  fetchedAt?: string
  generatedAt?: string
  model?: string
  /** 人工钉住的热词（提示词里要求必用） */
  pinned?: string[]
}

export type QuizKit = {
  title: string
  /** 列表卡片上的一句副标题（可选） */
  hook?: string
  topic: QuizTopicKey | null
  /** 认不出话题时保留模型原文，不丢信息 */
  topicLabel: string
  tags: string[]
  /** 这一版只有英文 */
  locale: 'en'
  archetypes: KitArchetype[]
  questions: KitQuestion[]
  meta: KitMeta
  /** 两条轴的四端标签（结果页地图的轴名）；缺了地图不渲染。 */
  axes?: AxeAxes
}

export type KitNormalizeResult = { kit: QuizKit; issues: string[] }

const isPlainObject = (v: unknown): v is Record<string, any> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 容忍地读一份 kit。
 *
 * 与 `normalizeAxeQuiz()` 同一套原则：**不抛异常**，认不出的地方记 issue、
 * 能补的补（缺 id 用下标、缺 locale 补 en），让「差一点」的模型输出还能进编辑器改。
 * 返回 null 只在「连 archetypes / questions 都没有」时发生 —— 那已经不是一份卷。
 */
export function normalizeQuizKit(raw: unknown): KitNormalizeResult | null {
  if (!isPlainObject(raw)) return null
  const issues: string[] = []

  const title = clip(oneLine(raw.title), 120)
  const hook = clip(oneLine(raw.hook ?? raw.subtitle), 140)
  const topicLabel = oneLine(raw.topic ?? raw.category ?? raw.topicLabel)
  const topic = resolveQuizTopic(topicLabel)
  if (topicLabel && !topic) issues.push(`认不出的分类「${topicLabel}」，已留给人工指定`)

  const tagInput = Array.isArray(raw.tags)
    ? raw.tags
    : typeof raw.tags === 'string'
      ? String(raw.tags).split(',')
      : []
  const tags: string[] = []
  for (const entry of tagInput) {
    const tag = resolveQuizTag(entry)
    if (!tag) continue
    if (tags.includes(tag.name)) continue
    tags.push(tag.name)
    if (tags.length >= 3) break
  }

  const rawArchetypes = Array.isArray(raw.archetypes) ? raw.archetypes.filter(isPlainObject) : []
  if (!rawArchetypes.length) return null

  const usedIds = new Set<string>()
  const archetypes: KitArchetype[] = rawArchetypes.map((a, index) => {
    const declaredId = normalizeArchetypeId(a.id ?? a.key)
    let id = declaredId || normalizeArchetypeId(a.name)
    if (!id) {
      id = `arch${index + 1}`
      issues.push(`第 ${index + 1} 个原型没有 id，已补成 ${id}`)
    } else if (!declaredId) {
      // 按名字推出来的 id 也要留痕：名字一改，权重表的键就跟着变（枚举会静默换一列）
      issues.push(`第 ${index + 1} 个原型没有 id，已按名字生成 ${id}`)
    }
    while (usedIds.has(id)) {
      id = `${id}${index + 1}`
      issues.push(`原型 id 重复，已改成 ${id}`)
    }
    usedIds.add(id)

    const stats = Array.isArray(a.stats)
      ? a.stats.map(oneLine).filter(Boolean).slice(0, KIT_MAX_STATS)
      : []
    const pills = Array.isArray(a.pills)
      ? a.pills
          .map(oneLine)
          .filter((p: string) => Boolean(p) && p.length <= KIT_MAX_PILL_CHARS)
          .slice(0, KIT_MAX_PILLS)
      : []

    return {
      id,
      name: clip(oneLine(a.name ?? a.title), MAX_NAME_CHARS + 20),
      short: clip(oneLine(a.short), 24) || undefined,
      headline: clip(oneLine(a.headline), KIT_MAX_HEADLINE_CHARS) || undefined,
      quote: clip(oneLine(a.quote), KIT_MAX_QUOTE_CHARS) || undefined,
      summary: clip(oneLine(a.summary ?? a.read), KIT_MAX_SUMMARY_CHARS) || undefined,
      stats: stats.length ? stats : undefined,
      pills: pills.length ? pills : undefined,
      // 这三格只透传、不补默认值：AI 没写就让它空着，由作者在编辑器里按象限挑色。
      // 但**过了白名单**才透传 —— 否则 `"tr "` / `"#fff"` 会一路写进库，前台静默丢弃。
      quadrant: parseAxeQuadrant(a.quadrant) ?? undefined,
      color: isAxeColor(a.color) ? oneLine(a.color) : undefined,
      pose: parseAxePose(a.pose) ?? undefined,
    }
  })

  const rawQuestions = Array.isArray(raw.questions) ? raw.questions.filter(isPlainObject) : []
  if (!rawQuestions.length) return null

  const questions: KitQuestion[] = rawQuestions.map((q, qi) => {
    const options = (Array.isArray(q.options) ? q.options : [])
      .filter(isPlainObject)
      .map((o, oi) => {
        const primary = normalizeArchetypeId(o.primary ?? o.archetype)
        if (!primary) issues.push(`Q${qi + 1} 选项 ${oi + 1} 没说是哪个原型（primary 缺失）`)
        const option: KitOption = { text: clip(oneLine(o.text ?? o.label), KIT_MAX_OPTION_CHARS), primary }
        // 数值同样只透传、不猜：AI 没写 intensity 时选项就不是「中等能量」，而是「没量过」。
        const intensity = Number(o.intensity)
        if (Number.isFinite(intensity) && intensity >= 1 && intensity <= 3) {
          option.intensity = Math.round(intensity)
        }
        if (o.bold === true || o.bold === 1 || o.bold === 'true') option.bold = true
        return option
      })
    return {
      scene: clip(oneLine(q.scene), 40) || undefined,
      title: clip(oneLine(q.title ?? q.question), KIT_MAX_QUESTION_CHARS),
      options,
    }
  })

  // 轴名：两端都有字才算一条轴，两条都在才落进 kit（半条轴画出来的地图没法读）。
  const axesSrc = isPlainObject(raw.axes) ? raw.axes : null
  const axisX = axesSrc && isPlainObject(axesSrc.x) ? axesSrc.x : null
  const axisY = axesSrc && isPlainObject(axesSrc.y) ? axesSrc.y : null
  const axes: AxeAxes | undefined =
    axisX && axisY && oneLine(axisX.neg) && oneLine(axisX.pos) && oneLine(axisY.neg) && oneLine(axisY.pos)
      ? {
          x: { neg: clip(oneLine(axisX.neg), KIT_MAX_AXIS_CHARS), pos: clip(oneLine(axisX.pos), KIT_MAX_AXIS_CHARS) },
          y: { neg: clip(oneLine(axisY.neg), KIT_MAX_AXIS_CHARS), pos: clip(oneLine(axisY.pos), KIT_MAX_AXIS_CHARS) },
        }
      : undefined

  return {
    kit: {
      title,
      hook: hook || undefined,
      topic: topic ? topic.key : null,
      topicLabel: topic ? topic.name : topicLabel,
      tags,
      locale: 'en',
      archetypes,
      questions,
      axes,
      meta: isPlainObject(raw.meta) ? (raw.meta as KitMeta) : {},
    },
    issues,
  }
}

/* ------------------------------------------------------------------ *
 * 3. 五条硬规则
 * ------------------------------------------------------------------ */

export type KitRuleId = 'archetypes' | 'questions' | 'options' | 'mapping' | 'copy'

export type KitRule = {
  id: KitRuleId
  /** blocker = 不能应用进编辑器；warning = 能应用，但要人再看一眼 */
  level: 'blocker' | 'warning'
  ok: boolean
  label: string
  detail?: string
}

export type KitValidation = {
  rules: KitRule[]
  blockers: KitRule[]
  warnings: KitRule[]
  /** 没有 blocker 才能「应用到编辑器」 */
  ok: boolean
}

/**
 * 把一份 kit 判成「能上」或「不能上」。
 *
 * 五条规则对应 quiz-kit 的五条硬约束，只是判据换成了我们这个引擎真正在意的东西：
 *   1. **archetypes**：正好 4 个、id 合法且唯一、名字非空且 ≤ 40 字、互不重复；
 *   2. **questions**：正好 8 题、题干非空且互不重复；
 *   3. **options**：每题正好 4 个、文案非空 / 不是占位 / 同题内不重复、≤ 90 字；
 *   4. **mapping**：每个选项的 primary 都是已声明的原型，且每题 4 个选项
 *      **恰好覆盖 4 个不同原型** —— 这一条是配平的来源：覆盖了，列合计天然相等；
 *      没覆盖，某列就会偏轻，实际作答会整片落进另一档；
 *   5. **copy**：每个原型都有 headline / quote / summary / ≥3 stats / ≥2 pills。
 *      缺席不拦应用（人还能在编辑器里补），但会标出来。
 */
export function validateQuizKit(kit: QuizKit): KitValidation {
  const rules: KitRule[] = []
  const ids = new Set(kit.archetypes.map((a) => a.id))
  const namesLower = kit.archetypes.map((a) => a.name.trim().toLowerCase())

  /* 1. 原型 */
  const badIds = kit.archetypes.filter((a) => !/^[a-z0-9_-]{2,32}$/.test(a.id))
  const badNames = kit.archetypes.filter((a) => !a.name.trim() || a.name.length > MAX_NAME_CHARS)
  const dupNames = [...new Set(namesLower.filter((n, i) => n && namesLower.indexOf(n) !== i))]
  const archetypeOk =
    kit.archetypes.length === KIT_ARCHETYPES &&
    ids.size === kit.archetypes.length &&
    badIds.length === 0 &&
    badNames.length === 0 &&
    dupNames.length === 0
  rules.push({
    id: 'archetypes',
    level: 'blocker',
    ok: archetypeOk,
    label:
      kit.archetypes.length === KIT_ARCHETYPES
        ? `${KIT_ARCHETYPES} 个原型 · id / 名字 / 唯一性`
        : `原型数量是 ${kit.archetypes.length}，必须是 ${KIT_ARCHETYPES}`,
    detail: archetypeOk
      ? undefined
      : [
          badIds.length ? `id 不合法：${badIds.map((a) => a.id || '(空)').join('、')}` : '',
          badNames.length
            ? `名字为空或超 ${MAX_NAME_CHARS} 字：${badNames.map((a) => a.name.slice(0, 12) || '(空)').join('、')}`
            : '',
          dupNames.length ? `结果名重复：${dupNames.join('、')}` : '',
        ]
          .filter(Boolean)
          .join('；'),
  })

  /* 2. 题目 */
  const titles = kit.questions.map((q) => q.title.trim().toLowerCase()).filter(Boolean)
  const dupTitles = [...new Set(titles.filter((t, i) => titles.indexOf(t) !== i))]
  const badTitles = kit.questions.filter(
    (q) => !q.title.trim() || q.title.length > KIT_MAX_QUESTION_CHARS
  )
  const questionOk =
    kit.questions.length === KIT_QUESTIONS && badTitles.length === 0 && dupTitles.length === 0
  rules.push({
    id: 'questions',
    level: 'blocker',
    ok: questionOk,
    label:
      kit.questions.length === KIT_QUESTIONS
        ? `${KIT_QUESTIONS} 题 · 题干非空且不重复`
        : `题数是 ${kit.questions.length}，必须是 ${KIT_QUESTIONS}`,
    detail: questionOk
      ? undefined
      : [
          badTitles.length
            ? `${badTitles.length} 道题题干为空或超过 ${KIT_MAX_QUESTION_CHARS} 字`
            : '',
          dupTitles.length ? `题干重复 ${dupTitles.length} 组` : '',
        ]
          .filter(Boolean)
          .join('；'),
  })

  /* 3. 选项 */
  const optionProblems: string[] = []
  kit.questions.forEach((q, qi) => {
    if (q.options.length !== KIT_OPTIONS) {
      optionProblems.push(`Q${qi + 1} 有 ${q.options.length} 个选项`)
      return
    }
    const texts = q.options.map((o) => o.text.trim().toLowerCase())
    if (q.options.some((o) => !o.text.trim() || isPlaceholder(o.text))) {
      optionProblems.push(`Q${qi + 1} 有空的 / 占位选项`)
    }
    if (q.options.some((o) => o.text.length > KIT_MAX_OPTION_CHARS)) {
      optionProblems.push(`Q${qi + 1} 有超过 ${KIT_MAX_OPTION_CHARS} 字的选项`)
    }
    if (new Set(texts).size !== texts.length) optionProblems.push(`Q${qi + 1} 选项文案重复`)
  })
  rules.push({
    id: 'options',
    level: 'blocker',
    ok: optionProblems.length === 0,
    label: `每题 ${KIT_OPTIONS} 个选项 · 非空 / 不重复 / ≤ ${KIT_MAX_OPTION_CHARS} 字`,
    detail: optionProblems.length ? optionProblems.slice(0, 4).join('；') : undefined,
  })

  /* 4. 指向：primary 必须存在，且每题覆盖 4 个不同原型 */
  const mappingProblems: string[] = []
  kit.questions.forEach((q, qi) => {
    const primaries = q.options.map((o) => o.primary)
    const unknown = primaries.filter((p) => !ids.has(p))
    if (unknown.length) {
      mappingProblems.push(
        `Q${qi + 1} 指向了不存在的原型：${[...new Set(unknown)].join('、') || '(空)'}`
      )
      return
    }
    if (new Set(primaries).size !== KIT_ARCHETYPES) {
      mappingProblems.push(
        `Q${qi + 1} 的 4 个选项没有覆盖 4 个原型（只有 ${new Set(primaries).size} 个）`
      )
    }
  })
  rules.push({
    id: 'mapping',
    level: 'blocker',
    ok: mappingProblems.length === 0,
    label: '每题 4 个选项分别指向 4 个不同原型（配平的来源）',
    detail: mappingProblems.length ? mappingProblems.slice(0, 4).join('；') : undefined,
  })

  /* 5. 文案：缺了能改，不拦应用 */
  const thin = kit.archetypes.filter(
    (a) =>
      !a.headline?.trim() ||
      !a.quote?.trim() ||
      !a.summary?.trim() ||
      (a.stats?.length ?? 0) < 3 ||
      (a.pills?.length ?? 0) < 2
  )
  rules.push({
    id: 'copy',
    level: 'warning',
    ok: thin.length === 0,
    label: '每个原型都有 headline / quote / summary / ≥3 stats / ≥2 pills',
    detail: thin.length ? `${thin.map((a) => a.name || a.id).join('、')} 的文案不完整` : undefined,
  })

  const blockers = rules.filter((r) => !r.ok && r.level === 'blocker')
  const warnings = rules.filter((r) => !r.ok && r.level === 'warning')
  return { rules, blockers, warnings, ok: blockers.length === 0 }
}

/** 组合用的便捷入口：raw → kit → 校验，一次给齐（UI 与路由都用这个）。 */
export function readQuizKit(raw: unknown): {
  kit: QuizKit | null
  issues: string[]
  validation: KitValidation | null
} {
  const normalized = normalizeQuizKit(raw)
  if (!normalized) {
    return { kit: null, issues: ['不是一份测验：缺 archetypes 或 questions'], validation: null }
  }
  return {
    kit: normalized.kit,
    issues: normalized.issues,
    validation: validateQuizKit(normalized.kit),
  }
}

/** 压掉换行与连续空格：题干里出现换行会让选项在窄屏上串行。 */
const oneLine = (v: unknown): string =>
  String(v ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const clip = (v: string, max: number): string => (v.length > max ? v.slice(0, max).trim() : v)

/** 原型 id 的合法化：小写、只留 a-z0-9_-，与矩阵编辑器 `renameArchetype` 同一规则。 */
export function normalizeArchetypeId(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32)
}

/** 光杆模板壳：整串只有 `Option A` / `Choice 2` / `Answer`（末尾允许一个标点）。 */
const PLACEHOLDER_EXACT = /^(option|choice|answer)\s*([a-d]|[1-4])?[.:;、。：]?$/i
/** 一眼假的短词：整串就是这几个字才算，`TBD` 后面跟正文的不算。 */
const PLACEHOLDER_WORD = /^(todo|tbd|n\/a)$/i
/** 假文永远不可能是真文案，所以这条允许后面继续跟词。 */
const PLACEHOLDER_PROSE = /^lorem ipsum\b/i

/**
 * 一眼假的占位文案。AI 偶尔会把模板里的 "Option A" 原样吐回来，
 * 这种卷在矩阵里看起来「有字」，上前台就是四个一模一样的空壳。
 *
 * **只认整串，不做前缀匹配** —— `option` / `choice` / `answer` 在英文选项里
 * 都是普通动词开头（`Answer with high energy…`、`Choice fatigue hits you first.`），
 * 前缀匹配会把好稿子判成占位：线上就有一份 8 题的卷子因为
 * `Answer with high energy for four minutes.` 被拦成「Q1 有空的 / 占位选项」。
 */
function isPlaceholder(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (PLACEHOLDER_EXACT.test(t)) return true
  if (PLACEHOLDER_WORD.test(t)) return true
  if (PLACEHOLDER_PROSE.test(t)) return true
  if (/^(undefined|null|nan)$/i.test(t)) return true
  if (/^[a-d]$/i.test(t)) return true
  return false
}
