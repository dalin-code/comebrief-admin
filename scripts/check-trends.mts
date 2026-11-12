#!/usr/bin/env node
/**
 * 趋势采集自检（**完全离线**）：解析器 / 归一化 / 过滤 / 轮转 / 热词。
 *
 * 这里不发任何网络请求 —— 夹具是三个源的真实响应切片（Google Trends 的 `ht:` 命名空间、
 * Atom 的自闭合 `<link>`、维基的 JSON）。CI 里挂网络只会有两种结果：慢，和红。
 * 「今天这些源还活着吗」是站长点一次「抓趋势」就能知道的事，不该由 CI 猜。
 *
 * 用法：node --import ./scripts/_ts-resolve.mts scripts/check-trends.mts
 */

import { decodeEntities, parseRss, parseTraffic, stripHtml } from '../lib/quizTrends/rss.ts'
import {
  dedupeTrends,
  filterTrends,
  isEnglishText,
  isSensitiveText,
  mergeRoundRobin,
  normalizeGeo,
  normalizeWindow,
  slugTerm,
  sortTrends,
  titleKey,
  trendId,
  windowToMs,
  type TrendItem,
} from '../lib/quizTrends.ts'
import { parseAppleMusic, parseWikipedia, wikipediaDate } from '../lib/quizTrends/sources.ts'
import { buildVocabularyBlock, extractHotWords, SLANG_SEEDS } from '../lib/quizLexicon.ts'

let failed = 0
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` —— ${extra}` : ''}`)
  if (!cond) failed += 1
}

/* ---------------------------------------------------------------- *
 * 夹具
 * ---------------------------------------------------------------- */

const GOOGLE_TRENDS_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:ht="https://trends.google.com/trending/rss">
  <channel>
    <title>Daily Trends</title>
    <item>
      <title><![CDATA[Taylor Swift &amp; Travis Kelce]]></title>
      <link>https://trends.google.com/trends/trendingsearches/daily?geo=US&amp;q=taylor</link>
      <description><![CDATA[<b>Taylor Swift</b> and Travis Kelce spotted again]]></description>
      <pubDate>Mon, 09 Nov 2026 10:00:00 GMT</pubDate>
      <ht:approx_traffic>200+</ht:approx_traffic>
      <ht:news_item_title>Fans react to the sighting</ht:news_item_title>
    </item>
    <item>
      <title>brat summer</title>
      <link>https://trends.google.com/x</link>
      <pubDate>Mon, 09 Nov 2026 09:00:00 GMT</pubDate>
      <ht:approx_traffic>50,000+</ht:approx_traffic>
    </item>
  </channel>
</rss>`

const ATOM_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>popular</title>
  <entry>
    <title>The group chat that broke the internet</title>
    <link rel="alternate" href="https://www.reddit.com/r/popular/comments/abc" />
    <updated>2026-11-09T09:00:00Z</updated>
    <summary>A thread about delulu fans</summary>
  </entry>
  <entry>
    <title>Nobody asked but here is my ranking</title>
    <link href="https://www.reddit.com/r/popular/comments/def" />
    <published>2026-11-09T08:00:00Z</published>
  </entry>
</feed>`

const WIKI_JSON = JSON.stringify({
  items: [
    {
      articles: [
        { article: 'Main_Page', views: 900000, rank: 1 },
        { article: 'Special:Search', views: 500000, rank: 2 },
        { article: 'KPop_Demon_Hunters', views: 123456, rank: 3 },
        { article: 'Taylor_Swift', views: 98765, rank: 4 },
        { article: 'Wikipedia:About', views: 100, rank: 5 },
      ],
    },
  ],
})

const APPLE_JSON = JSON.stringify({
  feed: {
    results: [
      { name: 'The Fate of Ophelia', artistName: 'Taylor Swift', url: 'https://music.apple.com/x' },
      { name: 'Golden', artistName: 'HUNTR/X', url: 'https://music.apple.com/y' },
    ],
  },
})

const ts = (offsetMs = 0) => new Date(Date.now() - offsetMs).toISOString()

const item = (over: Partial<TrendItem> = {}): TrendItem => ({
  id: trendId(over.source ?? 'reddit', over.title ?? 'x'),
  title: 'x',
  source: 'reddit',
  ...over,
})

/* ---------------------------------------------------------------- *
 * 1. RSS / Atom 解析
 * ---------------------------------------------------------------- */

check('1a 实体解码', decodeEntities('Taylor &amp; Travis &#39;92 &#x2019;') === "Taylor & Travis '92 ’")
check('1b 去标签 + 去 CDATA', stripHtml('<![CDATA[<b>Hi</b> there]]>') === 'Hi there')

const gtItems = parseRss(GOOGLE_TRENDS_RSS, 10, ['ht:approx_traffic', 'ht:news_item_title'])
check('1c RSS 2.0 条目数', gtItems.length === 2, String(gtItems.length))
check('1d CDATA + 实体', gtItems[0].title === 'Taylor Swift & Travis Kelce', gtItems[0].title)
check('1e 链接里的 &amp; 被解开', (gtItems[0].link || '').includes('&q=taylor'), gtItems[0].link)
check('1f description 去标签', gtItems[0].description === 'Taylor Swift and Travis Kelce spotted again', gtItems[0].description)
check('1g ht: 命名空间字段能读', gtItems[0].extra['ht:approx_traffic'] === '200+', JSON.stringify(gtItems[0].extra))
check('1h pubDate 原样保留', (gtItems[1].publishedAt || '').startsWith('Mon, 09 Nov 2026'))

check('1i 搜索量：200+ → 200', parseTraffic('200+') === 200)
check('1j 搜索量：50,000+ → 50000', parseTraffic('50,000+') === 50000)
check('1k 搜索量：5K → 5000', parseTraffic('5K') === 5000)
check('1l 搜索量：认不出 → 0', parseTraffic('—') === 0)

const atomItems = parseRss(ATOM_FEED, 10)
check('1m Atom <entry> 能解析', atomItems.length === 2, String(atomItems.length))
check('1n 自闭合 <link href> 能读', atomItems[0].link === 'https://www.reddit.com/r/popular/comments/abc', atomItems[0].link)
check('1o <updated> 当日期', (atomItems[0].publishedAt || '').startsWith('2026-11-09'))
check('1p <summary> 当描述', atomItems[0].description === 'A thread about delulu fans')
check('1q 第二段没有 summary 也不报错', atomItems[1].description === undefined)

check('1r 空输入 → 空数组（不抛异常）', parseRss('').length === 0)
check('1s 一页 HTML → 空数组', parseRss('<html><body>403 Forbidden</body></html>').length === 0)

/* ---------------------------------------------------------------- *
 * 2. JSON 源
 * ---------------------------------------------------------------- */

const wikiItems = parseWikipedia(WIKI_JSON, 'US')
check(
  '2a 维基跳过 Main_Page / Special: / Wikipedia:',
  wikiItems.length === 2,
  wikiItems.map((i) => i.title).join(',')
)
check('2b 下划线换成空格', wikiItems[0].title === 'KPop Demon Hunters', wikiItems[0].title)
check('2c 浏览量进 score', wikiItems[0].score === 123456)
check('2d 链接指回维基', (wikiItems[0].url || '').includes('en.wikipedia.org/wiki/KPop_Demon_Hunters'))

const appleItems = parseAppleMusic(APPLE_JSON, 'GB')
check('2e Apple Music 歌名 + 艺人', appleItems[0].title === 'The Fate of Ophelia — Taylor Swift', appleItems[0].title)
check('2f 排名越前分越高', (appleItems[0].score ?? 0) > (appleItems[1].score ?? 0))

const wd = wikipediaDate(new Date('2026-11-09T03:00:00Z'))
check('2g 维基取「昨天」的 UTC 日期', wd.year === '2026' && wd.month === '11' && wd.day === '08', JSON.stringify(wd))
const wd3 = wikipediaDate(new Date('2026-11-09T03:00:00Z'), 3)
check('2h 维基可回看（-3 天）', wd3.month === '11' && wd3.day === '06', JSON.stringify(wd3))

const wikiMany = parseWikipedia(
  JSON.stringify({
    items: [
      {
        articles: [
          { article: '.xxx', views: 999999, rank: 1 },
          { article: 'Brat_summer', views: 5000, rank: 2 },
        ],
      },
    ],
  }),
  'US'
)
check('2i 维基跳过 TLD 条目（.xxx）', wikiMany.length === 1 && wikiMany[0].title === 'Brat summer', JSON.stringify(wikiMany.map((i) => i.title)))

/* ---------------------------------------------------------------- *
 * 3. 归一化 / 去重 / 轮转
 * ---------------------------------------------------------------- */

check('3a geo 默认 US', normalizeGeo('nope') === 'US')
check('3b geo 大小写不敏感', normalizeGeo('gb') === 'GB')
check('3c window 默认 24h', normalizeWindow('') === '24h')
check('3d windowToMs', windowToMs('7d') === 7 * 24 * 60 * 60 * 1000)
check('3e slugTerm 去掉符号', slugTerm('Taylor Swift & Travis Kelce!') === 'taylor-swift-travis-kelce')
check('3f 同一标题在不同源里 id 不同', trendId('reddit', 'Same') !== trendId('wikipedia', 'Same'))
check('3g titleKey 去冠词与括号后缀', titleKey('The Bear (TV series)') === 'bear')

const dupes = dedupeTrends([
  item({ title: 'Brat summer', source: 'buzzfeed' }),
  item({ title: 'The brat summer', source: 'reddit', score: 900, url: 'https://x.test/1' }),
  item({ title: 'Golden', source: 'apple-music', score: 30 }),
])
check('3h 去重后剩 2 条', dupes.length === 2, String(dupes.length))
check(
  '3i 留信息更多的那条（有分数 + 链接）',
  (dupes.find((d) => d.title.includes('brat'))?.score ?? 0) === 900,
  JSON.stringify(dupes.map((d) => d.title))
)

const groups = [
  { source: 'google-trends' as const, items: Array.from({ length: 20 }, (_, i) => item({ title: `gt-${i}`, source: 'google-trends' })) },
  { source: 'reddit' as const, items: Array.from({ length: 20 }, (_, i) => item({ title: `rd-${i}`, source: 'reddit' })) },
  { source: 'buzzfeed' as const, items: Array.from({ length: 20 }, (_, i) => item({ title: `bf-${i}`, source: 'buzzfeed' })) },
]
const merged = mergeRoundRobin(groups, 30)
const counts = merged.reduce<Record<string, number>>((acc, entry) => {
  acc[entry.source] = (acc[entry.source] || 0) + 1
  return acc
}, {})
check('3j 轮转合并到上限 30 条', merged.length === 30, String(merged.length))
check(
  '3k 单个源占比 ≤ 50%（不会整页都是搜索词）',
  Object.values(counts).every((count) => count / merged.length <= 0.5),
  JSON.stringify(counts)
)
check('3l 顺序是轮流（前三条来自三个源）', new Set(merged.slice(0, 3).map((m) => m.source)).size === 3)

const sorted = sortTrends([item({ title: 'b', score: 10 }), item({ title: 'a', score: 999 }), item({ title: 'c' })])
check('3m 分数高的在前', sorted[0].title === 'a' && sorted[2].title === 'c', sorted.map((s) => s.title).join(','))

/* ---------------------------------------------------------------- *
 * 4. 过滤
 * ---------------------------------------------------------------- */

check('4a 政治词命中', isSensitiveText('Election results are in'))
check('4b 灾难词命中', isSensitiveText('Wildfire forces evacuations'))
check('4c 娱乐新闻不误伤', !isSensitiveText('Taylor Swift announces a new album'))
check('4d 中文标题不算英文', !isEnglishText('泰勒·斯威夫特发布新专辑'))
check('4e 正常英文标题算英文', isEnglishText('Brat summer is back'))
// 实测漏网（2026-11-09 真实抓取）：impeachment 全词、德语标题、讣告页
check('4h impeachment / Democrat 命中', isSensitiveText('Top House Democrat says he is a hard yes on impeachment'))
check('4i 德语标题不算英文', !isEnglishText('Polizei ermittelt nach Unfall in Marzahn'))
check('4j 2–3 词的全小写查询仍然放行（Google Trends）', isEnglishText('zach lavine'))
check('4k 没有虚词的正常英文标题不再被误杀', isEnglishText('Squid Game season 3 first look'))
check('4l «Deaths in 2026» 这类维基条目被拦', isSensitiveText('Deaths in 2026'))
check('4m 带变音符号的德语长标题不算英文', !isEnglishText('Was bitte ist da in meinem Gästebad gewachsen?'))
// 实测第二次漏网（同一天，Reddit r/popular）：整条德语新闻句 + 「标题就是子版名」
check(
  '4n 德语长句不算英文',
  !isEnglishText(
    'In einem unbewohnten Haus Leiche von 13-jähriger Lisa Ta aus Marzahn in Brandenburg gefunden'
  )
)
check('4o 子版名条目（ich_iel）被丢掉', !isEnglishText('ich_iel'))
check('4p 带 the/is 的英文标题不误伤', isEnglishText('La La Land cast reunion is officially happening'))
check('4q 正常英文娱乐新闻仍然过', isEnglishText('Taylor Swift and Travis Kelce spotted in New York'))
check('4r 西语标题不算英文', !isEnglishText('La policía encuentra el cuerpo de una mujer en su casa'))

const filtered = filterTrends(
  [
    item({ title: 'Taylor Swift announces a new album', publishedAt: ts(60_000) }),
    item({ title: 'Mass shooting reported downtown', publishedAt: ts(60_000) }),
    item({ title: '老友记重聚特辑', publishedAt: ts(60_000) }),
    item({ title: 'Old news from last month', publishedAt: ts(40 * 24 * 60 * 60 * 1000) }),
    item({ title: 'No date at all' }),
  ],
  '24h'
)
check('4f 只留下 2 条（娱乐 + 无日期）', filtered.items.length === 2, JSON.stringify(filtered.items.map((i) => i.title)))
check('4g 过滤条数被计数（不静默）', filtered.filtered === 3, String(filtered.filtered))

/* ---------------------------------------------------------------- *
 * 5. 热词
 * ---------------------------------------------------------------- */

check('5a 俚语词表规模 ≥ 100', SLANG_SEEDS.length >= 100, String(SLANG_SEEDS.length))

const trendItems: TrendItem[] = [
  item({ title: 'Taylor Swift announces a new album', source: 'google-trends', score: 200000 }),
  item({ title: 'Taylor Swift spotted with Travis Kelce', source: 'wikipedia', score: 98765 }),
  item({ title: 'brat summer returns as Charli XCX teases new single', source: 'reddit' }),
  item({ title: 'delulu fans are coping in the replies', source: 'reddit' }),
  item({ title: 'Why everyone is saying brat summer again', source: 'buzzfeed' }),
]
const hot = extractHotWords(trendItems, { limit: 40 })
const find = (term: string) => hot.find((word) => word.term.toLowerCase() === term.toLowerCase())

const taylor = find('Taylor Swift')
check('5b 实体能抽出来', Boolean(taylor), hot.slice(0, 6).map((h) => h.term).join(' | '))
check('5c 实体跨源计数', (taylor?.sources.length ?? 0) >= 2, JSON.stringify(taylor?.sources))
check('5d 跨源实体的分高于单源', (taylor?.score ?? 0) > (find('Charli')?.score ?? 0))

const brat = find('brat summer')
check('5e 俚语能抽出来', brat?.kind === 'slang', JSON.stringify(brat))
check('5f 俚语词组在多条标题里累计', (brat?.count ?? 0) >= 2, String(brat?.count))

check('5g 只出现一次的 n-gram 不当热词', !hot.some((word) => word.term === 'new album' && word.kind === 'phrase'))

const pinnedHot = extractHotWords(trendItems, { pinned: ['Squid Game'] })
check('5h 钉住的词一定在结果里且排第一', pinnedHot[0].term === 'Squid Game' && pinnedHot[0].score >= 1000, pinnedHot[0].term)

/* 5x. 查询型源：全小写标题也要能抽出来，且不重复计数 */
const queryHot = extractHotWords([
  item({ title: 'zach lavine', source: 'google-trends' }),
  item({ title: 'Jon Ossoff', source: 'wikipedia' }),
])
check(
  '5k Google Trends 的全小写查询整条成为热词',
  queryHot.some((word) => word.term === 'zach lavine' && word.count === 1),
  JSON.stringify(queryHot.map((w) => `${w.term}x${w.count}`))
)
check(
  '5l 维基的人名不会因为「大写规则 + 整条收录」被记两次',
  queryHot.filter((word) => word.term === 'Jon Ossoff').every((word) => word.count === 1),
  JSON.stringify(queryHot.filter((w) => w.term === 'Jon Ossoff').map((w) => w.count))
)

const vocabulary = buildVocabularyBlock(hot, 10)
check('5i 词汇表分三块', vocabulary.includes('ENTITIES') && vocabulary.includes('SLANG'), vocabulary.slice(0, 40))
check('5j 词汇表带上来源标注', /Taylor Swift \(/.test(vocabulary))

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
