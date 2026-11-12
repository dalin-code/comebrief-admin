#!/usr/bin/env node
/**
 * 文本粘贴路径自检（离线）：模板 → 解析 → 四层闸 → 落库行 → 往返。
 *
 * 这一层钉的是「人写稿子」这条路上最容易静默坏掉的六个地方：
 *   1. 模板自己过不了闸（那框里的「模板」按钮就是在教人写错的东西）；
 *   2. 选项按位置映射错了（A→结果 1 这条一错，整卷权重就歪了）；
 *   3. v3 四项（象限 / pose / intensity / bold）少一项却没报错
 *      —— 前台会**静默**退回旧版式，用户只会觉得「结果页不对」；
 *   4. 中文漏过去（前台是英文站）；
 *   5. 6–10 题的放宽把「5 题」也放进来了；
 *   6. `kitToText()` 打不回原文（AI 整理的回写会丢字段）。
 *
 * 用法：node --import ./scripts/_ts-resolve.mts scripts/check-quiz-text.mts
 */

import {
  QUIZ_TEXT_TEMPLATE,
  QUIZ_TEXT_MIN_QUESTIONS,
  QUIZ_TEXT_MAX_QUESTIONS,
  buildDraftRow,
  inspectQuizText,
  kitToText,
  splitQuizText,
  summarizeQuizText,
  validateTextKit,
} from '../lib/quizText.ts'
import { compileQuizKit, summarizeCompiled } from '../lib/quizCompile.ts'
import { AXE_POSES, MAX_TIE_PCT, MIN_HIT_PCT } from '../lib/quizAxes.ts'
import { KIT_ARCHETYPES, KIT_OPTIONS, KIT_QUESTIONS } from '../lib/quizKit.ts'
import { QUIZ_TEXT_SYSTEM, buildQuizTextTidyPrompt } from '../lib/quizTextPrompt.ts'

let failed = 0
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` —— ${extra}` : ''}`)
  if (!cond) failed += 1
}

const first = (text: string) => inspectQuizText(text).entries[0]
const codes = (text: string) => first(text).issues.map((entry) => `${entry.level}:${entry.code}`)

/* ------------------------------------------------------------------ *
 * 1. 模板：必须是一份「能直接存」的卷
 * ------------------------------------------------------------------ */

const template = inspectQuizText(QUIZ_TEXT_TEMPLATE)
const entry = template.entries[0]

check('模板：拆成 1 篇', template.entries.length === 1, `实际 ${template.entries.length}`)
check('模板：零 blocker', template.entries.every((e) => !e.issues.some((i) => i.level === 'blocker')),
  template.entries.flatMap((e) => e.issues.filter((i) => i.level === 'blocker')).map((i) => i.label).join('；'))
check('模板：零 warning', template.entries.every((e) => !e.issues.some((i) => i.level === 'warning')),
  template.entries.flatMap((e) => e.issues.filter((i) => i.level === 'warning')).map((i) => i.label).join('；'))
check('模板：ok = true', template.ok && entry.ok)

const kit = entry.kit
check('模板：4 个结果', kit?.archetypes.length === KIT_ARCHETYPES, `实际 ${kit?.archetypes.length}`)
check('模板：8 道题', kit?.questions.length === KIT_QUESTIONS, `实际 ${kit?.questions.length}`)
check('模板：每题 4 个选项', kit?.questions.every((q) => q.options.length === KIT_OPTIONS))
check('模板：两条轴都有两端', Boolean(kit?.axes?.x.neg && kit?.axes?.x.pos && kit?.axes?.y.neg && kit?.axes?.y.pos))

const quadrants = kit?.archetypes.map((a) => a.quadrant) ?? []
check('模板：四个象限各一个', new Set(quadrants).size === 4, quadrants.join(','))
const poses = kit?.archetypes.map((a) => a.pose) ?? []
check('模板：四个 pose 各一个', new Set(poses).size === 4 && poses.every((p) => (AXE_POSES as readonly string[]).includes(p)), poses.join(','))

const options = kit?.questions.flatMap((q) => q.options) ?? []
check(
  '模板：32 个选项都有 1–3 的能量档',
  options.length === KIT_QUESTIONS * KIT_OPTIONS && options.every((o) => o.intensity !== undefined && o.intensity >= 1 && o.intensity <= 3),
  `缺 ${options.filter((o) => o.intensity === undefined).length} 个`
)
check(
  '模板：每题恰好 1 个 (b)',
  (kit?.questions ?? []).every((q) => q.options.filter((o) => o.bold).length === 1)
)

/* ------------------------------------------------------------------ *
 * 2. 编译 + 全枚举：健康分与平局率
 * ------------------------------------------------------------------ */

const compiled = kit ? compileQuizKit(kit) : null
const summary = compiled ? summarizeCompiled(compiled) : null

check('编译：健康分 100', summary?.health === 100, `实际 ${summary?.health}`)
check(
  '编译：平局率 ≤ 上限',
  (summary?.tiePct ?? 99) <= MAX_TIE_PCT,
  `${summary?.tiePct}% / 上限 ${MAX_TIE_PCT}%`
)
const hitPcts = Object.values(summary?.hitPct ?? {})
check(
  `编译：每个原型命中 ≥ ${MIN_HIT_PCT}%`,
  hitPcts.length === 4 && hitPcts.every((pct) => pct >= MIN_HIT_PCT),
  hitPcts.map((pct) => `${pct.toFixed(1)}%`).join(' / ')
)
check('编译：分类落到旧词汇 Sports', JSON.stringify(compiled?.categories) === '["Sports"]', JSON.stringify(compiled?.categories))
check('编译：标签认得出 Internet Lore', JSON.stringify(compiled?.tags) === '["Internet Lore"]', JSON.stringify(compiled?.tags))
check('编译：model 是 axes', compiled?.quiz.model === 'axes')
check('契约：5 条规则里没有 warning', kit ? validateTextKit(kit).warnings.length === 0 : false)

/* ------------------------------------------------------------------ *
 * 3. 落库行：只造 draft，字段与 JSON 路径一致
 * ------------------------------------------------------------------ */

const row = buildDraftRow(entry)
const raw = row?.raw_data as any

check(
  '落库：status=draft / active=false / scoring_mode=axes',
  row?.status === 'draft' && row?.active === false && row?.scoring_mode === 'axes'
)
check('落库：raw_data 带 model=axes 与 cover_url', raw?.model === 'axes' && raw?.cover_url === '')
check(
  '落库：raw_data 有 archetypes / questions / axes',
  Array.isArray(raw?.archetypes) && Array.isArray(raw?.questions) && Boolean(raw?.axes)
)
check(
  '落库：不写 results / questions_count / published_at',
  !('results' in (raw ?? {})) && !('questions_count' in (row ?? {})) && !('published_at' in (row ?? {}))
)
check('落库：坏卷返回 null', buildDraftRow({ ...entry, ok: false }) === null)

/* ------------------------------------------------------------------ *
 * 4. 往返：kitToText → parse 必须是同一份 kit（AI 整理靠它回写）
 * ------------------------------------------------------------------ */

const again = kit ? inspectQuizText(kitToText(kit)).entries[0] : null
check('往返：再解析仍然 ok', Boolean(again?.ok))
check('往返：kit 逐字段相等', Boolean(kit) && JSON.stringify(again?.kit) === JSON.stringify(kit))

/* ------------------------------------------------------------------ *
 * 5. 拆分：`---` 与重复 TITLE 都要能拆成两篇
 * ------------------------------------------------------------------ */

check('拆分：--- 分成 2 篇', splitQuizText(`${QUIZ_TEXT_TEMPLATE}\n---\n${QUIZ_TEXT_TEMPLATE}`).length === 2)
check('拆分：重复 TITLE 分成 2 篇', splitQuizText(`${QUIZ_TEXT_TEMPLATE}\n${QUIZ_TEXT_TEMPLATE}`).length === 2)
check('拆分：空文本 0 篇', splitQuizText('   \n\n').length === 0)
check('解析：空文本不算错', inspectQuizText('  ').ok && inspectQuizText('  ').entries.length === 0)

/* ------------------------------------------------------------------ *
 * 6. 四层闸的负样本：每一层都要真的拦得住
 * ------------------------------------------------------------------ */

const noQuadrant = QUIZ_TEXT_TEMPLATE.replace('== RESULT 1 | TL | pose=wave ==', '== RESULT 1 | pose=wave ==')
const quadrantIssue = first(noQuadrant).issues.find((item) => item.code === 'quadrant')
check('缺象限：blocker', quadrantIssue?.level === 'blocker' && !first(noQuadrant).ok, codes(noQuadrant).join(','))
const quadrantLine = QUIZ_TEXT_TEMPLATE.split('\n').findIndex((line) => line.includes('== RESULT 1')) + 1
check('缺象限：行号指向那条 RESULT', quadrantIssue?.line === quadrantLine, `${quadrantIssue?.line} vs ${quadrantLine}`)

const dupQuadrant = QUIZ_TEXT_TEMPLATE.replace('== RESULT 2 | TR | pose=love ==', '== RESULT 2 | TL | pose=love ==')
check('象限撞车：blocker', codes(dupQuadrant).includes('blocker:quadrant'), codes(dupQuadrant).join(','))

/**
 * pose 撞车从 blocker 降为 warning（v2 的 IP 里角色由**象限**决定，pose 只决定表情）。
 * 这一条改动会在 diff 里看着像「放宽了校验」，所以钉两件事：**不再挡导入**、
 * **但仍然要说一声**（前台还没升级到 v2 时，两个同 pose 的结果确实长得一样）。
 */
const dupPose = QUIZ_TEXT_TEMPLATE.replace('pose=love', 'pose=wave')
check('pose 撞车：不再 blocker', !codes(dupPose).includes('blocker:pose'), codes(dupPose).join(','))
check('pose 撞车：warning 仍然在', codes(dupPose).includes('warning:pose'), codes(dupPose).join(','))
check('pose 撞车：能存', first(dupPose).ok, codes(dupPose).join(','))

/** 但**不认识**的 pose 必须拦住：以前它一路带到前台，四只角色全静默退回 host。 */
const badPose = first(QUIZ_TEXT_TEMPLATE.replace('pose=wave', 'pose=cool'))
check(
  'pose=cool：blocker 且点名这个值',
  badPose.issues.some((item) => item.level === 'blocker' && item.code === 'pose' && item.label.includes('"cool"')),
  badPose.issues.map((item) => item.label).join(' | ')
)
check('pose=cool：ok = false', !badPose.ok)

const noBold = QUIZ_TEXT_TEMPLATE.replace('(i3) (b)', '(i3)')
check('缺 (b)：blocker', codes(noBold).includes('blocker:bold'), codes(noBold).join(','))

const noIntensity = QUIZ_TEXT_TEMPLATE.replace('(i2)', '')
check('缺能量档：blocker', codes(noIntensity).includes('blocker:intensity'), codes(noIntensity).join(','))

const chinese = QUIZ_TEXT_TEMPLATE.replace('The Quiet Watcher', '安静的观察者')
const chineseIssue = first(chinese).issues.find((item) => item.code === 'language')
check(
  '中文：blocker 且指出字段',
  chineseIssue?.level === 'blocker' && (chineseIssue.label ?? '').includes('NAME'),
  codes(chinese).join(',')
)

const noAxis = QUIZ_TEXT_TEMPLATE.replace(/AXIS X: .*\n/, '')
check('缺轴名：blocker', codes(noAxis).includes('blocker:axis'), codes(noAxis).join(','))

/* ------------------------------------------------------------------ *
 * 7. 题量：区间内放宽（6–10），区间外仍然拦
 * ------------------------------------------------------------------ */

const sixText = QUIZ_TEXT_TEMPLATE.replace(/== Q7 \|[\s\S]*$/, '')
const six = first(sixText)
const sixRule = six.validation?.rules.find((rule) => rule.id === 'questions')
check('6 题：能存', six.ok, codes(sixText).join(','))
check('6 题：题数规则降成 warning', sixRule?.level === 'warning' && sixRule?.ok === false)

const extraQuestions = `
== Q9 | Extra scene ==
You find a voice memo you recorded at 3AM. You…
A. Play it once, then delete it.          (i1)
B. Send it to the group chat.             (i3)
C. Transcribe it into notes.              (i1) (b)
D. Record a reply right now.              (i2)

== Q10 | Extra scene, again ==
Last one: how do you close the night?
A. Phone face down.                       (i1)
B. One more scroll.                       (i2)
C. A screenshot of something.             (i2) (b)
D. A message you will regret tomorrow.    (i3)
`
const tenText = QUIZ_TEXT_TEMPLATE + extraQuestions
const ten = first(tenText)
check('10 题：仍然是 10 道题', ten.kit?.questions.length === 10, `实际 ${ten.kit?.questions.length}`)
check(`10 题：区间内（${QUIZ_TEXT_MIN_QUESTIONS}–${QUIZ_TEXT_MAX_QUESTIONS}）能存`, ten.ok, codes(tenText).join(','))

const fiveText = QUIZ_TEXT_TEMPLATE.replace(/== Q6 \|[\s\S]*$/, '')
const five = first(fiveText)
check(
  '5 题：blocker',
  !five.ok && five.issues.some((item) => item.level === 'blocker' && item.code === 'questions'),
  codes(fiveText).join(',')
)

/* ------------------------------------------------------------------ *
 * 8. 容错：位置映射之外的两处「人一定会写」的写法
 * ------------------------------------------------------------------ */

const reordered = QUIZ_TEXT_TEMPLATE.replace(
  'A. Read all of it, type nothing.          (i1)',
  'A. Read all of it, type nothing. (i1) → Menace'
).replace(
  'D. Reply to all four people at once.      (i3) (b)',
  'D. Reply to all four people at once. → Watcher (i3) (b)'
)
const reorderedEntry = first(reordered)
check(
  '→ Short：覆盖顺序映射',
  reorderedEntry.kit?.questions[0].options[0].primary === 'menace' &&
    reorderedEntry.kit?.questions[0].options[3].primary === 'watcher',
  `${reorderedEntry.kit?.questions[0].options[0].primary} / ${reorderedEntry.kit?.questions[0].options[3].primary}`
)
check('→ Short：仍然能存', reorderedEntry.ok, codes(reordered).join(','))

const swapped = first(
  QUIZ_TEXT_TEMPLATE.replace(
    'D. Reply to all four people at once.      (i3) (b)',
    'D. Reply to all four people at once. (b) (i3)'
  )
)
check(
  '(b) 写在 (i3) 前面也能读',
  swapped.kit?.questions[0].options[3].bold === true && swapped.kit?.questions[0].options[3].intensity === 3,
  `${swapped.kit?.questions[0].options[3].bold} / ${swapped.kit?.questions[0].options[3].intensity}`
)

const fencedText = '```\n' + QUIZ_TEXT_TEMPLATE.replace(/\n/g, '\r\n') + '\n```'
check('代码围栏 + CRLF 不影响解析', first(fencedText).ok, codes(fencedText).join(','))

/* ------------------------------------------------------------------ *
 * 9. AI 整理的提示词：它说的格式必须是解析器认的格式
 * ------------------------------------------------------------------ */

const tidyIssues = inspectQuizText(QUIZ_TEXT_TEMPLATE.replace('AXIS X: Solo ←→ Crowd', '')).entries.flatMap(
  (entry) => entry.issues
)
const tidyPrompt = buildQuizTextTidyPrompt({ text: QUIZ_TEXT_TEMPLATE, issues: tidyIssues })

check('整理提示词：system 不再要求 JSON（出口是纯文本）', !/single JSON object/i.test(QUIZ_TEXT_SYSTEM))
check('整理提示词：带了段头样例', tidyPrompt.includes('== RESULT 1 | TL | pose=wave ==') && tidyPrompt.includes('== Q1 |'))
check('整理提示词：带了三个标记的写法', ['(i1)', '(i3) (b)', '(b)'].every((token) => tidyPrompt.includes(token)))
check('整理提示词：把解析器的抱怨转给了模型', tidyPrompt.includes('## What the parser complained about'), tidyIssues.length ? `${tidyIssues.length} 条` : '0 条')
check('整理提示词：带上了原文', tidyPrompt.includes('TITLE: What Kind of 2AM Person Are You?'))

const longPrompt = buildQuizTextTidyPrompt({ text: 'x'.repeat(40000), issues: [] })
check(
  '整理提示词：长输入截到 16000 字（别把一整个粘贴板灌进去）',
  longPrompt.includes('x'.repeat(16000)) && !longPrompt.includes('x'.repeat(16001)),
  `${longPrompt.length} 字`
)
check('整理提示词：没有问题时不出现空小节', !longPrompt.includes('## What the parser complained about'))

/* ------------------------------------------------------------------ *
 * 10. 「AI 整理」失败之后：报错必须指向真问题，而不是一句「解析不出来」
 * ------------------------------------------------------------------ */

// ① 模型没写完（截断）：以前接口 200 照样回写，前端只弹一句「可能缺尾巴」。
//    现在接口一律 502 + code=TRUNCATED 且不带 text；这一层能钉住的是
//    「半截稿本身仍然是个合法的、可诊断的输入」—— 它必须报「读到几道题」而不是崩。
const halfTemplate = QUIZ_TEXT_TEMPLATE.replace(/== Q6 \|[\s\S]*$/, '')
const half = first(halfTemplate)
check(
  '半截稿：能算出「读到 5 道题」，不是一句「解析不出来」',
  half.kit?.questions.length === 5,
  `${half.kit?.questions.length ?? 0} 题`
)
check('半截稿：题量不足是 blocker（questions）', codes(halfTemplate).includes('blocker:questions'), codes(halfTemplate).join(','))

// ② 一段结果都没读到：段头被写坏（`## RESULT` 这种 markdown 标题，正则不认）
const noResults = first(QUIZ_TEXT_TEMPLATE.replace(/== RESULT/g, '## RESULT'))
check(
  '零结果：报的是「RESULT 段头没被认出来」',
  noResults.issues.some((item) => item.level === 'blocker' && item.code === 'archetypes' && item.label.includes('RESULT 段头')),
  noResults.issues.map((item) => `${item.level}:${item.code}:${item.label}`).join(' | ')
)

// ③ 一道题都没读到
const noQuestions = first(QUIZ_TEXT_TEMPLATE.replace(/== Q\d+ \|[\s\S]*$/, ''))
check(
  '零题目：报的是「Q 段头没被认出来」',
  noQuestions.issues.some((item) => item.level === 'blocker' && item.code === 'questions' && item.label.includes('Q 段头')),
  noQuestions.issues.map((item) => `${item.level}:${item.code}:${item.label}`).join(' | ')
)

// ④ pose 白名单 / 撞车已在第 6 节钉过（badPose / dupPose）—— 那里离其它负样本更近。

// ⑤ 采用前对比用的数字：必须和模板对得上（前端拿它说「题 0 → 8」）
const stats = summarizeQuizText(template)
check(
  '摘要数字：1 篇 / 4 结果 / 8 题 / 0 红',
  stats.entries === 1 && stats.results === 4 && stats.questions === 8 && stats.blockers === 0,
  JSON.stringify(stats)
)
check(
  '半截稿的数字：题数掉到 5（这就是「整理完题变少了」的可视化）',
  summarizeQuizText(inspectQuizText(halfTemplate)).questions === 5,
  JSON.stringify(summarizeQuizText(inspectQuizText(halfTemplate)))
)

/* ------------------------------------------------------------------ */

console.log('')
if (failed) {
  console.log(`FAILED ${failed} 项`)
  process.exit(1)
}
console.log('全部通过：四层闸、落库行、往返、拆分、题量区间、整理提示词都符合预期')

