/**
 * 大段小说文本 → 章节数组的切分 / 清洗 / 解码。纯函数、无副作用、不读环境变量。
 *
 * 为什么要有这一层（2026-11-01）：
 *   后台分章导入以前只有一个「JSON 批量」弹窗，它一次建【多部作品】，正文靠手敲。
 *   真实稿件是一整篇 Word / txt，粘进去会变成「一章 12 万字」，谁都改不动。
 *   这里把「一篇 → N 章」做成可断言的数据变换，UI 只是它的可视化：
 *     ① 识别四种章节标记：Markdown `#`/`##`、`第X章`、`Chapter X`、序章/楔子/番外；
 *     ② 正文必须存【纯文本】：前台 ComeBrief/app/(public)/stories/[slug]/page.tsx
 *        是 `text.split('\n').map(<p>)`，`##`/`**` 留在里面就会原样显示在读者眼前；
 *     ③ .txt 文件大量是 GBK（中文 Windows 默认），readAsText 会整篇乱码，
 *        所以有 decodeTextFile() 做 UTF-8 → GBK 回退嗅探。
 *
 * 契约（脚本 scripts/p14-story-import-check.mts 逐条断言）：
 *   splitChapters() 永远不抛异常；空输入返回空 parts + warning。
 */

/** 单次导入的章节上限：防止有人把整本书粘进来把浏览器卡死 */
export const MAX_PARTS = 300
/** 首个章节标记之前的文字，够长就单独成「前言」章，否则并进第一章 */
export const PREAMBLE_MIN_CHARS = 120
/** 少于这个字数的一章大概率是误切（正文句子被当成标题） */
export const MIN_PART_CHARS = 200
/** 多于这个字数的一章大概率是漏切（有标记没被识别） */
export const MAX_PART_CHARS = 20000
/** 前端上传上限 2MB：一章 5000 字 ≈ 15KB，2MB 足够一部中长篇 */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024

export type SplitRule = 'markdown' | 'cn' | 'en' | 'special' | 'even' | 'none'

export type SplitPart = {
  /** 章节标题（原文保持不动，它就是前台的 <h2>） */
  title: string
  /** 已清洗的纯正文，可直接写 content_text */
  body: string
  /** 正文字数（不含空白），统计条与异常提示都用它 */
  chars: number
  /** 这一章自己的问题：空章 / 过短 / 过长 */
  warnings: string[]
}

export type SplitResult = {
  parts: SplitPart[]
  /** 实际命中的规则（一篇稿子里可能混着 md 和「第X章」） */
  rules: SplitRule[]
  /** 整体问题（没识别到标记 / 章数超限 / 标题重复…） */
  warnings: string[]
  /** 中性提示（开头并入第一章、单独成前言…） */
  notes: string[]
}

export type ChapterDraft = {
  id: string
  title: string
  is_free: boolean
  price: number
  content_text: string
  comic_pages: string[]
}

export type DecodedText = {
  text: string
  /** utf-8 = 原样；gbk = 嗅探到乱码后重解 */
  encoding: 'utf-8' | 'gbk'
  /** 解码后残留的替换字符占比（0 = 干净） */
  replacedRatio: number
}

/* ------------------------------------------------------------------ *
 * 1. 归一化
 * ------------------------------------------------------------------ */

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g

/** CRLF / 全角空格 / BOM / 零宽字符统一掉，行首行尾空白剥掉（中文段的缩进两格不需要保留） */
export function normalizeText(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .replace(ZERO_WIDTH, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/\u3000/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, '').replace(/^[ \t]+/, ''))
    .join('\n')
}

/* ------------------------------------------------------------------ *
 * 2. 章节标记识别
 * ------------------------------------------------------------------ */

/** 标题行一般不长；超长的「第X章…」多半是正文句子（例：「第三章讲的是他怎么跑的。」） */
const HEADING_MAX_LEN = 40

const CN_HEADING =
  /^第\s*([〇零一二三四五六七八九十百千万两0-9０-９]{1,10})\s*([章节回卷篇部])(?:[\s:：、.．·\-—]+(.*))?$/
const EN_HEADING = /^(chapter|part)\s+([0-9]{1,4}|[ivxlcdm]{1,8})\b(?:[\s.:：\-—–]+(.*))?$/i
const SPECIAL_HEADING = /^(序章|序言|楔子|引子|前言|尾声|终章|尾章|后记|番外)(?:[\s:：·.\-—]{1,2}(.+))?$/
const MD_HEADING = /^(#{1,2})\s*(?!#)(\S.*)$/

/**
 * 判定一行是不是章节标题。命中返回标题，否则 null。
 * 顺序 = 优先级：md 标题 → 特殊章 → 「第X章」→「Chapter X」。
 */
export function detectHeading(line: string): { title: string; rule: SplitRule } | null {
  const text = line.trim()
  if (!text) return null

  const md = text.match(MD_HEADING)
  if (md) {
    // 去掉尾部闭合井号：`## 门后 ##` → `门后`
    const title = md[2].replace(/\s*#+$/, '').trim()
    if (title) return { title, rule: 'markdown' }
  }

  const special = text.match(SPECIAL_HEADING)
  if (special) {
    const extra = (special[2] ?? '').trim()
    if (extra.length <= 20) return { title: text, rule: 'special' }
  }

  const cn = text.match(CN_HEADING)
  if (cn) {
    const rest = (cn[3] ?? '').trim()
    // 无后半段 → 一定是标题；有后半段就要防「第X章讲的是…」这种正文句子
    if (!rest) return { title: text, rule: 'cn' }
    if (text.length <= HEADING_MAX_LEN && !/[。！？；，…]/.test(rest)) {
      return { title: text, rule: 'cn' }
    }
  }

  const en = text.match(EN_HEADING)
  if (en) {
    const rest = (en[3] ?? '').trim()
    if (!rest) return { title: text, rule: 'en' }
    if (text.length <= HEADING_MAX_LEN && !/[.!?;]/.test(rest)) {
      return { title: text, rule: 'en' }
    }
  }

  return null
}

/* ------------------------------------------------------------------ *
 * 3. 正文清洗（Markdown 必须剥干净，前台是逐行 <p>）
 * ------------------------------------------------------------------ */

const HR = /^(?:[-*_]\s*){3,}$/

/** 行内 markdown → 纯文本；不剥列表符（散文里极少，剥了反而会吃掉正文里的星号） */
function cleanLine(line: string): string {
  let out = line
  // 引用块标记
  while (/^\s*>\s?/.test(out)) out = out.replace(/^\s*>\s?/, '')
  // 三级以上标题当正文保留文字（`### 地点` → `地点`）
  out = out.replace(/^#{3,6}\s*(?!#)(.+)$/, '$1')
  // 图片整段丢弃，链接只留文字
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 行内代码 / 加粗 / 斜体
  out = out.replace(/`([^`]*)`/g, '$1')
  out = out.replace(/(\*\*|__)(.+?)\1/g, '$2')
  out = out.replace(/(\*|_)([^*_\s](?:[^*_]*?[^*_\s])?)\1/g, '$2')
  out = out.replace(/~~/g, '')
  return out.replace(/[ \t]{2,}/g, ' ').trim()
}

/** 行数组 → 纯正文：丢分隔线、剥行内标记、3+ 空行折叠成 1 个空行 */
export function cleanBody(lines: string[]): string {
  const kept: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (HR.test(line)) continue
    kept.push(cleanLine(line))
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 字数：不含空白字符（与 storyPrompt 里 countChineseChars 的口径一致） */
export function countChars(text: string): number {
  return text.replace(/\s+/g, '').length
}

/* ------------------------------------------------------------------ *
 * 4. 主切分
 * ------------------------------------------------------------------ */

type Draft = { title: string; rule: SplitRule; lines: string[] }

export type SplitOptions = {
  /** 开头这么长才单独成「前言」章，否则并进第一章 */
  minPreambleChars?: number
  /** 章数上限 */
  maxParts?: number
}

export function splitChapters(raw: string, opts: SplitOptions = {}): SplitResult {
  const minPreamble = opts.minPreambleChars ?? PREAMBLE_MIN_CHARS
  const maxParts = opts.maxParts ?? MAX_PARTS

  const rules: SplitRule[] = []
  const warnings: string[] = []
  const notes: string[] = []

  const text = normalizeText(raw)
  if (!text.trim()) {
    return { parts: [], rules, warnings: ['没有可导入的文字'], notes }
  }

  const drafts: Draft[] = []
  const preamble: string[] = []
  let current: Draft | null = null

  for (const line of text.split('\n')) {
    const hit = detectHeading(line)
    if (hit) {
      if (current) drafts.push(current)
      current = { title: hit.title, rule: hit.rule, lines: [] }
      if (!rules.includes(hit.rule)) rules.push(hit.rule)
      continue
    }
    if (current) current.lines.push(line)
    else preamble.push(line)
  }
  if (current) drafts.push(current)

  const preambleBody = cleanBody(preamble)
  const preambleChars = countChars(preambleBody)

  // 完全没有章节标记 → 整篇一章，由用户决定要不要「按长度等分」
  if (!drafts.length) {
    const part: SplitPart = {
      title: '正文',
      body: preambleBody,
      chars: preambleChars,
      warnings: [],
    }
    if (part.chars === 0) part.warnings.push('这一章没有正文')
    warnings.push(
      '没找到任何章节标记（#、##、第X章、Chapter X、序章/楔子/番外），整篇按一章处理；可用「按长度等分」再切一次'
    )
    return { parts: [part], rules: ['none'], warnings, notes }
  }

  if (preambleChars > 0) {
    if (preambleChars >= minPreamble) {
      drafts.unshift({ title: '前言', rule: 'none', lines: preamble })
      notes.push(`开头 ${preambleChars} 字已单独成「前言」章`)
    } else {
      notes.push(`开头 ${preambleChars} 字（短于 ${minPreamble}）已并入第一章`)
      drafts[0].lines = [...preamble, ...drafts[0].lines]
    }
  }

  let truncated = false
  if (drafts.length > maxParts) {
    truncated = true
    drafts.length = maxParts
  }

  const parts: SplitPart[] = drafts.map((draft, i) => {
    const body = cleanBody(draft.lines)
    const chars = countChars(body)
    const partWarnings: string[] = []
    if (chars === 0) partWarnings.push('这一章没有正文')
    else if (chars < MIN_PART_CHARS) partWarnings.push(`只有 ${chars} 字，可能是误切`)
    else if (chars > MAX_PART_CHARS) partWarnings.push(`${chars} 字，可能漏切了章节标记`)
    return {
      title: draft.title || `第 ${i + 1} 章`,
      body,
      chars,
      warnings: partWarnings,
    }
  })

  if (truncated) warnings.push(`章数超过上限 ${maxParts}，只保留前 ${maxParts} 章`)

  const seen = new Map<string, number>()
  for (const part of parts) seen.set(part.title, (seen.get(part.title) ?? 0) + 1)
  const dup = [...seen.entries()].filter(([, n]) => n > 1).map(([t]) => t)
  if (dup.length) {
    warnings.push(`有 ${dup.length} 个重复标题（${dup.slice(0, 3).join('、')}），建议改名`)
  }

  return { parts, rules, warnings, notes }
}

/**
 * 兜底：没有任何章节标记时，按空行分段后按字数等分。
 * 不默认启用 —— 散文硬切一定切在句子中间，只给用户一个显式按钮。
 */
export function splitEvenly(raw: string, targetChars = 3000): SplitPart[] {
  const body = cleanBody(normalizeText(raw).split('\n'))
  if (!body) return []

  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  const parts: SplitPart[] = []
  let buffer: string[] = []
  let buffered = 0

  const flush = () => {
    if (!buffer.length) return
    const text = buffer.join('\n\n')
    parts.push({
      title: `第 ${parts.length + 1} 章`,
      body: text,
      chars: countChars(text),
      warnings: [],
    })
    buffer = []
    buffered = 0
  }

  for (const paragraph of paragraphs) {
    const size = countChars(paragraph)
    // 攒够了就收；单段自身超长时独占一章（不会被劈成两半）
    if (buffered > 0 && buffered + size > targetChars) flush()
    buffer.push(paragraph)
    buffered += size
  }
  flush()

  return parts
}

/* ------------------------------------------------------------------ *
 * 5. 预览区的手动微调（合并 / 拆分），也做成纯函数以便断言
 * ------------------------------------------------------------------ */

/** 把 parts[index] 合并到前一章末尾，标题沿用前一章；index 为 0 或越界时原样返回 */
export function mergeParts(parts: SplitPart[], index: number): SplitPart[] {
  if (index <= 0 || index >= parts.length) return parts
  const prev = parts[index - 1]
  const cur = parts[index]
  const body = [prev.body, cur.body].filter(Boolean).join('\n\n')
  const merged: SplitPart = { title: prev.title, body, chars: countChars(body), warnings: [] }
  return [...parts.slice(0, index - 1), merged, ...parts.slice(index + 1)]
}

/**
 * 把 parts[index] 在 body 的第 offset 个字符处拆成两章。
 * offset 会向后吸附到最近的换行，避免把一个句子劈成两半。
 */
export function splitPartAt(parts: SplitPart[], index: number, offset: number): SplitPart[] {
  const part = parts[index]
  if (!part) return parts
  const body = part.body
  if (body.length < 2) return parts

  let cut = Math.max(1, Math.min(offset, body.length - 1))
  const nextBreak = body.indexOf('\n', cut)
  if (nextBreak > -1 && nextBreak - cut <= 200) cut = nextBreak + 1

  const head = body.slice(0, cut).trim()
  const tail = body.slice(cut).trim()
  if (!head || !tail) return parts

  const first: SplitPart = { title: part.title, body: head, chars: countChars(head), warnings: [] }
  const second: SplitPart = {
    title: `${part.title}（续）`,
    body: tail,
    chars: countChars(tail),
    warnings: [],
  }
  return [...parts.slice(0, index), first, second, ...parts.slice(index + 1)]
}

/* ------------------------------------------------------------------ *
 * 6. 写入编辑器状态
 * ------------------------------------------------------------------ */

/** SplitPart[] → 编辑器的 chapter 对象（id 形状与页面里 addChapter 的 `ch_xxx` 一致） */
export function toChapters(
  parts: SplitPart[],
  opts: { freeCount?: number; idSeed?: number } = {}
): ChapterDraft[] {
  const freeCount = opts.freeCount ?? 1
  const seed = (opts.idSeed ?? Date.now()).toString(36)
  return parts.map((part, i) => ({
    id: `ch_${seed}${i}`,
    title: part.title || `第 ${i + 1} 章`,
    is_free: i < freeCount,
    price: i < freeCount ? 0 : 99,
    content_text: part.body,
    comic_pages: [],
  }))
}

/* ------------------------------------------------------------------ *
 * 7. 文件解码（中文 txt 常见的 GBK 乱码）
 * ------------------------------------------------------------------ */

function replacementRatio(text: string): number {
  if (!text) return 0
  let bad = 0
  for (const ch of text) if (ch === '\uFFFD') bad += 1
  return bad / text.length
}

/**
 * UTF-8 优先；乱码比例超过 0.5% 就用 GBK 重解一次，取替换字符更少的那个。
 * 抽样字节 [B5 DA D2 BB D5 C2] = GBK 的「第一章」，脚本里有断言。
 */
export function decodeTextFile(input: ArrayBuffer | Uint8Array): DecodedText {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const utf8Ratio = replacementRatio(utf8)
  if (utf8Ratio <= 0.005) return { text: utf8, encoding: 'utf-8', replacedRatio: utf8Ratio }

  try {
    const gbk = new TextDecoder('gbk', { fatal: false }).decode(bytes)
    const gbkRatio = replacementRatio(gbk)
    if (gbkRatio < utf8Ratio) return { text: gbk, encoding: 'gbk', replacedRatio: gbkRatio }
  } catch {
    // 环境不支持 gbk 时保留 UTF-8 结果，交给用户手改
  }
  return { text: utf8, encoding: 'utf-8', replacedRatio: utf8Ratio }
}
