/**
 * AI 起草的三段式提示词与归一化（**不联网、不读环境变量**，所以可离线断言）。
 *
 * 为什么拆成三段，而不是「一次让它写完整卷」：
 *   ① **选题**（trends → 4–6 个 idea）：这一步只该想「什么值得写」，不该写题；
 *   ② **文案**（idea → 4 个原型的名字 / headline / quote / The Read / stats / pills）：
 *      这一步决定「结果页长什么样」，它不需要看题目；
 *   ③ **题目**（idea + 4 个原型 → 8 题 × 4 选项，每个选项只回答 `primary`）：
 *      这一步是唯一需要「配平」的地方 —— 每题 4 个选项必须指向 4 个不同原型。
 *
 * 一次性生成的问题（实测过）：模型会先写人名再编题，四个原型里必有一个
 * 变成「其他」，或者 8 道题全是同一件事的换皮。拆段之后，每一段都有一个
 * **能被机器检查的产出**（`normalizeIdeas` / `validateQuizKit`），坏了只重跑那一段。
 *
 * 三段都要求**只输出 JSON**，解析放在路由里（`safeParseModelJson`），这样这一层
 * 保持零依赖，脚本可以直接跑提示词的断言。
 */

import {
  KIT_OPTIONS,
  KIT_QUESTIONS,
  QUIZ_TAGS,
  QUIZ_TOPICS,
  resolveQuizTag,
  resolveQuizTopic,
  type KitArchetype,
  type KitQuestion,
  type QuizKit,
  type QuizTopicKey,
} from './quizKit'

/** 一次给几个选题：4 个刚好够选，多了会让模型开始凑数。 */
export const QUIZ_IDEA_COUNT = 4

const TOPIC_LINES = QUIZ_TOPICS.map((topic) => `- ${topic.key}: ${topic.name} — ${topic.blurb}`).join('\n')
const TAG_LINES = QUIZ_TAGS.map((tag) => `${tag.name} (${tag.kind})`).join(', ')

/** 三段共用的「我是谁、我怎么写」。放 system，让供应商的提示词缓存能吃到。 */
export const QUIZ_SYSTEM = `You are the quiz editor of an English-language pop-culture site. The audience is 16–30, mostly US/UK, reading on a phone, and they will close the tab if the first question feels like homework.

House style:
- Second person, present tense, short sentences. Never write "the user" or "participants".
- Specific beats clever: "You rewatched the same 40 seconds three times" over "You are a media enthusiast".
- All four results must be flattering in different ways. Nobody gets a "you are boring / you are the worst one" result.
- No emoji, no hashtags, no ALL-CAPS shouting, no em-dash chains.
- English only. Use slang naturally (one or two words per quiz), never as a costume.
- Never mention politics, elections, war, disasters, illness, death, or crime. If a trend item is about those, ignore it.

Output rules:
- Reply with a single JSON object. No prose before or after, no markdown fences.
- Follow the requested schema exactly. Do not invent extra keys.
- If you are unsure, choose the safer, friendlier option.`

/* ------------------------------------------------------------------ *
 * 1. 选题
 * ------------------------------------------------------------------ */

export type QuizIdea = {
  title: string
  /** 一句话说明「这卷在问什么」 */
  angle: string
  /** 列表卡片上的副标题 */
  hook: string
  topic: QuizTopicKey | null
  topicLabel: string
  tags: string[]
  /** 四个结果的方向（不是最终名字） */
  archetypes: string[]
  /** 为什么是现在（引用趋势） */
  whyNow?: string
}

export function buildIdeaSystemPrompt(): string {
  return QUIZ_SYSTEM
}

export function buildIdeaUserPrompt(input: {
  /** 趋势标题块（已过滤敏感内容） */
  trendBlock: string
  /** 热词表块（entity / slang / phrase 三块） */
  vocabularyBlock?: string
  /** 人工钉住的词：必须至少有一个 idea 用到 */
  pinned?: string[]
  /** 最近已经做过的标题，避免重复 */
  avoidTitles?: string[]
  count?: number
}): string {
  const count = Math.max(1, Math.min(6, input.count ?? QUIZ_IDEA_COUNT))
  const avoid = (input.avoidTitles ?? []).map((t) => String(t || '').trim()).filter(Boolean).slice(0, 12)
  const pinned = (input.pinned ?? []).map((t) => String(t || '').trim()).filter(Boolean)

  const parts: string[] = []
  parts.push('## What is trending right now')
  parts.push(input.trendBlock || '(no trend data today — pick a timeless pop-culture angle instead)')
  if (input.vocabularyBlock) {
    parts.push('')
    parts.push('## Vocabulary in the air')
    parts.push(input.vocabularyBlock)
  }
  if (pinned.length) {
    parts.push('')
    parts.push('## Must-use (the editor pinned these)')
    parts.push(`- ${pinned.join('\n- ')}`)
  }
  parts.push('')
  parts.push('## Allowed topics')
  parts.push(TOPIC_LINES)
  parts.push('')
  parts.push('## Allowed tags')
  parts.push(TAG_LINES)
  if (avoid.length) {
    parts.push('')
    parts.push('## Already published recently (do NOT reuse these angles)')
    parts.push(`- ${avoid.join('\n- ')}`)
  }
  parts.push('')
  parts.push('## Task')
  parts.push(`Write ${count} quiz ideas that a 19-year-old would send to a group chat. Each idea must:`)
  parts.push('- be answerable in 8 taps and finish under 90 seconds;')
  parts.push('- have four results that are all flattering (no "worst" tier);')
  parts.push('- be tied to something in the trend list OR to a specific pinned word;')
  parts.push('- read like a person wrote it, not like a content calendar.')
  parts.push('- keep every string short (angle ≤ 25 words, whyNow ≤ 12 words): the response has a hard length budget and gets cut off if you overshoot.')
  parts.push('')
  parts.push('Return JSON:')
  parts.push('{')
  parts.push('  "ideas": [')
  parts.push('    {')
  parts.push('      "title": "the quiz title, ends with a question mark only if it is one",')
  parts.push('      "angle": "one sentence: what question does this quiz actually ask?",')
  parts.push('      "hook": "max 90 chars, the line under the title on a card",')
  parts.push('      "topic": "one of the topic keys above",')
  parts.push('      "tags": ["1–2 tag names from the list above"],')
  parts.push('      "archetypes": ["four short directions, 2–4 words each, all positive"],')
  parts.push('      "whyNow": "which trend or pinned word this comes from"')
  parts.push('    }')
  parts.push('  ]')
  parts.push('}')
  return parts.join('\n')
}

const oneLine = (value: unknown): string =>
  String(value ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * 选题的归一化：数组 / `{ideas:[…]}` 两种形状都认，认不出的整条丢掉（不补假数据）。
 * 标题必须有；topic 认不出就留给人工（`topic: null` + 原文进 `topicLabel`）。
 */
export function normalizeIdeas(raw: unknown, count = QUIZ_IDEA_COUNT): QuizIdea[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as any).ideas)
      ? (raw as any).ideas
      : []
  const out: QuizIdea[] = []
  const seen = new Set<string>()

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, any>
    const title = oneLine(item.title).slice(0, 120)
    if (!title) continue
    const key = title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    const topicRaw = oneLine(item.topic ?? item.category)
    const topic = resolveQuizTopic(topicRaw)
    const tagInput = Array.isArray(item.tags) ? item.tags : []
    const tags: string[] = []
    for (const tag of tagInput) {
      const resolved = resolveQuizTag(tag)
      if (resolved && !tags.includes(resolved.name)) tags.push(resolved.name)
      if (tags.length >= 3) break
    }

    out.push({
      title,
      angle: oneLine(item.angle ?? item.description).slice(0, 240),
      hook: oneLine(item.hook ?? item.subtitle).slice(0, 140),
      topic: topic ? topic.key : null,
      topicLabel: topic ? topic.name : topicRaw,
      tags,
      archetypes: (Array.isArray(item.archetypes) ? item.archetypes : [])
        .map((a: unknown) => oneLine(a))
        .filter(Boolean)
        .slice(0, 6),
      whyNow: oneLine(item.whyNow ?? item.reason).slice(0, 200) || undefined,
    })
    if (out.length >= count) break
  }

  return out
}

/* ------------------------------------------------------------------ *
 * 2. 文案（四个原型）
 * ------------------------------------------------------------------ */

export function buildCopyUserPrompt(input: { idea: QuizIdea; vocabularyBlock?: string }): string {
  const idea = input.idea
  const parts: string[] = []
  parts.push('## The quiz')
  parts.push(`Title: ${idea.title}`)
  if (idea.angle) parts.push(`Angle: ${idea.angle}`)
  if (idea.topicLabel) parts.push(`Topic: ${idea.topicLabel}`)
  if (idea.archetypes.length) parts.push(`Result directions the editor already liked: ${idea.archetypes.join(' / ')}`)
  if (input.vocabularyBlock) {
    parts.push('')
    parts.push('## Vocabulary in the air (tone reference only)')
    parts.push(input.vocabularyBlock)
  }
  parts.push('')
  parts.push('## Task')
  parts.push('Write the four results of this quiz. Each result is a person the reader will happily be.')
  parts.push('Requirements:')
  parts.push('- names: 2–6 words, concrete, no "The [Adjective] One"; max 40 characters;')
  parts.push('- ids: short lowercase slug of the name (a-z, 0-9, hyphen); four distinct ids;')
  parts.push('- headline: one sentence, max 90 chars, second person;')
  parts.push('- quote: something this person would actually say, max 140 chars, no quotes around it;')
  parts.push('- summary: THE READ — 2–3 sentences (max 320 chars) explaining why their answers add up to this. Be specific about behaviour, not flattering generic.');
  parts.push('- stats: exactly 3 or 4 short labels with a number or a time (they get printed on a poster). Examples: "3 group chats on mute", "97% reply rate", "2am scroll sessions";')
  parts.push('- pills: 2–4 tiny tags, max 18 chars each (printed on a ticket);')
  parts.push('- the four results must not overlap: each one wins for a different reason.')
  parts.push('')
  parts.push('Return JSON:')
  parts.push('{')
  parts.push('  "archetypes": [')
  parts.push('    {')
  parts.push('      "id": "sarcastic-curator",')
  parts.push('      "name": "The Sarcastic Meme Curator",')
  parts.push('      "short": "Sarcastic",')
  parts.push('      "headline": "You speak fluent irony.",')
  parts.push('      "quote": "I am not late, the timeline is early.",')
  parts.push('      "summary": "You read the room before you read the message...",')
  parts.push('      "stats": ["3 group chats on mute", "97% reply rate", "2am scroll sessions"],')
  parts.push('      "pills": ["Chronically online", "Screenshot hoarder"]')
  parts.push('    }')
  parts.push('  ]')
  parts.push('}')
  return parts.join('\n')
}

/** 文案段只认 `archetypes`：其余字段（title / tags）在这一步不重新生成。 */
export function normalizeCopy(raw: unknown): { archetypes: KitArchetype[] } {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as any).archetypes)
      ? (raw as any).archetypes
      : []
  const archetypes: KitArchetype[] = list
    .filter((entry: unknown) => Boolean(entry) && typeof entry === 'object')
    .map((entry: any) => ({
      id: oneLine(entry.id ?? entry.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
      name: oneLine(entry.name),
      short: oneLine(entry.short) || undefined,
      headline: oneLine(entry.headline) || undefined,
      quote: oneLine(entry.quote) || undefined,
      summary: oneLine(entry.summary ?? entry.read) || undefined,
      stats: Array.isArray(entry.stats) ? entry.stats.map((s: unknown) => oneLine(s)).filter(Boolean) : undefined,
      pills: Array.isArray(entry.pills) ? entry.pills.map((p: unknown) => oneLine(p)).filter(Boolean) : undefined,
    }))
  return { archetypes }
}

/* ------------------------------------------------------------------ *
 * 3. 题目（每题 4 个选项，各指向一个不同原型）
 * ------------------------------------------------------------------ */

export function buildQuestionsUserPrompt(input: {
  idea: QuizIdea
  archetypes: KitArchetype[]
  vocabularyBlock?: string
  /** 上一轮没通过的题号（只重写这几题时用） */
  rewriteIndexes?: number[]
}): string {
  const ids = input.archetypes.map((a) => a.id)
  const roster = input.archetypes.map((a) => `- ${a.id}: ${a.name}`).join('\n')
  const parts: string[] = []

  parts.push('## The quiz')
  parts.push(`Title: ${input.idea.title}`)
  if (input.idea.angle) parts.push(`Angle: ${input.idea.angle}`)
  parts.push('')
  parts.push('## The four results (use these ids EXACTLY)')
  parts.push(roster || '(missing)')
  if (input.vocabularyBlock) {
    parts.push('')
    parts.push('## Vocabulary in the air (one or two words max, do not force them)')
    parts.push(input.vocabularyBlock)
  }
  parts.push('')
  parts.push('## Task')
  parts.push(`Write ${KIT_QUESTIONS} multiple-choice questions for this quiz.`)
  parts.push('Hard rules:')
  parts.push(`1. Every question has exactly ${KIT_OPTIONS} options.`)
  parts.push(
    `2. The ${KIT_OPTIONS} options of one question must point at ${KIT_OPTIONS} DIFFERENT results — never two options with the same "primary". Rotate which result comes first so no result is always option A.`
  )
  parts.push('3. Options are actions or reactions, max 90 characters, all four roughly the same length. No "all of the above", no "none of these".')
  parts.push('4. Question titles are specific scenes from ordinary life (max 120 chars), not abstract questions like "How do you handle stress?".')
  parts.push('5. `scene` is optional: a short time/place stamp, max 40 chars ("Monday, 9:03 AM"). At most 4 questions get one.')
  parts.push('6. Every option must be something a real person would pick. If one option is obviously the "right" answer, rewrite it.')
  parts.push('7. Do not repeat the same verb at the start of two options in one question.')
  parts.push('')
  parts.push('Return JSON:')
  parts.push('{')
  parts.push('  "questions": [')
  parts.push('    {')
  parts.push('      "scene": "Monday, 9:03 AM",')
  parts.push('      "title": "Your group chat is on fire before you have had coffee. You...",')
  parts.push('      "options": [')
  parts.push(`        { "text": "Reply with a meme in four seconds", "primary": "${ids[0] ?? 'arch1'}" },`)
  parts.push(`        { "text": "Read the whole thing, type nothing", "primary": "${ids[1] ?? 'arch2'}" },`)
  parts.push(`        { "text": "Screenshot it for later", "primary": "${ids[2] ?? 'arch3'}" },`)
  parts.push(`        { "text": "Mute the chat until noon", "primary": "${ids[3] ?? 'arch4'}" }`)
  parts.push('      ]')
  parts.push('    }')
  parts.push('  ]')
  parts.push('}')
  if (input.rewriteIndexes?.length) {
    parts.push('')
    parts.push(`Only rewrite questions ${input.rewriteIndexes.map((i) => i + 1).join(', ')}; keep everything else identical.`)
  }
  return parts.join('\n')
}

/**
 * 题目段的归一化。
 *
 * 关键的一条：**不替模型「修」primary**。指向不存在的 id 就原样留着，
 * 让 `validateQuizKit` 的 `mapping` 规则去报 —— 悄悄改成一个存在的 id，
 * 结果就是四个选项其实指向同一个原型，而 UI 上一切正常。
 */
export function normalizeQuestions(raw: unknown): { questions: KitQuestion[] } {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as any).questions)
      ? (raw as any).questions
      : []
  const questions: KitQuestion[] = list
    .filter((entry: unknown) => Boolean(entry) && typeof entry === 'object')
    .map((entry: any) => ({
      scene: oneLine(entry.scene) || undefined,
      title: oneLine(entry.title ?? entry.question),
      options: (Array.isArray(entry.options) ? entry.options : [])
        .filter((option: unknown) => Boolean(option) && typeof option === 'object')
        .map((option: any) => ({
          text: oneLine(option.text ?? option.label),
          primary: oneLine(option.primary ?? option.archetype ?? option.id).toLowerCase().replace(/[^a-z0-9_-]/g, ''),
        })),
    }))
  return { questions }
}

/* ------------------------------------------------------------------ *
 * 4. 合并：选题 + 文案 + 题目 → 一份待校验的 kit
 * ------------------------------------------------------------------ */

/**
 * 把三段拼成一份 kit（还没校验）。
 *
 * `meta` 只放「这一卷依据什么」：趋势 id / 热词 / 地区 / 时间窗 / 模型。
 * 三个月后有人问「这题为什么这么出」，答案就在这里，而不是在某个人的记忆里。
 */
export function mergeQuizKit(input: {
  idea: QuizIdea
  archetypes: KitArchetype[]
  questions: KitQuestion[]
  meta?: QuizKit['meta']
}): QuizKit {
  return {
    title: input.idea.title,
    hook: input.idea.hook || undefined,
    topic: input.idea.topic,
    topicLabel: input.idea.topicLabel,
    tags: input.idea.tags,
    locale: 'en',
    archetypes: input.archetypes,
    questions: input.questions,
    meta: input.meta ?? {},
  }
}

/** 趋势条目 → 提示词里的标题块（带来源与热度，模型据此判断「热不热」）。 */
export function buildTrendBlock(
  items: Array<{ title: string; source: string; score?: number; note?: string }>,
  limit = 40
): string {
  return items
    .slice(0, limit)
    .map((item) => {
      const score = item.score ? ` · ${item.score.toLocaleString('en-US')}` : ''
      const note = item.note ? ` — ${item.note.slice(0, 90)}` : ''
      return `- [${item.source}${score}] ${item.title}${note}`
    })
    .join('\n')
}
