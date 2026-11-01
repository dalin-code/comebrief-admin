#!/usr/bin/env node
/**
 * P13 自检：测验 JSON 包的诊断 / 校验 / 归一化（不联网、不碰数据库）。
 *
 * 背景（2026-10-29）：后台批量导入以前把「JSON 语法错 / 结构错 / 数据库错」
 * 全报成一句 Invalid JSON Format。这个脚本把三类脏输入钉在测试里，
 * 顺便保证「模板本身一定能过校验」——模板要是自己都过不了，按钮就没意义。
 *
 * 用法：node --import ./scripts/_ts-resolve.mts scripts/p13-quiz-pack-check.mts
 */
import {
  SCORE_TEMPLATE,
  formatPackText,
  inspectPackText,
  normalizePack,
  reachableRange,
  rewritePackText,
  validatePack,
} from '../lib/quizPack.ts'

let failed = 0
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` —— ${extra}` : ''}`)
  if (!cond) failed += 1
}

const blockers = (issues: Array<{ level: string; path: string; message: string }>) =>
  issues.filter((i) => i.level === 'blocker')
const warnings = (issues: Array<{ level: string }>) => issues.filter((i) => i.level === 'warning')

/* 1. 模板必须「零 blocker 零 warning」——否则「模板」按钮插进去就是脏数据 */
const tpl = inspectPackText(SCORE_TEMPLATE)
check('1a 模板能解析', tpl.ok === true, tpl.error?.message ?? '')
check('1b 模板没有需要修的东西', tpl.fixes.length === 0, tpl.fixes.join(' / '))
check('1c 模板零 blocker', tpl.entries.length === 1 && blockers(tpl.entries[0].issues).length === 0, JSON.stringify(blockers(tpl.entries[0]?.issues ?? [])))
check('1d 模板零 warning', tpl.entries.length === 1 && warnings(tpl.entries[0].issues).length === 0, JSON.stringify(warnings(tpl.entries[0]?.issues ?? [])))
check('1e 模板可达区间 = 2–8', JSON.stringify(reachableRange(tpl.entries[0]?.quiz.questions ?? [])) === '{"min":2,"max":8}')
check('1f 模板摘要（2 题 / 3 结果）', tpl.entries[0]?.summary.questionCount === 2 && tpl.entries[0]?.summary.resultCount === 3)

/* 2. AI 最常见的四种脏输出：围栏 + 中文引号 + 尾逗号 + // 注释 */
const dirty = '```json\n{\n  “title”: “脏输入测试”,  // 标题\n  “model”: “score”,\n  “questions”: [\n    { “id”: “q1”, “title”: “题一”, “options”: [\n      { “id”: “o1”, “text”: “A”, “score”: 2 },\n      { “id”: “o2”, “text”: “B”, “score”: 1 },\n    ] }\n  ],\n  “results”: [ { “id”: “r1”, “min_score”: 1, “max_score”: 1, “title”: “低”, “description”: “d” },\n               { “id”: “r2”, “min_score”: 2, “max_score”: 2, “title”: “高”, “description”: “d” } ],\n}\n```'
const dirtyRaw = inspectPackText(dirty)
check('2a 脏输入能直接吃下（自动容错）', dirtyRaw.ok === true && dirtyRaw.entries[0]?.ok === true, dirtyRaw.error?.message ?? '')
check('2b 修复清单列出了 4 类问题', dirtyRaw.fixes.length === 4, dirtyRaw.fixes.join(' / '))
const broken = inspectPackText('{\n  "title": "x",\n  "b":\n}')
check('2c 真坏的 JSON → 失败且带行号', broken.ok === false && typeof broken.error?.line === 'number', JSON.stringify(broken.error))
const fullwidth = inspectPackText('{"title"："x"}')
check('2d 全角冒号 → 提示「全角冒号」', fullwidth.ok === false && (fullwidth.error?.hints ?? []).some((h) => h.includes('全角冒号')), JSON.stringify(fullwidth.error?.hints))
const rewritten = rewritePackText(dirty)
check('2e 一键修复清单提到围栏', rewritten.applied.some((s) => s.includes('围栏')), rewritten.applied.join(' / '))
check('2f 一键修复清单提到中文引号', rewritten.applied.some((s) => s.includes('中文双引号')))
check('2g 一键修复清单提到尾逗号', rewritten.applied.some((s) => s.includes('尾逗号')))
check('2h 一键修复清单提到注释', rewritten.applied.some((s) => s.includes('注释')))
const dirtyFixed = inspectPackText(rewritten.text)
check('2i 修完能导入（零 blocker）', dirtyFixed.ok && blockers(dirtyFixed.entries[0].issues).length === 0, JSON.stringify(blockers(dirtyFixed.entries[0]?.issues ?? [])))

/* 3. 字符串里的 // 和逗号不能被误删 */
const keepContent = rewritePackText('{"title":"看 https://a.com/x?a=1,2 这篇","model":"score"}')
check('3a URL 里的 // 保住', keepContent.text.includes('https://a.com/x?a=1,2'))
check('3b 字符串里的逗号保住', keepContent.text.includes('a=1,2'))
check('3c 没有可修项 → 清单为空', keepContent.applied.length === 0, keepContent.applied.join(' / '))

/* 4. 结构错误（以前会「导入成功然后编辑页白屏」） */
const noQuestions = validatePack({ title: 'x', model: 'score', results: [] })
check('4a 缺 questions → blocker 且指到 questions', blockers(noQuestions).some((i) => i.path === 'questions'))
const objectQuestions = validatePack({ title: 'x', questions: { a: 1 }, results: [{ title: 'r', min_score: 0, max_score: 1 }] })
check('4b questions 不是数组 → blocker', blockers(objectQuestions).some((i) => i.path === 'questions'))
const emptyTitle = inspectPackText(JSON.stringify({ ...JSON.parse(SCORE_TEMPLATE), title: '   ' }))
check('4c 标题空白 → 有 blocker', blockers(emptyTitle.entries[0].issues).some((i) => i.path === 'title'))

/* 5. 分数区间：没人接 / 有缝 / 重叠 */
const gap = inspectPackText(
  JSON.stringify({
    ...JSON.parse(SCORE_TEMPLATE),
    results: [
      { id: 'r1', min_score: 2, max_score: 3, title: 'a', description: 'd' },
      { id: 'r2', min_score: 5, max_score: 6, title: 'b', description: 'd' },
    ],
  })
)
const gapIssues = gap.entries[0].issues
check('5a 中间有缝 → blocker', blockers(gapIssues).some((i) => i.message.includes('区间有缝')), JSON.stringify(blockers(gapIssues)))
check('5b 最高分没人接 → blocker', blockers(gapIssues).some((i) => i.message.includes('最高分没人接')))

const overlap = inspectPackText(
  JSON.stringify({
    ...JSON.parse(SCORE_TEMPLATE),
    results: [
      { id: 'r1', min_score: 2, max_score: 5, title: 'a', description: 'd' },
      { id: 'r2', min_score: 5, max_score: 8, title: 'b', description: 'd' },
    ],
  })
)
check('5c 区间重叠 → warning 不拦导入', blockers(overlap.entries[0].issues).length === 0 && overlap.entries[0].ok === true)

/* 6. 归一化：缺字段 / 字符串数字 / 缺 id 都要兜住 */
const normalized = normalizePack({
  title: '只有标题',
  questions: [{ title: '题一', options: [{ text: 'A', score: '3' }, { text: 'B', score: '1' }] }],
  results: [{ title: 'r', min_score: '1', max_score: '3' }],
})
check('6a model 默认 score', normalized.model === 'score')
check('6b categories 默认 Persona', JSON.stringify(normalized.categories) === '["Persona"]')
check('6c tags / cover_url / is_limited 补齐', JSON.stringify(normalized.tags) === '[]' && normalized.cover_url === '' && normalized.is_limited === false)
check('6d 题目 / 选项 / 结果 id 自动补', normalized.questions[0].id === 'q1' && normalized.questions[0].options[0].id === 'o1' && normalized.results[0].id === 'r1')
check('6e weight 默认 1', normalized.questions[0].weight === 1)
check('6f 字符串分数转成整数', normalized.questions[0].options[0].score === 3 && normalized.results[0].max_score === 3)
check('6g 未知字段保留（前台可能在用）', normalizePack({ title: 'x', foo: 'bar' }).foo === 'bar')

/* 7. 一个框里放数组 = 一次导多篇 */
const two = inspectPackText(`[${SCORE_TEMPLATE}, ${SCORE_TEMPLATE.replace('你是哪种恋爱类型', '第二篇')}]`)
check('7a 数组 → 2 篇', two.ok && two.entries.length === 2)
check('7b 两篇都能导', two.entries.every((e) => e.ok))
check('7c 空数组 → 老实报错', inspectPackText('[]').ok === false)
check('7d 空白文本 → 老实报错', inspectPackText('   \n  ').ok === false)

/* 8. 格式化 */
const formatted = formatPackText('{"title":"x","questions":[]}')
check('8a 格式化成功且是 2 空格缩进', formatted.ok === true && formatted.ok && formatted.text.includes('\n  "title"'))
check('8b 格式化失败时给出行列', formatPackText('{"title": }').ok === false)

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)


