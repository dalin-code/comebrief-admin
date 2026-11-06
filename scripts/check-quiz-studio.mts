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

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`)
process.exit(failed === 0 ? 0 : 1)
