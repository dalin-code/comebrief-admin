#!/usr/bin/env node
/**
 * Quiz Studio 纯逻辑自检。
 *
 * 这一层不连数据库、不需要登录，专门钉住三类容易「看起来正常、实际已经坏了」的口径：
 *   1. categories 可能是数组也可能是历史 CSV 字符串 —— 两种都要归一成同一个 topic；
 *   2. 旧卷没有权重矩阵，健康分只能按结构检查，不能伪造命中率；
 *   3. 「复制一份」必须剥掉 id / 时间戳并回到草稿，否则会覆盖原行或复制出已发布内容。
 *
 * 用法：
 *   node --import ./scripts/_ts-resolve.mts scripts/check-quiz-studio.mts
 */

import {
  buildAxesRawData,
  duplicateQuizRow,
  publicTopicUrl,
  quizCategories,
  quizHealth,
  quizModel,
  quizTopicList,
  type QuizRow,
} from '../lib/quizStudio.ts'
import { normalizeAxeQuiz } from '../lib/quizAxes.ts'

let failed = 0
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` —— ${extra}` : ''}`)
  if (!cond) failed += 1
}

/* 1. 分类归一：数组 / CSV / 大小写去重 */
const fromArray = quizCategories({ categories: ['Persona', 'Social', 'persona'] })
check('1a 数组分类去重', fromArray.length === 2 && fromArray[0] === 'Persona', JSON.stringify(fromArray))

const fromCsv = quizCategories({ categories: 'Persona, Social,Persona' })
check('1b CSV 分类去重', fromCsv.join('|') === 'Persona|Social', JSON.stringify(fromCsv))

/* 2. topic 聚合：同一个 slug 的不同写法合并，空 slug 丢弃 */
const topicRows: QuizRow[] = [
  { id: 'q1', title: 'A', categories: ['Pop Culture'] },
  { id: 'q2', title: 'B', categories: 'pop culture,Social' },
  { id: 'q3', title: 'C', categories: ['全中文'] },
]
const topics = quizTopicList(topicRows)
const pop = topics.find((topic) => topic.slug === 'pop-culture')
check('2a topic 合并大小写', Boolean(pop) && pop?.count === 2, JSON.stringify(topics))
check('2b 全中文分类没有 topic slug', !topics.some((topic) => topic.label === '全中文'))
check(
  '2c topic 地址可拼',
  publicTopicUrl('Pop Culture').endsWith('/quizzes/topic/pop-culture'),
  publicTopicUrl('Pop Culture')
)

/* 2d：分类屏的顺序必须与前台页签一致，历史脏值垫底等人工归并 */
const orderedRows: QuizRow[] = [
  { id: 'o1', title: 'A', categories: ['Mindset'] },
  { id: 'o2', title: 'B', categories: ['Sports'] },
  { id: 'o3', title: 'C', categories: ['Career'] },
  { id: 'o4', title: 'D', categories: ['Lifestyle'] },
]
check(
  '2d topic 按统一词表排序，未知分类垫底',
  quizTopicList(orderedRows)
    .map((topic) => topic.label)
    .join('|') === 'Career|Lifestyle|Mindset|Sports',
  quizTopicList(orderedRows)
    .map((topic) => topic.label)
    .join('|')
)

/* 3. 旧卷健康分：结构完整 = 100；缺题 = blocker；axes = 走 audit */
const legacy: QuizRow = {
  id: 'legacy',
  title: 'Legacy quiz',
  categories: ['Persona'],
  cover_url: 'https://example.com/cover.webp',
  raw_data: {
    title: 'Legacy quiz',
    model: 'score',
    categories: ['Persona'],
    cover_url: 'https://example.com/cover.webp',
    questions: [1, 2, 3].map((n) => ({
      id: `q${n}`,
      title: `Question ${n}`,
      options: [{ text: 'A', score: 1 }, { text: 'B', score: 2 }],
    })),
    results: [{ id: 'r1', title: 'Result', min_score: 3, max_score: 6 }],
  },
}
const legacyHealth = quizHealth(legacy)
check('3a 旧卷完整 = 100 分', legacyHealth.score === 100, String(legacyHealth.score))
check('3b 旧卷完整 = 0 blocker', legacyHealth.blockers.length === 0)

const broken = quizHealth({ id: 'broken', title: '', active: false })
check('3c 空卷有 blocker', broken.blockers.length > 0, String(broken.blockers.length))
check('3d 空卷分数会掉', broken.score < 100, String(broken.score))

const axesRow: QuizRow = {
  id: 'axes',
  title: 'Axes quiz',
  categories: ['Persona'],
  raw_data: {
    title: 'Axes quiz',
    model: 'axes',
    archetypes: [
      { id: 'a', name: 'Alpha', short: 'A' },
      { id: 'b', name: 'Beta', short: 'B' },
    ],
    questions: Array.from({ length: 6 }).map((_, index) => ({
      id: `q${index}`,
      title: `Question ${index}`,
      options: [
        { id: 'o1', text: 'One', weights: { a: 3, b: index % 2 } },
        { id: 'o2', text: 'Two', weights: { a: index % 2, b: 3 } },
      ],
    })),
  },
}
const axesHealth = quizHealth(axesRow)
check('3e axes 卷走 audit', quizModel(axesRow) === 'axes' && Boolean(axesHealth.axes))
check('3f axes 分数在 0–100', axesHealth.score >= 0 && axesHealth.score <= 100, String(axesHealth.score))

/* 4. 复制载荷：剥 id / 时间戳，回草稿，slug 不撞原行 */
const copy = duplicateQuizRow({
  ...legacy,
  slug: 'legacy-quiz',
  status: 'published',
  active: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  published_at: '2026-01-03T00:00:00.000Z',
})
check('4a 复制不带走 id', !('id' in copy))
check('4b 复制回到草稿', copy.status === 'draft' && copy.active === false)
check('4c 复制标题加 copy', String(copy.title).endsWith('(copy)'), String(copy.title))
check('4d 复制 slug 不撞原行', copy.slug !== 'legacy-quiz' && String(copy.slug).startsWith('legacy-quiz-copy-'))

/* 5. 矩阵保存载荷：保留外层字段，axes 正文只写 archetypes + questions */
const raw = buildAxesRawData(axesRow, {
  model: 'axes',
  title: 'Axes quiz',
  archetypes: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }],
  questions: [{ id: 'q1', title: 'Q', options: [{ id: 'o1', text: 'A', weights: { a: 3 } }] }],
})
check('5a raw_data 保留 model=axes', raw.model === 'axes')
check('5b raw_data 保留分类', Array.isArray(raw.categories) && raw.categories[0] === 'Persona')
check('5c raw_data 写入 archetypes/questions', raw.archetypes.length === 2 && raw.questions.length === 1)

/*
 * 5d–5g：v3 的三格元信息必须**原样穿过保存路径**。
 *
 * 这是这一层最容易悄悄坏掉的地方：`buildAxesRawData` 是「用编辑器状态重写
 * archetypes/questions」，只要哪次改动忘了带上某格，作者保存一次（哪怕只改
 * 一个错字），结果页的答案地图就会整块消失 —— 而库里的数据看起来完全正常。
 */
const v3Row: QuizRow = {
  ...axesRow,
  raw_data: {
    ...(axesRow.raw_data as Record<string, any>),
    axes: { x: { neg: 'Solo', pos: 'Social' }, y: { neg: 'Low-key', pos: 'Loud' } },
  },
}
const v3Quiz = normalizeAxeQuiz(v3Row.raw_data)
check('5d 归一化读得出两条轴', Boolean(v3Quiz?.quiz.axes?.x.neg === 'Solo' && v3Quiz?.quiz.axes?.y.pos === 'Loud'))

const v3Raw = buildAxesRawData(v3Row, {
  model: 'axes',
  title: 'Axes quiz',
  axes: v3Quiz?.quiz.axes,
  archetypes: [
    { id: 'a', name: 'Alpha', quadrant: 'TL', color: '#FFE45E', pose: 'worry' },
    { id: 'b', name: 'Beta', quadrant: 'BR', color: '#6EE7B7', pose: 'wave' },
  ],
  questions: [
    {
      id: 'q1',
      title: 'Q',
      options: [{ id: 'o1', text: 'A', weights: { a: 3 }, intensity: 2, bold: true }],
    },
  ],
})
check('5e 保存后 axes 仍在', v3Raw.axes?.x?.pos === 'Social' && v3Raw.axes?.y?.neg === 'Low-key')
check(
  '5f 保存后 quadrant / color / pose 仍在',
  v3Raw.archetypes[0].quadrant === 'TL' &&
    v3Raw.archetypes[0].color === '#FFE45E' &&
    v3Raw.archetypes[0].pose === 'worry'
)
check(
  '5g 保存后 intensity / bold 仍在',
  v3Raw.questions[0].options[0].intensity === 2 && v3Raw.questions[0].options[0].bold === true
)

/*
 * 5h：没有 v3 字段的旧卷保存后也不该「长出」这些键 —— 否则第一次保存就会
 * 给线上 20 多篇卷各塞进一堆 `axes: undefined` 形状的东西。
 */
const legacyQuiz = normalizeAxeQuiz(axesRow.raw_data)
const legacyRaw = buildAxesRawData(axesRow, {
  model: 'axes',
  title: 'Axes quiz',
  archetypes: legacyQuiz?.quiz.archetypes ?? [],
  questions: legacyQuiz?.quiz.questions ?? [],
})
check(
  '5h 旧卷保存后不凭空长出 axes / quadrant',
  legacyRaw.axes === undefined && legacyRaw.archetypes.every((a: any) => a.quadrant === undefined)
)

/*
 * 6. 缺 color 的原型：按象限补兜底色，且**不冒充「已纠正」**
 *
 * 2026-11-22 的事故：4 篇原型卷只写了 quadrant、没写 color，编辑器把
 * 「N 个原型没有 color」当错误弹了红条 —— 但前台本来就有同一组兜底色。
 * 现在归一化阶段就补齐；真正没改数据的降级（缺象限）走 advisories。
 */
const uncolored = normalizeAxeQuiz({
  title: 'Uncolored',
  model: 'axes',
  archetypes: [
    { id: 'a', name: 'A', quadrant: 'TL' },
    { id: 'b', name: 'B', quadrant: 'TR' },
    { id: 'c', name: 'C', quadrant: 'BL' },
    { id: 'd', name: 'D', quadrant: 'BR' },
  ],
  questions: [{ id: 'q1', title: 'Q', options: [{ id: 'o1', text: 'x', weights: { a: 3 } }] }],
})
check(
  '6a 缺 color 时按象限补兜底色（与前台 slotColor 同色）',
  uncolored?.quiz.archetypes.map((a) => a.color).join('|') ===
    '#FFE45E|#FF8FA3|#8C93FF|#6EE7B7',
  uncolored?.quiz.archetypes.map((a) => a.color).join('|')
)
check('6b 补色不算问题（issues 里不再出现 color）', !uncolored?.issues.some((i) => i.includes('color')))

const noQuadrant = normalizeAxeQuiz({
  title: 'No quadrant',
  model: 'axes',
  archetypes: [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
    { id: 'd', name: 'D' },
  ],
  questions: [{ id: 'q1', title: 'Q', options: [{ id: 'o1', text: 'x', weights: { a: 3 } }] }],
})
check(
  '6c 缺象限只进 advisories，不进 issues（否则打开就弹红条）',
  noQuadrant?.issues.length === 0 && (noQuadrant?.advisories.length ?? 0) === 1,
  `issues=${JSON.stringify(noQuadrant?.issues)} advisories=${JSON.stringify(noQuadrant?.advisories)}`
)
check('6d 没有象限时不硬塞颜色', noQuadrant?.quiz.archetypes.every((a) => a.color === undefined))

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`)
process.exit(failed === 0 ? 0 : 1)
