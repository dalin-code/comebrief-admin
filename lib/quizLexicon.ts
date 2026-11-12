/**
 * 热词抽取（离线可断言，不联网）。
 *
 * 为什么需要这一层：给 AI 的提示词里塞 60 条原始标题，它会写成「新闻摘要」；
 * 塞一份**词汇表**（谁 / 什么梗 / 哪句口头禅），它才会写出 18 岁的人会点开的题。
 *
 * 三类词分开抽，理由各不相同：
 *   · **entity**（实体）：人名 / 作品 / 品牌 —— 决定「这一卷讲谁」。靠大小写连读识别，
 *     所以 feed 里必须保留原始大小写（`stripHtml` 只去标签，不 lower）。
 *   · **slang**（俚语）：决定「这一卷怎么说话」。靠 `SLANG_SEEDS` 词表命中，
 *     因为「rizz / delulu / mid」这类词没法靠形态学识别。
 *   · **phrase**（词组）：跨条目标题重复出现的 2–3 词组合 —— 重复次数就是趋势强度。
 *
 * 打分 = 出现次数 + 跨源权重 + 类别加成。跨源加成是刻意的：
 * 「Taylor Swift」同时出现在 Google Trends、Wikipedia、PopCrave 才是真热，
 * 只在 BuzzFeed 出现一次的很可能只是一篇稿子。
 */

import { trendSourceDef, type TrendItem, type TrendSourceId } from './quizTrends'

export type HotWordKind = 'entity' | 'slang' | 'phrase'

export type HotWord = {
  term: string
  kind: HotWordKind
  /** 出现在哪些源（去重、按源权重降序） */
  sources: TrendSourceId[]
  /** 原始出现次数 */
  count: number
  /** 排序分（见文件头的公式） */
  score: number
  /** 一条示例标题，提示词里给人看 */
  sample: string
}

/**
 * 俚语词表。**只收能公开写在测验里、且不容易冒犯人的**：
 * 带性暗示 / 攻击群体 / 具体人名梗的都不收 —— 模型会照着用，而这是要上首页的文案。
 * 新增时保持小写；含空格的按词边界整句匹配。
 */
export const SLANG_SEEDS: string[] = [
  'rizz', 'delulu', 'delusionship', 'mid', 'aura', 'cooked', 'ate', 'slay', 'bussin', 'sus',
  'bet', 'cap', 'no cap', 'gyatt', 'skibidi', 'brat', 'brat summer', 'demure', 'very demure',
  'cozy', 'glazing', 'yapping', 'yapper', 'situationship', 'soft launch', 'hard launch',
  'ghosting', 'ghosted', 'breadcrumbing', 'orbiting', 'benching', 'cuffing season',
  'hot girl walk', 'girl dinner', 'boy math', 'girl math', 'roman empire', 'doomscrolling',
  'main character energy', 'pick me', 'ick', 'icks', 'canon event', 'lore', 'era',
  'aesthetic', 'flex', 'fomo', 'jomo', 'receipts', 'spill the tea', 'shade', 'snatched',
  'iconic', 'unhinged', 'feral', 'goblin mode', 'bed rotting', 'quiet quitting', 'rage bait',
  'clickbait', 'brainrot', 'touch grass', 'understood the assignment', 'giving',
  'lowkey', 'highkey', 'ngl', 'tbh', 'imho', 'irl', 'simp', 'stan', 'fanum tax', 'sigma',
  'mogging', 'looksmaxxing', 'mewing', 'sneaky link', 'talking stage', 'roster', 'softboy',
  'golden retriever boyfriend', 'black cat energy', 'feral girl', 'coastal grandma',
  'tomato girl', 'strawberry girl', 'clean girl', 'mob wife', 'loyalty test', 'photo dump',
  'healing era', 'villain era', 'flop era', 'red flag', 'green flag', 'red flags', 'green flags',
  'hyperfixation', 'hyperfixating', 'parasocial', 'nepo baby', 'mid-off', 'glow up',
  'hot take', 'cold take', 'unpopular opinion', 'trauma dumping', 'chronically online',
  'vibe check', 'vibes', 'vibe', 'based', 'cringe', 'cringey', 'goofy', 'gremlin',
  'hyperpop', 'y2k', 'blokecore', 'gorpcore', 'normcore', 'cottagecore', 'dark academia',
  'old money', 'quiet luxury', 'stealth wealth', 'dupe', 'dupes', 'haul', 'unboxing',
  'get ready with me', 'grwm', 'day in my life', 'streamer', 'speedrun', 'sweaty',
  'tryhard', 'nerfed', 'buffed', 'meta', 'smurf', 'noob', 'clutch', 'gg',
]

const SLANG_SET = new Set(SLANG_SEEDS)

/** 短语级的俚语（含空格的那几条）：按词边界匹配整句，而不是逐个 token。 */
const SLANG_PHRASES = SLANG_SEEDS.filter((seed) => seed.includes(' '))

/** 不算实体的词：句首大写、疑问词、时间词、泛化形容词。 */
const ENTITY_STOPWORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'here', 'there', 'then', 'than',
  'what', 'why', 'how', 'when', 'where', 'who', 'which', 'whose', 'whom',
  'you', 'your', 'yours', 'i', 'my', 'mine', 'me', 'we', 'our', 'us', 'they', 'their', 'them',
  'it', 'its', 'he', 'she', 'his', 'her', 'him',
  'and', 'but', 'or', 'nor', 'not', 'no', 'yes', 'so', 'if', 'as', 'at', 'by', 'for', 'from',
  'in', 'into', 'of', 'on', 'onto', 'over', 'under', 'with', 'without', 'about', 'after',
  'before', 'during', 'between', 'against', 'because', 'while', 'until', 'since',
  'just', 'now', 'today', 'tomorrow', 'yesterday', 'week', 'month', 'year', 'monday',
  'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december', 'new', 'best', 'top', 'first', 'last', 'next', 'real',
  'true', 'fake', 'viral', 'breaking', 'exclusive', 'watch', 'video', 'photos', 'update',
  'live', 'still', 'more', 'most', 'all', 'some', 'any', 'every', 'one', 'two', 'three',
  'says', 'said', 'amid', 'via', 'report', 'reports', 'news',
])

/** 实体里允许夹带的连接词（"House of the Dragon" / "Van Gogh"）。 */
const ENTITY_CONNECTORS = new Set(['of', 'the', 'and', 'de', 'da', 'van', 'von', 'la', 'du', '&'])

const tokenize = (text: string): string[] =>
  String(text ?? '')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .split(/[^A-Za-z0-9'&.-]+/)
    .map((token) => token.replace(/^[.'-]+|[.'-]+$/g, ''))
    .filter(Boolean)

const isCapitalized = (token: string): boolean => /^[A-Z]/.test(token) && /[A-Za-z]/.test(token)

/** 一条标题里所有「连续大写词」的实体候选（保留原始大小写）。 */
function entitySpans(title: string): string[] {
  const tokens = tokenize(title)
  const spans: string[] = []
  let index = 0

  while (index < tokens.length) {
    const token = tokens[index]
    if (!isCapitalized(token) || ENTITY_STOPWORDS.has(token.toLowerCase())) {
      index += 1
      continue
    }

    const parts = [token]
    let cursor = index + 1
    while (cursor < tokens.length) {
      const next = tokens[cursor]
      if (isCapitalized(next) && !ENTITY_STOPWORDS.has(next.toLowerCase())) {
        parts.push(next)
        cursor += 1
        continue
      }
      // 连接词后面必须还是大写，才算同一个实体
      if (
        ENTITY_CONNECTORS.has(next.toLowerCase()) &&
        cursor + 1 < tokens.length &&
        isCapitalized(tokens[cursor + 1])
      ) {
        parts.push(next)
        cursor += 1
        continue
      }
      break
    }

    const span = parts.join(' ')
    // 单字母 / 两个字母的「实体」多半是句首缩写或噪声（"A"、"OK"）；
    // 超过 4 个词的「实体」是整句 Title Case 的标题（"Knockout Stage Semi-final
    // Post-Match Discussion"），不是人名 / 作品名 —— 两种都丢掉。
    const letters = span.replace(/[^A-Za-z0-9]/g, '')
    if (letters.length >= 3 && parts.length <= 4) spans.push(span)
    index = cursor
  }

  return spans
}

/** 2–3 词的低频短语（全小写），用来捞「没有大写、但反复出现」的说法。 */
function phraseSpans(title: string): string[] {
  const tokens = tokenize(title).map((token) => token.toLowerCase())
  const spans: string[] = []
  for (let size = 2; size <= 3; size += 1) {
    for (let start = 0; start + size <= tokens.length; start += 1) {
      const slice = tokens.slice(start, start + size)
      if (slice.some((token) => token.length < 2)) continue
      spans.push(slice.join(' '))
    }
  }
  return spans
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const containsPhrase = (haystack: string, phrase: string): boolean =>
  new RegExp(`(^|[^a-z])${escapeRegex(phrase)}([^a-z]|$)`, 'i').test(haystack)

/**
 * 这些源的标题**本身就是查询词**（不是一句话），所以整条标题就该是一个热词。
 *
 * 实测：Google Trends 的 `<title>` 是 `zach lavine` / `pak vs sl` 这种全小写查询，
 * 既没有大写实体、又凑不出重复 n-gram —— 不整条收下的话，最热的那些词一个都抽不出来。
 * 维基的条目标题同理（`KPop Demon Hunters`），只是它大多能靠大写规则抓到。
 */
const QUERY_SOURCES = new Set<TrendSourceId>(['google-trends', 'wikipedia'])

type Bucket = {
  term: string
  kind: HotWordKind
  count: number
  sources: Set<TrendSourceId>
  sample: string
}

const scoreOf = (bucket: Bucket): number => {
  const weightSum = Array.from(bucket.sources).reduce(
    (sum, source) => sum + (trendSourceDef(source)?.weight ?? 1),
    0
  )
  const kindBonus = bucket.kind === 'slang' ? 4 : bucket.kind === 'entity' ? 2 : 1
  const crossSourceBonus = bucket.sources.size > 1 ? bucket.sources.size * 2 : 0
  return bucket.count * 2 + weightSum + kindBonus + crossSourceBonus
}

/**
 * 从趋势条目里抽热词。
 *
 * `pinned` 是人工钉住的词（向导里点过星标的）：它们**一定出现在结果里**，
 * 且排在最前面 —— 站长说「这期要做这个梗」，模型就没有不给它的余地。
 */
export function extractHotWords(
  items: TrendItem[],
  options: { limit?: number; pinned?: string[] } = {}
): HotWord[] {
  const limit = options.limit ?? 40
  const buckets = new Map<string, Bucket>()

  const add = (rawTerm: string, kind: HotWordKind, item: TrendItem, sample: string) => {
    const term = rawTerm.replace(/\s+/g, ' ').trim()
    if (!term) return
    const key = `${kind}:${term.toLowerCase()}`
    const existing = buckets.get(key)
    if (existing) {
      existing.count += 1
      existing.sources.add(item.source)
      return
    }
    buckets.set(key, { term, kind, count: 1, sources: new Set([item.source]), sample })
  }

  for (const item of items) {
    const title = item.title
    const haystack = `${title} ${item.note ?? ''}`

    const spans = entitySpans(title)
    for (const span of spans) add(span, 'entity', item, title)
    // 查询型源：整条标题就是一个热词（全小写也照收）。
    // 已被大写规则整条命中的就不再重复记一次 —— 否则 count 会凭空翻倍，
    // 让「只在维基出现一次」的人名排到「三个源都在提」的词前面。
    if (QUERY_SOURCES.has(item.source)) {
      const tokens = tokenize(title)
      const whole = title.trim().toLowerCase()
      const covered = spans.some((span) => span.toLowerCase() === whole)
      if (!covered && tokens.length >= 1 && tokens.length <= 6) add(title, 'entity', item, title)
    }
    for (const span of phraseSpans(title)) {
      // 与俚语词表 / 已抽到的实体重合的，交给对应分支，避免同一个词出现两次
      if (SLANG_SET.has(span) || buckets.has(`entity:${span}`)) continue
      add(span, 'phrase', item, title)
    }
    for (const seed of SLANG_PHRASES) {
      if (containsPhrase(haystack, seed)) add(seed, 'slang', item, title)
    }
    for (const token of tokenize(haystack)) {
      const lower = token.toLowerCase()
      if (!SLANG_SET.has(lower) || lower.includes(' ')) continue
      add(lower, 'slang', item, title)
    }
  }

  // 词组只留「至少两条标题、且来自两个不同源」的：
  // 只出现一次的 n-gram 是句子碎片；同一个源里两条相似标题（比如两场同赛事的讨论帖）
  // 也不该让 "stage semi-final" 这种碎片爬到最前面。
  const kept: HotWord[] = []
  for (const bucket of buckets.values()) {
    if (bucket.kind === 'phrase' && (bucket.count < 2 || bucket.sources.size < 2)) continue
    kept.push({
      term: bucket.term,
      kind: bucket.kind,
      sources: Array.from(bucket.sources).sort(
        (a, b) => (trendSourceDef(b)?.weight ?? 1) - (trendSourceDef(a)?.weight ?? 1)
      ),
      count: bucket.count,
      score: scoreOf(bucket),
      sample: bucket.sample,
    })
  }

  const pinned = (options.pinned ?? []).map((term) => term.trim()).filter(Boolean)
  for (const term of pinned) {
    const key = term.toLowerCase()
    const hit = kept.find((word) => word.term.toLowerCase() === key)
    if (hit) {
      hit.score += 1_000
      continue
    }
    kept.push({ term, kind: 'phrase', sources: [], count: 0, score: 1_000, sample: term })
  }

  return kept
    .sort((a, b) => b.score - a.score || b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, limit)
}

/**
 * 词汇表 → 提示词里的三块（实体 / 俚语 / 词组）。
 *
 * 分块而不是一坨列表：模型对「这些人名」「这些口头禅」的处理方式本来就不同
 * （前者要出现在题干里，后者要出现在选项的语气里）。空块直接不出，
 * 免得提示词里出现一个只有标题的空 section。
 */
export function buildVocabularyBlock(hot: HotWord[], limit = 24): string {
  const pick = (kind: HotWordKind) =>
    hot
      .filter((word) => word.kind === kind)
      .slice(0, limit)
      .map((word) => (word.sources.length ? `${word.term} (${word.sources.join('/')})` : word.term))

  const entities = pick('entity')
  const slang = pick('slang')
  const phrases = pick('phrase')
  const blocks: string[] = []
  if (entities.length) {
    blocks.push(`ENTITIES (people / titles / brands in the air right now):\n- ${entities.join('\n- ')}`)
  }
  if (slang.length) {
    blocks.push(`SLANG (use the register, don't staple words in):\n- ${slang.join('\n- ')}`)
  }
  if (phrases.length) {
    blocks.push(`PHRASES (recurring across sources):\n- ${phrases.join('\n- ')}`)
  }
  return blocks.join('\n\n')
}
