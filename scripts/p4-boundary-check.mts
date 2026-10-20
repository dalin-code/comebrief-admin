#!/usr/bin/env node
/**
 * P4 分段边界自检（纯函数，不花模型额度）。
 *
 * 钉住三件事：
 *   1. 超过软上限只警告，超过硬上限才裁；
 *   2. 裁切按段落 / 句子收口，不是从字中间砍断；
 *   3. 最后一段是否真的落到结局画面（detectEnding）。
 *
 * 用法：node --import ./scripts/_ts-resolve.mts scripts/p4-boundary-check.mts
 */
import { countChineseChars, htmlToPlainText } from '../lib/storyPrompt.ts'
import type { StoryBeat } from '../lib/storyPlan.ts'
import { detectEnding, enforceSectionBoundary, trimHtmlToMaxChars } from '../lib/storyWrite.ts'

let failed = 0
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` —— ${extra}` : ''}`)
  if (!cond) failed += 1
}

const beat: StoryBeat = {
  id: 'B1',
  function: '触发事件',
  goal: '把东西还回去',
  obstacle: '对方不肯开门',
  turn: '他发现东西不是自己的',
  reveal: '',
  stateDelta: 'additive',
  targetChars: 100,
  softMaxChars: 115,
  hardMaxChars: 135,
  forbiddenReveals: ['凶手是管家'],
  cutRule: '写完最后一个动作就停',
}

const sentence = '他推开门走进屋里，看见桌上放着一只旧杯子。'
const htmlOf = (times: number) => `<p>${sentence.repeat(times)}</p>`

/* 1. 正常范围：不动稿，也不该有警告 */
const normal = enforceSectionBoundary({ html: htmlOf(5), beat })
check('1a 正常字数不裁切', !normal.trimmed && normal.chars === countChineseChars(htmlToPlainText(htmlOf(5))))
check('1b 正常字数没有边界警告', normal.warnings.length === 0, normal.warnings.join('；'))

/* 2. 超软上限、未到硬上限：只警告，不裁 */
const soft = enforceSectionBoundary({ html: htmlOf(7), beat })
check('2a 超软上限被标记', soft.overSoft && !soft.overHard)
check('2b 超软上限不裁稿', !soft.trimmed && soft.chars === countChineseChars(htmlToPlainText(htmlOf(7))))
check('2c 超软上限提示压缩', soft.warnings.some((w) => w.includes('软上限')), soft.warnings.join('；'))

/* 3. 超硬上限：必须裁到硬上限以内，并且保留 HTML 结构 */
const hard = enforceSectionBoundary({ html: htmlOf(40), beat })
check('3a 超硬上限被标记', hard.overHard)
check('3b 超硬上限已裁切', hard.trimmed && hard.chars <= beat.hardMaxChars, `${hard.chars} / ${beat.hardMaxChars}`)
check('3c 裁切后仍是可渲染的段落', /^<p>[\s\S]*<\/p>$/.test(hard.html), hard.html.slice(0, 40))
check('3d 裁切后停在句子收口处', /[。！？…」』”"]\s*$/.test(htmlToPlainText(hard.html)))
check('3e 超硬上限有明确警告', hard.warnings.some((w) => w.includes('硬上限')), hard.warnings.join('；'))

/* 4. 提前写出后续揭示：只警告，不替站长删内容 */
const leak = enforceSectionBoundary({ html: `<p>${sentence.repeat(3)}凶手是管家。</p>`, beat })
check('4a 识别提前揭晓', leak.warnings.some((w) => w.includes('提前写出')), leak.warnings.join('；'))
check('4b 识别揭示不等于删稿', htmlToPlainText(leak.html).includes('凶手是管家'))

/* 5. trimHtmlToMaxChars：多段时优先整段保留，最后一段在句号处收口 */
const manyParas = Array.from({ length: 6 }, (_, i) => `<p>第${i + 1}段。${sentence.repeat(2)}</p>`).join('\n')
const trimmed = trimHtmlToMaxChars(manyParas, 40)
const trimmedChars = countChineseChars(htmlToPlainText(trimmed))
check('5a 多段裁切不超上限', trimmedChars <= 40, `${trimmedChars} / 40`)
check('5b 多段裁切保留段落标签', (trimmed.match(/<p>/g) || []).length >= 1 && trimmed.endsWith('</p>'))
check('5c 多段裁切停在句号处', /[。！？…」』”"]\s*$/.test(htmlToPlainText(trimmed)), htmlToPlainText(trimmed).slice(-20))

/* 6. 单段纯文本也能兜底成 <p>，且字数受控 */
const onePara = trimHtmlToMaxChars(sentence.repeat(20), 30)
check('6a 纯文本裁切补成段落', /^<p>[\s\S]*<\/p>$/.test(onePara), onePara.slice(0, 30))
check('6b 纯文本裁切不超上限', countChineseChars(htmlToPlainText(onePara)) <= 30)

/* 7. detectEnding：短稿 / 未完 / 无收束词 / 有信号 */
const prefix = '他坐在桌前，把杯子推到一边，窗外的雨一直下着。'.repeat(10)
const longEnough = countChineseChars(prefix) >= 180
check('7a 测试底稿够长', longEnough, String(countChineseChars(prefix)))

check('7b 短稿不算收尾', !detectEnding('他把门关上了。'))

const openTail = `${prefix}就在这时。`
check('7c 「就在这时」不算收尾', !detectEnding(openTail))

const signalTail = `${prefix}门外的脚步声走远了。`
check('7d 命中 endingSignal 算收尾', detectEnding(signalTail, '门外的脚步声走远'))

const plainTail = `${prefix}他们继续往前走了几步。`
check('7e 没有收束信号不算收尾', !detectEnding(plainTail))

const cueTail = `${prefix}他关上门，屋里安静下来。`
check('7f 收束动作 / 画面算收尾', detectEnding(cueTail))

const unfinishedTail = `${prefix}他关上门，未完。`
check('7g 「未完」不算收尾', !detectEnding(unfinishedTail))

if (failed) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
