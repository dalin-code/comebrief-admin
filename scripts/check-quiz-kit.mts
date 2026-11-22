#!/usr/bin/env node
/**
 * Quiz Kit 自检（离线）：契约 → 五条规则 → 编译 → 全枚举。
 *
 * 这一层钉的是「AI 起草」这条路最容易静默坏掉的四个地方：
 *   1. 适配层把 summary（The Read）/ 分类别名 / 字符串 tags 吃掉；
 *   2. 五条规则里有哪一条形同虚设（比如「每题 4 个选项指向 4 个不同原型」）；
 *   3. 编译出来的权重不是 3/1、列合计不相等 —— 那就不是「配平」，只是「看起来能跑」；
 *   4. 编译结果的平局率 / 命中率与 `check-quiz.mjs` 的干净卷不一致。
 *
 * 用法：node --import ./scripts/_ts-resolve.mts scripts/check-quiz-kit.mts
 */

import {
  KIT_QUESTIONS,
  QUIZ_CATEGORY_ORDER,
  QUIZ_TOPICS,
  normalizeQuizKit,
  readQuizKit,
  resolveQuizTag,
  resolveQuizTopic,
  topicToCategories,
  validateQuizKit,
  type QuizKit,
} from '../lib/quizKit.ts'
import {
  PRIMARY_WEIGHT,
  SECONDARY_WEIGHT,
  compileQuizKit,
  secondaryArchetype,
  summarizeCompiled,
  weightsFor,
} from '../lib/quizCompile.ts'
import {
  buildQuestionsUserPrompt,
  mergeQuizKit,
  normalizeIdeas,
  normalizeQuestions,
} from '../lib/quizAi.ts'
import { closeTruncatedJson } from '../lib/jsonSalvage.ts'

let failed = 0
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` —— ${extra}` : ''}`)
  if (!cond) failed += 1
}

const IDS = ['sarcastic', 'observer', 'mainchar', 'overload']

/* 造一份「AI 交付合格」的 kit：每题的 4 个选项覆盖 4 个原型。 */
function buildKit(overrides: Partial<QuizKit> = {}): QuizKit {
  const archetypes = IDS.map((id, index) => ({
    id,
    name: [
      'The Sarcastic Meme Curator',
      'The Calm Observer',
      'The Main Character',
      'The Midnight Overload Machine',
    ][index],
    short: `A${index + 1}`,
    headline: `Headline for ${id}`,
    quote: `Quote for ${id}`,
    summary: `The read for ${id}: two sentences explaining why the answers add up.`,
    stats: ['3 group chats on mute', '97% reply rate', '2am scroll sessions'],
    pills: ['Chronically online', 'Screenshot hoarder'],
  }))

  const questions = Array.from({ length: KIT_QUESTIONS }, (_, qi) => ({
    scene: qi < 4 ? `Scene ${qi + 1}` : undefined,
    title: `Question ${qi + 1}: the group chat is on fire, you…`,
    options: IDS.map((_, oi) => ({
      text: `Q${qi + 1} option ${String.fromCharCode(65 + oi)}`,
      primary: IDS[(qi + oi) % IDS.length],
    })),
  }))

  return {
    title: 'What Kind of Group Chat Are You?',
    hook: 'Eight taps and we will tell you who you are at 2am.',
    topic: 'pop-culture',
    topicLabel: 'Pop Culture & Entertainment',
    tags: ['Internet Lore'],
    locale: 'en',
    archetypes,
    questions,
    meta: { trendIds: ['reddit:brat-summer'], terms: ['brat summer'], geo: 'US' },
    ...overrides,
  }
}

/* 1. 分类词表：与 50_quiz_taxonomy.sql 同源 */
check('1a 6 个话题', QUIZ_TOPICS.length === 6, String(QUIZ_TOPICS.length))
check('1b 旧分类别名能认（Sports → pop-culture）', resolveQuizTopic('Sports')?.key === 'pop-culture')
check('1c 话题全名能认', resolveQuizTopic('Personality & Psychology')?.key === 'personality')
check('1d 认不出的分类返回 null', resolveQuizTopic('Underwater Basket Weaving') === null)
check(
  '1e 写库写统一词表里的展示名（Pop Culture）',
  JSON.stringify(topicToCategories(resolveQuizTopic('pop-culture'))) === '["Pop Culture"]'
)
check(
  '1f lifestyle 写的就是展示名',
  topicToCategories(resolveQuizTopic('lifestyle'))[0] === 'Lifestyle'
)
check('1g 标签别名能认（Kpop → K-Pop）', resolveQuizTag('Kpop')?.name === 'K-Pop')

/* 1h 旧词表全部有归属（2026-11-22 统一成 6 个分类，旧词只留在 aliases 里） */
const legacyMap: [string, string][] = [
  ['Persona', 'personality'],
  ['Subconscious', 'mindset'],
  ['Social', 'relationships'],
  ['Sports', 'pop-culture'],
  ['Future', 'career'],
  ['Trivia & Knowledge', 'pop-culture'],
  ['Lifestyle & Aesthetics', 'lifestyle'],
]
check(
  '1h 7 个旧分类词都能落到新词表',
  legacyMap.every(([legacy, key]) => resolveQuizTopic(legacy)?.key === key),
  legacyMap
    .map(([legacy]) => `${legacy} → ${resolveQuizTopic(legacy)?.key ?? 'null'}`)
    .join(' / ')
)
check(
  '1i 展示顺序就是 6 个分类（Career → Mindset）',
  QUIZ_CATEGORY_ORDER.join('|') ===
    'Career|Personality|Pop Culture|Relationships|Lifestyle|Mindset',
  QUIZ_CATEGORY_ORDER.join('|')
)

/* 2. 适配层：容忍地读 */
const messy = normalizeQuizKit({
  title: '  Messy <b>kit</b>  ',
  category: 'sports',
  tags: 'Kpop, memes, nope',
  archetypes: [{ name: 'No Id' }, { id: 'Dup' }, { id: 'dup' }, { id: 'fourth' }],
  questions: [
    { title: 'Only one question', options: [{ text: 'a', primary: 'dup' }, { text: 'b' }] },
  ],
})
check('2a 能读出不规整的 kit', messy !== null && messy.kit.archetypes.length === 4)
check(
  '2b 缺 id 的原型按名字补上并留痕',
  messy!.kit.archetypes[0].id === 'noid' && messy!.issues.some((i) => i.includes('没有 id'))
)
check(
  '2c 重复 id 被改名并留痕',
  messy!.kit.archetypes[2].id === 'dup3' && messy!.issues.some((i) => i.includes('重复'))
)
check('2d 标题去掉标签 / 压空白', messy!.kit.title === 'Messy kit')
check('2e 分类从 category 字段读出来', messy!.kit.topic === 'pop-culture')
check('2f 字符串 tags 也能解析，认不出的丢掉', messy!.kit.tags.join('|') === 'K-Pop|Internet Lore')
check(
  '2g 缺 primary 的选项留空并留痕',
  messy!.kit.questions[0].options[1].primary === '' && messy!.issues.some((i) => i.includes('primary'))
)

/* 3. 五条规则 */
const clean = buildKit()
const cleanValidation = validateQuizKit(clean)
check(
  '3a 合格 kit：5 条规则全绿',
  cleanValidation.rules.every((r) => r.ok),
  JSON.stringify(cleanValidation.rules.filter((r) => !r.ok))
)
check('3b 合格 kit 没有 blocker', cleanValidation.ok && cleanValidation.blockers.length === 0)

const threeArchetypes = buildKit({ archetypes: buildKit().archetypes.slice(0, 3) })
check(
  '3c 3 个原型 → archetypes blocker',
  validateQuizKit(threeArchetypes).blockers.some((r) => r.id === 'archetypes')
)

const sevenQuestions = buildKit({ questions: buildKit().questions.slice(0, 7) })
check(
  '3d 7 题 → questions blocker',
  validateQuizKit(sevenQuestions).blockers.some((r) => r.id === 'questions')
)

const dupOption = buildKit()
dupOption.questions[0].options[1].text = dupOption.questions[0].options[0].text
check(
  '3e 同题选项重复 → options blocker',
  validateQuizKit(dupOption).blockers.some((r) => r.id === 'options')
)

/* 3e1 / 3e2：占位符判定只认「光杆模板」，别把正常的英文句子误判成占位。
 * 线上真实事故：Q1 的 `Answer with high energy for four minutes.` 命中了
 * 旧版前缀正则 `^answer\b`，整份 8 题的好稿子被拦成「1 项要修」。 */
const optionsBlockedWith = (text: string) => {
  const kit = buildKit()
  kit.questions[0].options[3].text = text
  return validateQuizKit(kit).blockers.some((r) => r.id === 'options')
}

const realSentences = ['Answer with high energy for four minutes.', 'Answer the call, then go quiet.']
check(
  '3e1 以 Answer 开头的真实选项不算占位',
  realSentences.every((text) => !optionsBlockedWith(text)),
  realSentences.filter((text) => optionsBlockedWith(text)).join(' / ')
)

const shells = ['Option A', 'Choice 2', 'Answer', 'Answer B.', 'TBD', 'lorem ipsum dolor sit amet', 'n/a', 'A']
check(
  '3e2 光杆占位文案仍然被拦',
  shells.every((text) => optionsBlockedWith(text)),
  shells.filter((text) => !optionsBlockedWith(text)).join(' / ')
)

const badMapping = buildKit()
badMapping.questions[2].options[3].primary = badMapping.questions[2].options[0].primary
const badMappingValidation = validateQuizKit(badMapping)
check(
  '3f 两个选项指向同一原型 → mapping blocker（配平被破坏）',
  badMappingValidation.blockers.some((r) => r.id === 'mapping'),
  badMappingValidation.blockers.map((r) => r.detail).join('；')
)

const ghostId = buildKit()
ghostId.questions[0].options[0].primary = 'ghost'
check(
  '3g 指向不存在的原型 → mapping blocker',
  validateQuizKit(ghostId).blockers.some((r) => r.id === 'mapping' && (r.detail || '').includes('ghost'))
)

const thinCopy = buildKit()
thinCopy.archetypes[0].summary = ''
const thinValidation = validateQuizKit(thinCopy)
check(
  '3h 缺 The Read → copy warning（不拦应用）',
  thinValidation.warnings.some((r) => r.id === 'copy') && thinValidation.ok
)

/* 4. 编译：3/1 权重 + 列合计相等 */
check('4a 主原型 3 分、次原型 1 分', PRIMARY_WEIGHT === 3 && SECONDARY_WEIGHT === 1)
check('4b 次原型是声明顺序的下一个（循环）', secondaryArchetype(IDS, 'overload') === 'sarcastic')
const weights = weightsFor(IDS, 'observer')
check(
  '4c 权重表只有两格非 0',
  Object.keys(weights).length === 2 && weights.observer === 3 && weights.mainchar === 1,
  JSON.stringify(weights)
)
check('4d 不存在的原型 → 空权重', Object.keys(weightsFor(IDS, 'ghost')).length === 0)

const compiled = compileQuizKit(clean)
check(
  '4e 编译出 8 题 × 4 选项',
  compiled.quiz.questions.length === 8 && compiled.quiz.questions.every((q) => q.options.length === 4)
)
check('4f 选项 id 固定 a/b/c/d', compiled.quiz.questions[0].options.map((o) => o.id).join('') === 'abcd')
check(
  '4g 四列列合计全部相等（配平是算出来的，不是调出来的）',
  IDS.every((id) => compiled.audit?.enumeration.columnTotals[id] === 32),
  JSON.stringify(compiled.audit?.enumeration.columnTotals)
)
check('4h 分类写统一词表（Pop Culture）', compiled.categories.join('|') === 'Pop Culture')
check('4i summary 活着穿过编译', compiled.quiz.archetypes[0].summary === clean.archetypes[0].summary)

const summary = summarizeCompiled(compiled)
check('4j 全枚举 65,536 种组合', summary.total === 65536, String(summary.total))
check('4k 平局率 9.2% 左右（≤ 上限 12%）', Math.abs(summary.tiePct - 9.2) < 0.2, `${summary.tiePct.toFixed(1)}%`)
check(
  '4l 四个原型命中率都在 20–30%',
  IDS.every((id) => (summary.hitPct[id] ?? 0) > 20 && (summary.hitPct[id] ?? 0) < 30),
  JSON.stringify(summary.hitPct)
)
check('4m 健康分 100（与 check-quiz.mjs 的干净卷一致）', summary.health === 100, String(summary.health))
check('4n 没有任何 blocker', summary.blockers.length === 0, summary.blockers.join('；'))

/* 5. 半成品也能编译（进编辑器手工救），但会留 issue */
const halfKit = { ...buildKit(), questions: buildKit().questions.slice(0, 3) }
const halfCompiled = compileQuizKit(halfKit)
check('5a 3 题的半成品也能编译', halfCompiled.quiz.questions.length === 3)
check(
  '5b 半成品 → questions 规则报 blocker（而不是悄悄编权重）',
  halfCompiled.validation.blockers.some((r) => r.id === 'questions')
)

/* 6. 选题 / 题目段的归一化 */
const ideas = normalizeIdeas({
  ideas: [
    {
      title: 'What Kind of Group Chat Are You?',
      topic: 'Sports',
      tags: ['kpop', 'nope'],
      archetypes: ['a', 'b', 'c', 'd'],
    },
    { title: 'What Kind of Group Chat Are You?' },
    { angle: 'no title' },
  ],
})
check('6a 重复标题只留一条、没标题的丢掉', ideas.length === 1, String(ideas.length))
check('6b 分类 / 标签都被归一', ideas[0].topic === 'pop-culture' && ideas[0].tags.join('|') === 'K-Pop')

const parsedQuestions = normalizeQuestions({
  questions: [
    { title: 'Q1', options: [{ text: 'x', primary: 'Observer' }, { text: 'y', archetype: 'main char' }] },
  ],
})
check('6c primary 大小写被规整', parsedQuestions.questions[0].options[0].primary === 'observer')
check('6d archetype 别名能读', parsedQuestions.questions[0].options[1].primary === 'mainchar')

const merged = mergeQuizKit({
  idea: ideas[0],
  archetypes: clean.archetypes,
  questions: parsedQuestions.questions,
  meta: { geo: 'GB' },
})
check('6e 合并后 meta 保留', merged.meta.geo === 'GB')
check('6f 合并后 locale 固定 en', merged.locale === 'en')
check('6g 合并结果能被 readQuizKit 读', readQuizKit(merged).kit !== null)

const prompt = buildQuestionsUserPrompt({ idea: ideas[0], archetypes: clean.archetypes })
check('6h 题目提示词列全 4 个 id', IDS.every((id) => prompt.includes(`"${id}"`)))
check('6i 题目提示词写明「每题 4 个选项指向 4 个不同原型」', prompt.includes('DIFFERENT results'))

/* ---------------------------------------------------------------- *
 * 7. 截断的 JSON 兜底（实测：选题那次 AI 正好断在半句）
 * ---------------------------------------------------------------- */

const truncated = '{"ideas":[{"title":"A","angle":"x"},{"title":"B","angle":"y"},{"title":"C","ang'
const repaired = closeTruncatedJson(truncated)
check('7a 截断的数组能补回完整的前两条', Boolean(repaired), String(repaired))
check('7b 补完是合法 JSON', (() => {
  try {
    return Array.isArray(JSON.parse(String(repaired)).ideas)
  } catch {
    return false
  }
})())
check('7c 不完整的那条被丢掉，不是被瞎猜', (() => {
  const list = JSON.parse(String(repaired)).ideas as Array<{ title: string }>
  return list.length === 2 && list[1].title === 'B'
})())
check('7d 已经完整的 JSON 不动（返回 null 交给原来的解析）', closeTruncatedJson('{"ideas":[]}') === null)
check('7e 括号不配对的乱码不动', closeTruncatedJson('not json at all') === null)
check(
  '7f 截断在第二条中间时只留下第一条',
  (() => {
    const head = closeTruncatedJson('{"questions":[{"title":"Q1"},{"title":"Q2"')
    if (!head) return false
    const list = JSON.parse(head).questions as Array<{ title: string }>
    return list.length === 1 && list[0].title === 'Q1'
  })()
)

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
