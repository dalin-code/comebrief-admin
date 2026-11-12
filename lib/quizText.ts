/**
 * 文本 → 测验（手写路径）。纯函数、零依赖、可被 CI 断言。
 *
 * 为什么要有这一层（2026-11-11）：
 *   批量导入（`lib/quizPack.ts`）只吃 JSON —— 而人写稿子用的是「标题 / 题 / 选项 / 结果」
 *   这种段落。硬把一段人话塞进 JSON，出问题的永远是引号、尾逗号、代码围栏，
 *   不是内容本身（整篇 `docs/quiz-json-format.md` 都在讲这件事）。
 *
 * 所以这里只做一件事：**把段落拆成字段**，剩下的全部复用已有的链：
 *
 *   文本 ──parseQuizText──▶ QuizKit ──compileQuizKit──▶ axes 卷 + 全枚举体检
 *                                 └──validateTextKit──▶ 5 条规则（题数放宽到 6–10）
 *
 * 三条硬规则（决定了这份文件为什么长这样）：
 *   ① **选项按位置映射**：A→结果 1、B→结果 2…… 于是「四个选项」天然就是
 *      「同一个瞬间的四种活法」，而不是四段互不相干的话。想换顺序就写 `→ Short`。
 *   ② **v3 字段是必填**：象限、两条轴名、每个选项的 intensity、每题一个 bold。
 *      缺了前台会**静默**降级回旧版式（ComeBrief `ResultView` 的 map && mix && signals），
 *      用户只会看到「结果页不是最新那套」—— 这里把它变成粘贴时就能看见的 blocker。
 *   ③ **不发明数据**：没有 intensity 就说「没量过」，不按文案长短猜一个；
 *      没有象限就报错，不按声明顺序把四个结果摆到四个角上。
 */

import { AXE_POSES } from './quizAxes'
import {
  KIT_ARCHETYPES,
  KIT_QUESTIONS,
  normalizeArchetypeId,
  normalizeQuizKit,
  validateQuizKit,
  type KitOption,
  type KitRule,
  type KitValidation,
  type QuizKit,
} from './quizKit'
import { compileQuizKit, type CompiledKit } from './quizCompile'

/** 文本路径的题量区间：模板是 8 题，但不是所有人手上的稿子都刚好 8 题。 */
export const QUIZ_TEXT_MIN_QUESTIONS = 6
export const QUIZ_TEXT_MAX_QUESTIONS = 10

/** 弹窗「格式说明」里那几句；与 `docs/quiz-text-format.md` 的六条一一对应。 */
export const QUIZ_TEXT_CHECKLIST = [
  '每篇第一行是 TITLE:；结果段写 == RESULT 1 | TL | pose=wave ==，题目段写 == Q1 | 场景 ==',
  '四个结果各占一个象限（TL / TR / BL / BR），一个象限只能一个人；pose（shades / wave / love / worry）决定表情，可以重复',
  '每题 4 个选项按结果顺序写（A→结果 1，B→结果 2…），末尾标 (i1) / (i2) / (i3)，每题恰好一个 (b)',
  '两条轴的两端都要写字：AXIS X: Solo ←→ Crowd 与 AXIS Y: Calm ←→ Restless',
  '每个结果写全 NAME / HEADLINE / QUOTE / READ / 3 条 STATS / 2 个 PILLS —— 结果页的五段文案',
  '题量 6–10（模板 8）；正文写英文 —— 中文会被挡住，点「AI 整理」翻一遍再存',
]

/** 完整字段说明（弹窗底部那行路径） */
export const QUIZ_TEXT_DOC_PATH = 'docs/quiz-text-format.md'

/** 与 `KIT_MAX_QUESTION_CHARS` / `KIT_MAX_OPTION_CHARS` 同口径，这里只用于「超了」的提示。 */
const MAX_QUESTION_CHARS = 120
const MAX_OPTION_CHARS = 90
const MAX_TITLE_CHARS = 120
const MAX_HOOK_CHARS = 140

/** 前台是英文站（`locale: 'en'`）—— 中文正文上去只会显得更「各说各话」。 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

export type QuizTextCode =
  | 'title'
  | 'archetypes'
  | 'questions'
  | 'options'
  | 'names'
  | 'axis'
  | 'quadrant'
  | 'pose'
  | 'intensity'
  | 'bold'
  | 'language'
  | 'length'
  | 'topic'
  | 'syntax'
  | 'audit'

export type QuizTextIssue = {
  level: 'blocker' | 'warning'
  /** 机器可读的判据；`scripts/check-quiz-text.mts` 按 code 断言 */
  code: QuizTextCode
  label: string
  /** 原文行号（1 基，跨篇时也是原文行号） */
  line?: number
  detail?: string
}

/** 结果页 v3 版式（地图 + 配比 + 三块仪表）的入场券。 */
export type QuizTextV3 = {
  ok: boolean
  issues: QuizTextIssue[]
}

export type QuizTextEntry = {
  /** 一篇能不能存：语法 + 5 条规则 + v3 完备 + 引擎体检，任何 blocker 都为 false */
  ok: boolean
  title: string
  kit: QuizKit | null
  compiled: CompiledKit | null
  validation: KitValidation | null
  issues: QuizTextIssue[]
  v3: QuizTextV3
  /** 这一篇在原文里的行范围（1 基、含两端），给「第 N 行」跳转用 */
  from: number
  to: number
}

export type QuizTextInspection = {
  ok: boolean
  entries: QuizTextEntry[]
  issues: QuizTextIssue[]
}

/**
 * 一次检查的**数字**摘要（几篇 / 几结果 / 几题 / 几条红黄）。
 *
 * 两个地方要它，而且必须是同一份实现：
 *   · 「AI 整理」的采用前对比（结果 2 → 4、题 0 → 8、要修 2 → 0）；
 *   · 接口回包里的 `summary`（前端不用再解析一遍，也就不会有一边算出 8 题、
 *     另一边算出 7 题的尴尬）。
 *
 * 只数**已经解析出来的**：解析不出来时 `kit` 是 null，这里就是 0 —— 这正是
 * 「整理前 0 题」那个数字的来历，不需要特殊判断。
 */
export type QuizTextStats = {
  entries: number
  results: number
  questions: number
  blockers: number
  warnings: number
}

export function summarizeQuizText(inspection: QuizTextInspection): QuizTextStats {
  let results = 0
  let questions = 0
  let blockers = 0
  let warnings = 0
  for (const entry of inspection.entries) {
    results += entry.kit?.archetypes.length ?? 0
    questions += entry.kit?.questions.length ?? 0
    for (const item of entry.issues) {
      if (item.level === 'blocker') blockers += 1
      else warnings += 1
    }
  }
  return { entries: inspection.entries.length, results, questions, blockers, warnings }
}

const issue = (
  level: QuizTextIssue['level'],
  code: QuizTextCode,
  label: string,
  line?: number,
  detail?: string
): QuizTextIssue => ({ level, code, label, ...(line ? { line } : {}), ...(detail ? { detail } : {}) })

/* ------------------------------------------------------------------ *
 * 1. 词法：行 / 块 / 键值 / 选项尾标
 * ------------------------------------------------------------------ */

type RawLine = { n: number; text: string }

const SEP_RE = /^\s*(?:-{3,}|={3,}|\*{3,})\s*$/
const FENCE_RE = /^\s*(?:```|~~~)/
const TITLE_LINE_RE = /^\s*(?:\*\*)?TITLE\s*[:：]/i
const RESULT_RE = /^\s*=*\s*RESULT\s*#?\s*(\d+)\b(.*)$/i
const QUESTION_RE = /^\s*=*\s*(?:Q|QUESTION)\s*#?(\d+)\b(.*)$/i
const OPTION_RE = /^\s*[*_]*([A-Da-d]|[1-4])\s*[*_]*\s*[.)、:：]\s+(.*)$/
const KEY_RE = /^\s*[-*•]?\s*([A-Za-z][A-Za-z0-9 _-]{0,24}?)\s*[:：]\s*(.*)$/

const OPTION_LETTER_INDEX: Record<string, number> = { a: 0, b: 1, c: 2, d: 3, '1': 0, '2': 1, '3': 2, '4': 3 }

/** 全角空格 / 零宽字符 / CRLF 先统一，否则「看着一样的行」会解析成两种。 */
const normalizeSource = (source: string): string =>
  source
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u2007\u202f\u3000]/g, ' ')
    .replace(/[\u200b-\u200d]/g, '')

function toLines(source: string, offset = 0): RawLine[] {
  const lines = normalizeSource(source).split('\n')
  const out: RawLine[] = []
  for (let i = 0; i < lines.length; i += 1) {
    // 代码围栏整行丢掉，围栏里的内容照常读 —— 从 ChatGPT 复制过来时它总在。
    if (FENCE_RE.test(lines[i])) continue
    out.push({ n: offset + i + 1, text: lines[i] })
  }
  return out
}

/** 块 = 一篇。`---` 或第二个 `TITLE:` 起新篇（两种写法都常见）。 */
function splitWithOffsets(source: string): Array<{ text: string; startLine: number }> {
  const lines = normalizeSource(source).split('\n')
  const blocks: Array<Array<{ i: number; text: string }>> = []
  let current: Array<{ i: number; text: string }> = []
  let seenTitle = false

  const flush = () => {
    if (current.some((line) => line.text.trim())) blocks.push(current)
    current = []
    seenTitle = false
  }

  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i]
    if (SEP_RE.test(text)) {
      flush()
      continue
    }
    const isTitle = TITLE_LINE_RE.test(text)
    if (isTitle && seenTitle) flush()
    if (isTitle) seenTitle = true
    current.push({ i, text })
  }
  flush()

  return blocks.map((block) => ({
    text: block.map((line) => line.text).join('\n'),
    startLine: block[0].i + 1,
  }))
}

/** 一整段里拆出多篇，给弹窗的「拆分成多个框」用。 */
export function splitQuizText(source: string): string[] {
  return splitWithOffsets(source)
    .map((block) => block.text.trim())
    .filter(Boolean)
}

/** 标题行尾的 `==` 与开头的 `|` 都要剥掉，剩下的才是 token / 场景。 */
const trimHeaderRest = (rest: string): string =>
  rest
    .replace(/^[\s|｜]+/, '')
    .replace(/[\s=*|｜]+$/, '')
    .trim()

type ResultTokens = { quadrant?: string; pose?: string; id?: string; color?: string }

/** `== RESULT 1 | TL | pose=wave ==` 尾巴上的三样；也认分开写（`QUADRANT:` / `POSE:`）。 */
function parseResultTokens(rest: string): ResultTokens {
  const out: ResultTokens = {}
  const tokens = trimHeaderRest(rest)
    .split(/[|｜,，;；]/)
    .map((token) => token.trim())
    .filter(Boolean)

  for (const token of tokens) {
    const kv = /^([A-Za-z ]{1,12}?)\s*[=:]\s*(.+)$/.exec(token)
    if (kv) {
      const key = kv[1].trim().toUpperCase()
      const value = kv[2].trim()
      if (key === 'POSE') out.pose = value.toLowerCase()
      else if (key === 'ID' || key === 'KEY') out.id = value
      else if (key === 'COLOR' || key === 'COLOUR') out.color = value
      else if (key === 'QUADRANT') out.quadrant = value.toUpperCase()
      continue
    }
    const upper = token.toUpperCase()
    if (!out.quadrant && /^(TL|TR|BL|BR)$/.test(upper)) out.quadrant = upper
  }
  return out
}

type OptionTail = { text: string; intensity?: number; bold?: boolean; target?: string }

/**
 * 选项行尾的三个可选标记，顺序随意、可重复剥：
 *   `(i2)` 能量档 · `(b)` 每题唯一的少数派 · `→ Short` 覆盖顺序映射
 */
function parseOptionTail(raw: string): OptionTail {
  let text = raw.trim()
  let intensity: number | undefined
  let bold: boolean | undefined
  let target: string | undefined

  for (let guard = 0; guard < 6; guard += 1) {
    // 先剥末尾的标记，再剥箭头：`→ Short` 之后可能还挂着 `(i3) (b)`。
    const tag = /^(.*?)\s*[（(\[]\s*(i\s*[1-3]|bold|b)\s*[)）\]]\s*$/i.exec(text)
    if (tag) {
      const token = tag[2].replace(/\s+/g, '').toLowerCase()
      text = tag[1].trim()
      if (token.startsWith('i')) intensity = Number(token.slice(1))
      else bold = true
      continue
    }
    const arrow = /^(.*?)\s*(?:→|->|=>|»)\s*(\S.*)$/.exec(text)
    if (arrow && !target) {
      text = arrow[1].trim()
      target = arrow[2].trim()
      continue
    }
    break
  }

  return { text, ...(intensity ? { intensity } : {}), ...(bold ? { bold } : {}), ...(target ? { target } : {}) }
}

/** 逗号 / 斜杠 / 竖线都当分隔符：STATS、PILLS、轴端都吃这三种。 */
const splitList = (value: string): string[] =>
  value
    .split(/\s*(?:\/|｜|\||·|;|；)\s*/)
    .map((entry) => entry.trim())
    .filter(Boolean)

/** 轴名两端：`A ←→ B`，也认 `<->` / `→` / ` / ` / ` - `。 */
function parseAxis(value: string): { neg: string; pos: string } | null {
  const pair = /^(.*?)\s*(?:←→|↔|<->|<=>|→|=>|\/|—|–|\s-\s)\s*(.*)$/.exec(value.trim())
  if (!pair) return null
  const neg = pair[1].trim()
  const pos = pair[2].trim()
  if (!neg || !pos) return null
  return { neg, pos }
}


/* ------------------------------------------------------------------ *
 * 2. 模板：框里「模板」按钮插的就是这一份
 * ------------------------------------------------------------------ */

/**
 * 一份能直接过全部四层闸的标准卷。改它等于改所有新卷的形状，所以：
 *
 *   · 4 个结果占满 4 个象限、4 个不同 pose（少一个地图就退回雷达）；
 *   · 每题 4 个选项**按结果顺序**写（A→结果 1……），这是「配平的来源」；
 *   · 每个选项都有 `(i1–i3)`，每题恰好一个 `(b)`（这是三块仪表的输入）；
 *   · 结果页五段文案齐全（headline / quote / read / 3 stats / 2 pills）。
 *
 * `scripts/check-quiz-text.mts` 会断言它「零 blocker 零 warning + 健康分 100」，
 * 改了模板而断言没过，说明改坏了 —— 别去改断言。
 */
export const QUIZ_TEXT_TEMPLATE = `TITLE: What Kind of 2AM Person Are You?
HOOK: Eight taps, one verdict. We tell you who you are when the city is asleep.
TOPIC: pop-culture
TAGS: Internet Lore
AXIS X: Solo ←→ Crowd
AXIS Y: Calm ←→ Restless

== RESULT 1 | TL | pose=wave ==
NAME: The Quiet Watcher
SHORT: Watcher
HEADLINE: You see everything and post nothing.
QUOTE: I was online. I just didn't have anything to add.
READ: You read the room before you read the message. That is why your answers got quieter instead of louder: you were already three replies ahead, and none of them needed to be sent.
STATS: 3 group chats on mute / 97% read rate / 0 unread badges
PILLS: Silent lurker / Screenshot hoarder

== RESULT 2 | TR | pose=love ==
NAME: The Group Chat Main Character
SHORT: Main Character
HEADLINE: You don't join the conversation. You host it.
QUOTE: If nobody replies in 40 seconds, I assume the group is dead.
READ: You are the reason the chat is awake at 2AM, and you would never say so out loud. Your answers kept picking the option that gives other people something to react to: a link, a take, a bit.
STATS: 4 chats on mute / 40 sec avg reply / 12 screenshots sent today
PILLS: Chat starter / Meme economy

== RESULT 3 | BL | pose=shades ==
NAME: The 3AM Archivist
SHORT: Archivist
HEADLINE: You keep receipts nobody asked for.
QUOTE: I am not awake. I am just cataloguing.
READ: You do your living after midnight and your filing after that. Every answer you picked was a small act of collecting: a tab left open, a screenshot saved, a message drafted and never sent.
STATS: 61 open tabs / 2AM search history / 1 folder called later
PILLS: Night researcher / Draft hoarder

== RESULT 4 | BR | pose=worry ==
NAME: The Reply-All Menace
SHORT: Menace
HEADLINE: You answer before the question finishes.
QUOTE: Sorry, saw it late. (It was 11 seconds.)
READ: You would rather be wrong out loud than quiet and right. Your answers kept picking the fastest, most visible move, and that is exactly why the chat is never boring when you are in it.
STATS: 11 sec reply time / 3 chats, all unread / 0 unsent drafts
PILLS: Fastest thumbs / Chaos gremlin

== Q1 | Monday, 2:07 AM ==
Your phone lights up. The group chat is on fire. You…
A. Read all of it, type nothing.          (i1)
B. Send one perfect meme, then go quiet.  (i2)
C. Screenshot it for the archive.         (i1)
D. Reply to all four people at once.      (i3) (b)

== Q2 | Tuesday, 11:48 PM ==
Someone posts the worst take you have read all week. You…
A. Scroll past and remember it forever.   (i1)
B. Quote it in the group chat.            (i3) (b)
C. Save it to the folder.                 (i1)
D. Type a reply, delete it, send it.      (i3)

== Q3 | Wednesday, 1:15 AM ==
A song you have not heard in years comes on. You…
A. Let it play and keep scrolling.        (i1)
B. Post it with "this is so us".          (i2)
C. Add it to a playlist named after someone. (i2)
D. Send it to three chats at once.        (i3) (b)

== Q4 | Thursday, 12:40 AM ==
You cannot sleep. The most tempting thing on your phone is…
A. A 40-minute video essay.               (i1)
B. The group chat, to see who is still up. (i2)
C. Your camera roll from 2021.            (i1) (b)
D. A notes app draft you never finished.  (i2)

== Q5 | Friday, 3:02 AM ==
A friend posts "can't sleep". You…
A. Like it and say nothing.               (i1)
B. Reply "same" with a meme.              (i2)
C. Read their last month of posts.        (i1) (b)
D. Call them.                             (i3)

== Q6 | Saturday, 2:33 AM ==
The chat goes silent for ten minutes. You…
A. Enjoy it.                              (i1)
B. Send a "hello??" into the void.        (i2)
C. Start a side chat with one person.     (i2)
D. Start three side chats with three people. (i3) (b)

== Q7 | Sunday, 12:58 AM ==
You open your phone to check one thing. Two hours later you have…
A. Read a 300-comment thread, said nothing. (i1)
B. Sent 14 memes.                         (i3) (b)
C. Taken 30 new screenshots.              (i2)
D. Replied to everyone who texted this week. (i3)

== Q8 | Any night, 2:59 AM ==
Last question: what does 3AM you actually want?
A. One more hour of quiet.                (i1)
B. One more person awake.                 (i2)
C. One more thing worth remembering.      (i2) (b)
D. One more conversation to start.        (i3)
`

/* ------------------------------------------------------------------ *
 * 3. 解析：一段一段读成 Draft，再交给 normalizeQuizKit 收口
 * ------------------------------------------------------------------ */

type DraftOption = { text: string; intensity?: number; bold?: boolean; target?: string; line: number }
type DraftQuestion = { scene?: string; title: string; options: DraftOption[]; line: number }
type DraftArchetype = {
  id?: string
  name: string
  short?: string
  headline?: string
  quote?: string
  summary?: string
  stats: string[]
  pills: string[]
  quadrant?: string
  pose?: string
  color?: string
  line: number
}
type Draft = {
  title: string
  hook?: string
  topic?: string
  tags: string[]
  axes?: { x: { neg: string; pos: string }; y: { neg: string; pos: string } }
  archetypes: DraftArchetype[]
  questions: DraftQuestion[]
  titleLine: number
}

/** 只认 A–D；`E.` 这类会被提示，而不是静默拼进 D 的文案。 */
const ANY_OPTION_RE = /^\s*([A-Za-z]|\d{1,2})\s*[.)、]\s+/

type Pending = { append: (extra: string) => void }

const joinText = (current: string, extra: string): string => (current ? `${current} ${extra}` : extra)

function parseDraft(lines: RawLine[]): { draft: Draft; issues: QuizTextIssue[] } {
  const issues: QuizTextIssue[] = []
  const draft: Draft = { title: '', tags: [], archetypes: [], questions: [], titleLine: lines[0]?.n ?? 1 }
  let section: 'kit' | 'result' | 'question' = 'kit'
  let pending: Pending | null = null

  const lastArchetype = () => (section === 'result' ? draft.archetypes[draft.archetypes.length - 1] : undefined)
  const lastQuestion = () => (section === 'question' ? draft.questions[draft.questions.length - 1] : undefined)

  for (const line of lines) {
    const text = line.text.trim()
    if (!text) {
      pending = null
      continue
    }

    const resultHit = RESULT_RE.exec(text)
    if (resultHit) {
      draft.archetypes.push({ name: '', stats: [], pills: [], line: line.n, ...parseResultTokens(resultHit[2]) })
      section = 'result'
      pending = null
      continue
    }

    const questionHit = QUESTION_RE.exec(text)
    if (questionHit) {
      const scene = trimHeaderRest(questionHit[2])
      draft.questions.push({ title: '', options: [], line: line.n, ...(scene ? { scene } : {}) })
      section = 'question'
      pending = null
      continue
    }

    const optionHit = OPTION_RE.exec(text)
    const question = lastQuestion()
    if (optionHit && question) {
      const tail = parseOptionTail(optionHit[2])
      const option: DraftOption = { text: tail.text, line: line.n }
      if (tail.intensity) option.intensity = tail.intensity
      if (tail.bold) option.bold = true
      if (tail.target) option.target = tail.target
      question.options.push(option)
      pending = { append: (extra) => { option.text = joinText(option.text, extra) } }
      continue
    }
    // 选项字母越界：说清楚，别让它变成上一行的后半句。
    const stray = ANY_OPTION_RE.exec(text)
    if (stray && question && !/[A-Da-d1-4]/.test(stray[1])) {
      issues.push(issue('warning', 'options', `第 ${line.n} 行：第 5 个及以后的选项不会被读`, line.n, '每题只认 A–D'))
      pending = null
      continue
    }


    const kv = KEY_RE.exec(text)
    if (kv) {
      const key = kv[1].trim().toUpperCase().replace(/\s+/g, ' ')
      const value = kv[2].trim()
      const archetype = lastArchetype()

      if (section === 'kit') {
        if (key === 'TITLE' || key === 'QUIZ') {
          draft.title = joinText(draft.title, value)
          draft.titleLine = line.n
          pending = { append: (extra) => { draft.title = joinText(draft.title, extra) } }
          continue
        }
        if (key === 'HOOK' || key === 'SUBTITLE') {
          draft.hook = joinText(draft.hook ?? '', value)
          pending = { append: (extra) => { draft.hook = joinText(draft.hook ?? '', extra) } }
          continue
        }
        if (key === 'TOPIC' || key === 'CATEGORY') {
          draft.topic = value
          continue
        }
        if (key === 'TAG' || key === 'TAGS') {
          draft.tags.push(
            ...value
              .split(/[,，/｜|]/)
              .map((tag) => tag.trim())
              .filter(Boolean)
          )
          continue
        }
        if (key === 'AXIS X' || key === 'X AXIS') {
          const axis = parseAxis(value)
          if (axis) draft.axes = { x: axis, y: draft.axes?.y ?? { neg: '', pos: '' } }
          else issues.push(issue('blocker', 'axis', `第 ${line.n} 行：X 轴要写两端`, line.n, '例：AXIS X: Solo ←→ Crowd'))
          continue
        }
        if (key === 'AXIS Y' || key === 'Y AXIS') {
          const axis = parseAxis(value)
          if (axis) draft.axes = { x: draft.axes?.x ?? { neg: '', pos: '' }, y: axis }
          else issues.push(issue('blocker', 'axis', `第 ${line.n} 行：Y 轴要写两端`, line.n, '例：AXIS Y: Calm ←→ Restless'))
          continue
        }
      }

      if (section === 'result' && archetype) {
        if (key === 'NAME' || key === 'TITLE') {
          archetype.name = joinText(archetype.name, value)
          pending = { append: (extra) => { archetype.name = joinText(archetype.name, extra) } }
          continue
        }
        if (key === 'SHORT') {
          archetype.short = value
          continue
        }
        if (key === 'HEADLINE') {
          archetype.headline = joinText(archetype.headline ?? '', value)
          pending = { append: (extra) => { archetype.headline = joinText(archetype.headline ?? '', extra) } }
          continue
        }
        if (key === 'QUOTE') {
          archetype.quote = joinText(archetype.quote ?? '', value)
          pending = { append: (extra) => { archetype.quote = joinText(archetype.quote ?? '', extra) } }
          continue
        }
        if (key === 'READ' || key === 'SUMMARY' || key === 'THE READ') {
          archetype.summary = joinText(archetype.summary ?? '', value)
          pending = { append: (extra) => { archetype.summary = joinText(archetype.summary ?? '', extra) } }
          continue
        }
        if (key === 'STATS' || key === 'STAT') {
          archetype.stats.push(...splitList(value))
          continue
        }
        if (key === 'PILLS' || key === 'PILL') {
          archetype.pills.push(...splitList(value))
          continue
        }
        if (key === 'QUADRANT' || key === 'CORNER') {
          archetype.quadrant = value.toUpperCase()
          continue
        }
        if (key === 'POSE') {
          archetype.pose = value.toLowerCase()
          continue
        }
        if (key === 'ID' || key === 'KEY') {
          archetype.id = value
          continue
        }
        if (key === 'COLOR' || key === 'COLOUR') {
          archetype.color = value
          continue
        }
      }

      if (section === 'question' && question) {
        if (key === 'TITLE' || key === 'QUESTION' || key === 'Q') {
          question.title = joinText(question.title, value)
          pending = { append: (extra) => { question.title = joinText(question.title, extra) } }
          continue
        }
        if (key === 'SCENE' || key === 'SETTING') {
          question.scene = value
          continue
        }
      }
    }

    // 认不出的行：能接就接在上一段后面（ChatGPT 经常折行），接不上才提示。
    if (pending) {
      pending.append(text)
      continue
    }
    // 题干就是段头下面那一行自由文本 —— 这是唯一允许「裸行」的位置。
    if (section === 'question' && question && !question.title) {
      question.title = text
      pending = { append: (extra) => { question.title = joinText(question.title, extra) } }
      continue
    }
    issues.push(issue('warning', 'syntax', `第 ${line.n} 行读不出字段，已忽略`, line.n, text.slice(0, 60)))
  }

  return { draft, issues }
}

/** id 先从 `id=` / `SHORT` / `NAME` 推，推不出才用 arch1；重复的按声明顺序加序号。 */
function assignIds(archetypes: DraftArchetype[]): string[] {
  const used = new Set<string>()
  return archetypes.map((archetype, index) => {
    const base = normalizeArchetypeId(archetype.id ?? archetype.short ?? archetype.name) || `arch${index + 1}`
    let id = base
    let suffix = 1
    while (used.has(id)) {
      suffix += 1
      id = `${base}${suffix}`
    }
    used.add(id)
    return id
  })
}

/**
 * Draft → 契约对象。**不在这里判对错** —— 交给 `normalizeQuizKit` + `validateQuizKit`，
 * 这样文本路径和 JSON 路径用的是同一套判据，不会出现「JSON 拦了、文本漏了」。
 */
function buildKit(draft: Draft, issues: QuizTextIssue[]): QuizKit | null {
  const ids = assignIds(draft.archetypes)

  const archetypes = draft.archetypes.map((archetype, index) => ({
    id: ids[index],
    name: archetype.name,
    short: archetype.short,
    headline: archetype.headline,
    quote: archetype.quote,
    summary: archetype.summary,
    stats: archetype.stats,
    pills: archetype.pills,
    quadrant: archetype.quadrant,
    pose: archetype.pose,
    color: archetype.color,
  }))

  const questions = draft.questions.map((question) => ({
    scene: question.scene,
    title: question.title,
    options: question.options.map((option, index) => {
      let primary = ids[index] ?? ''
      if (option.target) {
        const key = normalizeArchetypeId(option.target)
        const hit = ids.findIndex(
          (id, at) =>
            id === key ||
            normalizeArchetypeId(draft.archetypes[at].short ?? '') === key ||
            normalizeArchetypeId(draft.archetypes[at].name) === key
        )
        if (hit >= 0) primary = ids[hit]
        else
          issues.push(
            issue('warning', 'names', `第 ${option.line} 行：→ ${option.target} 找不到对应结果`, option.line, '已按顺序映射')
          )
      }
      return { text: option.text, primary, intensity: option.intensity, bold: option.bold }
    }),
  }))

  const normalized = normalizeQuizKit({
    title: draft.title,
    hook: draft.hook,
    topic: draft.topic,
    tags: draft.tags,
    axes: draft.axes,
    archetypes,
    questions,
  })

  if (!normalized) {
    issues.push(issue('blocker', 'syntax', '没有读到可用的结果或题目', draft.titleLine))
    return null
  }

  for (const note of normalized.issues) {
    // 适配层补 id / 改重名这类是「它替我改了」，只提示；分类认不出要人自己定。
    issues.push(issue('warning', note.includes('分类') ? 'topic' : 'syntax', note, draft.titleLine))
  }

  if (!normalized.kit.title) {
    issues.push(issue('blocker', 'title', '缺 TITLE:（每篇的第一行必须是标题）', draft.titleLine))
  }

  return normalized.kit
}

/* ------------------------------------------------------------------ *
 * 4. 闸门：5 条规则（题数放宽到 6–10）+ v3 完备性 + 引擎体检
 * ------------------------------------------------------------------ */

/**
 * `validateQuizKit` 的第 2 条规则要求「正好 8 题」。
 *
 * 文本路径放宽到 6–10（与 `lib/quizAxes.ts` 的 `MIN_QUESTIONS` / `MAX_QUESTIONS`、
 * 与 `shape` 检查同一区间），但仍然：
 *   · 越界 → blocker；
 *   · 落在区间内但不是 8 题 → warning（`tie` 会跟着掉分，6 题约 38%）。
 * 其余四条规则原样沿用 —— 尤其是 `mapping`（每题 4 个选项覆盖 4 个原型），
 * 那是配平的唯一来源。
 */
export function validateTextKit(kit: QuizKit): KitValidation {
  const base = validateQuizKit(kit)
  const count = kit.questions.length
  const titles = kit.questions.map((q) => q.title.trim().toLowerCase())
  const duplicates = [...new Set(titles.filter((title, index) => title && titles.indexOf(title) !== index))]
  const blank = kit.questions.filter((q) => !q.title.trim()).length
  const longTitles = kit.questions.filter((q) => q.title.length > MAX_QUESTION_CHARS).length
  const inRange = count >= QUIZ_TEXT_MIN_QUESTIONS && count <= QUIZ_TEXT_MAX_QUESTIONS
  const healthy = inRange && blank === 0 && longTitles === 0 && duplicates.length === 0

  const detail = [
    !inRange ? `题数是 ${count}，要求 ${QUIZ_TEXT_MIN_QUESTIONS}–${QUIZ_TEXT_MAX_QUESTIONS}` : '',
    blank ? `${blank} 道题没有题干` : '',
    longTitles ? `${longTitles} 道题干超过 ${MAX_QUESTION_CHARS} 字` : '',
    duplicates.length ? `题干重复：${duplicates.slice(0, 2).join('、')}` : '',
  ]
    .filter(Boolean)
    .join('；')

  const rule: KitRule = !healthy
    ? {
        id: 'questions',
        level: 'blocker',
        ok: false,
        label: `题目 ${QUIZ_TEXT_MIN_QUESTIONS}–${QUIZ_TEXT_MAX_QUESTIONS} 道 · 题干非空不重复`,
        detail,
      }
    : count === KIT_QUESTIONS
      ? { id: 'questions', level: 'blocker', ok: true, label: `${KIT_QUESTIONS} 题 · 题干非空且不重复` }
      : {
          id: 'questions',
          level: 'warning',
          ok: false,
          label: `${count} 题（模板是 ${KIT_QUESTIONS} 题）`,
          detail: '能存，但平局率会升高（6 题约 38%）；发布前看一眼体检里的「平局率」',
        }

  const rules = base.rules.map((entry) => (entry.id === 'questions' ? rule : entry))
  const blockers = rules.filter((entry) => !entry.ok && entry.level === 'blocker')
  const warnings = rules.filter((entry) => !entry.ok && entry.level === 'warning')
  return { rules, blockers, warnings, ok: blockers.length === 0 }
}

const EMPTY_DRAFT: Draft = { title: '', tags: [], archetypes: [], questions: [], titleLine: 0 }

/**
 * 结果页 v3 版式的入场券 —— 缺一项，前台就**静默**退回雷达 / 旧仪表。
 *
 * 所以这几项是 blocker 而不是「建议」：
 *   · 两条轴名（地图的四个方向要写字）；
 *   · 四个结果的象限（`TL` / `TR` / `BL` / `BR` 各一个，撞了就少一角）；
 *   · 四个结果的 pose —— 但**只查「写了没」「认不认识」**：pose 决定表情，
 *     不再决定角色（角色由象限推导），所以两个人撞 pose 只是 warning；
 *   · 每个选项的 intensity（缺了就整块 `Intensity` 仪表不渲染）。
 *
 * `bold` 特殊：一个都没有是 blocker（`signals` 算不出来），有两个只是 warning
 * （语义上「少数派」只能有一个，但引擎还能跑）。
 */
function v3Issues(kit: QuizKit, draft: Draft): QuizTextIssue[] {
  const issues: QuizTextIssue[] = []
  const archLine = (index: number) => draft.archetypes[index]?.line

  if (!kit.axes) {
    issues.push(
      issue('blocker', 'axis', '缺两条轴名（AXIS X / AXIS Y）', draft.titleLine || undefined, '没有轴名，结果页地图的四个方向是空的')
    )
  }

  // 长度只是 warning：标题长一点不会炸，但海报上会换行到两行 —— 先说一声。
  if (kit.title.length > MAX_TITLE_CHARS) {
    issues.push(issue('warning', 'length', `TITLE 有 ${kit.title.length} 字（建议 ≤ ${MAX_TITLE_CHARS}）`, draft.titleLine))
  }
  if ((kit.hook ?? '').length > MAX_HOOK_CHARS) {
    issues.push(issue('warning', 'length', `HOOK 有 ${(kit.hook ?? '').length} 字（建议 ≤ ${MAX_HOOK_CHARS}）`, draft.titleLine))
  }

  const quadrants = new Map<string, number>()
  kit.archetypes.forEach((archetype, index) => {
    const line = archLine(index)
    if (!archetype.quadrant) {
      issues.push(
        issue(
          'blocker',
          'quadrant',
          `结果 ${index + 1}「${archetype.name || '未命名'}」没有象限`,
          line,
          '写成 == RESULT 1 | TL | pose=wave =='
        )
      )
      return
    }
    const owner = quadrants.get(archetype.quadrant)
    if (owner !== undefined) {
      issues.push(
        issue('blocker', 'quadrant', `象限 ${archetype.quadrant} 被两个结果占了`, line, `结果 ${owner + 1} 也是 ${archetype.quadrant}；四个角要一人一个`)
      )
      return
    }
    quadrants.set(archetype.quadrant, index)
  })

  /**
   * `pose` 三项检查，顺序不能换：
   *   ① **没写** —— 老稿子常见，报「没有 pose」并给出白名单；
   *   ② **写了但不认识**（`pose=cool` / `pose=眼镜`）—— 以前这里不报，一路带到前台，
   *      结果页对着 `CharacterForPose` 查不到就静默退回 host，作者只看到「四只一样」；
   *   ③ **两个人用同一个 pose** —— 从 blocker 降为 warning：v2 的 IP 里**角色由象限决定**，
   *      pose 只决定「这只朋友摆什么表情」，所以两个人撞 pose 不再撞脸。
   *      （前台还没升级到 v2 时它们确实会一样，所以留一条提醒，别让人以为没影响。）
   */
  const poses = new Map<string, number>()
  kit.archetypes.forEach((archetype, index) => {
    const line = archLine(index)
    /**
     * ⚠️ 这里读的是 **draft 的原始值**，不是 kit 的值。
     *
     * `normalizeQuizKit` 只认四个白名单值，`pose=cool` 走到这一层已经变成
     * `undefined` —— 拿 kit 判断，报出来的就是「结果 1 没有 pose」，
     * 而作者明明写了，只能对着那行发呆（这是真踩过的）。
     */
    const raw = (draft.archetypes[index]?.pose ?? '').trim()
    const pose = archetype.pose
    if (!pose) {
      issues.push(
        raw
          ? issue('blocker', 'pose', `结果 ${index + 1} 的 pose="${raw}" 不认识`, line, `只能写这四个：${AXE_POSES.join(' / ')}`)
          : issue('blocker', 'pose', `结果 ${index + 1}「${archetype.name}」没有 pose`, line, `写 pose=${AXE_POSES.join(' / ')} 之一`)
      )
      return
    }
    const owner = poses.get(pose)
    if (owner !== undefined) {
      issues.push(
        issue(
          'warning',
          'pose',
          `pose=${pose} 被两个结果用了`,
          line,
          `结果 ${owner + 1} 也是这个姿态：两个结果会摆同一个表情，能存，但不如换一个`
        )
      )
      return
    }
    poses.set(pose, index)
  })

  kit.questions.forEach((question, index) => {
    const line = draft.questions[index]?.line
    const missing = question.options.filter((option) => option.intensity === undefined).length
    if (missing > 0) {
      issues.push(
        issue('blocker', 'intensity', `Q${index + 1} 有 ${missing} 个选项没写能量档`, line, '每个选项末尾写 (i1) / (i2) / (i3)')
      )
    }
    const bolds = question.options.filter((option) => option.bold).length
    if (bolds === 0) {
      issues.push(issue('blocker', 'bold', `Q${index + 1} 没有 (b)`, line, '每题标一个「多数人不会选」的选项；结果页靠它算 signals'))
    } else if (bolds > 1) {
      issues.push(issue('warning', 'bold', `Q${index + 1} 有 ${bolds} 个 (b)`, line, '每题只该有一个'))
    }
  })

  return issues
}

export function v3Completeness(kit: QuizKit): QuizTextV3 {
  const issues = v3Issues(kit, EMPTY_DRAFT)
  return { ok: issues.every((entry) => entry.level !== 'blocker'), issues }
}

/* ------------------------------------------------------------------ *
 * 6. 一篇 = 一次 inspect：语法 → 契约 → v3 → 体检，四个闸一起给结论
 * ------------------------------------------------------------------ */

/** 中文正文在前台是另一套排版（也是另一群读者）—— 挡住，交给「AI 整理」翻。 */
function cjkField(kit: QuizKit): string | null {
  const pairs: Array<[string, string]> = [
    ['TITLE', kit.title],
    ['HOOK', kit.hook ?? ''],
    ...kit.archetypes.flatMap((archetype, index): Array<[string, string]> => [
      [`结果 ${index + 1} 的 NAME`, archetype.name],
      [`结果 ${index + 1} 的 HEADLINE`, archetype.headline ?? ''],
      [`结果 ${index + 1} 的 QUOTE`, archetype.quote ?? ''],
      [`结果 ${index + 1} 的 READ`, archetype.summary ?? ''],
      [`结果 ${index + 1} 的 STATS`, (archetype.stats ?? []).join(' ')],
      [`结果 ${index + 1} 的 PILLS`, (archetype.pills ?? []).join(' ')],
    ]),
    ...kit.questions.flatMap((question, index): Array<[string, string]> => [
      [`Q${index + 1} 的题干`, question.title],
      [`Q${index + 1} 的选项`, question.options.map((option) => option.text).join(' ')],
    ]),
    ['轴名', kit.axes ? `${kit.axes.x.neg} ${kit.axes.x.pos} ${kit.axes.y.neg} ${kit.axes.y.pos}` : ''],
  ]
  const hit = pairs.find(([, value]) => CJK.test(value))
  return hit ? hit[0] : null
}

function inspectBlock(text: string, startLine: number): QuizTextEntry {
  const lines = toLines(text, startLine - 1)
  const { draft, issues } = parseDraft(lines)
  const entry: QuizTextEntry = {
    ok: false,
    title: draft.title.trim(),
    kit: null,
    compiled: null,
    validation: null,
    issues,
    v3: { ok: false, issues: [] },
    from: startLine,
    to: lines.length ? lines[lines.length - 1].n : startLine,
  }

  if (!draft.title.trim()) {
    issues.push(issue('blocker', 'title', '缺 TITLE:（每篇的第一行必须是标题）', draft.titleLine))
  }
  /**
   * 「读到 0 个」和「读到 2 个」是两种病，别用一句话糊过去：
   *   · 0 个 —— 段头根本没被认出来（`== RESULT 1 | TL | pose=wave ==` 少了等号、
   *     写成中文竖线、或者整段被模型改成了 markdown 标题）；
   *   · 2 个 —— 段头对，但少写了两段。
   * 以前两者都报「没有读到结果或题目」，作者只会觉得「我明明写了啊」。
   */
  if (!draft.archetypes.length) {
    issues.push(
      issue(
        'blocker',
        'archetypes',
        '一段结果都没读到 —— RESULT 段头没被认出来',
        draft.archetypes[0]?.line ?? draft.titleLine,
        '段头要独占一行：== RESULT 1 | TL | pose=wave ==（两边各两个等号，中间竖线分隔）'
      )
    )
  } else if (draft.archetypes.length !== KIT_ARCHETYPES) {
    issues.push(
      issue(
        'blocker',
        'archetypes',
        `读到 ${draft.archetypes.length} 个结果，要 ${KIT_ARCHETYPES} 个`,
        draft.archetypes[0]?.line ?? draft.titleLine,
        '每个结果以 == RESULT 1 | TL | pose=wave == 开头'
      )
    )
  }
  if (!draft.questions.length) {
    issues.push(
      issue(
        'blocker',
        'questions',
        '一道题都没读到 —— Q 段头没被认出来',
        draft.archetypes[0]?.line ?? draft.titleLine,
        '段头要独占一行：== Q1 | 场景 ==（题量 6–10 道）'
      )
    )
  }
  if (!draft.archetypes.length || !draft.questions.length) return entry

  const kit = buildKit(draft, issues)
  if (!kit) return entry

  const validation = validateTextKit(kit)
  for (const rule of validation.rules) {
    if (rule.ok) continue
    const code: QuizTextCode =
      rule.id === 'questions'
        ? 'questions'
        : rule.id === 'archetypes'
          ? 'archetypes'
          : rule.id === 'options'
            ? 'options'
            : rule.id === 'mapping'
              ? 'names'
              : 'syntax'
    issues.push(issue(rule.level, code, rule.label, undefined, rule.detail))
  }

  const compiled = validation.ok ? compileQuizKit(kit) : null
  const v3List = v3Issues(kit, draft)
  issues.push(...v3List)

  // 体检只补结构性的 blocker（死区 / 重名）；文案类的扣分项在编辑器里还有一次机会，
  // 不在这里刷屏。`compiled` 只在契约层全过时才有 —— 契约层已经红了就没有体检可谈。
  for (const check of compiled?.audit?.blockers ?? []) {
    issues.push(issue('blocker', 'audit', check.label, undefined, check.detail))
  }

  const language = cjkField(kit)
  if (language) {
    issues.push(
      issue(
        'blocker',
        'language',
        `${language} 写的是中文`,
        draft.titleLine,
        '前台是英文站；自己改成英文，或点「AI 整理」翻成英文再存'
      )
    )
  }

  const blocked = issues.some((item) => item.level === 'blocker')
  return {
    ...entry,
    ok: !blocked,
    kit,
    compiled,
    validation,
    v3: { ok: v3List.every((item) => item.level !== 'blocker'), issues: v3List },
  }
}

/**
 * 粘一段（可能含多篇）→ 每篇一份结论。**不抛异常**：任何输入都返回结构与行号。
 * 空文本返回 `ok: true` + 空 entries（空框不该先是红的）。
 */
export function inspectQuizText(source: string): QuizTextInspection {
  const blocks = splitWithOffsets(source)
  if (!blocks.length) return { ok: true, entries: [], issues: [] }
  const entries = blocks.map((block) => inspectBlock(block.text, block.startLine))
  return { ok: entries.every((entry) => entry.ok), entries, issues: [] }
}

/* ------------------------------------------------------------------ *
 * 7. 回写：kit → 文本（AI 整理 / 自动修复都走这一条，绝不直接写库）
 * ------------------------------------------------------------------ */

/**
 * 把一份 kit 打回文本。
 *
 * 为什么回写文本而不是直接写库（P3 的 AI 整理用）：
 *   模型改了什么，人得**看得见**。回写成同一套模板，作者能在原来的框里逐行对照、
 *   撤销（框上有 undo），确认后才存 —— 而不是「点一下按钮，库里多了一卷我没读过的卷」。
 *
 * `kitToText(parse(QUIZ_TEXT_TEMPLATE))` 必须能再 parse 回同一份 kit，
 * `scripts/check-quiz-text.mts` 里有这条往返断言。
 */
export function kitToText(kit: QuizKit): string {
  const lines: string[] = [`TITLE: ${kit.title}`]
  if (kit.hook) lines.push(`HOOK: ${kit.hook}`)
  if (kit.topic) lines.push(`TOPIC: ${kit.topic}`)
  if (kit.tags.length) lines.push(`TAGS: ${kit.tags.join(' / ')}`)
  if (kit.axes) {
    lines.push(`AXIS X: ${kit.axes.x.neg} ←→ ${kit.axes.x.pos}`)
    lines.push(`AXIS Y: ${kit.axes.y.neg} ←→ ${kit.axes.y.pos}`)
  }

  kit.archetypes.forEach((archetype, index) => {
    const head = [`== RESULT ${index + 1}`]
    if (archetype.quadrant) head.push(archetype.quadrant)
    if (archetype.pose) head.push(`pose=${archetype.pose}`)
    // 只在「按 SHORT/NAME 推不出这个 id」时才写 id=，免得模板里多一行噪音。
    if (archetype.id !== normalizeArchetypeId(archetype.short ?? archetype.name)) head.push(`id=${archetype.id}`)
    if (archetype.color) head.push(`color=${archetype.color}`)

    lines.push('', `${head.join(' | ')} ==`, `NAME: ${archetype.name}`)
    if (archetype.short) lines.push(`SHORT: ${archetype.short}`)
    if (archetype.headline) lines.push(`HEADLINE: ${archetype.headline}`)
    if (archetype.quote) lines.push(`QUOTE: ${archetype.quote}`)
    if (archetype.summary) lines.push(`READ: ${archetype.summary}`)
    if (archetype.stats?.length) lines.push(`STATS: ${archetype.stats.join(' / ')}`)
    if (archetype.pills?.length) lines.push(`PILLS: ${archetype.pills.join(' / ')}`)
  })

  kit.questions.forEach((question, index) => {
    lines.push('', question.scene ? `== Q${index + 1} | ${question.scene} ==` : `== Q${index + 1} ==`)
    if (question.title) lines.push(question.title)

    question.options.forEach((option, optionIndex) => {
      const marks: string[] = []
      if (option.intensity !== undefined) marks.push(`(i${option.intensity})`)
      if (option.bold) marks.push('(b)')
      // 顺序映射之外的原型要写回 `→ Short`，否则再 parse 一次会换成另一个原型。
      const positional = kit.archetypes[optionIndex]?.id
      const target =
        option.primary && option.primary !== positional
          ? kit.archetypes.find((archetype) => archetype.id === option.primary)
          : null
      const arrow = option.primary !== positional ? ` → ${target?.short || target?.name || option.primary}` : ''
      lines.push(`${String.fromCharCode(65 + optionIndex)}. ${option.text}${marks.length ? `  ${marks.join(' ')}` : ''}${arrow}`)
    })
  })

  return `${lines.join('\n')}\n`
}

/* ------------------------------------------------------------------ *
 * 8. 落库：只造 draft 行，字段与 JSON 路径（lib/quizPack.ts 的 normalizePack）一致
 * ------------------------------------------------------------------ */

/**
 * 文本 → 一行 `quizzes`。**只造 draft**：不写 `published_at`、不写 `results`、
 * 不写 `questions_count` —— 这些是发布动作的产物，不是导入动作的产物。
 *
 * `raw_data` 的字段与 `normalizePack()` 给 axes 卷补的那一组逐字对齐
 * （title / model / categories / tags / cover_url / is_limited / archetypes / questions），
 * 所以文本路径存出来的卷，编辑页与前台读法与 JSON 路径完全一样。
 */
export function buildDraftRow(entry: QuizTextEntry): Record<string, unknown> | null {
  if (!entry.ok || !entry.kit || !entry.compiled) return null
  const { kit, compiled } = entry
  const { quiz } = compiled

  return {
    title: kit.title,
    active: false,
    status: 'draft',
    scoring_mode: 'axes',
    categories: compiled.categories,
    tags: compiled.tags,
    cover_url: '',
    raw_data: {
      title: kit.title,
      model: 'axes',
      categories: compiled.categories,
      tags: compiled.tags,
      cover_url: '',
      is_limited: false,
      ...(kit.hook ? { hook: kit.hook } : {}),
      ...(kit.axes ? { axes: kit.axes } : {}),
      archetypes: quiz.archetypes,
      questions: quiz.questions,
    },
  }
}

