/**
 * P11 离线复验：双语页签错位 + 多话题写入 + 翻译后自动补封面。
 *
 * 背景（2026-10-21）：
 *   ① 翻译完之后，中文页签下显示的却是英文正文；根因是编辑页载入时无条件把
 *      `content_html` 塞进编辑器，而切页签与写正文又是两个互不知情的动作，
 *      异步回调里读到的 `lang` 还是旧值。
 *   ② 话题矩阵是单选。现在 articles.categories 是 text[]，编辑页保存时必须
 *      同时写 category（主话题）与 categories（全部）。
 *   ③ 封面要能手动生成，并在翻译成功且没有封面时自动补一张。
 *
 * 本脚本只做纯函数 + 源码接线断言，不联网、不花额度：
 *   cd Sass && node --import ./scripts/_ts-resolve.mts scripts/p11-editor-bilingual-check.mts
 */
import { readFileSync } from 'node:fs'

import { isMostlyChinese, resolveBilingualDraft } from '../lib/storyPrompt.ts'

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name} ${extra}`)
  }
}

const zhHtml = `<p>${'他在凌晨三点收到自己发来的短信，窗外的雨一直没有停。'.repeat(12)}</p>`
const enHtml = `<p>${'At three in the morning he received a message from himself, and the rain outside never stopped. '.repeat(8)}</p>`

console.log('A. 双语落位（哪份正文属于哪一边）')

const mixed = resolveBilingualDraft({
  titleEn: 'The Message',
  titleZh: '那条短信',
  excerptEn: 'A man receives a message from himself.',
  excerptZh: '一个男人收到了自己发来的短信。',
  htmlEn: enHtml,
  htmlZh: zhHtml,
})
ok('英文稿 + 中文稿 → 停英文页签', mixed.initialLang === 'en')
ok('英文正文不被误判成中文', !isMostlyChinese(mixed.htmlEn))
ok('中文正文留在中文栏', mixed.htmlZh === zhHtml)
ok('两边都正常时不报 recovered', mixed.recovered === false)

const misplaced = resolveBilingualDraft({
  titleEn: '凌晨三点的短信',
  excerptEn: '一个男人收到了自己发来的短信。',
  htmlEn: zhHtml,
  htmlZh: '',
})
ok('content_html 里是中文 → 识别为错列', misplaced.recovered === true)
ok('中文被搬进中文原稿', misplaced.htmlZh === zhHtml)
ok('英文列被清空（前台不能再挂中文）', misplaced.htmlEn === '')
ok('初始页签自动停在中文', misplaced.initialLang === 'zh')
ok('错位的中文标题 / 摘要也被搬走', /短信/.test(misplaced.titleZh) && misplaced.titleEn === '')
ok('错位的中文摘要不被留在英文栏', misplaced.excerptEn === '')

const bothChinese = resolveBilingualDraft({
  titleEn: '中文标题',
  titleZh: '中文标题',
  excerptEn: '',
  excerptZh: '',
  htmlEn: zhHtml,
  htmlZh: zhHtml,
})
ok('两列都是中文 → 英文列清空、保留一份中文', bothChinese.htmlEn === '' && bothChinese.htmlZh === zhHtml)

const englishOnly = resolveBilingualDraft({ titleEn: 'Only English', htmlEn: enHtml })
ok('只有英文 → 停英文', englishOnly.initialLang === 'en' && englishOnly.htmlEn === enHtml)

const titleButChineseBody = resolveBilingualDraft({
  titleEn: 'English Title',
  titleZh: '中文标题',
  htmlEn: '',
  htmlZh: zhHtml,
})
ok('只有英文标题、正文只有中文 → 停中文原稿（不让人对着空正文）', titleButChineseBody.initialLang === 'zh')

const blank = resolveBilingualDraft({})
ok('新建空稿 → 停中文原稿', blank.initialLang === 'zh' && blank.htmlEn === '' && blank.htmlZh === '')

console.log('\nB. 编辑页接线（源码静态断言）')

const source = readFileSync(
  new URL('../app/admin/(protected)/trends/edit/page.tsx', import.meta.url),
  'utf8'
)
ok('载入与保存都走 resolveBilingualDraft', (source.match(/resolveBilingualDraft\(/g) || []).length >= 2)
ok('不再无条件把 content_html 塞进编辑器', !/editor\.commands\.setContent\(data\.content_html/.test(source))
ok('翻译成功用 switchLang 一次切页签 + 正文', /switchLang\('en', enHtml\)/.test(source))
ok('保存同时写 category 与 categories', /categories:\s*savedCategories/.test(source))
ok('多选 toggleCat 会 append，而不是覆盖成单值', /setSelectedCats\(prev => prev\.includes\(cat\)/.test(source))
ok('封面支持手动生成按钮', /runCoverGeneration\(\)/.test(source) && /AI 生成/.test(source))
ok('翻译成功且无封面时自动补一张', /if \(!coverUrlRef\.current\.trim\(\)\)[\s\S]{0,200}runCoverGeneration\(/.test(source))
ok('自动生成不会覆盖已有封面', /if \(opts\?\.auto && coverUrlRef\.current\.trim\(\)\) return/.test(source))
ok('保存会等 AI 封面任务结束', /const pendingCover = coverTaskRef\.current/.test(source))
ok('保存前会拦下「英文列里是中文」', /resolveBilingualDraft\(\{[\s\S]{0,400}htmlEn: enHtmlRef\.current/.test(source))
ok('封面生成会读取最新选中话题，而不是翻译开始时的旧闭包', /selectedCatsRef\.current = selectedCats/.test(source))
ok(
  '封面请求把话题矩阵（主话题在前）传给 /api/ai/draw',
  /categories:\s*topicTags/.test(source) && /selectedCatsRef\.current[\s\S]{0,120}\.slice\(0,\s*5\)/.test(source)
)
ok(
  '封面请求显式带上摘要与正文第一段',
  /excerpt:\s*sourceExcerpt/.test(source) && /opening:\s*openingParagraph/.test(source)
)
ok('翻译后自动补封面会带上刚生成的英文摘要', /excerpt:\s*enExcerpt/.test(source))
ok(
  '载入旧文章时把 category 主话题排在 selectedCats 第一位',
  /const primaryCat = String\(data\.category \|\| ''\)\.trim\(\)/.test(source) && /setSelectedCats\(orderedCats\)/.test(source)
)

const drawSource = readFileSync(new URL('../app/api/ai/draw/route.ts', import.meta.url), 'utf8')
ok(
  'Cloudflare 模型路径不整体 URL 编码（否则 7000 No route）',
  !/ai\/run\/\$\{encodeURIComponent\(cfModel\)\}/.test(drawSource)
)
ok(
  '生成与局部重绘共用 cfRunUrl',
  (drawSource.match(/cfRunUrl\(cfAccountId, cfModel\)/g) || []).length === 2
)
ok(
  '上传按真实图片类型写 MIME / 扩展名',
  /detectImageMeta\(imgBuf, contentType\)/.test(drawSource) && /contentType: imageMeta\.mime/.test(drawSource)
)
ok(
  '封面接口会清洗话题并跳过 Other 兜底标签',
  /normalizeCoverTopics\(body\?\.categories\)/.test(drawSource) && /COVER_TOPIC_SKIP/.test(drawSource)
)
ok('话题数量有上限（避免挤掉故事本身）', /COVER_TOPIC_LIMIT = 5/.test(drawSource))
ok(
  '提示词区分主话题与次话题',
  /primary_topic: \$\{primaryTopic\}/.test(drawSource) && /secondary_topics:/.test(drawSource)
)
ok('提示词明确禁止把话题文字画进图里', /Never render topic words/.test(drawSource))
ok(
  '封面提示词把摘要 / 正文第一段设为首要画面来源',
  /story_summary:/.test(drawSource) &&
    /opening_paragraph:/.test(drawSource) &&
    /Build the image primarily from story_summary and opening_paragraph/.test(drawSource)
)
ok(
  '摘要与第一段会先清洗并限制长度',
  /const excerpt = cleanPromptField\(body\?\.excerpt, 600\)/.test(drawSource) &&
    /const opening = cleanPromptField\(body\?\.opening, 700\)/.test(drawSource)
)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
