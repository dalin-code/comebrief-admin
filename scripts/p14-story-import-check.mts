#!/usr/bin/env node
/**
 * P14 自检：大段文本 → 章节数组的切分 / 清洗 / 解码（不联网、不碰数据库）。
 *
 * 背景（2026-11-01）：后台要加「把一整篇稿子切成多章」，最容易翻车的三件事
 * 全是纯数据问题，跟 UI 无关，所以先钉死在这里：
 *   ① 四种章节标记混在一篇里（Markdown / 第X章 / Chapter X / 楔子番外）；
 *   ② Markdown 残留 —— 前台是 split('\n').map(<p>)，`##`、`**` 会直接显示给读者；
 *   ③ 中文 .txt 是 GBK 时用 UTF-8 解会整篇乱码。
 *
 * 用法：node --import ./scripts/_ts-resolve.mts scripts/p14-story-import-check.mts
 */
import {
  cleanBody,
  countChars,
  decodeTextFile,
  detectHeading,
  mergeParts,
  normalizeText,
  splitChapters,
  splitEvenly,
  splitPartAt,
  toChapters,
} from '../lib/storyImport.ts'
import type { SplitPart } from '../lib/storyImport.ts'

let failed = 0
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` —— ${extra}` : ''}`)
  if (!cond) failed += 1
}
const echo = (parts: SplitPart[]) => JSON.stringify(parts.map((p) => [p.title, p.chars]))

/* 1. Markdown 的 # / ##：既当章节边界，又必须从正文里消失 */
const sample = [
  '# 第一章 起点',
  '',
  '雨从傍晚开始下，一直没停。',
  '',
  '**他**站在屋檐下，看着街对面的灯。',
  '',
  '---',
  '',
  '## 第二章 门后',
  '',
  '门后是另一条街，[点这里](https://example.com/x) 只留文字。',
].join('\n')
const md = splitChapters(sample)
check('1a 两个 md 标题 → 两章', md.parts.length === 2, echo(md.parts))
check('1b 标题原样保留', md.parts[0]?.title === '第一章 起点' && md.parts[1]?.title === '第二章 门后')
check('1c 正文里的 # 已清掉', !md.parts[0].body.includes('#') && !md.parts[1].body.includes('#'))
check('1d 加粗标记已清掉', md.parts[0].body.includes('他站在屋檐下') && !md.parts[0].body.includes('**'))
check('1e 分隔线已丢弃', !md.parts[0].body.includes('---'))
check('1f 链接只留文字', md.parts[1].body.includes('点这里 只留文字') && !md.parts[1].body.includes('](http'))
check('1g 命中规则是 markdown', md.rules.join(',') === 'markdown', md.rules.join(','))

/* 2. 「第X章」：含全角数字、冒号、半角数字 */
const cn = splitChapters(
  ['第一章 起风', '一'.repeat(240), '第十二章：门后', '二'.repeat(240), '第３章', '三'.repeat(240)].join('\n')
)
check('2a 三章都认出来了', cn.parts.length === 3, echo(cn.parts))
check('2b 标题原样保留（含全角数字）', cn.parts[2]?.title === '第３章', cn.parts[2]?.title ?? '')
check('2c 命中规则是 cn', cn.rules.join(',') === 'cn', cn.rules.join(','))

/* 3. Chapter X：阿拉伯数字与罗马数字 */
const en = splitChapters(['Chapter 1', 'a'.repeat(240), 'Chapter IV — The Key', 'b'.repeat(240)].join('\n'))
check('3a 英文两章', en.parts.length === 2, echo(en.parts))
check('3b 罗马数字也算', en.parts[1]?.title === 'Chapter IV — The Key', en.parts[1]?.title ?? '')

/* 4. 特殊章：楔子 / 番外 */
const special = splitChapters(['楔子', 'x'.repeat(240), '番外·雪', 'y'.repeat(240)].join('\n'))
check('4a 楔子 + 番外 → 两章', special.parts.length === 2, echo(special.parts))
check('4b 标题原样保留', special.parts[0]?.title === '楔子' && special.parts[1]?.title === '番外·雪')

/* 5. 四种标记混在一篇里 */
const mixed = splitChapters(
  [
    '# 雨夜',
    'a'.repeat(240),
    '第二章 门后',
    'b'.repeat(240),
    'Chapter 3 — The Key',
    'c'.repeat(240),
    '楔子',
    'd'.repeat(240),
  ].join('\n')
)
check('5a 混排 → 四章', mixed.parts.length === 4, echo(mixed.parts))
check(
  '5b 四种规则都记录到',
  ['markdown', 'cn', 'en', 'special'].every((r) => mixed.rules.includes(r as never)),
  mixed.rules.join(',')
)

/* 6. 没有任何标记 → 整篇一章 + 明确提示 */
const plain = splitChapters('这是一段没有任何标记的文字。'.repeat(20))
check('6a 无标记 → 一章', plain.parts.length === 1 && plain.parts[0].title === '正文', echo(plain.parts))
check('6b 有「没找到标记」提示', plain.warnings.some((w) => w.includes('没找到任何章节标记')), plain.warnings.join(' / '))

/* 7. 开头的题记：够长单独成前言，太短并进第一章 */
const longPre = splitChapters(['题记'.repeat(70), '第一章 开始', 'a'.repeat(240)].join('\n'))
check('7a 长题记 → 前言章', longPre.parts[0]?.title === '前言', echo(longPre.parts))
const shortPre = splitChapters(['作者：某某', '第一章 开始', 'a'.repeat(240)].join('\n'))
check(
  '7b 短题记 → 并进第一章',
  shortPre.parts.length === 1 && shortPre.parts[0].body.startsWith('作者：某某'),
  echo(shortPre.parts)
)

/* 8. 空输入不抛异常 */
const empty = splitChapters('   \n\n  ')
check('8a 空输入 → 空数组', empty.parts.length === 0 && empty.warnings.length > 0)

/* 9. 正文句子不能被当成标题 */
check('9a 正文句子不误判', detectHeading('我第一次见到她，是在一场雨里。') === null)
check('9b `#` 只有一个也认', detectHeading('# 门后')?.title === '门后')
check('9c 三个井号不当章节（是正文小节）', detectHeading('### 地点') === null)

/* 10. 章数上限 */
const many = splitChapters(Array.from({ length: 5 }, (_, i) => `第${i + 1}章`).join('\n正文\n'), { maxParts: 2 })
check('10a 超上限只保留 2 章', many.parts.length === 2, echo(many.parts))
check('10b 有上限提示', many.warnings.some((w) => w.includes('上限')), many.warnings.join(' / '))

/* 11. cleanBody / normalizeText / countChars */
check('11a CRLF 归一', normalizeText('a\r\nb\rc') === 'a\nb\nc')
check('11b 全角空格归一', normalizeText('　正文　') === '正文')
check('11c 行内代码剥壳', cleanBody(['这是 `code` 片段']) === '这是 code 片段')
check('11d 图片整段丢弃', cleanBody(['![封面](x.png)我来了']) === '我来了')
check('11e 字数不算空白', countChars('一 二\n三') === 3)

/* 12. 写入编辑器：首章免费、id 唯一 */
const chapters = toChapters(md.parts, { idSeed: 1 })
check('12a 首章免费且价格 0', chapters[0].is_free === true && chapters[0].price === 0)
check('12b 其余章节收费 99', chapters[1].is_free === false && chapters[1].price === 99)
check(
  '12c id 唯一且是 ch_ 前缀',
  new Set(chapters.map((c) => c.id)).size === 2 && chapters.every((c) => c.id.startsWith('ch_'))
)
check('12d content_text 就是清洗后正文', chapters[0].content_text === md.parts[0].body)

/* 13. 预览区微调：合并 / 拆分 */
const merged = mergeParts(md.parts, 1)
check('13a 合并后剩一章且沿用前标题', merged.length === 1 && merged[0].title === md.parts[0].title, echo(merged))
check('13b 合并保留两段正文', merged[0].body.includes('雨从傍晚') && merged[0].body.includes('门后是另一条街'))
check('13c index 0 合并原样返回', mergeParts(md.parts, 0).length === 2)
const long = splitChapters(['第一章 长文', Array.from({ length: 30 }, (_, i) => `第${i}行内容。`).join('\n')].join('\n'))
const split = splitPartAt(long.parts, 0, 10)
check('14a 拆分后变两章', split.length === 2, echo(split))
check('14b 拆出来的后半章带（续）', split[1]?.title.endsWith('（续）') === true, split[1]?.title ?? '')
check(
  '14c 拆分不丢字',
  split[0].chars + split[1].chars === long.parts[0].chars,
  `${split[0].chars}+${split[1].chars} vs ${long.parts[0].chars}`
)

/* 15. 等分兜底 */
const para = '段'.repeat(100)
const even = splitEvenly(Array.from({ length: 6 }, () => para).join('\n\n'), 300)
check('15a 等分出多章', even.length >= 2, echo(even))
check(
  '15b 等分不丢字',
  even.reduce((s, p) => s + p.chars, 0) === 600,
  String(even.reduce((s, p) => s + p.chars, 0))
)

/* 16. 编码嗅探：GBK 的「第一章」= B5 DA D2 BB D5 C2 */
const gbk = decodeTextFile(new Uint8Array([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2]))
check('16a GBK 被识别', gbk.encoding === 'gbk', `${gbk.encoding} / ${gbk.text}`)
check('16b GBK 解出「第一章」', gbk.text.trim() === '第一章', gbk.text)
const utf8 = decodeTextFile(new TextEncoder().encode('第一章 夜'))
check('16c UTF-8 原样通过', utf8.encoding === 'utf-8' && utf8.text === '第一章 夜')

console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 条失败`}`)
process.exit(failed === 0 ? 0 : 1)
