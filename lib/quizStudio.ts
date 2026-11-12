/**
 * Quiz Studio 的纯逻辑层（无 React、无 Supabase）。
 *
 * 静态稿 `/mockup/quiz-studio` 里所有数字都来自 `data.ts`，所以「点列表没反应、
 * 点三个点没反应」不是交互 bug，而是根本没有数据与动作。这里把真实后台需要
 * 的判断集中到一处，保证列表、详情抽屉、检查屏、分类屏用的是同一份口径：
 *
 *   · `quizHealth()`：axes 卷直接复用 `auditAxeQuiz()`（与 CI 的 check:quiz 同源）；
 *     旧的 score / personality 卷没有权重矩阵，就按「结构完整度」给一份可解释的
 *     检查表 —— 不伪造命中率、不伪造浏览量。
 *   · `quizTopicList()`：与 ComeBrief `lib/quiz-topics.ts` 同规则（categories 可能
 *     是数组，也可能是历史 CSV 字符串；slug 化后去重）。后台分类屏与前台主题页
 *     因此永远说同一件事。
 *   · `buildAxesRawData()` / `duplicateQuizRow()`：矩阵保存与「复制一份」的写库
 *     载荷只在这里拼，避免不同按钮写出不同形状的 raw_data。
 *
 * 这里**不做任何网络请求**，所以可以直接被脚本断言，也不会把 Supabase 客户端
 * 带进服务端渲染。
 */

import {
  auditAxeQuiz,
  isAxeQuiz,
  normalizeAxeQuiz,
  type AxeAudit,
  type AxeCheck,
  type AxeQuiz,
} from './quizAxes'

/** 一条 quizzes 行。字段都按「可能缺列」处理：阶段 0 的 SQL 不一定跑过。 */
export type QuizRow = {
  id: string
  title?: string | null
  slug?: string | null
  description?: string | null
  categories?: unknown
  tags?: unknown
  cover_url?: string | null
  raw_data?: unknown
  status?: string | null
  active?: boolean | null
  scheduled_at?: string | null
  published_at?: string | null
  publish_error?: string | null
  is_featured?: boolean | null
  featured_order?: number | null
  questions_count?: number | null
  created_at?: string | null
  updated_at?: string | null
  scoring_mode?: string | null
  [key: string]: any
}

export type StudioCheckLevel = 'ok' | 'warning' | 'blocker'

export type StudioCheck = {
  id: string
  level: StudioCheckLevel
  label: string
  detail?: string
  /** 未通过时扣的分；ok 时保留，方便 UI 显示「修好这项 +8」。 */
  penalty: number
}

export type QuizHealth = {
  score: number
  checks: StudioCheck[]
  blockers: StudioCheck[]
  warnings: StudioCheck[]
  /** 第一条 blocker / warning 的说明，列表里只显示这一句 */
  note: string
  model: 'axes' | 'personality' | 'score' | 'legacy'
  /** axes 卷附带的完整枚举结果（命中占比 / 平局率），旧卷为 null */
  axes: AxeAudit | null
}

const isPlainObject = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const asArray = (value: unknown): any[] => (Array.isArray(value) ? value : [])

const rawOf = (row: QuizRow | null | undefined): Record<string, any> =>
  isPlainObject(row?.raw_data) ? row.raw_data : {}

/**
 * categories 的归一：数组 / CSV 字符串 / 单值都认，大小写去重。
 *
 * 与 ComeBrief 的 `quizCategories()` 同口径。后台历史上确实写过
 * `"Persona,Social"` 这种字符串，直接当数组用会得到 0 个分类。
 */
export function quizCategories(
  source: { categories?: unknown } | null | undefined
): string[] {
  const raw = source?.categories
  const list: string[] = []

  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i += 1) list.push(String(raw[i] ?? '').trim())
  } else if (typeof raw === 'string') {
    const parts = raw.split(',')
    for (let i = 0; i < parts.length; i += 1) list.push(parts[i].trim())
  } else if (raw !== null && raw !== undefined) {
    list.push(String(raw).trim())
  }

  const seen = new Set<string>()
  const out: string[] = []
  for (let i = 0; i < list.length; i += 1) {
    const label = list[i]
    if (!label) continue
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(label)
  }
  return out
}

/** 与 ComeBrief/lib/slug.ts 的 slugify 逐条对齐（引号先删，其余折成 -）。 */
export function slugify(input: unknown): string {
  return String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/['\u2018\u2019"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function quizTopicSlug(label: unknown): string {
  return slugify(label)
}

/** 详情页 URL 用 slug，缺 slug 时退回 id（与 ComeBrief 的 slugOrId 一致）。 */
export function slugOrId(row: { slug?: string | null; id?: string | null } | null | undefined): string {
  if (!row) return ''
  const slug = String(row.slug ?? '').trim()
  if (slug) return slug
  return String(row.id ?? '').trim()
}

export type QuizTopic = {
  slug: string
  label: string
  count: number
}

/** 全量话题（按数量降序、同数量按名字升序），与前台主题页 / sitemap 同源规则。 */
export function quizTopicList(rows: readonly QuizRow[]): QuizTopic[] {
  const bySlug = new Map<string, QuizTopic>()

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    const labels = quizCategories({ categories: row.categories ?? rawOf(row).categories })
    for (let j = 0; j < labels.length; j += 1) {
      const label = labels[j]
      const slug = quizTopicSlug(label)
      if (!slug) continue

      const existing = bySlug.get(slug)
      if (existing) {
        existing.count += 1
        continue
      }
      bySlug.set(slug, { slug, label, count: 1 })
    }
  }

  return Array.from(bySlug.values()).sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label)
  )
}

export function quizModel(row: QuizRow | null | undefined): QuizHealth['model'] {
  const raw = rawOf(row)
  if (row?.scoring_mode === 'axes' || raw.model === 'axes' || isAxeQuiz(row?.raw_data)) {
    return 'axes'
  }
  if (raw.model === 'personality') return 'personality'
  if (raw.model === 'score') return 'score'
  return 'legacy'
}

export function quizModelLabel(row: QuizRow | null | undefined): string {
  const model = quizModel(row)
  if (model === 'axes') return 'Archetype'
  if (model === 'personality') return 'Personality'
  if (model === 'score') return 'Score'
  return 'Legacy'
}

export function quizQuestionCount(row: QuizRow | null | undefined): number {
  const raw = rawOf(row)
  const questions = asArray(raw.questions)
  if (questions.length) return questions.length
  const stored = Number(row?.questions_count)
  return Number.isFinite(stored) && stored > 0 ? stored : 0
}

export function quizResultCount(row: QuizRow | null | undefined): number {
  if (quizModel(row) === 'axes') {
    const normalized = normalizeAxeQuiz(row?.raw_data)
    if (normalized) return normalized.quiz.archetypes.length
  }
  return asArray(rawOf(row).results).length
}

/** axes 检查 → 后台统一的检查形状（只改字段名，不改判据）。 */
function fromAxeChecks(checks: AxeCheck[]): StudioCheck[] {
  return checks.map((check) => ({
    id: check.id,
    level: check.level,
    label: check.label,
    detail: check.detail,
    penalty: check.penalty,
  }))
}

/**
 * 旧卷（score / personality）的结构检查。
 *
 * 没有权重矩阵就不该假装能算「命中占比」；这里只检查「发布出去会不会立刻坏」：
 * 标题、题目、选项、结果、分类、封面，以及结果名是否为空。每条都写清为什么。
 */
function legacyChecks(row: QuizRow, raw: Record<string, any>): StudioCheck[] {
  const checks: StudioCheck[] = []
  const push = (
    id: string,
    ok: boolean,
    label: string,
    detail: string,
    penalty: number,
    blocker = false
  ) => {
    checks.push({
      id,
      level: ok ? 'ok' : blocker ? 'blocker' : 'warning',
      label,
      detail: ok ? undefined : detail,
      penalty,
    })
  }

  const title = asText(row.title) || asText(raw.title)
  const questions = asArray(raw.questions)
  const results = asArray(raw.results)
  const categories = quizCategories({ categories: row.categories ?? raw.categories })
  const cover = asText(row.cover_url) || asText(raw.cover_url)

  push('title', Boolean(title), '标题', '没有标题：列表和分享卡片只能显示 Untitled', 30, true)
  push('questions', questions.length > 0, '题目', '没有任何题目，用户点进去会看到空白', 30, true)
  push('results', results.length > 0, '结果', '没有任何结果，答完题无法给出答案', 30, true)

  const emptyOptions = questions.filter((q) => asArray(q?.options).length === 0).length
  push(
    'options',
    emptyOptions === 0,
    '选项',
    `${emptyOptions} 道题没有选项，这些题无法作答`,
    30,
    true
  )

  const emptyQuestionTitles = questions.filter((q) => !asText(q?.title)).length
  push(
    'question-titles',
    emptyQuestionTitles === 0,
    '题干',
    `${emptyQuestionTitles} 道题没有题干，前台会显示空行`,
    8
  )

  const emptyResultTitles = results.filter((r) => !asText(r?.title)).length
  push(
    'result-titles',
    emptyResultTitles === 0,
    '结果名',
    `${emptyResultTitles} 个结果没有名字，抽中后卡片没有标题`,
    8
  )

  push('categories', categories.length > 0, '分类', '没有分类：不会出现在任何主题页', 8)
  push('cover', Boolean(cover), '封面', '没有封面：列表卡片会是空图', 8)
  push(
    'question-count',
    questions.length >= 3,
    '题目数量',
    `只有 ${questions.length} 道题，建议至少 3 道，否则结果区分度很低`,
    8
  )

  return checks
}

/**
 * 一条测验的发布前健康度。
 *
 * axes 卷：`auditAxeQuiz()` 的 12 项检查 + 全枚举（与 CI 同一个函数）。
 * 旧卷：结构检查，分数 = 100 − Σ 未通过项 penalty，夹到 0–100。
 *
 * 返回对象永远非 null，调用方不需要在每个列表单元里判空。
 */
export function quizHealth(row: QuizRow | null | undefined): QuizHealth {
  const model = quizModel(row)
  if (!row) {
    return {
      score: 0,
      checks: [],
      blockers: [],
      warnings: [],
      note: '没有测验数据',
      model,
      axes: null,
    }
  }

  if (model === 'axes') {
    const audit = auditAxeQuiz(row.raw_data)
    if (audit) {
      const checks = fromAxeChecks(audit.checks)
      const blockers = checks.filter((c) => c.level === 'blocker')
      const warnings = checks.filter((c) => c.level === 'warning')
      return {
        score: audit.health,
        checks,
        blockers,
        warnings,
        note: blockers[0]?.detail || blockers[0]?.label || warnings[0]?.detail || '',
        model,
        axes: audit,
      }
    }
  }

  const raw = rawOf(row)
  const checks = legacyChecks(row, raw)
  const blockers = checks.filter((c) => c.level === 'blocker')
  const warnings = checks.filter((c) => c.level === 'warning')
  const score = Math.max(
    0,
    Math.min(100, checks.reduce((sum, c) => (c.level === 'ok' ? sum : sum - c.penalty), 100))
  )

  return {
    score,
    checks,
    blockers,
    warnings,
    note: blockers[0]?.detail || blockers[0]?.label || warnings[0]?.detail || '',
    model,
    axes: null,
  }
}

/** 矩阵保存时拼 raw_data：外层字段留在顶层，axes 正文只写 archetypes + questions。 */
export function buildAxesRawData(row: QuizRow, quiz: AxeQuiz): Record<string, any> {
  const base = rawOf(row)
  const title = asText(row.title) || asText(base.title) || asText(quiz.title) || 'Untitled quiz'
  const categories = row.categories ?? base.categories
  const tags = row.tags ?? base.tags
  const cover = row.cover_url ?? base.cover_url

  return {
    ...base,
    title,
    model: 'axes',
    categories,
    tags,
    cover_url: cover,
    is_limited: Boolean(row.is_limited ?? base.is_limited),
    archetypes: quiz.archetypes,
    questions: quiz.questions,
    // `...base` 已经把库里的 axes 带过来了，但编辑器里的那份才是**这次**编辑的结果
    // （作者可能刚改完轴名）。显式覆盖：少这一行，保存一次就会把新写的轴名回滚成
    // 库里那份旧值 —— 而且因为 `...base` 在前后顺序上「看起来是对的」，这种回滚
    // 只在「改了轴名又保存」时出现，很难复现。
    axes: quiz.axes ?? base.axes,
  }
}

/**
 * 「复制一份」的插入载荷。
 *
 * id / created_at / updated_at / published_at 必须剥掉，否则 PostgREST 会尝试
 * 用原主键插入；slug 加时间后缀，避免撞唯一索引。状态一律回到草稿，防止复制
 * 动作直接把一份未检查的内容上线。
 */
export function duplicateQuizRow(source: QuizRow): Record<string, any> {
  const copy: Record<string, any> = JSON.parse(JSON.stringify(source))
  const drop = [
    'id',
    'created_at',
    'updated_at',
    'published_at',
    'publish_error',
    'scheduled_at',
  ]
  for (let i = 0; i < drop.length; i += 1) delete copy[drop[i]]

  const baseTitle = asText(source.title) || 'Untitled'
  copy.title = `${baseTitle} (copy)`
  if (source.slug) {
    copy.slug = `${slugify(source.slug) || 'quiz'}-copy-${Date.now().toString(36)}`
  } else if ('slug' in copy) {
    copy.slug = null
  }

  copy.status = 'draft'
  copy.active = false
  copy.is_featured = false
  copy.featured_order = 0
  if (isPlainObject(copy.raw_data)) copy.raw_data.title = copy.title

  return copy
}

/** Supabase 缺列时的错误文案解析（与现有保存流程同一套兜底策略）。 */
export function missingColumnFrom(message: unknown): string {
  const msg = String(message || '')
  const m1 = msg.match(/Could not find the '([^']+)' column/i)
  const m2 = msg.match(/column\s+[a-zA-Z0-9_]+\.([a-zA-Z0-9_]+)\s+does\s+not\s+exist/i)
  return (m1?.[1] || m2?.[1] || '').trim()
}

/** 前台地址：优先 NEXT_PUBLIC_SITE_URL；本地默认 3000，线上默认主站。 */
export function frontBaseUrl(): string {
  const configured = (process.env.NEXT_PUBLIC_SITE_URL || '').trim().replace(/\/+$/, '')
  if (configured) return configured

  if (process.env.NODE_ENV === 'production') return 'https://comebrief.com'

  if (typeof window !== 'undefined') {
    const { protocol, hostname } = window.location
    return `${protocol}//${hostname}:3000`
  }
  return 'http://localhost:3000'
}

export function publicQuizUrl(row: QuizRow): string {
  const key = slugOrId(row)
  return key ? `${frontBaseUrl()}/quizzes/${encodeURIComponent(key)}` : ''
}

export function publicTopicUrl(label: string): string {
  const slug = quizTopicSlug(label)
  return slug ? `${frontBaseUrl()}/quizzes/topic/${slug}` : ''
}

/** 列表/详情里的统一日期格式。 */
export function formatStudioDate(value: unknown): string {
  if (!value) return '—'
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
