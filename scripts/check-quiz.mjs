#!/usr/bin/env node
/**
 * 测验自检（P0）：把「发布前检查」搬进 CI —— 全枚举 + 仲裁 + 健康分。
 *
 * 背景
 *   线上 22 篇测验，题数 / 分数区间 / 结果可达性全靠人眼看。真实事故：
 *   · 3 篇的 questions_count 是 0（实际 8/8/10）；
 *   · personality 模型的区间 `15-20` 永远抽不到（8 题最多命中 8 次）；
 *   · 改一个字之后某个原型再也抽不到，没有任何人发现。
 *   静态稿（/mockup/quiz-studio 屏 3）证明这些都能算出来。这个脚本就是把
 *   那套计算钉进 CI：**改卷不跑它，就会在评审时才发现有人抽不到结果**。
 *
 * 用法
 *   node scripts/check-quiz.mjs                  # 跑内置的 30 组断言（CI 用，默认）
 *   node scripts/check-quiz.mjs --file quiz.json # 体检一份真卷（对象或数组都行）
 *
 *   不需要 `--import ./scripts/_ts-resolve.mts`：Node 24 原生支持剥离 TS 类型，
 *   而 lib/quizAxes.ts 又刻意零依赖（不 import 任何东西），所以能直接跑。
 *
 * 退出码
 *   0 = 全部通过（真卷模式下 = 没有 blocker）；1 = 有失败。
 */
import { readFileSync } from 'node:fs'
import {
  AXE_MODEL,
  MATCH_PCT_CAP,
  MAX_EXACT_COMBOS,
  MAX_TIE_PCT,
  auditAxeQuiz,
  axeMatchPct,
  enumerateAxe,
  normalizeAxeQuiz,
  scoreByArchetype,
} from '../lib/quizAxes.ts'

let failed = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` —— ${extra}` : ''}`)
  if (!cond) failed += 1
}

const ARCHS = [
  { id: 'sarcastic', name: 'The Sarcastic Meme Curator' },
  { id: 'observer', name: 'The Calm Observer' },
  { id: 'mainchar', name: 'The Main Character' },
  { id: 'overload', name: 'The Midnight Overload Machine' },
]

/** 造一份「结构干净」的卷：每题 4 个选项，主原型 3 分、相邻原型 1 分。 */
function buildQuiz({ questions = 8, archetypes = ARCHS, weights } = {}) {
  const ids = archetypes.map((a) => a.id)
  const qs = []
  for (let qi = 0; qi < questions; qi++) {
    const options = []
    for (let oi = 0; oi < 4; oi++) {
      const primary = (qi + oi) % ids.length
      const secondary = (qi + oi + 1) % ids.length
      const w = weights ? weights(qi, oi, ids) : { [ids[primary]]: 3, [ids[secondary]]: 1 }
      options.push({ id: `o${oi + 1}`, text: `Q${qi + 1} option ${oi + 1}`, weights: w })
    }
    qs.push({ id: `q${qi + 1}`, scene: `Scene ${qi + 1}`, title: `Question ${qi + 1}`, options })
  }
  return {
    title: 'Fixture',
    model: AXE_MODEL,
    archetypes: archetypes.map((a) => ({
      ...a,
      headline: `${a.name} headline`,
      quote: `${a.name} quote`,
      stats: ['70%', '3am', '1 tab'],
      pills: ['pill'],
    })),
    questions: qs,
  }
}

/* 1. 全枚举：8 题 × 4 选项 = 65,536，且四个原型都抽得到 */
const clean = buildQuiz()
const cleanEnum = enumerateAxe(clean)
check('1a 8 题 × 4 选项 = 65,536 种组合', cleanEnum.total === 65536 && cleanEnum.combos === 65536, String(cleanEnum.total))
check('1b 不是抽样', cleanEnum.sampled === false)
const pctSum = Object.values(cleanEnum.hitPct).reduce((a, b) => a + b, 0)
check('1c 命中占比加总 = 100%', Math.abs(pctSum - 100) < 1e-6, pctSum.toFixed(6))
check('1d 四个原型都抽得到', ARCHS.every((a) => cleanEnum.hits[a.id] > 0), JSON.stringify(cleanEnum.hits))
check('1e 列合计均衡（每题 4 分 × 8 题 ÷ 4 列 = 32）', ARCHS.every((a) => cleanEnum.columnTotals[a.id] === 32), JSON.stringify(cleanEnum.columnTotals))
check('1f 列满分 = 24（每题最高 3 分 × 8）', ARCHS.every((a) => cleanEnum.columnMax[a.id] === 24), JSON.stringify(cleanEnum.columnMax))
check('1g 重复跑结果完全一致（确定性）', JSON.stringify(enumerateAxe(clean)) === JSON.stringify(cleanEnum))

/* 2. 健康分：干净的卷零 blocker / 12 项检查都在 / 12 项全绿（tie 9.2% ≤ 上限 12%） */
const cleanAudit = auditAxeQuiz(clean)
check('2a 干净卷零 blocker', cleanAudit.blockers.length === 0, JSON.stringify(cleanAudit.blockers.map((c) => c.id)))
check('2b 干净卷 12 项检查都在', cleanAudit.checks.length === 12, String(cleanAudit.checks.length))
const notOk = cleanAudit.checks.filter((c) => c.level !== 'ok')
check('2c 干净卷 12 项全绿（无 warning）', notOk.length === 0, notOk.map((c) => c.id).join(','))
check(
  '2d 8 题 × 4 原型的平局率 9.2%，落在 8%–12% 之间（旧上限 8% 判错的就是这一类）',
  cleanEnum.tiePct > 8 && cleanEnum.tiePct <= MAX_TIE_PCT,
  `${cleanEnum.tiePct.toFixed(1)}% / 上限 ${MAX_TIE_PCT}%`
)
check(
  '2e 健康分 = 100 − 未通过项扣分之和',
  cleanAudit.health === 100 - notOk.reduce((sum, c) => sum + c.penalty, 0),
  String(cleanAudit.health)
)


/* 3. 死区：声明了原型却一格权重都没有 → blocker，必须拦住发布 */
const ghost = buildQuiz()
ghost.archetypes = [...ghost.archetypes, { id: 'ghost', name: 'The Ghost' }]
const ghostAudit = auditAxeQuiz(ghost)
check('3a 无权重原型 = 死区 → blocker', ghostAudit.blockers.some((c) => c.id === 'reachable'))
check(
  '3b 死区项本身扣 40 分（其它项另算）',
  ghostAudit.blockers[0]?.penalty === 40 && ghostAudit.health <= 60,
  `health=${ghostAudit.health}`
)
check('3c 死区点名是哪个原型', (ghostAudit.blockers[0]?.detail || '').includes('The Ghost'), ghostAudit.blockers[0]?.detail)

/* 4. 废选项：一个选项不给任何原型加分 → warning，点名到题号与选项 */
const dead = buildQuiz()
dead.questions[5].options[1].weights = {}
const deadCheck = auditAxeQuiz(dead).checks.find((c) => c.id === 'deadopt')
check('4a 废选项 → warning', deadCheck.level === 'warning')
check('4b 点名「Q6 选项 B」', (deadCheck.detail || '').includes('Q6 选项 B'), deadCheck.detail)

/* 5. 平局：四个原型轮流出分，平局率必然爆表 */
const tieQuiz = buildQuiz({ questions: 6, weights: (qi, oi, ids) => ({ [ids[oi % ids.length]]: 3 }) })
const tieEnum = enumerateAxe(tieQuiz)
check('5a 平局率超过上限', tieEnum.tiePct > MAX_TIE_PCT, `${tieEnum.tiePct.toFixed(1)}% > ${MAX_TIE_PCT}%`)
check('5b 平局 → warning 且不拦发布', auditAxeQuiz(tieQuiz).checks.find((c) => c.id === 'tie').level === 'warning')

/* 6. 结果名过长 / 题量不足 → 各扣分，但都不拦发布 */
const longName = buildQuiz({ questions: 5 })
longName.archetypes[0].name = 'The Midnight Overload Machine (Final Boss Edition, Deluxe)'
const longAudit = auditAxeQuiz(longName)
check('6a 超长结果名 → warning', longAudit.checks.find((c) => c.id === 'name').level === 'warning')
check('6b 5 题 → shape warning', longAudit.checks.find((c) => c.id === 'shape').level === 'warning')
check('6c warning 不产生 blocker', longAudit.blockers.length === 0)

/* 7. 组合数爆炸：退化成固定种子抽样，但结果仍可复现 */
const huge = buildQuiz({ questions: 14 })
const hugeEnum = enumerateAxe(huge)
check('7a 超过精确上限 → 抽样', hugeEnum.sampled === true, `combos=${hugeEnum.combos}`)
check('7b 理论组合数仍是 4^14', hugeEnum.combos === 4 ** 14 && hugeEnum.combos > MAX_EXACT_COMBOS)
check('7c 抽样也是确定的', JSON.stringify(enumerateAxe(huge)) === JSON.stringify(hugeEnum))

/* 8. matchPct：封顶 97，不给 100（决策 2026-11-06） */
// 按「每个原型各选自己最重的那一项」造两份满分答案：只有本列满分才谈得上 100%。
const bestFor = (archetypeId) =>
  clean.questions.map((q) => {
    let bestIndex = 0
    let bestScore = -1
    q.options.forEach((o, oi) => {
      const s = o.weights[archetypeId] || 0
      if (s > bestScore) {
        bestScore = s
        bestIndex = oi
      }
    })
    return bestIndex
  })
const maxRun = scoreByArchetype(clean, bestFor('sarcastic'))
check('8a 全选最重项 → matchPct 封顶 97', maxRun.matchPct === MATCH_PCT_CAP, String(maxRun.matchPct))
check('8b score 与 maxScore 相等', maxRun.score === maxRun.maxScore, `${maxRun.score}/${maxRun.maxScore}`)
check('8c 百分比换算夹在 1–97', axeMatchPct(0, 0) === 1 && axeMatchPct(999, 10) === 97)
const partial = scoreByArchetype(clean, [0, 0, null, undefined])
check('8d 没答的题不计入分母', partial.answered === 2 && partial.missing === 6, `${partial.answered}/${partial.missing}`)
check('8e 中途退出也能出结果', typeof partial.archetypeId === 'string' && partial.archetypeId.length > 0)
const zeroRun = scoreByArchetype(clean, Array.from({ length: 8 }, () => null))
check('8f 一题没答也不崩（matchPct = 1）', zeroRun.matchPct === 1 && zeroRun.answered === 0)

/* 9. 旧模型零回归：score / personality 一律不被 axes 认领 */
check('9a score 模型不被 axes 认领', normalizeAxeQuiz({ model: 'score', questions: [] }) === null)
check('9b personality 模型不被 axes 认领', normalizeAxeQuiz({ model: 'personality', questions: [] }) === null)
check('9c 旧卷 audit 返回 null（调用方继续走旧路径）', auditAxeQuiz({ model: 'score', questions: [] }) === null)

/* 10. 适配层：容忍 `w` 别名 / 越界权重 / 未声明原型，且每处都留痕 */
const messy = {
  model: 'axes',
  archetypes: [{ id: 'a', name: 'A' }],
  questions: [
    {
      title: 'q',
      options: [
        { text: 'a', w: { a: 5, ghost: 2 } },
        { text: 'b', weights: { a: '2' } },
      ],
    },
  ],
}
const messyNorm = normalizeAxeQuiz(messy)
check('10a `w` 别名能读', messyNorm.quiz.questions[0].options[0].weights.a === 3)
check('10b 越界权重被夹住并留痕', messyNorm.issues.some((i) => i.includes('越界')))
check('10c 未声明原型被忽略并留痕', messyNorm.issues.some((i) => i.includes('未声明的原型')))
check('10d 同名字符串权重能读成数字', messyNorm.quiz.questions[0].options[1].weights.a === 2)

/* 11. summary（The Read）必须活着穿过适配层 —— 它曾因为「没在类型里声明」被静默丢掉 */
const withSummary = buildQuiz()
withSummary.archetypes[0].summary = 'You read the room before you read the message.'
const summaryNorm = normalizeAxeQuiz(withSummary)
check(
  '11a summary 能读回来',
  summaryNorm.quiz.archetypes[0].summary === 'You read the room before you read the message.'
)
check(
  '11b 没写 summary 的原型不会被补成空串',
  summaryNorm.quiz.archetypes[1].summary === undefined
)

/* 12. v3 的三格（象限 / 配色 / 姿态）+ 选项的两格（intensity / bold） */
const withV3 = buildQuiz()
withV3.axes = { x: { neg: 'Solo', pos: 'Social' }, y: { neg: 'Low-key', pos: 'Loud' } }
withV3.archetypes[0].quadrant = 'tr'
withV3.archetypes[0].color = '#ff8fa3'
withV3.archetypes[0].pose = 'Shades'
withV3.archetypes[1].quadrant = 'XX'
withV3.archetypes[1].color = '#fff'
withV3.archetypes[1].pose = 'none'
withV3.questions[0].options[0].intensity = 9
withV3.questions[0].options[1].intensity = 2
withV3.questions[0].options[1].bold = true
const v3Norm = normalizeAxeQuiz(withV3)
check('12a 小写象限 / 大写姿态被规范成白名单值', v3Norm.quiz.archetypes[0].quadrant === 'TR' && v3Norm.quiz.archetypes[0].pose === 'shades')
check('12b 十六进制颜色原样保留', v3Norm.quiz.archetypes[0].color === '#ff8fa3')
check(
  '12c 认不出的象限 / 短颜色 / 姿态被丢掉并留痕',
  v3Norm.quiz.archetypes[1].quadrant === undefined &&
    v3Norm.quiz.archetypes[1].color === undefined &&
    v3Norm.quiz.archetypes[1].pose === undefined &&
    v3Norm.issues.filter((i) => /quadrant|color|pose/.test(i)).length >= 3
)
check('12d intensity 越界被夹到 3、bold 能读', v3Norm.quiz.questions[0].options[0].intensity === 3 && v3Norm.quiz.questions[0].options[1].bold === true)
check('12e 两条轴都齐了才会落进 quiz', v3Norm.quiz.axes?.x.neg === 'Solo' && v3Norm.quiz.axes?.y.pos === 'Loud')
const halfAxes = buildQuiz()
halfAxes.axes = { x: { neg: 'Solo', pos: '' }, y: { neg: 'Low-key', pos: 'Loud' } }
const halfNorm = normalizeAxeQuiz(halfAxes)
check('12f 半条轴不落、并留一条 issue', halfNorm.quiz.axes === undefined && halfNorm.issues.some((i) => i.includes('axes')))


/* 真卷模式：给一份 raw_data，直接告诉你哪里会出事 */
const fileIndex = process.argv.indexOf('--file')
const target = fileIndex > -1 ? process.argv[fileIndex + 1] : process.argv[2]
if (target) {
  const raw = JSON.parse(readFileSync(target, 'utf8'))
  const packs = Array.isArray(raw) ? raw : [raw]
  packs.forEach((pack, index) => {
    const audit = auditAxeQuiz(pack)
    const label = pack?.title || `#${index + 1}`
    if (!audit) {
      console.log(`\nSKIP  ${label} —— 不是 axes 卷（model !== 'axes'），旧路径不动`)
      return
    }
    console.log(`\n===== ${label} · health ${audit.health}/100 =====`)
    audit.checks.forEach((c) => {
      const mark = c.level === 'ok' ? '✓' : c.level === 'blocker' ? '✗' : '!'
      console.log(`${mark} ${c.label}${c.detail ? ` —— ${c.detail}` : ''}`)
    })
    audit.issues.forEach((issue) => console.log(`· 适配层：${issue}`))
    if (!audit.ok) failed += 1
  })
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)

