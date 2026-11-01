/**
 * 测验 JSON 包（quiz pack）的解析 / 诊断 / 校验 / 归一化。
 *
 * 为什么要有这一层（2026-10-29）：
 *   后台「BATCH JSON IMPORT」以前是「一个 textarea + JSON.parse + insert」，
 *   任何一步出错都只弹一句 Invalid JSON Format。于是三类完全不同的错误被
 *   伪装成同一句「格式错误」：
 *     ① 真的 JSON 语法错：AI 输出带 ```json 围栏、中文引号 “ ”、尾逗号、// 注释；
 *     ② 能 parse 但结构不对：questions 不是数组 —— 导入【会成功】，之后点编辑
 *        直接白屏，因为编辑器无兜底地 quizData.questions.map(...)；
 *     ③ 数据库报错（title 为 null / 缺列 / RLS）也被报成「格式错误」。
 *   这里把 ①② 全部前移到提交之前，并且错误信息带上「第几行第几列 / 哪个字段」。
 *
 * 形状以库里已发布的真实行为准（2026-10-29 抽样 3 条 published 行）：
 *   score 模型：8 题 × 4 选项（分值 1/2/3/4）→ 可达 8–32 → 结果 8-12/13-19/20-26/27-32
 *   personality：选项带 tag，results 的 min/max 是「该 tag 被选中的次数」
 *   顶层 key：title / model / categories / tags / cover_url / is_limited / questions / results
 *   option.id 在生产数据里是每道题内复用的 o1..o4；question.id 形如 q12_1
 *
 * 纯函数、无副作用、不读环境变量 —— 所以能直接被
 * `scripts/p13-quiz-pack-check.mts` 断言（含「模板本身必须过校验」）。
 */

export type QuizModel = 'score' | 'personality'

export type QuizPackIssue = {
  /** 出错位置：questions[2].options[1].text 这种写法，UI 与文档共用 */
  path: string
  message: string
  /** blocker = 不能导入；warning = 能导但值得看一眼 */
  level: 'blocker' | 'warning'
}

export type QuizPackParseError = {
  /** 人话原因（带「第 X 行第 Y 列」） */
  message: string
  line?: number
  column?: number
  /** 追加的猜测提示（全角标点 / 单引号 / undefined …），没有就是空数组 */
  hints: string[]
  /** 原始 error.message，排查用 */
  raw: string
}

export type QuizPackSummary = {
  title: string
  model: QuizModel
  questionCount: number
  resultCount: number
  /** score 模型下「全选最低分 ~ 全选最高分」；算不出来就是 null */
  minScore: number | null
  maxScore: number | null
}

export type QuizPackEntry = {
  /** 同一段文本里第几篇（0 起） */
  index: number
  /** 已补默认值、可直接写 raw_data 的对象 */
  quiz: any
  issues: QuizPackIssue[]
  /** 没有 blocker 才能导入 */
  ok: boolean
  summary: QuizPackSummary
}

export type QuizPackInspection = {
  /** 解析成功且至少有一篇 */
  ok: boolean
  entries: QuizPackEntry[]
  /** 自动修复改了什么（中文描述，空数组 = 原文没毛病） */
  fixes: string[]
  /** 修复后的文本；「自动修复」按钮直接把它写回 textarea */
  fixedText: string
  error?: QuizPackParseError
}

/** 编辑器里预置的分类按钮（新增分类要在那个页面加，不然点不到） */
export const QUIZ_CATEGORIES = ['Persona', 'Subconscious', 'Social', 'Future'] as const

/** 编辑器里预置的运营标签 */
export const QUIZ_TAGS = ['hot', 'featured', 'hardcore'] as const

export const DEFAULT_CATEGORY = 'Persona'

const isPlainObject = (v: any): boolean =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const asText = (v: any): string => (typeof v === 'string' ? v.trim() : '')

const asStringArray = (v: any): string[] =>
  Array.isArray(v)
    ? v.filter((item) => typeof item === 'string' && item.trim()).map((item: string) => item.trim())
    : []

const toNumber = (v: any): number => {
  if (v === null || v === undefined) return NaN
  const text = String(v).trim()
  if (!text) return NaN
  const n = typeof v === 'number' ? v : Number(text.replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : NaN
}

/* ------------------------------------------------------------------ *
 * 1. 容错修复（只做「几乎不可能误伤正文」的那几件事，且由用户点按钮触发）
 * ------------------------------------------------------------------ */

type RewriteResult = { text: string; applied: string[] }

/**
 * 去掉 ```json 围栏、把中文双引号换成英文、删尾逗号 / 注释 / 全角空格。
 *
 * 只处理「字符串外面」的符号（用扫描器跟踪 ASCII 双引号的开闭），
 * 所以正文里的 // 、逗号、引号不会被改坏。
 * 唯一例外是中文双引号 “ ”：它们几乎总是被 AI 当引号用的，全局替换。
 * 中文单引号 ’ 不替换（在字符串里是合法内容），只在解析失败时提示。
 */
export function rewritePackText(raw: string): RewriteResult {
  let text = String(raw ?? '')
  const applied: string[] = []

  // 1) ```json / ``` 围栏（整段包裹，或只贴了一半）
  const fenced = text.match(/^\s*```[a-zA-Z0-9]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```[ \t]*\s*$/)
  if (fenced) {
    text = fenced[1]
    applied.push('去掉 ```json 代码围栏')
  } else {
    const head = text.match(/^\s*```[a-zA-Z0-9]*[ \t]*\r?\n/)
    if (head) {
      text = text.slice(head[0].length)
      applied.push('去掉开头的 ``` 代码围栏')
    }
    if (/```\s*$/.test(text)) {
      text = text.replace(/\s*```\s*$/, '')
      applied.push('去掉结尾的 ``` 代码围栏')
    }
  }

  // 2) 中文双引号 → 英文双引号
  const smartCount = (text.match(/[“”]/g) || []).length
  if (smartCount > 0) {
    text = text.replace(/[“”]/g, '"')
    applied.push(`把 ${smartCount} 个中文双引号 “ ” 换成英文 "`)
  }

  // 3) 逐字符扫描：只在字符串外面删尾逗号 / 注释，替换全角空格
  let out = ''
  let inString = false
  let trailingCommas = 0
  let comments = 0
  let spaces = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]

    if (inString) {
      out += ch
      if (ch === '\\' && i + 1 < text.length) {
        out += text[i + 1]
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i += 1
      continue
    }

    if (ch === '"') {
      inString = true
      out += ch
      i += 1
      continue
    }

    if (ch === '\u00a0' || ch === '\u3000') {
      out += ' '
      spaces += 1
      i += 1
      continue
    }

    // 行注释 //（URL 里的 // 在字符串内，已经走不到这里）
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      comments += 1
      continue
    }

    // 块注释 /* … */
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
      comments += 1
      continue
    }

    // 尾逗号 ,} / ,]
    if (ch === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j += 1
      if (text[j] === '}' || text[j] === ']') {
        trailingCommas += 1
        i += 1
        continue
      }
    }

    out += ch
    i += 1
  }

  if (trailingCommas > 0) applied.push(`删掉 ${trailingCommas} 个多余的尾逗号`)
  if (comments > 0) applied.push(`删掉 ${comments} 处 // 或 /* */ 注释`)
  if (spaces > 0) applied.push(`把 ${spaces} 个全角/不间断空格换成普通空格`)

  return { text: out.trim(), applied }
}

/* ------------------------------------------------------------------ *
 * 2. 解析失败 → 「第几行第几列 + 人话」
 * ------------------------------------------------------------------ */

function lineColumnOf(text: string, position: number): { line: number; column: number } {
  const safe = Math.max(0, Math.min(position, text.length))
  const before = text.slice(0, safe)
  const line = before.split('\n').length
  const column = safe - before.lastIndexOf('\n')
  return { line, column }
}

function beyondCheck(text: string): string[] {
  const hints: string[] = []
  if (/[\uFF0C]/.test(text)) hints.push('这段里有全角逗号「，」—— JSON 只认英文逗号「,」')
  if (/[\uFF1A]/.test(text)) hints.push('这段里有全角冒号「：」—— JSON 只认英文冒号「:」')
  if (/[\u2018\u2019]/.test(text)) hints.push('这段里有中文单引号「’」—— JSON 里不能当引号用')
  if (/\bundefined\b/.test(text)) hints.push('JSON 不支持 undefined，用 null 或直接删掉这个字段')
  if (/\bNaN\b/.test(text)) hints.push('JSON 不支持 NaN，只能写数字')
  if (/(^|[\s,[{])'[^'\n]*'\s*:/.test(text)) hints.push('看起来用单引号当了键的引号 —— JSON 只认英文双引号 "')
  return hints
}

function humanizeParseMessage(rawMessage: string): string {
  const msg = rawMessage.trim()
  const unexpected = msg.match(/Unexpected token\s+'?([^\s']+)'?/i)
  if (/Unexpected end of JSON input/i.test(msg)) return '内容没写完：括号或引号少了一个'
  if (unexpected) return `这里出现了一个不该出现的字符 ${unexpected[1]}`
  if (/Expected property name or '\}'/i.test(msg)) return '这里应该是 "键": 值 的形式（可能多了逗号，或键没加引号）'
  if (/Expected ',' or '\}'/i.test(msg)) return '少了一个逗号，或者多了一段内容'
  if (/Expected ',' or '\]'/i.test(msg)) return '少了一个逗号，或者数组少了一个 ]'
  if (/Expected double-quoted property name/i.test(msg)) return '键必须用英文双引号包起来'
  if (/Bad control character/i.test(msg)) return '字符串里有没转义的换行（要用 \\n）'
  return msg || 'JSON 解析失败'
}

export function describeParseError(source: string, err: any): QuizPackParseError {
  const raw = String(err?.message || err || '')
  const lineColumn = raw.match(/line\s+(\d+)\s+column\s+(\d+)/i)
  const position = raw.match(/(?:at\s+)?position\s+(\d+)/i)

  let line: number | undefined
  let column: number | undefined
  if (lineColumn) {
    line = Number(lineColumn[1])
    column = Number(lineColumn[2])
  } else if (position) {
    const found = lineColumnOf(source, Number(position[1]))
    line = found.line
    column = found.column
  } else {
    // Node 22+ / Chrome 的 JSON.parse 不再给 position，只甩一段 `...'}' is not valid JSON`，
    // 浏览器（Safari 更狠，只说 unexpected identifier）也没法靠。这里自己扫一遍定位。
    const index = firstJsonProblemIndex(source)
    if (index !== null) {
      const found = lineColumnOf(source, index)
      line = found.line
      column = found.column
    }
  }

  const where = line ? `第 ${line} 行${column ? `第 ${column} 列` : ''}：` : ''
  return {
    message: `${where}${humanizeParseMessage(raw)}`,
    line,
    column,
    hints: beyondCheck(source),
    raw,
  }
}

/**
 * 只为一个目的服务：JSON.parse 报错没带 position 时，自己扫出「第一个不对的位置」。
 * 不是完整校验器（字面量 1e5 / 转义合法性都交给 JSON.parse），
 * 结构错（少逗号、多逗号、缺冒号、括号没闭合、字符串没闭合）足够准。
 */
function firstJsonProblemIndex(text: string): number | null {
  let i = 0
  let problem: number | null = null
  const stop = (at: number): never => {
    if (problem === null) problem = at
    throw new Error('__stop__')
  }
  const skipWs = () => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i += 1
  }

  function parseString(): void {
    i += 1
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2
        continue
      }
      if (text[i] === '"') {
        i += 1
        return
      }
      i += 1
    }
    stop(Math.max(0, i - 1))
  }

  function parseValue(): void {
    skipWs()
    const ch = text[i]
    if (ch === undefined) stop(i)
    if (ch === '{') return parseObject()
    if (ch === '[') return parseArray()
    if (ch === '"') return parseString()
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i))
      if (!m) stop(i)
      i += m[0].length
      return
    }
    if (text.startsWith('true', i)) return void (i += 4)
    if (text.startsWith('false', i)) return void (i += 5)
    if (text.startsWith('null', i)) return void (i += 4)
    stop(i)
  }

  function parseArray(): void {
    i += 1
    skipWs()
    if (text[i] === ']') {
      i += 1
      return
    }
    for (;;) {
      parseValue()
      skipWs()
      if (text[i] === ',') {
        i += 1
        continue
      }
      if (text[i] === ']') {
        i += 1
        return
      }
      stop(i)
    }
  }

  function parseObject(): void {
    i += 1
    skipWs()
    if (text[i] === '}') {
      i += 1
      return
    }
    for (;;) {
      skipWs()
      if (text[i] !== '"') stop(i)
      parseString()
      skipWs()
      if (text[i] !== ':') stop(i)
      i += 1
      parseValue()
      skipWs()
      if (text[i] === ',') {
        i += 1
        continue
      }
      if (text[i] === '}') {
        i += 1
        return
      }
      stop(i)
    }
  }

  try {
    skipWs()
    parseValue()
    skipWs()
    if (i < text.length) stop(i)
  } catch {
    // stop() 已经把位置记下来了
  }
  return problem
}

/* ------------------------------------------------------------------ *
 * 3. 结构校验（把「编辑页白屏 / 测完没有结果页」这类坑挡在提交之前）
 * ------------------------------------------------------------------ */

/** score 模型的可达区间：每题取最小选项分求和 / 取最大选项分求和。 */
export function reachableRange(questions: any[]): { min: number; max: number } | null {
  if (!Array.isArray(questions) || questions.length === 0) return null
  let min = 0
  let max = 0
  for (const q of questions) {
    const options = Array.isArray(q?.options) ? q.options : []
    const scores = options.map((o: any) => toNumber(o?.score))
    if (scores.length === 0 || scores.some((s) => !Number.isFinite(s))) return null
    min += Math.min(...scores)
    max += Math.max(...scores)
  }
  return { min, max }
}

export function validatePack(quiz: any): QuizPackIssue[] {
  const issues: QuizPackIssue[] = []
  const add = (path: string, message: string, level: QuizPackIssue['level'] = 'blocker') =>
    issues.push({ path, message, level })

  if (!isPlainObject(quiz)) {
    add('(根)', '每一篇必须是一个对象 { ... }，不能是字符串 / 数字 / 数组')
    return issues
  }

  if (!asText(quiz.title)) add('title', '缺标题：这个字段会写进列表页，不能为空')

  const model: QuizModel | null =
    quiz.model === undefined || quiz.model === null || quiz.model === 'score'
      ? 'score'
      : quiz.model === 'personality'
        ? 'personality'
        : null
  if (model === null) add('model', `model 只能是 "score" 或 "personality"，当前是 ${JSON.stringify(quiz.model)}`)

  if (quiz.categories !== undefined) {
    if (!Array.isArray(quiz.categories)) {
      add('categories', 'categories 必须是数组，例如 ["Persona"]')
    } else {
      const unknown = quiz.categories.filter(
        (c: any) => typeof c === 'string' && c.trim() && !(QUIZ_CATEGORIES as readonly string[]).includes(c.trim())
      )
      if (unknown.length) {
        add(
          'categories',
          `分类 ${unknown.join('、')} 不在编辑器预置列表（${QUIZ_CATEGORIES.join(' / ')}）里 —— 能存，但后台分类按钮点不到它`,
          'warning'
        )
      }
    }
  }

  if (quiz.tags !== undefined) {
    if (!Array.isArray(quiz.tags)) {
      add('tags', 'tags 必须是数组，例如 ["hot"]；不需要就写 []')
    } else {
      const unknown = quiz.tags.filter(
        (t: any) => typeof t === 'string' && t.trim() && !(QUIZ_TAGS as readonly string[]).includes(t.trim())
      )
      if (unknown.length) {
        add('tags', `运营标签 ${unknown.join('、')} 编辑器里没有对应按钮（只有 ${QUIZ_TAGS.join(' / ')}）`, 'warning')
      }
    }
  }

  if (quiz.cover_url !== undefined && typeof quiz.cover_url !== 'string') {
    add('cover_url', 'cover_url 必须是字符串，没有封面就写 ""')
  }
  if (quiz.is_limited !== undefined && typeof quiz.is_limited !== 'boolean') {
    add('is_limited', 'is_limited 只能是 true / false', 'warning')
  }

  const questions: any[] = quiz.questions
  if (!Array.isArray(questions) || questions.length === 0) {
    add('questions', '缺 questions 数组（至少 1 题）。没有它，点「编辑」打开会白屏')
    return issues
  }

  const seenQuestionIds = new Map<string, number>()
  questions.forEach((q: any, qi: number) => {
    const p = `questions[${qi}]`
    if (!isPlainObject(q)) {
      add(p, '题目必须是对象')
      return
    }
    if (!asText(q.title)) add(`${p}.title`, '题干为空')

    const qid = asText(q.id)
    if (qid) {
      if (seenQuestionIds.has(qid)) {
        add(`${p}.id`, `题目 id "${qid}" 与 questions[${seenQuestionIds.get(qid)}] 重复（同一篇内必须唯一）`, 'warning')
      } else {
        seenQuestionIds.set(qid, qi)
      }
    }

    const options: any[] = q.options
    if (!Array.isArray(options) || options.length < 2) {
      add(`${p}.options`, '选项至少 2 个（前端版式按 4 个设计，建议 4 个）')
      return
    }
    options.forEach((o: any, oi: number) => {
      const op = `${p}.options[${oi}]`
      if (!isPlainObject(o)) {
        add(op, '选项必须是对象')
        return
      }
      if (!asText(o.text)) add(`${op}.text`, '选项文案为空')
      if (model === 'score') {
        const score = toNumber(o.score)
        if (!Number.isFinite(score)) {
          add(`${op}.score`, 'score 模型下每个选项都要有数字分数')
        } else if (!Number.isInteger(score)) {
          add(`${op}.score`, `分数 ${o.score} 不是整数（编辑器按整数读，建议 1/2/3/4）`, 'warning')
        }
      }
      if (model === 'personality' && !asText(o.tag)) {
        add(`${op}.tag`, 'personality 模型下每个选项都要写 tag（对应一个结果人格）')
      }
    })
  })

  const results: any[] = quiz.results
  if (!Array.isArray(results) || results.length === 0) {
    add('results', '缺 results 数组（至少 1 条结果），测完没有结果页')
    return issues
  }

  const seenResultIds = new Map<string, number>()
  results.forEach((r: any, ri: number) => {
    const rp = `results[${ri}]`
    if (!isPlainObject(r)) {
      add(rp, '结果必须是对象')
      return
    }
    const min = toNumber(r.min_score)
    const max = toNumber(r.max_score)
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      add(`${rp}.min_score / max_score`, '区间必须是数字')
    } else if (min > max) {
      add(rp, `min_score(${min}) 大于 max_score(${max})`)
    }
    if (!asText(r.title)) add(`${rp}.title`, '结果标题为空')
    if (r.description !== undefined && typeof r.description !== 'string') {
      add(`${rp}.description`, 'description 必须是字符串', 'warning')
    } else if (!asText(r.description)) {
      add(`${rp}.description`, '结果解读是空的，结果页会很干', 'warning')
    }
    const rid = asText(r.id)
    if (rid) {
      if (seenResultIds.has(rid)) {
        add(`${rp}.id`, `结果 id "${rid}" 与 results[${seenResultIds.get(rid)}] 重复`, 'warning')
      } else {
        seenResultIds.set(rid, ri)
      }
    }
  })

  const ranges = results
    .filter(isPlainObject)
    .map((r: any) => ({ min: toNumber(r.min_score), max: toNumber(r.max_score) }))
    .filter((r) => Number.isFinite(r.min) && Number.isFinite(r.max))
    .sort((a, b) => a.min - b.min)

  if (model === 'score') {
    const range = reachableRange(questions)
    if (range && ranges.length) {
      const first = ranges[0]
      const last = ranges[ranges.length - 1]
      if (first.min > range.min) {
        add(
          'results',
          `最低分没人接：全选最低分是 ${range.min}，但第一条结果从 ${first.min} 起步（${range.min}–${first.min - 1} 分会拿到空结果）`
        )
      }
      if (last.max < range.max) {
        add('results', `最高分没人接：全选最高分是 ${range.max}，但最后一条结果只到 ${last.max}`)
      }
      for (let i = 1; i < ranges.length; i++) {
        const prev = ranges[i - 1]
        const cur = ranges[i]
        if (cur.min > prev.max + 1) {
          add('results', `区间有缝：${prev.max} 分和 ${cur.min} 分之间（${prev.max + 1}–${cur.min - 1}）没有对应结果`)
        } else if (cur.min <= prev.max) {
          add(
            'results',
            `区间重叠：${prev.min}-${prev.max} 与 ${cur.min}-${cur.max} 都盖住了 ${cur.min} 分（前端取第一条命中，后面的可能永远出不来）`,
            'warning'
          )
        }
      }
    }
  } else {
    const tags = new Set<string>()
    questions.forEach((q: any) => {
      const options = Array.isArray(q?.options) ? q.options : []
      options.forEach((o: any) => {
        const tag = asText(o?.tag)
        if (tag) tags.add(tag)
      })
    })
    if (tags.size && tags.size !== results.length) {
      add(
        'results',
        `选项里出现了 ${tags.size} 个 tag（${[...tags].join('、')}），但只有 ${results.length} 条结果 —— 按 tag 命中次数落点，数量对不上通常意味着有条结果永远出不来`,
        'warning'
      )
    }
  }

  return issues
}

/* ------------------------------------------------------------------ *
 * 4. 归一化：补默认值，保证写进 raw_data 的东西「编辑器打开不崩」
 * ------------------------------------------------------------------ */

/**
 * 补默认值 + 修 id。
 *
 * 特意保留原始对象上的其它字段（...src / ...q / ...o），因为前台可能已经在用
 * 我们不知道的扩展字段，删掉属于破坏性改动。
 * id 用「索引」而不是时间戳：稳定、可 diff，且编辑器只要求同篇内唯一。
 */
export function normalizePack(quiz: any): any {
  const src = isPlainObject(quiz) ? quiz : {}
  const model: QuizModel = src.model === 'personality' ? 'personality' : 'score'
  const questions: any[] = Array.isArray(src.questions) ? src.questions.filter(isPlainObject) : []
  const results: any[] = Array.isArray(src.results) ? src.results.filter(isPlainObject) : []

  return {
    ...src,
    title: asText(src.title),
    model,
    categories: asStringArray(src.categories).length ? asStringArray(src.categories) : [DEFAULT_CATEGORY],
    tags: asStringArray(src.tags),
    cover_url: typeof src.cover_url === 'string' ? src.cover_url : '',
    is_limited: Boolean(src.is_limited),
    questions: questions.map((q, qi) => ({
      ...q,
      id: asText(q.id) || `q${qi + 1}`,
      title: asText(q.title),
      weight: Number.isFinite(toNumber(q.weight)) ? toNumber(q.weight) : 1,
      options: (Array.isArray(q.options) ? q.options.filter(isPlainObject) : []).map((o: any, oi: number) => ({
        ...o,
        id: asText(o.id) || `o${oi + 1}`,
        text: asText(o.text),
        score: Number.isFinite(toNumber(o.score)) ? Math.round(toNumber(o.score)) : 0,
        tag: asText(o.tag),
      })),
    })),
    results: results.map((r, ri) => ({
      ...r,
      id: asText(r.id) || `r${ri + 1}`,
      min_score: Number.isFinite(toNumber(r.min_score)) ? Math.round(toNumber(r.min_score)) : 0,
      max_score: Number.isFinite(toNumber(r.max_score)) ? Math.round(toNumber(r.max_score)) : 0,
      title: asText(r.title),
      description: asText(r.description),
    })),
  }
}

export function summarizePack(quiz: any): QuizPackSummary {
  const questions: any[] = Array.isArray(quiz?.questions) ? quiz.questions : []
  const results: any[] = Array.isArray(quiz?.results) ? quiz.results : []
  const range = quiz?.model === 'personality' ? null : reachableRange(questions)
  return {
    title: asText(quiz?.title),
    model: quiz?.model === 'personality' ? 'personality' : 'score',
    questionCount: questions.length,
    resultCount: results.length,
    minScore: range ? range.min : null,
    maxScore: range ? range.max : null,
  }
}

/* ------------------------------------------------------------------ *
 * 5. 一个框 → 检查结果（UI 直接用这个）
 * ------------------------------------------------------------------ */

/** 把 parse 出来的值（对象或数组）变成 entries；空数组返回 null。 */
function buildEntries(parsed: any): QuizPackEntry[] | null {
  const packs = Array.isArray(parsed) ? parsed : [parsed]
  if (packs.length === 0) return null
  return packs.map((quiz, index) => {
    const issues = validatePack(quiz)
    const normalized = normalizePack(quiz)
    return {
      index,
      quiz: normalized,
      issues,
      ok: !issues.some((issue) => issue.level === 'blocker'),
      summary: summarizePack(normalized),
    }
  })
}

export function inspectPackText(text: string): QuizPackInspection {
  const raw = String(text ?? '')
  const trimmed = raw.trim()
  const { text: fixed, applied } = rewritePackText(raw)

  if (!trimmed) {
    return {
      ok: false,
      entries: [],
      fixes: applied,
      fixedText: fixed,
      error: { message: '这个框还是空的', hints: [], raw: '' },
    }
  }

  // 先按用户粘贴的原样解析；失败才走容错（这样报错的行号永远对得上原文）
  let strictError: any = null
  try {
    const entries = buildEntries(JSON.parse(trimmed))
    if (entries) return { ok: true, entries, fixes: [], fixedText: fixed }
    return {
      ok: false,
      entries: [],
      fixes: applied,
      fixedText: fixed,
      error: { message: '这是个空数组，里面没有测验', hints: [], raw: '' },
    }
  } catch (err) {
    strictError = err
  }

  if (fixed && fixed !== trimmed) {
    try {
      const entries = buildEntries(JSON.parse(fixed))
      if (entries) return { ok: true, entries, fixes: applied, fixedText: fixed }
    } catch {
      // 容错后还是不行，回到原始报错
    }
  }

  return {
    ok: false,
    entries: [],
    fixes: applied,
    fixedText: fixed,
    error: describeParseError(trimmed, strictError),
  }
}

/** 「格式化」按钮：重新缩进成 2 空格（会先跑一遍容错修复）。 */
export function formatPackText(text: string): { ok: boolean; text: string; error?: QuizPackParseError } {
  const { text: fixed } = rewritePackText(text)
  try {
    const parsed = JSON.parse(fixed)
    return { ok: true, text: JSON.stringify(parsed, null, 2) }
  } catch (err) {
    return { ok: false, text: fixed, error: describeParseError(fixed, err) }
  }
}

/* ------------------------------------------------------------------ *
 * 6. 模板 / 说明（「模板」按钮、docs 文档、p13 自检共用同一份，别各写一份）
 * ------------------------------------------------------------------ */

/** 文档位置（弹窗里的「查看格式说明」提示用） */
export const QUIZ_PACK_DOC_PATH = 'docs/quiz-json-format.md'

/**
 * score 模型模板：2 题 × 4 选项，分值 1/2/3/4 → 可达 2–8 分，
 * 结果区间 2-4 / 5-6 / 7-8 正好首尾覆盖、无重叠。
 *
 * 加题时的算法（一定要记牢）：
 *   下限 = Σ 每题最小选项分，上限 = Σ 每题最大选项分；
 *   结果区间要从下限到上限连续铺满，中间不能留缝（8 题 × 1~4 分 = 8–32）。
 */
export const SCORE_TEMPLATE = `{
  "title": "你是哪种恋爱类型",
  "model": "score",
  "categories": ["Persona"],
  "tags": [],
  "cover_url": "",
  "is_limited": false,
  "questions": [
    {
      "id": "q1",
      "title": "周五晚上突然空出三个小时，你会？",
      "weight": 1,
      "options": [
        { "id": "o1", "text": "约人出门，越热闹越好", "score": 4 },
        { "id": "o2", "text": "去一家熟悉的店坐一会儿", "score": 3 },
        { "id": "o3", "text": "在家补一部一直想看的片", "score": 2 },
        { "id": "o4", "text": "什么都不做，先睡一觉", "score": 1 }
      ]
    },
    {
      "id": "q2",
      "title": "对方三天没回消息，你的第一反应是？",
      "weight": 1,
      "options": [
        { "id": "o1", "text": "直接问一句「你最近还好吗」", "score": 4 },
        { "id": "o2", "text": "先忙自己的事，等对方开口", "score": 3 },
        { "id": "o3", "text": "翻一遍聊天记录找原因", "score": 2 },
        { "id": "o4", "text": "当作没发生，慢慢就淡了", "score": 1 }
      ]
    }
  ],
  "results": [
    {
      "id": "r1",
      "min_score": 2,
      "max_score": 4,
      "title": "松弛派",
      "description": "你把关系放在生活的其中一格，而不是全部。对方慢，你也慢，很少为了回应速度内耗。"
    },
    {
      "id": "r2",
      "min_score": 5,
      "max_score": 6,
      "title": "平衡派",
      "description": "你愿意主动，但也留着自己的节奏。关系里的分寸感是你最擅长的事。"
    },
    {
      "id": "r3",
      "min_score": 7,
      "max_score": 8,
      "title": "投入派",
      "description": "你习惯把在意说出口，也期待同样的回应。热烈是你的优点，偶尔也是你的负担。"
    }
  ]
}`

/** 「模板」按钮可插入的模板（目前只放最常用的 score；personality 见文档） */
export const QUIZ_PACK_TEMPLATES: Record<string, string> = {
  score: SCORE_TEMPLATE,
}

/** 弹窗里「格式说明」折叠面板的要点，和 docs/quiz-json-format.md 同源 */
export const QUIZ_PACK_CHECKLIST: string[] = [
  '一个框 = 一篇。也可以在一个框里放 [ {...}, {...} ]，一次导入多篇。',
  '必填四项：title / model / questions / results。缺 questions 会导入成功但编辑页白屏。',
  'score 模型：每题 4 个选项，分值 1/2/3/4；结果区间必须从「所有题最小分之和」到「所有题最大分之和」连续铺满，中间不能有缝或重叠。',
  'personality 模型：每个选项写 tag，results 的 min_score / max_score 是「该 tag 被选中的次数」。',
  '不要贴 ```json 围栏、不要用中文引号 “ ”、不要尾逗号、不要 // 注释 —— 这几样都能一键修复。',
  '导入进来的一律是草稿（status = draft、active = false），去 /admin/quizzes 点编辑、设时间、再发布。',
]


