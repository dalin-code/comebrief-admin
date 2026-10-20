/**
 * P4 写作层：按骨架逐段写，每段有字数硬边界 + 禁止提前揭晓 + 收尾规则。
 *
 * 为什么不再一次写整篇：
 *   · 整篇生成时模型很容易在前面把后面的反转讲完，后面只能水；
 *   · 一次输出也容易撞 maxOutputTokens，写到 80% 就断；
 *   · 分段之后，某一段写坏了可以只重写那一段，前后文不动。
 */
import {
  DEFAULT_WORLD_BRIEF,
  buildSkillBlock,
  countChineseChars,
  htmlToPlainText,
  toStoryHtml,
  type StorySkill,
} from './storyPrompt'
import type { StoryBeat, StorySkeleton, StoryStateDelta } from './storyPlan'
import type { StorySurface } from './storyIdentity'

export type StorySection = {
  index: number
  beatId: string
  function: string
  html: string
  chars: number
  stateDelta: StoryStateDelta
  isFinal: boolean
  ended: boolean
  warnings: string[]
}

export type BoundaryResult = {
  html: string
  chars: number
  overSoft: boolean
  overHard: boolean
  trimmed: boolean
  warnings: string[]
}

const SECTION_RULES = [
  '【这一遍怎么干】',
  '- 你只写当前这一段。前文已经发生的事不要重述，后面才发生的事不要提前写。',
  '- 用具体的动作、对话、物件推进；不写情绪总结，不写「他明白了」这类旁白。',
  '- 人名、地名、时间、物件只能用【表皮设定】里给出的那一套，一个都不许换、不许新增。',
  '- 本段结束就停，不要写「下一段会怎样」，不要总结这段的意义。',
  '- 不在正文里解释「这是第几段」「本段功能是什么」。',
  '',
  '【输出格式】',
  '只输出：',
  '<<<BODY>>>',
  '（正文，用 <p> 分段；需要强调用 <strong>；不要标题、不要摘要、不要说明）',
].join('\n')

export function buildSectionSystemPrompt(skill?: StorySkill | null) {
  const parts = ['你是一位中文短篇小说作家，正在按导演的节拍表写其中一段。']
  if (skill) parts.push('', buildSkillBlock(skill))
  parts.push('', DEFAULT_WORLD_BRIEF, '', SECTION_RULES)
  return parts.join('\n')
}

const renderRoles = (surface: StorySurface) =>
  (surface.roles || [])
    .map((r) => `- ${r.role}：${r.name}，${r.age} 岁，${r.occupation}；${r.detail}`)
    .join('\n')

const renderSurface = (surface: StorySurface) => {
  const roles = renderRoles(surface) || `- 主角：${surface.protagonistName}`
  return [
    `【人物】`,
    roles,
    '',
    `【地点】${surface.city} · ${surface.district} · ${surface.place}`,
    `【时间】${surface.season}，${surface.weather}，${surface.time}`,
    `【关键物件】${surface.objects.join('；')}`,
    `【感官细节】${surface.sensoryDetail}`,
    `【前史钩子】${surface.backstoryHook}`,
  ].join('\n')
}

export function buildSectionUserPrompt(input: {
  skeleton: StorySkeleton
  surface: StorySurface
  sectionIndex: number
  previousSections?: Array<{ html?: string }>
  idea?: string
  materials?: string
  length?: number
  tagBrief?: string
}) {
  const { skeleton, surface } = input
  const index = Math.max(0, Math.min(skeleton.beats.length - 1, Math.trunc(Number(input.sectionIndex) || 0)))
  const beat = skeleton.beats[index]
  const isFinal = index === skeleton.beats.length - 1
  const previous = (input.previousSections || []).slice(-2)
  const previousText = previous
    .map((s) => htmlToPlainText(String(s?.html || '')).trim())
    .filter(Boolean)
    .join('\n')
    .slice(-1600)

  const overview = skeleton.beats
    .map((b, i) => `${i === index ? '→' : ' '} ${i + 1}. ${b.function}`)
    .join('\n')

  const parts = [
    `【整篇骨架（只写箭头这一段）】`,
    overview,
    '',
    `【本段任务 · 第 ${index + 1}/${skeleton.beats.length} 段 · ${beat.function}】`,
    `目标：${beat.goal}`,
    `阻力：${beat.obstacle}`,
    `必须发生的变化：${beat.turn}`,
    beat.reveal ? `本段才允许揭晓：${beat.reveal}` : '本段不揭晓新的真相。',
    '',
    renderSurface(surface),
    '',
    `【本段硬边界】`,
    `- 目标 ${beat.targetChars} 字；写到 ${beat.softMaxChars} 字就要收，绝不允许超过 ${beat.hardMaxChars} 字。`,
    `- 禁止提前写出：${beat.forbiddenReveals.length ? beat.forbiddenReveals.join('；') : '（没有）'}`,
    `- ${beat.cutRule}`,
  ]

  if (isFinal) {
    parts.push(
      '',
      '【这是最后一段：必须把故事收完】',
      `- 结局画面：${skeleton.endingImage}`,
      `- 收尾信号：${skeleton.endingSignal}`,
      `- 结局类型：${skeleton.endingType}`,
      '- 写完这个画面就停，不解释、不总结、不写「后来他们……」；读者必须能明确感到故事结束了。'
    )
  }

  if (input.tagBrief) parts.push('', '【写法 / 标签约束】', input.tagBrief)
  if (String(input.idea || '').trim()) parts.push('', '【站长的总体构思】', String(input.idea).trim().slice(0, 800))
  if (String(input.materials || '').trim()) {
    parts.push(
      '',
      '【改编底本（只参照情节功能；其中的人名地名一律换成上面的表皮设定，不许照抄）】',
      String(input.materials).trim().slice(0, 4000)
    )
  }
  if (previousText) {
    parts.push(
      '',
      '【上一段结尾（供你接上，不要重复输出）】',
      previousText
    )
  }
  parts.push('', '现在只写这一段。直接从动作或对话开始。')
  return parts.join('\n')
}

export function buildSectionRewritePrompt(input: {
  skeleton: StorySkeleton
  surface: StorySurface
  sectionIndex: number
  currentHtml: string
  instruction?: string
  previousSections?: Array<{ html?: string }>
  idea?: string
  materials?: string
  tagBrief?: string
}) {
  const base = buildSectionUserPrompt({
    skeleton: input.skeleton,
    surface: input.surface,
    sectionIndex: input.sectionIndex,
    previousSections: input.previousSections,
    idea: input.idea,
    materials: input.materials,
    tagBrief: input.tagBrief,
  })
  const currentText = htmlToPlainText(input.currentHtml).trim().slice(0, 4000)
  return [
    base,
    '',
    '【这一遍是重写本段，不是写新的一段】',
    '下面是你上一版的本段正文。只改这一段，前后段落逐字保留。',
    input.instruction?.trim() ? `站长的改法：${input.instruction.trim().slice(0, 800)}` : '',
    '',
    '【上一版本段正文】',
    currentText,
    '',
    '【重写要求】',
    '- 仍然必须满足上面的目标字数 / 硬上限 / 禁止揭晓。',
    '- 如果站长要求改情节方向，可以改本段的事实与动作，但不要顺手把后面几段也写了。',
    '- 输出仍然只包含 <<<BODY>>> 和本段正文。',
  ]
    .filter(Boolean)
    .join('\n')
}

const escapeHtml = (s: string) =>
  String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const cutPlainAtBoundary = (text: string, max: number) => {
  const plain = String(text || '')
  if (plain.length <= max) return plain
  const hard = plain.slice(0, max)
  const marks = ['。', '！', '？', '…', '」', '』', '”', '"']
  const idx = Math.max(...marks.map((m) => hard.lastIndexOf(m)))
  if (idx >= Math.floor(max * 0.55)) return hard.slice(0, idx + 1).trim()
  return `${hard.replace(/[，、；：\s]+$/g, '').trim()}。`
}

/**
 * 超过硬上限才裁。按段落裁，尽量停在句号 / 问号 / 引号收口处；
 * 这是「重写一次仍越界」之后的最后一道保险，不参与正常写作。
 */
export function trimHtmlToMaxChars(html: string, maxChars: number) {
  const input = toStoryHtml(String(html || ''))
  const plainAll = htmlToPlainText(input)
  if (countChineseChars(plainAll) <= maxChars) return input

  const blocks = input.match(/<(p|h2|h3|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gi) || []
  if (!blocks.length) {
    return `<p>${escapeHtml(cutPlainAtBoundary(plainAll, maxChars))}</p>`
  }

  const out: string[] = []
  let used = 0
  for (const block of blocks) {
    const tag = (block.match(/^<([a-z0-9]+)/i)?.[1] || 'p').toLowerCase()
    const plain = htmlToPlainText(block).trim()
    if (!plain) continue
    const count = countChineseChars(plain)
    const left = maxChars - used
    if (left <= 0) break
    if (count <= left) {
      out.push(block)
      used += count
      continue
    }
    out.push(`<${tag}>${escapeHtml(cutPlainAtBoundary(plain, left))}</${tag}>`)
    used = maxChars
    break
  }
  return out.join('\n') || `<p>${escapeHtml(cutPlainAtBoundary(plainAll, maxChars))}</p>`
}

/** 每段写完后的硬边界检查 / 兜底裁切 */
export function enforceSectionBoundary(input: {
  html: string
  beat: StoryBeat
  endingSignal?: string
  isFinal?: boolean
}): BoundaryResult {
  const { beat } = input
  let html = toStoryHtml(input.html)
  const before = countChineseChars(htmlToPlainText(html))
  const overSoft = before > beat.softMaxChars
  const overHard = before > beat.hardMaxChars
  const warnings: string[] = []

  if (overHard) {
    html = trimHtmlToMaxChars(html, beat.hardMaxChars)
  }
  const chars = countChineseChars(htmlToPlainText(html))
  if (overSoft && !overHard) {
    warnings.push(`本段写了 ${before} 字，超过软上限 ${beat.softMaxChars}（硬上限 ${beat.hardMaxChars}），建议下一轮压缩`)
  }
  if (overHard) {
    warnings.push(`本段 ${before} 字超过硬上限 ${beat.hardMaxChars}，已自动裁到 ${chars} 字`)
  }
  const plain = htmlToPlainText(html)
  const hits = (beat.forbiddenReveals || []).filter((x) => x && plain.includes(x))
  if (hits.length) warnings.push(`本段可能提前写出了后续揭示：${hits.join('；')}`)
  return {
    html,
    chars,
    overSoft,
    overHard,
    trimmed: chars < before,
    warnings,
  }
}

const END_PUNCT = /[。！？…」』”"]\s*$/
const OPEN_END = /(未完|待续|下集|下一章|他不知道|她不知道|就在这时|突然)\s*[。！？…]*\s*$/
const CLOSURE_CUES = [
  '最后', '终于', '已经', '没有', '不再', '离开', '回来', '关上', '停下',
  '转身', '放下', '熄灭', '亮着', '安静', '空', '剩', '走远', '睡', '醒',
]

/**
 * 只判断「读者是否已经看到结局画面」，不再拿 92% 字数当停止条件。
 * 有骨架的 endingSignal 时优先看信号；没有时用收束词 + 终止标点兜底。
 */
export function detectEnding(text: string, endingSignal?: string) {
  const plain = htmlToPlainText(String(text || '')).trim()
  if (plain.length < 180) return false
  if (!END_PUNCT.test(plain)) return false
  if (OPEN_END.test(plain.slice(-80))) return false

  const signal = String(endingSignal || '').trim()
  if (signal) {
    const tokens = signal
      .split(/[，。！？、；：\s「」『』“”"']/)
      .map((x) => x.trim())
      .filter((x) => x.length >= 2)
    if (tokens.some((x) => plain.slice(-320).includes(x))) return true
  }

  const tail = plain.slice(-260)
  const cueCount = CLOSURE_CUES.filter((x) => tail.includes(x)).length
  return cueCount >= 1
}

const FINALIZE_SYSTEM = [
  '你是一位中文短篇编辑，只负责给已经写完的故事起标题、写摘要。',
  '不要改写正文，不要评价，不要解释。',
  '标题 12 字以内，落在一个具体物件或动作上，不要抽象词，不要书名号。',
  '摘要 80–120 字，说清发生了什么、为什么值得读，但不许剧透结局。',
  '',
  '输出格式：',
  '<<<TITLE>>>',
  '（标题）',
  '<<<EXCERPT>>>',
  '（摘要）',
].join('\n')

export function buildFinalizeSystemPrompt() {
  return FINALIZE_SYSTEM
}

export function buildFinalizeUserPrompt(input: {
  html: string
  skeleton: StorySkeleton
  idea?: string
}) {
  return [
    `【标题角度】${input.skeleton.titleAngle}`,
    `【故事前提】${input.skeleton.premise}`,
    input.idea?.trim() ? `【站长构思】${input.idea.trim().slice(0, 800)}` : '',
    '',
    '【已经写完的正文】',
    htmlToPlainText(input.html).slice(0, 12000),
    '',
    '只输出 TITLE 和 EXCERPT，不要输出正文。',
  ]
    .filter(Boolean)
    .join('\n')
}

