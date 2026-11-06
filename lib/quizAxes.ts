/**
 * 原型轴打分（`model: 'axes'`）：0–3 权重矩阵 + 全枚举自检。
 *
 * 为什么要有这一层（2026-11-06）：
 *   现在两套打分并存 —— `score`（选项 1–4 分，结果按分数区间落点）和
 *   `personality`（选项打 tag，按命中次数落点）。两者的共同毛病是：
 *   **改一个选项的分，没有任何人知道某个结果会不会从此再也抽不到**。
 *   线上 22 篇里 3 篇题数是脏的、personality 的区间盖不到上限，
 *   都是「写的时候没人算过」的结果。
 *
 * axes 模型把这件事变成一张表：
 *   每道题 4 个选项 × 每个原型 0–3 分 → 8 题 = 65,536 种答案组合。
 *   `enumerateAxe()` 把这 65,536 种全跑一遍，于是
 *   「每个原型占多少比例 / 平局多少 / 有没有原型一种组合都抽不到」
 *   全部是**算出来的**。后台的发布前检查、CI 的
 *   `scripts/check-quiz.mjs`、前台的 `scoreByArchetype()` 共用这一份。
 *
 * 仲裁规则（三条，改动要同步 docs/quiz-axes.md）：
 *   ① 总分最高的原型胜；
 *   ② 平局按 `archetypes` 的声明顺序取靠前的那个（确定性：同一份答案永远同一结果）；
 *   ③ 平局仍记一次 tie —— 平局率高说明题目区分度不够，是真问题，不是噪声。
 *
 * 纯函数、零依赖、不读环境变量、不 import 任何东西 —— 所以既能被 Next
 * 打包进后台，也能被 `node scripts/check-quiz.mjs` 直接跑（Node 24 原生剥类型）。
 * 旧的 `score` / `personality` 路径**一行都不动**：本模块只认 `model === 'axes'`。
 */

/** 模型名。写进 `raw_data.model`，也写进 `quizzes.scoring_mode`。 */
export const AXE_MODEL = 'axes'

/** 单格权重上限（0 = 不为该原型加分；超过 3 会让一题就决定胜负）。 */
export const MAX_WEIGHT = 3

/** 题量建议区间：低于 6 题 4 个原型互相抢票，高于 10 题完成率掉到 40% 以下。 */
export const MIN_QUESTIONS = 6
export const MAX_QUESTIONS = 10

/** 每个原型至少要被抽到 12%（再低用户会觉得「答案总是那几个」）。 */
export const MIN_HIT_PCT = 12

/** 平局率上限 8%。 */
export const MAX_TIE_PCT = 8

/** 结果名上限：海报 / 票根在 360px 下 3 行以内（上一版丢过半个括号）。 */
export const MAX_NAME_CHARS = 40

/** matchPct 封顶 97 —— 100% 显得机械化、伪造感重（决策 2026-11-06）。 */
export const MATCH_PCT_CAP = 97

/** 精确枚举上限。8 题 × 4 = 65,536；10 题 × 4 = 1,048,576 仍走精确。 */
export const MAX_EXACT_COMBOS = 2_000_000

/** 超过上限时退化成确定性抽样：固定种子，所以同一份卷每次跑结果一致。 */
export const SAMPLE_DRAWS = 60_000
export const SAMPLE_SEED = 20260101

export type AxeWeights = Record<string, number>

export type AxeArchetype = {
  /** 稳定 id，写进选项权重表的键；改了等于换结果 */
  id: string
  /** 结果名（印在海报上，长度受 MAX_NAME_CHARS 约束） */
  name: string
  /** 矩阵表头用的短名，没有就取 name */
  short?: string
  /** 结果页的长句 / 引语 / 三条 stats（可缺，缺了只扣分不拦发布） */
  headline?: string
  quote?: string
  stats?: string[]
  /** 卡片上的小标签（≤ 4 个、每个 ≤ 18 字） */
  pills?: string[]
}

export type AxeOption = {
  id?: string
  text: string
  /** 只写非 0 的格子；没写的格子按 0 算 */
  weights: AxeWeights
}

export type AxeQuestion = {
  id?: string
  /** 场景标签，矩阵里每题的分组标题；没有就显示 Q{n} */
  scene?: string
  title: string
  options: AxeOption[]
}

export type AxeQuiz = {
  title?: string
  model: typeof AXE_MODEL
  archetypes: AxeArchetype[]
  questions: AxeQuestion[]
}


/* ------------------------------------------------------------------ *
 * 1. 适配层：库里的 raw_data 长什么样都可能，先洗成上面的形状
 * ------------------------------------------------------------------ */

const isPlainObject = (v: unknown): v is Record<string, any> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

const toWeight = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.-]/g, ''))
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(MAX_WEIGHT, Math.round(n)))
}

/** 只认 `model === 'axes'`；旧的两套模型一律返回 false，保证零回归。 */
export function isAxeQuiz(raw: unknown): boolean {
  return isPlainObject(raw) && raw.model === AXE_MODEL && Array.isArray(raw.questions)
}

export type AxeNormalizeResult = {
  quiz: AxeQuiz
  /** 结构上被纠正的地方（未知原型 id、权重越界、缺名字…），给编辑器显示 */
  issues: string[]
}

/**
 * 容忍地读一份 axes 卷。
 *
 * 认不出的东西**不抛异常**（和 lib/quizPack 的 normalizePack 一致）：
 *   · 缺 `archetypes` → 从所有选项权重的键名里推（老草稿可能只写了权重表）；
 *   · 选项权重可以写在 `weights` 或 `w` 上；
 *   · 越界权重夹到 0–3 并记一条 issue，而不是整卷报废。
 *
 * 返回 null 表示「这不是 axes 卷」，调用方应当继续走旧路径。
 */
export function normalizeAxeQuiz(raw: unknown): AxeNormalizeResult | null {
  if (!isAxeQuiz(raw)) return null
  const src = raw as Record<string, any>
  const issues: string[] = []

  const questions: AxeQuestion[] = (src.questions as any[])
    .filter(isPlainObject)
    .map((q, qi) => {
      const options: AxeOption[] = (Array.isArray(q.options) ? q.options : [])
        .filter(isPlainObject)
        .map((o: Record<string, any>, oi: number) => {
          const bag = isPlainObject(o.weights) ? o.weights : isPlainObject(o.w) ? o.w : {}
          const weights: AxeWeights = {}
          for (const [key, value] of Object.entries(bag)) {
            const id = asText(key)
            if (!id) continue
            const n = typeof value === 'number' ? value : Number(value)
            if (!Number.isFinite(n)) {
              issues.push(`Q${qi + 1} 选项 ${oi + 1} 的 ${id} 不是数字，按 0 算`)
              continue
            }
            if (n < 0 || n > MAX_WEIGHT) {
              issues.push(`Q${qi + 1} 选项 ${oi + 1} 的 ${id} = ${n} 越界（0–${MAX_WEIGHT}），已夹住`)
            }
            const clamped = toWeight(n)
            if (clamped > 0) weights[id] = clamped
          }
          return { id: asText(o.id) || `o${oi + 1}`, text: asText(o.text), weights }
        })
      return {
        id: asText(q.id) || `q${qi + 1}`,
        scene: asText(q.scene) || undefined,
        title: asText(q.title),
        options,
      }
    })

  const declared: AxeArchetype[] = (Array.isArray(src.archetypes) ? src.archetypes : [])
    .filter(isPlainObject)
    .map((a: Record<string, any>, ai: number) => ({
      id: asText(a.id) || `a${ai + 1}`,
      name: asText(a.name) || asText(a.id) || `Archetype ${ai + 1}`,
      short: asText(a.short) || undefined,
      headline: asText(a.headline) || undefined,
      quote: asText(a.quote) || undefined,
      stats: Array.isArray(a.stats) ? a.stats.map(asText).filter(Boolean) : undefined,
      pills: Array.isArray(a.pills) ? a.pills.map(asText).filter(Boolean) : undefined,
    }))

  // 没声明 archetypes：从权重表的键里推，顺序取第一次出现的顺序（稳定、可 diff）。
  let archetypes: AxeArchetype[] = declared
  if (!archetypes.length) {
    const seen: string[] = []
    questions.forEach((q) =>
      q.options.forEach((o) =>
        Object.keys(o.weights).forEach((id) => {
          if (!seen.includes(id)) seen.push(id)
        })
      )
    )
    if (seen.length) issues.push('没有 archetypes 声明，按选项权重里出现的原型名字补齐')
    archetypes = seen.map((id) => ({ id, name: id }))
  }

  const known = new Set(archetypes.map((a) => a.id))
  questions.forEach((q) =>
    q.options.forEach((o) => {
      for (const id of Object.keys(o.weights)) {
        if (!known.has(id)) {
          issues.push(`选项权重里出现了未声明的原型 ${id}，已忽略`)
          delete o.weights[id]
        }
      }
    })
  )

  const ids = archetypes.map((a) => a.id)
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
  if (dupes.length) issues.push(`原型 id 重复：${dupes.join('、')}（只留第一个）`)
  if (!archetypes.length) issues.push('一个原型都没有：没有结果可落点')

  return {
    quiz: {
      title: asText(src.title) || undefined,
      model: AXE_MODEL,
      archetypes: archetypes.filter((a, i) => ids.indexOf(a.id) === i),
      questions,
    },
    issues,
  }
}

/* ------------------------------------------------------------------ *
 * 2. 全枚举：65,536 种答案组合，一次算完
 * ------------------------------------------------------------------ */

export type AxeDeadOption = { questionId: string; optionId: string; label: string }
export type AxeThinQuestion = { questionId: string; label: string; fed: number }

export type AxeEnumeration = {
  /** 实际跑过的答案组合数（抽样时 = SAMPLE_DRAWS） */
  total: number
  /** true = 组合数超过 MAX_EXACT_COMBOS，退化成固定种子抽样 */
  sampled: boolean
  /** 理论组合数（几何级增长，抽样时远大于 total） */
  combos: number
  hits: Record<string, number>
  hitPct: Record<string, number>
  ties: number
  tiePct: number
  /** 每列权重之和（矩阵底部的「列合计」） */
  columnTotals: Record<string, number>
  /** 每个原型的满分：每题取该列最大权重再求和 */
  columnMax: Record<string, number>
  /** 命中占比的极差（百分点） */
  spread: number
  deadOptions: AxeDeadOption[]
  thinQuestions: AxeThinQuestion[]
}

const zeroRecord = (ids: string[]): Record<string, number> => {
  const out: Record<string, number> = {}
  ids.forEach((id) => {
    out[id] = 0
  })
  return out
}

/** 每题 → 每选项 → 每原型 的权重立方体。算一次，枚举时直接下标取数。 */
function weightCube(quiz: AxeQuiz): number[][][] {
  const cols = quiz.archetypes.map((a) => a.id)
  return quiz.questions.map((q) =>
    q.options.map((o) => cols.map((id) => toWeight(o.weights[id])))
  )
}

/** 每个原型在「全部答对最重的那一项」时的满分；作答不全时按已答题折算。 */
export function axeMaxScores(quiz: AxeQuiz): Record<string, number> {
  const out = zeroRecord(quiz.archetypes.map((a) => a.id))
  const cube = weightCube(quiz)
  cube.forEach((perQuestion) => {
    quiz.archetypes.forEach((a, ci) => {
      const best = perQuestion.reduce((m, perOption) => Math.max(m, perOption[ci]), 0)
      out[a.id] += best
    })
  })
  return out
}

/**
 * 把 65,536 种组合全跑一遍。
 *
 * 为什么不用「随机抽 1 万次」代替：抽样的百分比每次都不一样，评审时改一格
 * 数字会跳 0.3%，看起来像 bug；而且「某个原型完全抽不到」这种稀有事件
 * 恰恰最容易被抽样漏掉（漏掉的那次就是线上事故）。所以默认精确，
 * 只有组合数超过 200 万时才抽样，并且用固定种子（可复现、可 diff）。
 */
export function enumerateAxe(quiz: AxeQuiz): AxeEnumeration {
  const cols = quiz.archetypes.map((a) => a.id)
  const hits = zeroRecord(cols)
  const columnTotals = zeroRecord(cols)
  const deadOptions: AxeDeadOption[] = []
  const thinQuestions: AxeThinQuestion[] = []

  quiz.questions.forEach((q, qi) => {
    const fed = new Set<number>()
    q.options.forEach((o, oi) => {
      let any = false
      cols.forEach((id, ci) => {
        const w = toWeight(o.weights[id])
        columnTotals[id] += w
        if (w > 0) {
          any = true
          fed.add(ci)
        }
      })
      if (!any) {
        deadOptions.push({
          questionId: q.id || `q${qi + 1}`,
          optionId: o.id || `o${oi + 1}`,
          label: `Q${qi + 1} 选项 ${String.fromCharCode(65 + (oi % 26))}`,
        })
      }
    })
    if (fed.size < 2) {
      thinQuestions.push({
        questionId: q.id || `q${qi + 1}`,
        label: q.scene || q.title.slice(0, 18) || `Q${qi + 1}`,
        fed: fed.size,
      })
    }
  })

  const combos = quiz.questions.reduce(
    (acc, q) => acc * Math.max(1, q.options.length),
    quiz.questions.length ? 1 : 0
  )
  const cube = weightCube(quiz)
  const scores = cols.map(() => 0)
  let total = 0
  let ties = 0

  const tally = () => {
    total += 1
    let best = -Infinity
    let winner = 0
    let winnerCount = 0
    for (let ci = 0; ci < scores.length; ci++) {
      const s = scores[ci]
      if (s > best) {
        best = s
        winner = ci
        winnerCount = 1
      } else if (s === best) {
        winnerCount += 1
      }
    }
    if (winnerCount > 1) ties += 1
    if (cols.length) hits[cols[winner]] += 1
  }

  const walk = (qi: number) => {
    if (qi === quiz.questions.length) {
      tally()
      return
    }
    const perQuestion = cube[qi]
    for (let oi = 0; oi < perQuestion.length; oi++) {
      const perOption = perQuestion[oi]
      for (let ci = 0; ci < scores.length; ci++) scores[ci] += perOption[ci]
      walk(qi + 1)
      for (let ci = 0; ci < scores.length; ci++) scores[ci] -= perOption[ci]
    }
  }

  const sampled = combos > MAX_EXACT_COMBOS
  if (quiz.questions.length && cols.length) {
    if (!sampled) {
      walk(0)
    } else {
      // 线性同余，固定种子：肉眼看不出来，但机器每次跑结果完全一致。
      let seed = SAMPLE_SEED
      const next = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648
        return seed / 2147483648
      }
      for (let i = 0; i < SAMPLE_DRAWS; i++) {
        for (let ci = 0; ci < scores.length; ci++) scores[ci] = 0
        for (let qi = 0; qi < cube.length; qi++) {
          const perQuestion = cube[qi]
          const oi = Math.min(perQuestion.length - 1, Math.floor(next() * perQuestion.length))
          const perOption = perQuestion[oi]
          for (let ci = 0; ci < scores.length; ci++) scores[ci] += perOption[ci]
        }
        tally()
      }
    }
  }

  const hitPct = zeroRecord(cols)
  cols.forEach((id) => {
    hitPct[id] = total ? (hits[id] / total) * 100 : 0
  })
  const values = cols.map((id) => hitPct[id])

  return {
    total,
    sampled,
    combos,
    hits,
    hitPct,
    ties,
    tiePct: total ? (ties / total) * 100 : 0,
    columnTotals,
    columnMax: axeMaxScores(quiz),
    spread: values.length ? Math.max(...values) - Math.min(...values) : 0,
    deadOptions,
    thinQuestions,
  }
}


/* ------------------------------------------------------------------ *
 * 3. 运行时打分：前台提交答案时只调这一个函数
 * ------------------------------------------------------------------ */

/** 答案可以是选项下标（0..3），也可以是选项 id；null / undefined = 这题没答。 */
export type AxeAnswers = Array<number | string | null | undefined>

export type AxeScore = {
  archetypeId: string
  archetype: AxeArchetype | null
  /** 原始总分 */
  score: number
  /** 同样这些题、全部选最重的那一项时的分数 */
  maxScore: number
  /** 1–97，封顶 MATCH_PCT_CAP（不给 100%） */
  matchPct: number
  /** 平局时并列的全部原型 id（含自己），按声明顺序 */
  tied: string[]
  tally: Record<string, number>
  answered: number
  missing: number
}

/** 百分比换算的唯一实现：四舍五入后夹到 1–97。 */
export function axeMatchPct(score: number, maxScore: number): number {
  if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) return 1
  const raw = Math.round((score / maxScore) * 100)
  return Math.max(1, Math.min(MATCH_PCT_CAP, raw))
}

/**
 * 按原型轴打分。
 *
 * 和 `enumerateAxe()` 用同一套仲裁规则（最高分胜、平局取声明顺序靠前者），
 * 所以「用户实际抽到的结果」和「枚举出来的分布」永远对得上 —— 这也是
 * 发布前检查有意义的前提：枚举说 20%，线上就应该是 20%。
 *
 * 没答的题不计入分母（作答中途退出也能出结果，matchPct 不会因此掉到 0）。
 */
export function scoreByArchetype(quiz: AxeQuiz, answers: AxeAnswers): AxeScore | null {
  const cols = quiz.archetypes.map((a) => a.id)
  if (!cols.length) return null

  const tally = zeroRecord(cols)
  let maxScore = 0
  let answered = 0
  let missing = 0

  quiz.questions.forEach((q, qi) => {
    const answer = answers[qi]
    let hit: AxeOption | null = null
    if (typeof answer === 'number') hit = q.options[answer] || null
    else if (typeof answer === 'string') hit = q.options.find((o) => o.id === answer) || null
    if (!hit) {
      missing += 1
      return
    }
    answered += 1
    cols.forEach((id) => {
      tally[id] += toWeight(hit!.weights[id])
    })
    maxScore += q.options.reduce(
      (best, o) => Math.max(best, cols.reduce((m, id) => Math.max(m, toWeight(o.weights[id])), 0)),
      0
    )
  })

  let best = -Infinity
  let winners: string[] = []
  cols.forEach((id) => {
    if (tally[id] > best) {
      best = tally[id]
      winners = [id]
    } else if (tally[id] === best) {
      winners.push(id)
    }
  })

  const winner = winners[0]
  return {
    archetypeId: winner,
    archetype: quiz.archetypes.find((a) => a.id === winner) || null,
    score: tally[winner] ?? 0,
    maxScore,
    matchPct: axeMatchPct(tally[winner] ?? 0, maxScore),
    tied: winners,
    tally,
    answered,
    missing,
  }
}

/* ------------------------------------------------------------------ *
 * 4. 发布前检查：12 项，全部由数据推出（不联网、不看数据库）
 * ------------------------------------------------------------------ */

export type AxeCheckLevel = 'blocker' | 'warning' | 'ok'

export type AxeCheck = {
  /** 稳定 id，UI 上用来记「哪一项已经看过了」 */
  id: string
  level: AxeCheckLevel
  label: string
  /** 触发时的补充说明（谁、哪一题、差多少） */
  detail?: string
  /** 触发时扣的分（ok 时也保留，方便 UI 显示「修好这项 +8」） */
  penalty: number
}

const pushCheck = (
  checks: AxeCheck[],
  input: { id: string; ok: boolean; label: string; detail?: string; penalty: number; blocker?: boolean }
) => {
  checks.push({
    id: input.id,
    level: input.ok ? 'ok' : input.blocker ? 'blocker' : 'warning',
    label: input.label,
    detail: input.ok ? undefined : input.detail,
    penalty: input.penalty,
  })
}

/**
 * 健康分 = 100 − Σ(未通过项的 penalty)，夹到 0–100。
 *
 * 扣分表与静态稿（/mockup/quiz-studio 屏 3）逐项一致（40 / 8 / 10 / 6 / 4n / 4 / 6 / 5 / 5 / 4 / 3），
 * 但把静态稿里恒过的 poster / jsonld 两项换成了能算的 nameunique / scale ——
 * 所以两者项数都是 12、分数可比。改动要同步 docs/quiz-axes.md 的表格：
 * 前台展示的分数与 CI 的退出码必须同源。
 */
export function axeHealthScore(checks: AxeCheck[]): number {
  const score = checks.reduce(
    (acc, c) => (c.level === 'ok' ? acc : acc - Math.max(0, c.penalty)),
    100
  )
  return Math.max(0, Math.min(100, score))
}

export function axeChecks(quiz: AxeQuiz, enumeration: AxeEnumeration): AxeCheck[] {
  const checks: AxeCheck[] = []
  const ids = quiz.archetypes.map((a) => a.id)
  const minHit = ids.length ? Math.min(...ids.map((id) => enumeration.hitPct[id])) : 0
  const unreachable = ids.filter((id) => (enumeration.hits[id] || 0) === 0)

  pushCheck(checks, {
    id: 'reachable',
    ok: ids.length > 0 && unreachable.length === 0,
    label:
      ids.length && !unreachable.length
        ? `${enumeration.total.toLocaleString('en-US')} 种答案组合，${ids.length} 个原型全部可达`
        : '有原型一种组合都抽不到（死区）',
    detail: ids.length
      ? unreachable.map((id) => quiz.archetypes.find((a) => a.id === id)?.name || id).join('、')
      : '一个原型都没有',
    penalty: 40,
    blocker: true,
  })

  pushCheck(checks, {
    id: 'minhit',
    ok: minHit >= MIN_HIT_PCT,
    label: `最低命中率 ${minHit.toFixed(1)}%（下限 ${MIN_HIT_PCT}%）`,
    detail: '某个原型过于难抽，用户会觉得答案总是那几个',
    penalty: 8,
  })

  pushCheck(checks, {
    id: 'tie',
    ok: enumeration.tiePct <= MAX_TIE_PCT,
    label: `平局率 ${enumeration.tiePct.toFixed(1)}%（上限 ${MAX_TIE_PCT}%）`,
    detail: '题目区分度不够，相邻两档会互相稀释（平局按声明顺序取靠前者）',
    penalty: 10,
  })

  const colValues = ids.map((id) => enumeration.columnTotals[id])
  const totalWeight = colValues.reduce((a, b) => a + b, 0)
  const colSpread = colValues.length ? Math.max(...colValues) - Math.min(...colValues) : 0
  pushCheck(checks, {
    id: 'balance',
    ok: colSpread <= Math.max(4, totalWeight * 0.15),
    label: `权重均衡度：列合计极差 ${colSpread}（总和 ${totalWeight}）`,
    detail: '某列明显偏轻，实际作答时会整片落进另一档',
    penalty: 6,
  })

  pushCheck(checks, {
    id: 'deadopt',
    ok: enumeration.deadOptions.length === 0,
    label: enumeration.deadOptions.length
      ? `${enumeration.deadOptions.length} 个选项不给任何原型加分`
      : '无废选项：每个选项至少喂养 1 个原型',
    detail: enumeration.deadOptions.map((d) => d.label).join('、'),
    penalty: Math.min(12, 4 * enumeration.deadOptions.length),
  })

  pushCheck(checks, {
    id: 'thin',
    ok: enumeration.thinQuestions.length === 0,
    label: enumeration.thinQuestions.length
      ? `${enumeration.thinQuestions.length} 道题只喂养 1 个原型`
      : '每题至少喂养 2 个原型（区分度够）',
    detail: enumeration.thinQuestions.map((t) => `${t.label}（${t.fed} 个）`).join('、'),
    penalty: 6,
  })

  const longest = quiz.archetypes.reduce((max, a) => (a.name.length > max.length ? a.name : max), '')
  pushCheck(checks, {
    id: 'name',
    ok: longest.length <= MAX_NAME_CHARS,
    label:
      longest.length <= MAX_NAME_CHARS
        ? `最长结果名 ${longest.length} 字，360px 下 3 行内`
        : `「${longest.slice(0, 26)}…」${longest.length} 字，360px 下要 4 行`,
    detail: '海报 / 票根会截断名字（上一版丢过半个括号），建议压到 40 字内',
    penalty: 5,
  })

  const fourOptions = quiz.questions.every((q) => q.options.length === 4)
  pushCheck(checks, {
    id: 'shape',
    ok:
      quiz.questions.length >= MIN_QUESTIONS &&
      quiz.questions.length <= MAX_QUESTIONS &&
      fourOptions,
    label: `${quiz.questions.length} 题 × ${fourOptions ? '4' : '≠4'} 选项（建议 ${MIN_QUESTIONS}–${MAX_QUESTIONS} 题）`,
    detail: '题量过少会让 4 个原型互相抢票，过多则完成率掉到 40% 以下；前端版式按 4 个选项设计',
    penalty: 5,
  })

  const thinResults = quiz.archetypes.filter(
    (a) => !a.headline || !a.quote || !a.stats || a.stats.length < 3
  )
  pushCheck(checks, {
    id: 'stats',
    ok: thinResults.length === 0,
    label:
      thinResults.length === 0
        ? `${quiz.archetypes.length} 个原型都有 headline / quote / 3 条 stats`
        : `${thinResults.length} 个原型缺少 headline / quote / stats`,
    detail: thinResults.map((a) => a.name).join('、'),
    penalty: 4,
  })

  const badPills = quiz.archetypes.filter(
    (a) => a.pills && (a.pills.length > 4 || a.pills.some((p) => p.length > 18))
  )
  pushCheck(checks, {
    id: 'pills',
    ok: badPills.length === 0,
    label: badPills.length
      ? `${badPills.length} 个原型的 pill tags 超限`
      : 'pill tags ≤ 4 个、每个 ≤ 18 字',
    detail: badPills.map((a) => a.name).join('、'),
    penalty: 3,
  })

  const names = quiz.archetypes.map((a) => a.name.trim().toLowerCase())
  const dupNames = [...new Set(names.filter((n, i) => n && names.indexOf(n) !== i))]
  pushCheck(checks, {
    id: 'nameunique',
    ok: dupNames.length === 0,
    label: dupNames.length ? `结果名重复：${dupNames.length} 组` : '结果名互不重复',
    detail: dupNames.join('、'),
    penalty: 10,
    blocker: true,
  })

  const maxUsed = Math.max(
    0,
    ...quiz.questions.flatMap((q) => q.options.flatMap((o) => Object.values(o.weights).map(toWeight)))
  )
  pushCheck(checks, {
    id: 'scale',
    ok: maxUsed >= MAX_WEIGHT,
    label: `最高权重用到 ${maxUsed} / ${MAX_WEIGHT}`,
    detail: '整卷没用满 0–3 档，区分度会被压缩；至少每题要有一个 3 分格',
    penalty: 4,
  })

  return checks
}

export type AxeAudit = {
  quiz: AxeQuiz
  enumeration: AxeEnumeration
  checks: AxeCheck[]
  health: number
  blockers: AxeCheck[]
  warnings: AxeCheck[]
  /** 适配层纠正过的结构问题（越界权重、未声明原型…），不算健康分 */
  issues: string[]
  ok: boolean
}

/** 一步到位：raw_data → 归一化 → 全枚举 → 12 项检查 → 健康分。 */
export function auditAxeQuiz(raw: unknown): AxeAudit | null {
  const normalized = normalizeAxeQuiz(raw)
  if (!normalized) return null
  const enumeration = enumerateAxe(normalized.quiz)
  const checks = axeChecks(normalized.quiz, enumeration)
  const blockers = checks.filter((c) => c.level === 'blocker')
  const warnings = checks.filter((c) => c.level === 'warning')
  return {
    quiz: normalized.quiz,
    enumeration,
    checks,
    health: axeHealthScore(checks),
    blockers,
    warnings,
    issues: normalized.issues,
    ok: blockers.length === 0,
  }
}


