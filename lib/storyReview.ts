/**
 * P3 第二遍：AI 自评（把草稿读成一份 JSON 体检报告）。
 *
 * 为什么要这一步：
 *   第一遍草稿出来后，站长能看出「有点平」，但说不出平在哪、更不知道从哪句改。
 *   这一步让模型以**审稿人**身份，按 6 个维度打分，并且 —— 这是关键 ——
 *   每条问题都必须**照抄原文引句**（evidence）+ 给出**具体改法**（fix）。
 *   有了这份清单，第三遍才能做「定向重写」，而不是重新抽一次卡。
 *
 * 三条设计红线（踩了这一步就没意义）：
 *   1. **不许客气给分**：打分锚点写死在提示词里，且要求「没有原文证据不许给 8 分以上」。
 *      否则模型给满屏 8 分，评审等于没评。
 *   2. **只输出 JSON**：走 callText 的 jsonMode + 这里的宽松解析兜底。解析不出来就
 *      返回 ok:false —— 调用处照常保留原稿，绝不因为评审失败丢稿子。
 *   3. **维度固定 6 个**：多一个少一个都会让前端渲染和「按问题重写」失配。
 *
 * 这一层不碰数据库、不发请求，纯函数 —— 客户端组件也能直接 import。
 */
import { buildSkillBlock, type StorySkill } from './storyPrompt'
import { safeParseModelJson } from './aiGemini'

export type ReviewDimensionKey = 'hook' | 'character' | 'dialogue' | 'detail' | 'ending' | 'style'

export type ReviewDimension = {
  key: ReviewDimensionKey
  label: string
  /** 评这一维时要回答的问题（同时是提示词里的评分说明） */
  ask: string
}

/** 6 个维度：前 4 个管「好不好看」，末尾两个管「像不像人写的 / 像不像这套写法」 */
export const REVIEW_DIMENSIONS: ReviewDimension[] = [
  {
    key: 'hook',
    label: '开篇抓力',
    ask: '前 120 字里有没有具体的人在做具体的事、有没有反常或悬念？还是先铺天气、背景、心情？',
  },
  {
    key: 'character',
    label: '人物动机',
    ask: '主角想要什么、怕什么，能不能从动作和对话里看出来？有没有作者替人物解释内心？',
  },
  {
    key: 'dialogue',
    label: '对话自然度',
    ask: '像人说的话吗？有没有两个人互相交代设定、把话说满、把情绪直接说出来？',
  },
  {
    key: 'detail',
    label: '细节密度',
    ask: '有没有具体到能看见的物件、数字、动作？还是通篇形容词、气氛词、比喻？',
  },
  {
    key: 'ending',
    label: '结尾余味',
    ask: '最后一句是停在一个画面上，还是收口、升华、讲道理、把话说完？',
  },
  {
    key: 'style',
    label: '写法符形度',
    ask: '句长、分段、收尾方式跟给定写法（姿态板 + 范文）是不是同一支笔？有没有滑回均匀、四平八稳的默认腔调？',
  },
]

export type ReviewIssue = {
  /** I1 / I2 …（前端勾选用的 key） */
  id: string
  dimension: ReviewDimensionKey
  severity: 'high' | 'mid' | 'low'
  /** 原文引句（照抄正文，用于定位） */
  evidence: string
  /** 问题是什么 */
  problem: string
  /** 怎么改（越具体越好） */
  fix: string
}

export type ReviewScore = {
  key: ReviewDimensionKey
  label: string
  /** 0–10，一位小数 */
  score: number
  comment: string
}

export type StoryReview = {
  /** 六维平均分，一位小数 */
  total: number
  /** 一句话总评 */
  verdict: string
  scores: ReviewScore[]
  issues: ReviewIssue[]
  /** 出报告时用的模型（留痕，方便对比几版） */
  model?: string
}

export type ParseReviewResult =
  | { ok: true; review: StoryReview }
  | { ok: false; error: string; raw: string }


const clampScore = (n: unknown) => {
  const v = typeof n === 'number' ? n : Number(String(n ?? '').replace(/[^\d.-]/g, ''))
  if (!Number.isFinite(v)) return 0
  return Math.round(Math.min(10, Math.max(0, v)) * 10) / 10
}

const clip = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

const asArray = (v: unknown): any[] =>
  Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v as any) : []

/**
 * 把模型返回的 JSON 原文变成一份能直接渲染的报告。
 *
 * 宽容之处：scores 允许写成数组或对象、分数允许是字符串、severity 允许写中文。
 * 严格之处：维度必须是这 6 个、必须有 ≥4 个维度 —— 少了说明模型没照格式来，
 * 与其拿半份报告去驱动重写，不如老实报错。
 */
export function parseStoryReview(rawText: string, model?: string): ParseReviewResult {
  const raw = String(rawText || '')
  const parsed = safeParseModelJson(raw)
  if (parsed.ok === false) {
    return { ok: false, error: '模型没按 JSON 格式返回（解析失败）', raw: raw.slice(0, 500) }
  }
  const data: any = parsed.value
  const root = data?.review && typeof data.review === 'object' ? data.review : data

  // ---- 六个维度打分 ----
  // 兼容两种写法：数组 [{key,score,comment}] 和对象映射 { hook: 7, ending: {score:5,comment:'…'} }
  const scoreSource = root?.scores ?? root?.dimensions ?? root?.分项
  const rawEntries: Array<{ rawKey: string; value: any }> = Array.isArray(scoreSource)
    ? scoreSource.map((v: any) => ({ rawKey: String(v?.key ?? v?.dimension ?? v?.label ?? ''), value: v }))
    : scoreSource && typeof scoreSource === 'object'
      ? Object.entries(scoreSource).map(([k, v]) => ({ rawKey: k, value: v }))
      : []

  const byKey = new Map<ReviewDimensionKey, ReviewScore>()
  for (const { rawKey, value } of rawEntries) {
    const isObj = value !== null && typeof value === 'object'
    const dim = REVIEW_DIMENSIONS.find(
      (d) =>
        d.key === rawKey ||
        d.label === rawKey ||
        (isObj && (d.key === value.key || d.key === value.dimension || d.label === value.label))
    )
    if (!dim || byKey.has(dim.key)) continue
    byKey.set(dim.key, {
      key: dim.key,
      label: dim.label,
      score: clampScore(isObj ? (value.score ?? value.value) : value),
      comment: clip(isObj ? (value.comment ?? value.reason ?? value.note) : '', 160),
    })
  }
  if (byKey.size < 4) {
    return { ok: false, error: `模型只评了 ${byKey.size} 个维度（至少要 4 个）`, raw: raw.slice(0, 500) }
  }
  // 固定顺序输出，缺的补 0 分并注明 —— 前端那一列 6 格永远不会错位
  const scores: ReviewScore[] = REVIEW_DIMENSIONS.map(
    (d) =>
      byKey.get(d.key) ?? {
        key: d.key,
        label: d.label,
        score: 0,
        comment: '模型没评这一项（按 0 分算，建议重跑一次自评）',
      }
  )
  const total = Math.round((scores.reduce((s, x) => s + x.score, 0) / scores.length) * 10) / 10

  // ---- 待改清单 ----
  const issues: ReviewIssue[] = []
  const seen = new Set<string>()
  for (const item of asArray(root?.issues ?? root?.problems ?? root?.问题)) {
    const dim = REVIEW_DIMENSIONS.find(
      (d) => d.key === item?.dimension || d.key === item?.key || d.label === item?.dimension || d.label === item?.key
    )
    if (!dim) continue
    const evidence = clip(item?.evidence ?? item?.quote ?? item?.引句, 80)
    const problem = clip(item?.problem ?? item?.issue ?? item?.问题, 200)
    const fix = clip(item?.fix ?? item?.suggestion ?? item?.改法, 240)
    if (!problem && !fix) continue
    const dedupe = `${dim.key}|${evidence}|${problem}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    const sevRaw = String(item?.severity ?? item?.level ?? '').toLowerCase()
    const severity: ReviewIssue['severity'] = (['high', 'mid', 'low'] as const).includes(sevRaw as any)
      ? (sevRaw as ReviewIssue['severity'])
      : /high|高|必/.test(sevRaw)
        ? 'high'
        : /low|低|可选/.test(sevRaw)
          ? 'low'
          : 'mid'
    issues.push({ id: `I${issues.length + 1}`, dimension: dim.key, severity, evidence, problem, fix })
    if (issues.length >= 8) break
  }

  // 分低却没给问题的维度：用评语合成一条，保证「按问题重写」永远有料可用。
  // 只在 < 7 分时合成 —— 7~8 分的评语常常是「还行，稍微紧一点」，
  // 硬把它写成「问题」会产出「开篇抓力只给了 7.5 分：开篇动作精度高」这种废话。
  for (const s of scores) {
    if (s.score >= 7 || !s.comment) continue
    if (issues.some((i) => i.dimension === s.key)) continue
    issues.push({
      id: `I${issues.length + 1}`,
      dimension: s.key,
      severity: s.score < 6 ? 'high' : 'mid',
      evidence: '',
      problem: `${s.label}只给了 ${s.score} 分：${s.comment}`,
      fix: '按这一维的评语整段调整（对照姿态板改）',
    })
  }

  const verdict = clip(root?.verdict ?? root?.summary ?? root?.总评, 200) || `六维均分 ${total}`
  // 合成条排在有引句的条目后面，所以最后再截一次：模型给满 8 条时，先保真凭实据的。
  return { ok: true, review: { total, verdict, scores, issues: issues.slice(0, 8), model } }
}

/** 均分低于这个线，说明这篇还值得再改一遍 */
export const REVIEW_PASS_SCORE = 7.5

/**
 * 默认勾哪些问题去重写：
 *   必改的一律勾；某一维没到 8 分的问题也勾 —— 分数已经够高的维度就别动了，
 *   改得越多，越容易把本来对的地方改坏。
 */
export function pickDefaultIssueIds(review: StoryReview, minDimensionScore = 8): string[] {
  const lowDims = new Set(review.scores.filter((s) => s.score < minDimensionScore).map((s) => s.key))
  return review.issues.filter((i) => i.severity === 'high' || lowDims.has(i.dimension)).map((i) => i.id)
}

/** 分数 → 配色（前端共用，省得每处各写一套阈值） */
export function scoreTone(score: number) {
  if (score >= 8.5) return 'text-emerald-600 bg-emerald-50 border-emerald-100'
  if (score >= 7) return 'text-lime-600 bg-lime-50 border-lime-100'
  if (score >= 5.5) return 'text-amber-600 bg-amber-50 border-amber-100'
  return 'text-rose-600 bg-rose-50 border-rose-100'
}

/* ============================================================
 * 提示词：审稿人角色 + 打分锚点 + JSON 契约
 * ============================================================ */

const REVIEW_ROLE = [
  '你是一位中文短篇小说的审稿人。你不写故事，你只挑毛病 —— 挑得越准，作者越省事。',
  '你的读者是网站站长：他要拿你这份报告去改稿，所以每条意见都必须能直接落地。',
  '',
  '铁律：',
  '1. 只依据给到的正文说话。**每条问题都必须照抄正文里的连续片段当证据**，不许转述、不许自己编例句。',
  '2. 不许客气。没有原文证据支撑，不许给 8 分以上。满屏高分等于没评，那是最严重的失职。',
  '3. 只输出一个 JSON 对象。不要解释、不要寒暄、不要 ``` 包裹、不要注释。',
].join('\n')

/** 打分锚点 —— 写死在这里，防止模型自己发明刻度 */
const REVIEW_RUBRIC = [
  '【打分锚点（0–10 分，允许一位小数）】',
  '9–10：这一维做得很好，几乎挑不出可改之处 —— 只有你能举出具体证据时才给。',
  '7–8：合格，读者读得下去，但有一到两处明显能更好。',
  '5–6：能看出问题，读到那里会出戏。',
  '3–4：这一维基本没做到。',
  '0–2：完全失控（例如通篇讲道理、没有任何场景）。',
  '',
  '注意：**低于 8 分的维度必须至少给一条 issue**，并附上原文引句。',
].join('\n')

const REVIEW_JSON_CONTRACT = [
  '【输出格式：只输出这一个 JSON 对象】',
  '{',
  '  "verdict": "一句话总评，40 字以内，说清这篇最该先改什么",',
  '  "scores": [',
  '    { "key": "hook",      "score": 7,   "comment": "20 字以内的判断" },',
  '    { "key": "character", "score": 6.5, "comment": "…" },',
  '    { "key": "dialogue",  "score": 8,   "comment": "…" },',
  '    { "key": "detail",    "score": 7,   "comment": "…" },',
  '    { "key": "ending",    "score": 5,   "comment": "…" },',
  '    { "key": "style",     "score": 6,   "comment": "…" }',
  '  ],',
  '  "issues": [',
  '    {',
  '      "dimension": "ending",',
  '      "severity": "high",',
  '      "evidence": "照抄正文里的连续片段，10–40 字，一字不改",',
  '      "problem": "问题是什么，30 字以内",',
  '      "fix": "怎么改：具体到句子或段落，能给改写示范更好，60 字以内"',
  '    }',
  '  ]',
  '}',
  '',
  'key 只能取这六个（顺序照上面写）：hook 开篇抓力 / character 人物动机 / dialogue 对话自然度 /',
  'detail 细节密度 / ending 结尾余味 / style 写法符形度。',
  'severity 只能取 high（必改）/ mid（建议改）/ low（可改可不改）。',
  'issues 最多 8 条，按该改的优先级从高到低排；一条只对准一个具体位置，不许写「整体偏平」这种空话。',
].join('\n')

/** 评审的 system 提示词：审稿人角色 + 打分口径 + 输出契约（有写法时把写法一起给它，用于评 style） */
export function buildReviewSystemPrompt(skill?: StorySkill | null) {
  const parts: string[] = [REVIEW_ROLE, '']
  if (skill) {
    parts.push('【作者这次用的写法（只用来评 style 这一维，别拿它去评别的维度）】', buildSkillBlock(skill), '')
  } else {
    parts.push(
      '【作者没有选任何写法】',
      'style 这一维改为评「语言有没有 AI 味」：句子长短是不是过于均匀、每段是不是都在收口、有没有把话说尽。',
      ''
    )
  }
  parts.push(REVIEW_RUBRIC, '', REVIEW_JSON_CONTRACT)
  return parts.join('\n')
}

/** 评审的 user 提示词：本篇正文（要原文，不要摘要、不要 HTML 标签）*/
export function buildReviewUserPrompt(input: {
  title: string
  bodyText: string
  targetLength?: number
  /** 站长自己写的评价与想法（可留空）—— 只当线索，不许因为他说了就跟着改分 */
  notes?: string
}) {
  const { title, bodyText, targetLength, notes } = input
  const body = String(bodyText || '').trim()
  const parts: string[] = []
  if (title.trim()) parts.push(`【标题】${title.trim().slice(0, 60)}`, '')
  if (targetLength) {
    parts.push(`【目标篇幅】约 ${targetLength} 字（现在 ${body.length} 字；偏短本身不算问题，别只按字数给分）`, '')
  }
  parts.push('【正文（逐字评审，evidence 必须从这里照抄）】', body.slice(0, 8000))
  const own = String(notes || '').trim()
  if (own) {
    // 把站长的话喂进来，是为了让他关心的位置**一定被评到**（他提了却没回音，等于没评）；
    // 但打分锚点必须照旧 —— 否则「我和 AI 一起评」会退化成「AI 顺着我说」。
    parts.push(
      '',
      '【站长自己的判断（他关心的地方必须评到，但别顺着他说）】',
      own.slice(0, 800),
      '',
      '处理他的判断的规矩：',
      '1. 他点到的地方，必须给一条 issue：若你也认为有问题，就照常给证据和改法；若你判断没问题，也要照抄原文当 evidence，在 problem 里说清你的看法（他可以自己决定要不要改）。',
      '2. 打分锚点不变：不许因为他提了就跟着扣分，也不许加分。',
      '3. 他没提到但确实该改的地方，照常列出来。'
    )
  }
  return parts.join('\n')
}

export const SEVERITY_LABEL: Record<ReviewIssue['severity'], string> = {
  high: '必改',
  mid: '建议改',
  low: '可改可不改',
}
