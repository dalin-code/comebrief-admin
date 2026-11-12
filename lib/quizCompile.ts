/**
 * Kit → axes 卷的编译层（纯函数、零副作用）。
 *
 * 这一层回答的核心问题：**AI 只说「这个选项最像哪个原型」，怎么变成一张能过
 * 65,536 次枚举的权重表？**
 *
 * 规则只有两条，但都是算出来的、不是猜的：
 *   ① 每个选项的主原型 = 3 分；
 *   ② 次原型 = 声明顺序里的**下一个原型**（循环）= 1 分。
 *
 * 为什么是「循环下一个」而不是「随机配一个」：
 *   每题 4 个选项恰好覆盖 4 个原型（`quizKit.validateQuizKit` 的第 4 条规则），
 *   于是每题给每个原型的分是 3（自己）+ 1（上一个选项的次权重）= 4 分，
 *   8 题下来四列列合计**天然全部等于 32** —— `balance` 检查永远过，
 *   不需要 `autoBalance()` 去补，也不需要 AI 去理解什么叫「配平」。
 *
 * 平局率因此是**结构性的**：这一段结构恒定给出 9.2%（见
 * `scripts/check-quiz.mjs` 与 docs/quiz-axes.md），所以 `MAX_TIE_PCT = 12` 能过，
 * 而 6 题（38%）或完全不给次权重（25%）会被挡住 —— 阈值拦的正是真问题。
 *
 * 反过来，AI 一旦写出「4 个选项都指向同一个原型」，列合计立刻歪，
 * `validateQuizKit` 会先把它拦在 `mapping` 这条 blocker 上，这里不会悄悄编造权重。
 */

import {
  auditAxeQuiz,
  type AxeArchetype,
  type AxeAudit,
  type AxeOption,
  type AxeQuestion,
  type AxeQuiz,
} from './quizAxes'
import {
  KIT_OPTIONS,
  QUIZ_TOPICS,
  topicToCategories,
  validateQuizKit,
  type KitArchetype,
  type KitValidation,
  type QuizKit,
} from './quizKit'

/** 选项 id 固定成 a/b/c/d：前台与后台的深链（?a=…）靠它保持稳定。 */
export const OPTION_IDS = ['a', 'b', 'c', 'd'] as const

/** 主原型 3 分、次原型 1 分 —— 与 `MAX_WEIGHT = 3` 同源。 */
export const PRIMARY_WEIGHT = 3
export const SECONDARY_WEIGHT = 1

export type CompiledKit = {
  quiz: AxeQuiz
  title: string
  /** 写进 `quizzes.categories` 的旧词汇（前台配色依赖它） */
  categories: string[]
  tags: string[]
  validation: KitValidation
  /** 编译结果的全枚举 + 12 项检查；结构太差时为 null */
  audit: AxeAudit | null
  issues: string[]
}

/** 声明顺序里的下一个原型（循环）；只有一个原型时返回它自己。 */
export function secondaryArchetype(ids: string[], primary: string): string {
  if (!ids.length) return ''
  const index = ids.indexOf(primary)
  if (index === -1) return ids[0]
  return ids[(index + 1) % ids.length]
}

/** 一个选项的权重表：只写非 0 的两格（`normalizeAxeQuiz` 把没写的按 0 算）。 */
export function weightsFor(ids: string[], primary: string): Record<string, number> {
  if (!ids.includes(primary)) return {}
  const secondary = secondaryArchetype(ids, primary)
  const weights: Record<string, number> = { [primary]: PRIMARY_WEIGHT }
  if (secondary && secondary !== primary) weights[secondary] = SECONDARY_WEIGHT
  return weights
}

function toAxeArchetype(a: KitArchetype): AxeArchetype {
  return {
    id: a.id,
    name: a.name,
    short: a.short,
    headline: a.headline,
    quote: a.quote,
    summary: a.summary,
    stats: a.stats,
    pills: a.pills,
    // 结果页地图的三格：kit 里没有就留空，**不**在这里按顺序自动分配象限 ——
    // 「第几个原型落哪个角」是内容决定的事（谁偏独处、谁偏外放），按顺序猜出来的
    // 地图会把四个人摆错位置，而且错得很像真的。
    quadrant: a.quadrant,
    color: a.color,
    pose: a.pose,
  }
}

/**
 * 把 kit 编译成 `model: 'axes'` 的 raw_data 正文。
 *
 * 容忍地编：指向不存在的原型、缺选项的题目都不会抛异常（权重就是空表，
 * 枚举时会被 `deadopt` / `reachable` 检查点出来）。这样「AI 交了一份半成品」
 * 也能进矩阵编辑器被人手工救回来，而不是让整个向导报错。
 */
export function compileQuizKit(kit: QuizKit): CompiledKit {
  const issues: string[] = []
  const validation = validateQuizKit(kit)
  const ids = kit.archetypes.map((a) => a.id)

  if (kit.archetypes.length !== 4) {
    issues.push(`原型数量是 ${kit.archetypes.length}，标准卷是 4 个`)
  }

  const questions: AxeQuestion[] = kit.questions.map((q, qi) => ({
    id: `q${qi + 1}`,
    scene: q.scene,
    title: q.title,
    options: (() => {
      if (q.options.length > KIT_OPTIONS) {
        issues.push(`Q${qi + 1} 有 ${q.options.length} 个选项，只编译前 ${KIT_OPTIONS} 个`)
      }
      return q.options.slice(0, KIT_OPTIONS).map((o, oi) => {
        const weights = weightsFor(ids, o.primary)
        if (!Object.keys(weights).length) {
          issues.push(
            `Q${qi + 1} 选项 ${String.fromCharCode(65 + oi)} 的原型 ${o.primary || '(空)'} 不存在`
          )
        }
        const option: AxeOption = { id: OPTION_IDS[oi] ?? `o${oi + 1}`, text: o.text, weights }
        // 只在 kit 写了的时候带上（`AxeOption` 里两格都是可选的：缺了前台不画那块仪表）。
        if (o.intensity !== undefined) option.intensity = o.intensity
        if (o.bold !== undefined) option.bold = o.bold
        return option
      })
    })(),
  }))

  const quiz: AxeQuiz = {
    title: kit.title,
    model: 'axes',
    archetypes: kit.archetypes.map(toAxeArchetype),
    questions,
  }
  if (kit.axes) quiz.axes = kit.axes

  return {
    quiz,
    title: kit.title,
    categories: topicToCategories(
      kit.topic ? QUIZ_TOPICS.find((t) => t.key === kit.topic) ?? null : null
    ),
    tags: kit.tags,
    validation,
    audit: auditAxeQuiz(quiz),
    issues,
  }
}

export type CompiledSummary = {
  /** 12 项检查的健康分；结构缺失时为 0 */
  health: number
  /** 每个原型的命中占比（百分点，0–100） */
  hitPct: Record<string, number>
  tiePct: number
  blockers: string[]
  warnings: string[]
  /** 答案组合总数（抽样时为抽样次数） */
  total: number
}

/** 给 UI 用的一行摘要：健康分 / 命中分布 / 平局率 / 拦路的项。 */
export function summarizeCompiled(compiled: CompiledKit): CompiledSummary {
  const audit = compiled.audit
  if (!audit) {
    return { health: 0, hitPct: {}, tiePct: 0, blockers: [], warnings: [], total: 0 }
  }
  return {
    health: audit.health,
    hitPct: audit.enumeration.hitPct,
    tiePct: audit.enumeration.tiePct,
    blockers: audit.blockers.map((c) => c.label),
    warnings: audit.warnings.map((c) => c.label),
    total: audit.enumeration.total,
  }
}
