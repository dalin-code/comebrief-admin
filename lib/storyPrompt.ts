/**
 * 故事创作面板的「大脑」 —— 把站长选中的标签，翻译成给 AI 的写作指令。
 *
 * 设计要点（这是整套功能里最值得花心思的一块）：
 *   1. 每个标签不只是把名字塞进去，而是把「定义 + 例句」一起给模型。
 *      只给名字（例如"白描"），模型会自己去猜，出来的东西往往很油；
 *      给了例句，它就有了可以模仿的手感。
 *   2. 末尾的禁忌清单是必须的。不写清楚，模型会自动往「升华、总结人生、
 *      仿佛/似乎、命运/灵魂」这些方向滑 —— 那就是所谓"AI 味"。
 *   3. 输出用 <<<TITLE>>> 这种分隔符而不是 JSON：1500 字的中文正文塞进 JSON
 *      字符串里，转义很容易出问题；纯文本分隔符则天然安全。
 */

export type DimensionKey = 'genre' | 'era' | 'pov' | 'style' | 'structure' | 'ending' | 'pace'

/**
 * 去掉模型偶尔自己加的 ``` 包裹。
 * 放在这个文件里（而不是 aiGemini）是为了让 storyPrompt 保持「零依赖」——
 * 后台面板是客户端组件，也会 import 这个文件做预览清洗，不能把服务端工具带进浏览器。
 */
export const stripFences = (text: string) =>
  String(text || '')
    .replace(/^\s*```[a-zA-Z]*[ \t]*\r?\n/, '')
    .replace(/\r?\n?```\s*$/, '')
    .trim()

/** HTML 正文 → 纯文本（翻译、摘要、字数统计都要先看纯文本） */
export const htmlToPlainText = (html: string) =>
  String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|blockquote|li|div)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

export type StoryTag = {
  id: string
  dimension: DimensionKey
  name: string
  summary: string
  example: string
  usage_note: string
  sort_order: number
  is_active: boolean
}

export type StoryCombo = Partial<Record<DimensionKey, string[]>> & {
  length?: number
  idea?: string
  materials?: string
  /** 写法 code（A–F）。留空 = 用 story_skills 表里的默认写法 */
  skill?: string
}

/** 7 排的显示顺序与中文名 —— 后台面板与提示词共用这一份定义，不会再对不上 */
export const DIMENSIONS: Array<{
  key: DimensionKey
  label: string
  cn: string
  hint: string
  /** 最多能选几个 */
  max: number
}> = [
  { key: 'genre', label: '题材', cn: '①', hint: '写什么', max: 2 },
  { key: 'era', label: '时代', cn: '②', hint: '发生在什么时候', max: 1 },
  { key: 'pov', label: '视角', cn: '③', hint: '谁在讲', max: 1 },
  { key: 'style', label: '风格', cn: '④', hint: '语言长什么样', max: 2 },
  { key: 'structure', label: '结构', cn: '⑤', hint: '怎么排', max: 1 },
  { key: 'ending', label: '结局', cn: '⑥', hint: '怎么收', max: 1 },
  { key: 'pace', label: '节奏', cn: '⑦', hint: '快还是慢', max: 1 },
]

export const LENGTH_PRESETS = [
  { value: 800, label: '短（约 800 字）' },
  { value: 1500, label: '中（约 1500 字）' },
  { value: 2500, label: '长（约 2500 字）' },
]

/** 全局禁忌清单 —— 这一段的措辞直接决定成品有没有"AI 味" */
const FORBIDDEN = [
  '不许升华点题、不许在结尾总结人生道理',
  '不许写「他感到害怕」「她很伤心」这类直接把情绪说出来的句子',
  '不许出现命运、灵魂、救赎、深渊、宿命这类大词',
  '不许用排比句堆砌气氛，不许写散文诗',
  '不要连续使用「仿佛 / 似乎 / 好像」，全文最多出现两次',
  '不许出现「本文」「这个故事告诉我们」这类旁白',
]

const OUTPUT_SPEC = [
  '【输出格式（严格照办，不要输出任何多余内容）】',
  '<<<TITLE>>>',
  '（一份中文标题，12 字以内，不要加书名号）',
  '<<<EXCERPT>>>',
  '（80–120 字的内容摘要，用于前台列表页，不要剧透结局）',
  '<<<BODY>>>',
  '（正文：用 <p> 分段；需要小标题时用 <h3>；强调用 <strong>；引用用 <blockquote>）',
]

function renderTags(tags: StoryTag[] | undefined) {
  const list = (tags || []).filter(Boolean)
  if (!list.length) return ''
  return list
    .map((t) => {
      const lines = [`  ${t.summary || t.name}`]
      if (t.example) lines.push(`  例句参考：${t.example}`)
      if (t.usage_note) lines.push(`  适用：${t.usage_note}`)
      return lines.join('\n')
    })
    .join('\n')
}

/**
 * 拼出「生成一篇中文短篇」的完整指令。
 * combo 里某个维度没选 → 那段就不出现，把决定权交给模型。
 */
/** 「写作要求 + 禁忌清单 + 输出格式」—— 每次生成都一模一样，独立出来放 system，可被提示缓存 */
function buildStoryRules() {
  return [
    '【写作要求】',
    `- 直接开始讲故事。不要写标题、不要写「以下是」、不要解释、不要在结尾总结。`,
    '- 用具体的动作、对话、物件推进剧情；形容词能省就省。',
    '- 人名、地名要具体（例如「林晚」「城西老小区」），不要用「小明」「某地」这类占位词。',
    '- 使用中文全角标点。对话用「」或「」，全文统一。',
    '',
    '【禁忌清单（出现任何一条都算失败）】',
    ...FORBIDDEN.map((x) => `- ${x}`),
    '',
    ...OUTPUT_SPEC,
  ].join('\n')
}

/** 「标签设定 + 构思 + 素材 + 篇幅」—— 每篇都不一样，放 user；且放在最后，模型记得最牢 */
function buildStorySetting(input: {
  combo: StoryCombo
  tagsByDimension: Partial<Record<DimensionKey, StoryTag[]>>
  idea: string
  materials: string
  length: number
}) {
  const { tagsByDimension, idea, materials, length } = input
  const lengthMin = Math.max(200, Math.round(length * 0.9))
  const lengthMax = Math.round(length * 1.15)

  const settingBlocks: string[] = []
  for (const dim of DIMENSIONS) {
    const picked = tagsByDimension[dim.key]
    if (!picked || !picked.length) continue
    const names = picked.map((t) => t.name).join(' ＋ ')
    settingBlocks.push(`【${dim.cn} ${dim.label}】${names}\n${renderTags(picked)}`)
  }

  const parts = [
    settingBlocks.length ? settingBlocks.join('\n\n') : '（本次没有指定维度，请你自行判断最合适的写法。）',
    '',
    '【本篇构思（必须围绕它写，不要跑题）】',
    idea.trim() || '（没有额外构思：请围绕上面选定的题材自行设计一个具体、可信、有画面的故事。）',
  ]

  if (materials.trim()) {
    parts.push(
      '',
      '【可参考的素材（用来获取细节和真实感，不要照抄句子）】',
      materials.trim().slice(0, 4000)
    )
  }

  parts.push('', `【篇幅】${length} 字左右（${lengthMin}–${lengthMax} 字之间，宁可写满也不要写短）`)

  return parts.join('\n')
}

/** 角色定位 —— system 的第一段，永远不变 */
const STORY_ROLE = [
  '你是一位中文短篇小说作家，专门写两三分钟就能读完的短篇。',
  '请严格按照下面的设定，写一篇完整的故事。',
].join('\n')

/* ============================================================
 * 写法层（story_skills）：同一套标签，"怎么写"还能再换一档
 *
 * 背景：AI 味主要不在用词，而在**叙述姿态**（句长、停顿、说多少、
 * 什么时候收）。所以每个写法给三样东西：
 *   posture  姿态板 —— 明确告诉模型这次要偏在哪几条上
 *   exemplar 范文   —— 让它直接模仿手感，比讲一百句道理有用
 *   rules    专属规矩 + avoid 易踩的坑
 * ============================================================ */

export type StorySkill = {
  id?: string
  /** A/B/C/D/E/F —— 后台选择器上显示的那个字母 */
  code: string
  name: string
  /** 一句话卖点，选择器上的一行小字 */
  tagline?: string
  summary: string
  posture: string
  exemplar: string
  rules: string
  avoid: string
  /** 适合什么题材，只在后台展示，不进提示词 */
  best_for?: string
  /** 下面是库里那几列，只给后台管理页用（生成时不读） */
  sort_order?: number
  is_active?: boolean
  is_default?: boolean
}

/** 把写法渲染成提示词里的一段 */
export function buildSkillBlock(skill: StorySkill) {
  const parts: string[] = []
  parts.push(`【本次写法 · ${skill.code ? `${skill.code} ` : ''}${skill.name}】`)
  if (skill.summary.trim()) parts.push(`这个写法在干什么：${skill.summary.trim()}`)
  if (skill.posture.trim()) {
    parts.push('', '【姿态板：这次必须明显偏在这几条上（不偏就是 AI 的默认腔调，也就是所谓的 AI 味）】', skill.posture.trim())
  }
  if (skill.rules.trim()) parts.push('', '【这个写法专属的规矩】', skill.rules.trim())
  if (skill.avoid.trim()) parts.push('', '【这个写法最容易踩的坑（踩了就算写砸）】', skill.avoid.trim())
  if (skill.exemplar.trim()) {
    parts.push(
      '',
      '【范文：学它的句子长短、停顿位置、句子怎么结束 —— 不要抄情节、不要抄人物、不要抄句子】',
      skill.exemplar.trim()
    )
  }
  return parts.join('\n')
}

/**
 * system 提示词：稳定不变的那一半。
 * 顺序是「角色 → 写法（含范文）→ 写作要求与禁忌 → 输出格式」。
 * 每一段都不随请求变化，所以能稳定命中提示缓存 —— 别往里面塞随请求变的东西。
 */
export function buildStorySystemPrompt(skill?: StorySkill | null) {
  const parts: string[] = [STORY_ROLE]
  if (skill) parts.push('', buildSkillBlock(skill))
  parts.push('', buildStoryRules())
  return parts.join('\n')
}

/** user 提示词：这一篇专属的那一半（标签 + 构思 + 素材 + 篇幅） */
export function buildStoryUserPrompt(input: {
  combo: StoryCombo
  tagsByDimension: Partial<Record<DimensionKey, StoryTag[]>>
  idea: string
  materials: string
  length: number
}) {
  return buildStorySetting(input)
}

/**
 * 兼容函数：把两半拼成「一整段」。
 * 拼接顺序与拆分前逐字节一致 —— P0 盲测脚本靠它保证多次运行用的是同一份提示词。
 */
export function buildStoryPrompt(input: {
  combo: StoryCombo
  tagsByDimension: Partial<Record<DimensionKey, StoryTag[]>>
  idea: string
  materials: string
  length: number
  /** 选了写法就把范文一起给模型；不传则与拆分前的提示词逐字节一致 */
  skill?: StorySkill | null
}) {
  const parts: string[] = [STORY_ROLE, '']
  if (input.skill) parts.push(buildSkillBlock(input.skill), '')
  parts.push(buildStorySetting(input), '', buildStoryRules())
  return parts.join('\n')
}

/** 文风/结构类标签在提示词里的权重最高 —— 单独导出给「为什么这么写」的说明用 */
export function describeCombo(tagsByDimension: Partial<Record<DimensionKey, StoryTag[]>>) {
  return DIMENSIONS.filter((d) => (tagsByDimension[d.key] || []).length)
    .map((d) => `${d.label}：${(tagsByDimension[d.key] || []).map((t) => t.name).join('＋')}`)
    .join(' · ')
}

/**
 * 中文 → 英文。
 * 站长选的方案是「母语化重写」：读起来必须像英语作家直接写的，不能有翻译腔；
 * 但情节、情绪、结局、伏笔位置一律不动 —— 这是不能越的红线。
 */
export function buildTranslatePrompt(input: {
  zhTitle: string
  zhExcerpt: string
  zhBodyText: string
  zhLength: number
}) {
  const { zhTitle, zhExcerpt, zhBodyText, zhLength } = input
  // 中文 → 英文的经验字数比约 1 : 0.65（词）
  const words = Math.max(400, Math.round(zhLength * 0.65))
  const wordsMin = Math.round(words * 0.85)
  const wordsMax = Math.round(words * 1.2)

  return [
    'You are a native English-speaking fiction editor.',
    'Below is a finished short story written in Chinese.',
    'Rewrite it as an ORIGINAL ENGLISH short story — a reader must never feel it was translated.',
    '',
    '【不可越界的红线】',
    '1. 情节、人物、人物关系、情绪走向、结局指向、伏笔位置，一律保持不变。',
    '   不许增加情节、不许删减情节、不许新增角色、不许改结局。',
    '2. 不要解释中国文化背景，也不要加译注 —— 需要读者自己体会的地方就让它留白。',
    '',
    '【可以自由发挥的地方】',
    '3. 句子顺序可以重组；中文成语、俗语不要直译，换成英语读者熟悉的说法。',
    '4. 中文的「留白」用英语的短句、停顿、留白来还原，不要补充说明。',
    '5. 保持原文的语气与节奏：原文快就快，原文慢就慢，原文冷就冷。',
    '6. 人名可以保留拼音（如 Lin Wan），也可以换成自然的英文名；全篇统一。',
    '',
    `【篇幅】English, ${wordsMin}–${wordsMax} words（对应中文约 ${zhLength} 字）。`,
    '',
    '【英文写作要求】',
    '- Use straight, concrete prose. Show, do not tell. Avoid adjectives piling up.',
    '- 用英语全角标点；引号用弯引号 “ ”；破折号用 —。',
    '- 不要写标题以外的任何说明文字。',
    '',
    '【原始中文信息】',
    `中文标题：${zhTitle || '（无）'}`,
    `中文摘要：${zhExcerpt || '（无）'}`,
    '',
    '中文正文：',
    zhBodyText.slice(0, 12000),
    '',
    '【输出格式（严格照办，不要输出任何多余内容）】',
    '<<<TITLE>>>',
    '(The English title, in Title Case.)',
    '<<<EXCERPT>>>',
    '(A 120–180 character English excerpt for the listing page. Do not spoil the ending.)',
    '<<<BODY>>>',
    '(The English story body. Use <p> for paragraphs, <h3> for a section heading if needed, <strong> for emphasis, <blockquote> for quoted passages.)',
  ].join('\n')
}

/** 生成摘要 —— 跟随当前语言页签：中文页签生成中文摘要，英文页签生成英文摘要 */
export function buildExcerptPrompt(input: {
  language: 'zh' | 'en'
  title: string
  bodyText: string
  excerpt?: string
}) {
  const { language, title, bodyText } = input
  if (language === 'zh') {
    return [
      '下面是一篇文章的标题和正文。请为它写一段摘要。',
      '',
      '要求：',
      '- 一段话，80–120 个汉字，中间不要换行。',
      '- 说清「讲了什么」＋「为什么值得读」，制造一点点好奇。',
      '- 不要剧透结局，不要用「本文」「这篇文章」开头，不要用引号包裹。',
      '- 只输出摘要本身，不要任何前后缀。',
      '',
      `标题：${title || '（无）'}`,
      '正文：',
      bodyText.slice(0, 8000),
    ].join('\n')
  }
  return [
    'Below is the title and body of an article. Write a summary for it.',
    '',
    'Requirements:',
    '- One paragraph, 120–180 characters, no line breaks.',
    '- Cover what the story is about and why it is worth reading; create a little curiosity.',
    '- Do not spoil the ending. Do not start with "This article". Do not wrap it in quotes.',
    '- Output the summary only, with no prefix or suffix.',
    '',
    `Title: ${title || '(none)'}`,
    'Body:',
    bodyText.slice(0, 8000),
  ].join('\n')
}

/* ============================================================
 * 输出解析与清洗
 * ============================================================ */

const SECTION_KEYS = ['TITLE', 'EXCERPT', 'BODY'] as const

/** 取 `<<<KEY>>>` 到下一个分隔符之间的内容 */
function pickSection(text: string, key: string) {
  const marker = `<<<${key}>>>`
  const start = text.indexOf(marker)
  if (start === -1) return ''
  const after = text.slice(start + marker.length)
  const next = after.search(/<<<[A-Z_]+>>>/)
  return (next === -1 ? after : after.slice(0, next)).trim()
}

/**
 * 解析三段式输出。
 * 正文用「BODY 之后全部内容」兜底，这样即使模型把 EXCERPT 落下了也不会吃掉正文。
 * 完全没写分隔符时 → 整段当成正文，标题由调用处兜底。
 */
export function parseDelimitedStory(raw: string): { title: string; excerpt: string; body: string } {
  const text = stripFences(String(raw || ''))
  if (!SECTION_KEYS.some((k) => text.includes(`<<<${k}>>>`))) {
    return { title: '', excerpt: '', body: text }
  }
  const bodyMarker = text.indexOf('<<<BODY>>>')
  const head = bodyMarker === -1 ? text : text.slice(0, bodyMarker)
  const body = bodyMarker === -1 ? '' : text.slice(bodyMarker + '<<<BODY>>>'.length).trim()
  const title = pickSection(head, 'TITLE')
  const excerpt = pickSection(head, 'EXCERPT')
  return { title, excerpt, body: body || pickSection(text, 'EXCERPT') }
}

const ALLOWED_TAGS = new Set(['p', 'h2', 'h3', 'blockquote', 'strong', 'em', 'ul', 'ol', 'li', 'br', 'hr'])
const VOID_TAGS = new Set(['br', 'hr'])
const DANGEROUS_TAGS = 'script|style|iframe|object|embed|form|input|button|svg|img|video|audio|link|meta|base|noscript'

const escapeHtml = (s: string) =>
  String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * 把模型吐出来的 HTML 洗成编辑器敢直接吃的样子。
 * 白名单以外的标签一律去掉外壳、保留文字；所有属性（style / class / on*）全部丢弃。
 * —— 模型偶尔会夹带 <script> 或 style 属性，直接塞进 Tiptap 是不安全的。
 */
export function sanitizeStoryHtml(input: string): string {
  let html = String(input || '')
  html = html.replace(/<!--[\s\S]*?-->/g, '')
  html = html.replace(new RegExp(`<\\s*(${DANGEROUS_TAGS})[^>]*>[\\s\\S]*?<\\s*/\\s*\\1\\s*>`, 'gi'), '')
  html = html.replace(new RegExp(`<\\s*/?\\s*(${DANGEROUS_TAGS})[^>]*>`, 'gi'), '')
  html = html.replace(/<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g, (_m, slash: string, tagRaw: string) => {
    let tag = String(tagRaw).toLowerCase()
    if (tag === 'b') tag = 'strong'
    else if (tag === 'i') tag = 'em'
    else if (tag === 'h1') tag = 'h2'
    else if (tag === 'h4' || tag === 'h5' || tag === 'h6') tag = 'h3'
    if (!ALLOWED_TAGS.has(tag)) return ''
    if (VOID_TAGS.has(tag)) return `<${tag}>`
    return `<${slash}${tag}>`
  })
  html = html.replace(/(<p>\s*<\/p>\s*)+/g, '')
  html = html.replace(/(<br>\s*){3,}/g, '<br><br>')
  return html.trim()
}

/** 模型返回纯文本 / Markdown 时的兜底：按空行切段，`## 小标题` 转成 h3 */
export function plainTextToHtml(text: string): string {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const heading = line.match(/^#{1,4}\s+(.+)$/)
    if (heading) {
      out.push(`<h3>${escapeHtml(heading[1].replace(/[#*`]/g, '').trim()).slice(0, 120)}</h3>`)
      continue
    }
    const boldLine = line.match(/^\*\*(.+)\*\*$/)
    out.push(`<p>${escapeHtml(boldLine ? boldLine[1] : line)}</p>`)
  }
  return out.join('\n')
}

/** 模型没给 HTML（或清洗后什么都不剩）时的统一出口 */
export function toStoryHtml(body: string): string {
  const cleaned = sanitizeStoryHtml(body)
  if (/<(p|h2|h3|blockquote|ul|ol)\b/i.test(cleaned)) return cleaned
  const fromPlain = plainTextToHtml(body)
  return fromPlain || `<p>${escapeHtml(body)}</p>`
}

/* ============================================================
 * 长度统计 & 网址 slug
 * ============================================================ */

/** 汉字个数（不含标点空格）—— 用来检查模型是不是偷偷写短了 */
export const countChineseChars = (text: string) =>
  (String(text || '').match(/[\u4e00-\u9fa5]/g) || []).length

/** 英文词数 */
export const countWords = (text: string) =>
  String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length

/**
 * 生成网址用的 slug（只保留 a-z0-9）。
 * 中文标题会得到空字符串 —— 这正是「中文标题生成 --x7k2p 这种垃圾网址」的根源。
 * 所以英文版翻译好之后，一定要用英文标题来生成 slug。
 */
export function slugify(input: string) {
  return String(input || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/g, '')
}

/** 带随机尾巴的最终 slug；英文标题为空时返回 ''（调用处自己决定怎么兜底） */
export function buildArticleSlug(englishTitle: string) {
  const base = slugify(englishTitle)
  if (!base) return ''
  return `${base}-${Math.random().toString(36).substring(2, 7)}`
}

/** 现有 slug 是否是一条「能用」的网址（至少含一个字母或数字） */
export const isUsableSlug = (slug: string) => /[a-z0-9]/.test(String(slug || '').toLowerCase())

/**
 * 「接着写下去」的指令。
 * 模型写长文时有个常见毛病：写到八成突然收尾（偷工）。与其重写一整篇赌运气，
 * 不如把已经写好的结尾贴回去，让它从断掉的地方续上 —— 便宜、稳、可控。
 */
/** 续写的「铁律 + 输出格式」—— 稳定不变，放 system */
function buildContinueRules() {
  return [
    '【铁律】',
    '- 不要重述前文、不要重新开头、不要写「前情提要」。直接从下一句接着写。',
    '- 保持同一人称、同一时态、同一语气，人物名字不许变。',
    '- 不要在结尾总结人生、不要升华。该收就收，收在该收的地方。',
    '- 如果上一段的结尾其实已经像一个正常的 ending，那就顺着它往后多写一层：'
      + '补一段真正的收束与前因后果，不要另起一个故事。',
    '',
    '【输出格式】',
    '只输出下面这一段，不要写标题、不要写摘要、不要任何说明：',
    '<<<BODY>>>',
    '（续写内容，用 <p> 分段；继续沿用原文的写法与标点习惯）',
  ].join('\n')
}

const CONTINUE_ROLE = '你正在写一篇中文短篇故事，但上一段写得太短就收尾了。请从断掉的地方接着写完。'

/** 续写的「设定 + 构思 + 还差多少字 + 上文尾巴」—— 每次都变，放 user */
function buildContinueBrief(input: {
  tagsByDimension: Partial<Record<DimensionKey, StoryTag[]>>
  idea: string
  tailText: string
  remainingWords: number
}) {
  const { tagsByDimension, idea, tailText, remainingWords } = input
  const settings = DIMENSIONS.filter((d) => (tagsByDimension[d.key] || []).length)
    .map((d) => {
      const picked = tagsByDimension[d.key] || []
      return `【${d.label}】${picked.map((t) => t.name).join('＋')}：${picked.map((t) => t.summary).join('；')}`
    })
    .join('\n')

  return [
    '【这篇的设定（保持不变）】',
    settings || '（保持与上文一致）',
    '',
    '【本篇构思】',
    idea.trim() || '（保持与上文一致）',
    '',
    `【还要补】${Math.max(200, remainingWords)} 字左右，把故事真正讲完整。`,
    '',
    '【上文最后一段（供你接续，不要重复输出它）】',
    tailText.slice(-1200),
  ].join('\n')
}

/**
 * 续写的 system 提示词（角色 + 写法 + 铁律 + 输出格式）
 * 写法要一并带上：续写必须和前半篇是同一支笔，
 * 否则「接着写下去」会把腔调拉回模型默认的那股 AI 味 —— 前面白写。
 */
export function buildContinueSystemPrompt(skill?: StorySkill | null) {
  const parts: string[] = [CONTINUE_ROLE]
  if (skill) parts.push('', buildSkillBlock(skill))
  parts.push('', buildContinueRules())
  return parts.join('\n')
}

/** 续写的 user 提示词（设定 + 构思 + 还差多少 + 上文尾巴） */
export function buildContinueUserPrompt(input: {
  tagsByDimension: Partial<Record<DimensionKey, StoryTag[]>>
  idea: string
  tailText: string
  remainingWords: number
}) {
  return buildContinueBrief(input)
}

/** 兼容函数：把续写的两半拼成一整段（不带写法，与拆分前逐字节一致） */
export function buildContinuePrompt(input: {
  tagsByDimension: Partial<Record<DimensionKey, StoryTag[]>>
  idea: string
  tailText: string
  remainingWords: number
}) {
  return [CONTINUE_ROLE, '', buildContinueRules(), '', buildContinueBrief(input)].join('\n')
}



