#!/usr/bin/env node
/**
 * P3 自评解析器自检（不花额度：全部用假数据）。
 *
 * 模型不听话的花样很多：包 ```json、分数给字符串、severity 写中文、
 * 维度少给、问题给十条……这里把能想到的脏输入全喂一遍，
 * 确认 parseStoryReview 要么给出干净的报告，要么老实报错（绝不半份报告去驱动重写）。
 *
 * 用法：node --import ./scripts/_ts-resolve.mts scripts/p3-parser-check.mts
 */
import { parseStoryReview, pickDefaultIssueIds, type StoryReview } from '../lib/storyReview.ts'

let failed = 0
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` —— ${extra}` : ''}`)
  if (!cond) failed += 1
}

const six = (scores: Array<[string, number, string]>) =>
  scores.map(([key, score, comment]) => ({ key, score, comment }))

/* 1. 标准契约（用真实跑出来的那条 7.5 分「表扬型评语」验合成逻辑） */
const normal = parseStoryReview(
  JSON.stringify({
    verdict: '结尾太用力，先改结尾。',
    scores: six([
      ['hook', 7.5, '开篇动作精度高，红梅烟的意象立得住。'],
      ['character', 5, '人物动机因结尾反转变得混乱。'],
      ['dialogue', 7, '对话克制，符合写法要求。'],
      ['detail', 6.5, '对账本的过度解释显得冗余。'],
      ['ending', 4, '反转生硬，点题味重。'],
      ['style', 5.5, '长句过多，视角没拉远。'],
    ]),
    issues: [
      { dimension: 'ending', severity: 'high', evidence: '那是一张带血的身份证', problem: '强行点题', fix: '停在把烟嵌进阴影的动作上' },
    ],
  }),
  'fake-model'
)
check('1a 标准契约能解析', normal.ok === true)
if (normal.ok) {
  check('1b 六维齐全且顺序固定', normal.review.scores.map((s) => s.key).join(',') === 'hook,character,dialogue,detail,ending,style')
  check('1c 均分 = 六维平均', normal.review.total === Math.round(((7.5 + 5 + 7 + 6.5 + 4 + 5.5) / 6) * 10) / 10, String(normal.review.total))
  check('1d 7.5 分的表扬评语不再被合成「问题」', !normal.review.issues.some((i) => i.problem.includes('开篇抓力只给了')), normal.review.issues.map((i) => i.dimension).join(','))
  check('1e 5/6.5/5.5/4 分这四维都补上了条目', ['character', 'detail', 'ending', 'style'].every((k) => normal.review.issues.some((i) => i.dimension === k)))
  check('1f 评分低的合成条自动升级为必改', normal.review.issues.find((i) => i.dimension === 'character')?.severity === 'high')
}

/* 2. ```json 包裹 + 中文 severity + 字符串分数 */
const messy = parseStoryReview(
  '```json\n' + JSON.stringify({
    summary: '还行',
    scores: { hook: '8.5', character: 7, dialogue: 6, detail: 7, ending: 9, style: 8 },
    problems: [{ dimension: '对话自然度', severity: '高', quote: '“你来了。”他说。', 问题: '太客气', 改法: '让他先递烟' }],
  }) + '\n```'
)
check('2a 代码块包裹 / 对象型 scores / 字符串分数 都能吃下', messy.ok === true)
if (messy.ok) {
  check('2b 分数被 clamp 成数字', messy.review.scores[0].score === 8.5, String(messy.review.scores[0].score))
  check('2c 中文维度名能映射回 key', messy.review.issues[0]?.dimension === 'dialogue')
  check('2d 中文 severity「高」→ high', messy.review.issues[0]?.severity === 'high')
  check('2e 中文字段名（问题/改法/引句）能识别', messy.review.issues[0]?.fix === '让他先递烟')
  check('2f verdict 走 summary 兜底', messy.review.verdict === '还行')
}

/* 3. 畸形输入 */
const tooFew = parseStoryReview(JSON.stringify({ scores: [{ key: 'hook', score: 5 }] }))
check('3a 只给 1 个维度 → 老实报错', tooFew.ok === false, tooFew.ok ? '' : tooFew.error)
check('3b 完全不是 JSON → 老实报错', parseStoryReview('我觉得这篇挺好的，不用改。').ok === false)
check('3c 空字符串 → 老实报错', parseStoryReview('').ok === false)

/* 4. 问题条数上限 + 去重 */
const many = parseStoryReview(
  JSON.stringify({
    verdict: 'x',
    scores: six([['hook', 6, 'a'], ['character', 6, 'b'], ['dialogue', 6, 'c'], ['detail', 6, 'd'], ['ending', 6, 'e'], ['style', 6, 'f']]),
    issues: Array.from({ length: 12 }, (_, i) => ({
      dimension: 'style',
      severity: 'mid',
      evidence: `证据${i}`,
      problem: `问题${i}`,
      fix: `改法${i}`,
    })),
  })
)
check('4a 12 条问题被截到 8 条', many.ok === true && many.review.issues.length === 8, many.ok ? String(many.review.issues.length) : '')

const dup = parseStoryReview(
  JSON.stringify({
    verdict: 'x',
    scores: six([['hook', 6, 'a'], ['character', 6, 'b'], ['dialogue', 6, 'c'], ['detail', 6, 'd'], ['ending', 6, 'e'], ['style', 6, 'f']]),
    issues: [
      { dimension: 'style', severity: 'mid', evidence: '同一句', problem: '同一个问题', fix: '一样的改法' },
      { dimension: 'style', severity: 'mid', evidence: '同一句', problem: '同一个问题', fix: '一样的改法' },
    ],
  })
)
check('4b 重复条目只留一条', dup.ok === true && dup.review.issues.filter((i) => i.problem === '同一个问题').length === 1)

/* 5. 勾选逻辑 */
const fake: StoryReview = {
  total: 6,
  verdict: 'x',
  scores: [
    { key: 'hook', label: '开篇抓力', score: 9, comment: '' },
    { key: 'ending', label: '结尾余味', score: 5, comment: '' },
  ] as StoryReview['scores'],
  issues: [
    { id: 'I1', dimension: 'hook', severity: 'low', evidence: '', problem: 'p', fix: 'f' },
    { id: 'I2', dimension: 'ending', severity: 'mid', evidence: '', problem: 'p', fix: 'f' },
    { id: 'I3', dimension: 'hook', severity: 'high', evidence: '', problem: 'p', fix: 'f' },
  ],
}
const picked = pickDefaultIssueIds(fake)
check('5a 低分维度的条目被勾', picked.includes('I2'))
check('5b 必改条目无条件被勾', picked.includes('I3'))
check('5c 高分维度里的「可改可不改」不勾', !picked.includes('I1'))

console.log(failed ? `\n✗ ${failed} 项不通过` : '\n✓ 全部通过')
process.exit(failed ? 1 : 0)
