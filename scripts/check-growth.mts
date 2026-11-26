#!/usr/bin/env node
/**
 * 增长与运营中台的自检（**完全离线**）。
 *
 * 为什么需要这一层：`lib/growth.ts` 里全是不联网的纯逻辑，而它同时被
 * 三个后台页面、AI 提示词、单条索引推送使用 —— 出错的方式都很安静：
 *   · slugify 和前台 `ComeBrief/lib/slug.ts` 分叉 → 后台配置的
 *     `/quizzes/topic/pop-culture` 指不到真实话题页，页面标题永远是旧的；
 *   · UTM 拼接把 `?ref=` 丢了 → 渠道报表看起来「自然流量暴涨」；
 *   · 长度上限写成 `>=` → 60 字符的标题在 SERP 上被截成半句；
 *   · `{url}` 占位符被截断 → 社媒文案里印出 `{ur`；
 *   · 与 `52_growth_seo_geo.sql` 的默认模板不一致 → 站长看到的「默认文案」
 *     和数据库里的不是同一份。
 * 这些都不会让 typecheck 变红（全是 string 与 number），只能靠断言钉住。
 *
 * 用法：node --import ./scripts/_ts-resolve.mts scripts/check-growth.mts
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  GROWTH_DEFAULT_TEMPLATES,
  GROWTH_DEFAULTS_FALLBACK,
  GROWTH_HUB_PAGES,
  GROWTH_LIMITS,
  GROWTH_PAGE_PRESETS,
  GROWTH_TOPIC_PAGES,
  SOCIAL_COPY_KEYS,
  SOCIAL_COPY_LIMITS,
  SOCIAL_PLATFORMS,
  buildUtmUrl,
  clampGrowthFields,
  contentPathFor,
  countWords,
  growthFieldIssues,
  growthPayload,
  growthReadiness,
  measureLength,
  missingGrowthColumnFromError,
  normalizeGrowthDefaults,
  normalizeGrowthFields,
  normalizePagePath,
  normalizeSocialCopies,
  normalizeTargetEntities,
  normalizeTopicConfig,
  pageReadiness,
  parseFaqList,
  renderTemplate,
  slugifyText,
  topicPagePath,
  type GrowthContentFields,
} from '../lib/growth.ts'
import { QUIZ_TOPICS } from '../lib/quizKit.ts'
import {
  buildGrowthSystemPrompt,
  buildGrowthUserPrompt,
  normalizeGrowthAiResult,
  normalizeGrowthTasks,
} from '../lib/growthAi.ts'
import { isSameSiteUrl, toAbsoluteSiteUrl } from '../lib/indexPush.ts'

let failed = 0
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` —— ${extra}` : ''}`)
  if (!cond) failed += 1
}

const section = (title: string) => console.log(`\n— ${title} —`)

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** 一段「都填满了」的内容字段，用于就绪度与体检的正向用例。 */
const FULL_FIELDS: GrowthContentFields = {
  seo_title: 'Free Career Quiz: Instant Results, No Sign-Up | ComeBrief',
  seo_description:
    'Answer eight quick questions and get a work-style read in under a minute. No sign-up, no email, results shown instantly on the page.',
  target_entities: ['Career', 'Holland Codes', 'Job Satisfaction', 'ComeBrief'],
  ai_tldr_summary:
    'A free eight-question quiz that maps work preferences to one of four career archetypes. Results are shown instantly without an account, and the page explains how each archetype tends to behave in day-to-day work. The quiz takes about a minute and is intended for people weighing a job change rather than for clinical assessment.',
  geo_faq_list: [
    { question: 'How long does the quiz take?', answer: 'About one minute: eight questions, one answer each.' },
    { question: 'Do I need an account?', answer: 'No. Results appear as soon as the last question is answered.' },
    { question: 'Is this a clinical assessment?', answer: 'No. It is a light read of work preferences, not a diagnosis.' },
  ],
  social_copies: {
    reddit_title: 'I built a one-minute career quiz with no sign-up',
    reddit_body: 'Made this and thought this crowd might enjoy it: {url} — curious what you get.',
  },
  is_noindex: false,
}

/* ------------------------------------------------------------------ *
 * 1. slug / 路径
 * ------------------------------------------------------------------ */

section('slug 与路径')
const slugCases: Array<[string, string, string]> = [
  ['1a 空格转连字符', 'Pop Culture', 'pop-culture'],
  ['1b 引号先删掉（whats，不是 what-s）', "What's Your Type?", 'whats-your-type'],
  ['1c & 折成连字符', 'Career & Workstyle', 'career-workstyle'],
  ['1d 斜杠与多余空白', '  MBTI / Archetypes  ', 'mbti-archetypes'],
  ['1e 连续符号合并', '--a--b--', 'a-b'],
  ['1f 全中文没有可用字符', '职业测验', ''],
  ['1g 空串', '', ''],
]
for (const [name, input, expected] of slugCases) {
  const actual = slugifyText(input)
  check(name, actual === expected, `in=${JSON.stringify(input)} out=${JSON.stringify(actual)}`)
}

const pathCases: Array<[string, unknown, string]> = [
  ['2a 去掉尾斜杠', '/quizzes/', '/quizzes'],
  ['2b 补上前导斜杠', 'quizzes/topic/career', '/quizzes/topic/career'],
  ['2c 完整 URL 只取路径', 'https://comebrief.com/quizzes/?x=1#top', '/quizzes'],
  ['2d 首页就是 /', '/', '/'],
  ['2e 空白是「没给」不是首页', '   ', ''],
  ['2f 合并连续斜杠', '//a//b/', '/a/b'],
  ['2g 统一小写（本站路由全小写）', '/Quizzes/Topic/Career', '/quizzes/topic/career'],
]
for (const [name, input, expected] of pathCases) {
  const actual = normalizePagePath(input)
  check(name, actual === expected, `in=${JSON.stringify(input)} out=${JSON.stringify(actual)}`)
}

check(
  '2h 话题页路径',
  topicPagePath('Pop Culture') === '/quizzes/topic/pop-culture',
  topicPagePath('Pop Culture')
)
check('2i 无可用字符的话题不拼伪地址', topicPagePath('职业') === '')

/* ------------------------------------------------------------------ *
 * 2. 预置页与内容路径
 * ------------------------------------------------------------------ */

section('页面预置与内容路径')
check('3a 四个 hub', GROWTH_HUB_PAGES.length === 4, String(GROWTH_HUB_PAGES.length))
check(
  '3b 分类页与 QUIZ_TOPICS 同源',
  GROWTH_TOPIC_PAGES.length === QUIZ_TOPICS.length,
  `${GROWTH_TOPIC_PAGES.length} vs ${QUIZ_TOPICS.length}`
)
check(
  '3c 每个分类页路径都由 slug 拼出',
  GROWTH_TOPIC_PAGES.every((page, i) => page.path === `/quizzes/topic/${QUIZ_TOPICS[i].slug}`)
)
const allPaths = GROWTH_PAGE_PRESETS.map((page) => page.path)
check('3d 路径不重复', new Set(allPaths).size === allPaths.length)
check(
  '3e 每条都以 / 开头且无尾斜杠（首页除外）',
  allPaths.every((path) => path.startsWith('/') && (path === '/' || !path.endsWith('/')))
)
check(
  '3f category_type 都在 CHECK 允许值内',
  GROWTH_PAGE_PRESETS.every((page) => ['quiz', 'story', 'brief', 'general'].includes(page.category_type))
)
check('3g 预置路径都是归一化后的形状', allPaths.every((path) => normalizePagePath(path) === path))

check('4a quizzes 路径', contentPathFor('quizzes', 'career-test') === '/quizzes/career-test')
check('4b stories 路径', contentPathFor('stories', 'abc') === '/stories/abc')
check('4c articles 走 /briefs', contentPathFor('articles', 'abc') === '/briefs/abc')
check('4d 空 slug 不拼', contentPathFor('quizzes', '  ') === '')

/* ------------------------------------------------------------------ *
 * 3. UTM
 * ------------------------------------------------------------------ */

section('UTM')
const utm = buildUtmUrl('https://comebrief.com/quizzes/career-test', {
  source: 'reddit',
  medium: 'social',
  campaign: 'organic',
  content: 'career-test',
})
const utmUrl = new URL(utm || 'https://invalid.local')
check('5a 四个参数都带上', ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'].every((k) => !!utmUrl.searchParams.get(k)), utm)
check('5b utm_source 用平台名', utmUrl.searchParams.get('utm_source') === 'reddit')

const kept = buildUtmUrl('https://comebrief.com/quizzes/x?ref=newsletter&utm_source=old', {
  source: 'x',
})
const keptUrl = new URL(kept || 'https://invalid.local')
check('5c 保留已有参数', keptUrl.searchParams.get('ref') === 'newsletter', kept)
check('5d 同名 utm 被覆盖而不是追加', keptUrl.searchParams.get('utm_source') === 'x')

const emptyUtm = buildUtmUrl('https://comebrief.com/quizzes/x?utm_source=manual', { source: '' })
check(
  '5e 空值不动原有 utm',
  new URL(emptyUtm || 'https://invalid.local').searchParams.get('utm_source') === 'manual'
)
check('5f 非法地址返回空串', buildUtmUrl('not a url', { source: 'x' }) === '')
check('5g 非 http(s) 协议拒绝', buildUtmUrl('javascript:alert(1)', { source: 'x' }) === '')

/* ------------------------------------------------------------------ *
 * 4. 归一化
 * ------------------------------------------------------------------ */

section('归一化')
const faqSix = parseFaqList([
  { question: 'Q1?', answer: 'A1' },
  { question: 'Q2?', answer: 'A2' },
  { question: 'Q3?', answer: 'A3' },
  { question: 'Q4?', answer: 'A4' },
  { question: 'Q5?', answer: 'A5' },
  { question: 'Q6?', answer: 'A6' },
])
check('6a 问答最多 5 组', faqSix.length === 5, String(faqSix.length))
check(
  '6b 同一问题换语序只留一条',
  parseFaqList([
    { question: 'How long does it take?', answer: 'A' },
    { question: 'how long does it take', answer: 'B' },
  ]).length === 1
)
check('6c 缺答案整条丢掉', parseFaqList([{ question: 'Q?' }, { question: 'Q2?', answer: 'ok' }]).length === 1)
check(
  '6d 问句自动补问号',
  parseFaqList([{ question: 'Is it free', answer: 'Yes' }])[0]?.question === 'Is it free?'
)
check(
  '6e 兼容 q/a 与 JSON 字符串',
  parseFaqList('[{"q":"Q?","a":"A"}]')[0]?.answer === 'A'
)
check('6f 空值就是空数组', parseFaqList(null).length === 0)

check(
  '7a 实体接受 CSV 并去重',
  sameJson(normalizeTargetEntities('Career, career ,Holland Codes'), ['Career', 'Holland Codes']),
  JSON.stringify(normalizeTargetEntities('Career, career ,Holland Codes'))
)
check('7b 去掉行首 #', normalizeTargetEntities(['#MBTI'])[0] === 'MBTI')
check('7c 实体最多 8 个', normalizeTargetEntities(Array.from({ length: 12 }, (_, i) => `E${i}`)).length === 8)
check(
  '7d 单个实体最长 40',
  normalizeTargetEntities(['x'.repeat(80)])[0].length === GROWTH_LIMITS.targetEntities.itemMax
)

const copies = normalizeSocialCopies({ ...FULL_FIELDS.social_copies, bogus_key: 'x', tiktok_caption: 123 })
check('8a 只留已知键', Object.keys(copies).every((k) => (SOCIAL_COPY_KEYS as string[]).includes(k)), JSON.stringify(copies))
check('8b 非字符串值丢掉', !('tiktok_caption' in copies))

check(
  '9a 占位符被替换',
  renderTemplate('Took {title} — {url}', { title: 'Quiz', url: 'https://x.y/z' }) ===
    'Took Quiz — https://x.y/z'
)
check('9b 变量为空时保留占位符', renderTemplate('See {url}', {}) === 'See {url}')
check('9c 未知占位符不动', renderTemplate('{foo}', { foo: 'x' }) === '{foo}')

/* ------------------------------------------------------------------ *
 * 5. 默认值
 * ------------------------------------------------------------------ */

section('全局默认值')
const defaults = normalizeGrowthDefaults(null)
check('10a 空值回落出厂值', defaults.brand_suffix === 'ComeBrief' && sameJson(defaults.templates, GROWTH_DEFAULT_TEMPLATES))
check('10b auto_index_on_save 缺字段时为 true', defaults.auto_index_on_save === true)
check(
  '10c 只改一个字段时模板不被打回出厂值',
  normalizeGrowthDefaults({ utm_campaign: 'launch' }).templates.tiktok_caption ===
    GROWTH_DEFAULT_TEMPLATES.tiktok_caption
)
const partialTemplates = normalizeGrowthDefaults({ templates: { x_post_copy: 'Hello {url}' } })
check('10d 模板逐键合并', partialTemplates.templates.x_post_copy === 'Hello {url}')
check('10e 显式 false 才关掉自动推送', normalizeGrowthDefaults({ auto_index_on_save: false }).auto_index_on_save === false)
check('10f 脏值不炸（数组当对象）', normalizeGrowthDefaults([1, 2]).utm_medium === GROWTH_DEFAULTS_FALLBACK.utm_medium)

/* ------------------------------------------------------------------ *
 * 6. 长度 / 体检 / 就绪度
 * ------------------------------------------------------------------ */

section('长度与就绪度')
const titleMax = GROWTH_LIMITS.seoTitle.max
check('11a 恰好上限是 ok', measureLength('x'.repeat(titleMax), GROWTH_LIMITS.seoTitle).state === 'ok')
check('11b 超一个字符就 long', measureLength('x'.repeat(titleMax + 1), GROWTH_LIMITS.seoTitle).state === 'long')
check('11c 太短是 short', measureLength('short', GROWTH_LIMITS.seoTitle).state === 'short')
check('11d 空是 empty', measureLength('   ', GROWTH_LIMITS.seoTitle).state === 'empty')

const EMPTY_FIELDS = normalizeGrowthFields({})
const emptyReadiness = growthReadiness(EMPTY_FIELDS)
check('12a 空内容 0/6', emptyReadiness.filled === 0 && emptyReadiness.total === 6, JSON.stringify(emptyReadiness))
check('12b 空内容 level=empty', emptyReadiness.level === 'empty')
check('12c 空内容列全所有缺项', emptyReadiness.missing.length === 6)
const fullReadiness = growthReadiness(FULL_FIELDS)
check('12d 全填满 6/6', fullReadiness.level === 'ready' && fullReadiness.percent === 100, JSON.stringify(fullReadiness))

const emptyPage = pageReadiness(normalizeTopicConfig({ slug: '/quizzes', page_name: 'Quizzes', category_type: 'quiz' }))
check('12e 页面配置空 0/5', emptyPage.filled === 0 && emptyPage.total === 5, JSON.stringify(emptyPage))

check('13a 空内容没有 error（不挡保存）', growthFieldIssues(EMPTY_FIELDS).filter((i) => i.level === 'error').length === 0)
check(
  '13b 标题超长是 error',
  growthFieldIssues({ ...FULL_FIELDS, seo_title: 'x'.repeat(titleMax + 5) }).some(
    (i) => i.field === 'seo_title' && i.level === 'error'
  )
)
check(
  '13c 推文超 280 是 error',
  growthFieldIssues({ ...FULL_FIELDS, social_copies: { x_post_copy: 'a'.repeat(300) } }).some(
    (i) => i.field === 'x_post_copy' && i.level === 'error'
  )
)
check('13d 全填满没有 error', growthFieldIssues(FULL_FIELDS).filter((i) => i.level === 'error').length === 0)

/* ------------------------------------------------------------------ *
 * 7. 硬切 / 存库 / 缺列
 * ------------------------------------------------------------------ */

section('硬切与存库')
const clampedTitle = clampGrowthFields({ ...FULL_FIELDS, seo_title: 'word '.repeat(30) }).seo_title
check('14a 标题被切到上限内', clampedTitle.length <= titleMax, `${clampedTitle.length}`)
check('14b 切在词边界（不以空格结尾）', clampedTitle === clampedTitle.trim() && /[a-z]$/i.test(clampedTitle))
check(
  '14c 问答切到 5 组',
  clampGrowthFields({
    ...FULL_FIELDS,
    geo_faq_list: Array.from({ length: 8 }, (_, i) => ({
      question: `Distinct question ${i}?`,
      answer: `Answer ${i}.`,
    })),
  }).geo_faq_list.length === 5,
  String(
    clampGrowthFields({
      ...FULL_FIELDS,
      geo_faq_list: Array.from({ length: 8 }, (_, i) => ({
        question: `Distinct question ${i}?`,
        answer: `Answer ${i}.`,
      })),
    }).geo_faq_list.length
  )
)
const longCopy = clampGrowthFields({
  ...FULL_FIELDS,
  social_copies: { x_post_copy: `{url} ${'y'.repeat(400)}` },
}).social_copies.x_post_copy || ''
check('14d 占位符不会被切坏', longCopy.includes('{url}'), longCopy.slice(0, 12))
check('14e 带占位符的文案有额外余量', longCopy.length > SOCIAL_COPY_LIMITS.x_post_copy)

const payload = growthPayload({ seo_title: 'x', is_noindex: true })
check('15a payload 只带给出的键', sameJson(Object.keys(payload).sort(), ['is_noindex', 'seo_title']), JSON.stringify(payload))
check('15b payload 丢掉 undefined', !('seo_description' in growthPayload({ seo_description: undefined })))

check(
  '16a 认出 PostgREST 缺列',
  missingGrowthColumnFromError(
    "Could not find the 'seo_title' column of 'quizzes' in the schema cache"
  ) === 'seo_title'
)
check('16b PGRST204 也认', missingGrowthColumnFromError('PGRST204: social_copies') === 'social_copies')
check('16c 别的错不误判', missingGrowthColumnFromError('duplicate key value violates unique constraint') === '')

/* ------------------------------------------------------------------ *
 * 8. 单条索引推送的地址判定
 * ------------------------------------------------------------------ */

section('单条推送地址')
check(
  '17a 站内路径补成绝对地址',
  toAbsoluteSiteUrl('/quizzes/career-test', 'https://comebrief.com') === 'https://comebrief.com/quizzes/career-test',
  toAbsoluteSiteUrl('/quizzes/career-test', 'https://comebrief.com')
)
check(
  '17b 脏 origin 也能归一',
  toAbsoluteSiteUrl('/x', '[https://www.comebrief.com] (https://www.comebrief.com)') ===
    'https://www.comebrief.com/x',
  toAbsoluteSiteUrl('/x', '[https://www.comebrief.com] (https://www.comebrief.com)')
)
check('17c 协议相对地址拒绝', toAbsoluteSiteUrl('//evil.com/x') === '')
check('17d javascript: 拒绝', toAbsoluteSiteUrl('javascript:alert(1)') === '')
check('17e 没有协议的裸域拒绝', toAbsoluteSiteUrl('comebrief.com/x') === '')
check('17f 同域认得出', isSameSiteUrl('https://comebrief.com/quizzes/x', 'https://comebrief.com'))
check('17g 预览域名（www）不算同域', !isSameSiteUrl('https://www.comebrief.com/x', 'https://comebrief.com'))
check('17h 托管域名不算同域', !isSameSiteUrl('https://evil.com/x', 'https://comebrief.com'))

/* ------------------------------------------------------------------ *
 * 9. 提示词（只断言「该说的说了、不该说的没说」）
 * ------------------------------------------------------------------ */

section('提示词')
const userPrompt = buildGrowthUserPrompt(
  {
    scope: 'content',
    title: 'Career Quiz',
    category: 'Career',
    summary: 'A one-minute quiz.',
    body: 'Eight questions, four archetypes.',
    url: 'https://comebrief.com/quizzes/career-test',
  },
  normalizeGrowthTasks([])
)
const promptKeys = ['seo_title', 'seo_description', 'ai_tldr_summary', 'geo_faq_list', 'target_entities', 'social_copies']
check('18a 五个任务都写进 schema', promptKeys.every((key) => userPrompt.includes(key)))
const platformKeys = SOCIAL_PLATFORMS.flatMap((p) => p.fields.map((f) => f.key))
check('18b 六个社媒键逐个列了预算', platformKeys.every((key) => userPrompt.includes(key)), platformKeys.join(','))
check('18c 带上了硬长度', userPrompt.includes(`${GROWTH_LIMITS.seoDescription.max} characters`))
check('18d 带上了 TL;DR 词数', userPrompt.includes(`${GROWTH_LIMITS.tldr.minWords}-${GROWTH_LIMITS.tldr.maxWords} words`))
check('18e 带上了平台上限', userPrompt.includes(`hard limit ${SOCIAL_COPY_LIMITS.x_post_copy}`))
check('18f 带上正文事实', userPrompt.includes('Eight questions, four archetypes.'))
check('18g 提到品牌后缀', userPrompt.includes('| ComeBrief'))

const seoOnly = buildGrowthUserPrompt({ scope: 'page', title: 'Quizzes' }, ['seo'])
check('19a 只要 seo 时不多要别的', !seoOnly.includes('geo_faq_list') && !seoOnly.includes('social_copies'))
check('19b 列表页口径不同', seoOnly.includes('listing / hub page'))

const systemPrompt = buildGrowthSystemPrompt()
check('20a 第一条就是不许编事实', /1\. Never invent facts/.test(systemPrompt))
check('20b 明确禁止编链接', systemPrompt.includes('{url}'))
check('20c 明确只输出 JSON', systemPrompt.includes('Output JSON only'))

const tldrWords = countWords('One two three four.')
check('21a 英文按空格数词', tldrWords === 4, String(tldrWords))
check('21b 中文按字折算', countWords('你好世界') === 4)

/* ------------------------------------------------------------------ *
 * 10. AI 输出归一化
 * ------------------------------------------------------------------ */

section('AI 输出归一化')
check('22a tasks 空 = 全要', normalizeGrowthTasks([]).length === 5)
check('22b 去掉未知任务', sameJson(normalizeGrowthTasks(['seo', 'bogus']), ['seo']))
check('22c 大小写不敏感', sameJson(normalizeGrowthTasks(['FAQ']), ['faq']))
check('22d 全是未知 = 全要（不静默什么都不生成）', normalizeGrowthTasks(['nope']).length === 5)

const wrapped = normalizeGrowthAiResult({ result: { seo_title: 'Career Quiz for Busy People | ComeBrief' } }, ['seo'])
check('23a 认得 {result:…} 包装', wrapped.fields.seo_title === 'Career Quiz for Busy People | ComeBrief')

const fixedArticle = normalizeGrowthAiResult({ seo_title: 'a hour long career test' }, ['seo'])
check('23b a/an 在归一化时修掉', fixedArticle.fields.seo_title === 'an hour long career test', fixedArticle.fields.seo_title)

const cappedFaq = normalizeGrowthAiResult(
  { geo_faq_list: Array.from({ length: 6 }, (_, i) => ({ question: `Question number ${i}?`, answer: 'Answer.' })) },
  ['faq']
)
check('23c 问答切到 5 组', (cappedFaq.fields.geo_faq_list || []).length === 5)

const seoOnlyResult = normalizeGrowthAiResult(
  { seo_title: 'X', geo_faq_list: [{ question: 'Q?', answer: 'A' }] },
  ['seo']
)
check('24a 没要的字段不进结果', !('geo_faq_list' in seoOnlyResult.fields), JSON.stringify(seoOnlyResult.fields))

const longDesc = normalizeGrowthAiResult({ seo_description: 'word '.repeat(60) }, ['seo'])
check(
  '24b 超长描述被切到上限内',
  (longDesc.fields.seo_description || '').length <= GROWTH_LIMITS.seoDescription.max,
  String((longDesc.fields.seo_description || '').length)
)

const aliasResult = normalizeGrowthAiResult(
  { tldr: 'Short summary.', copies: { reddit_title: 'Hello' }, entities: 'Career, MBTI' },
  ['tldr', 'social', 'entities']
)
check('25a tldr 别名认', aliasResult.fields.ai_tldr_summary === 'Short summary.')
check('25b copies 别名认', aliasResult.fields.social_copies?.reddit_title === 'Hello')
check('25c entities 接受 CSV', sameJson(aliasResult.fields.target_entities, ['Career', 'MBTI']))
check('25d 有 warning 时是数组', Array.isArray(aliasResult.warnings))

const emptyResult = normalizeGrowthAiResult({}, ['seo', 'tldr', 'faq'])
check(
  '26a 空对象返回本次要的四个键（值为空）+ 提示',
  sameJson(Object.keys(emptyResult.fields), ['seo_title', 'seo_description', 'ai_tldr_summary', 'geo_faq_list']) &&
    emptyResult.warnings.length > 0,
  `${JSON.stringify(Object.keys(emptyResult.fields))} / warnings=${emptyResult.warnings.length}`
)

/* ------------------------------------------------------------------ *
 * 11. 与 52 号 SQL 对拍
 * ------------------------------------------------------------------ */

section('与 supabase/52_growth_seo_geo.sql 对拍')
const sqlPath = fileURLToPath(new URL('../../ComeBrief/supabase/52_growth_seo_geo.sql', import.meta.url))
if (!existsSync(sqlPath)) {
  // 单仓库检出不带前台仓库很正常：跳过而不是失败，否则 CI 会红得莫名其妙。
  console.log(`SKIP  找不到 ${sqlPath}（单仓库检出时属正常）`)
} else {
  const sql = readFileSync(sqlPath, 'utf8')
  check('27a 两张表都在', sql.includes('seo_topic_configs') && sql.includes('seo_global_defaults'))
  check('27b 建表语句带 if not exists', /create table if not exists public\.seo_topic_configs/i.test(sql))
  check('27c 开了 RLS', /row level security/i.test(sql))
  const columns = [
    'seo_title',
    'seo_description',
    'target_entities',
    'ai_tldr_summary',
    'geo_faq_list',
    'social_copies',
    'is_noindex',
  ]
  check('27d 七个运营列都在', columns.every((column) => sql.includes(column)), columns.join(','))
  const templateKeys = Object.keys(GROWTH_DEFAULT_TEMPLATES) as Array<keyof typeof GROWTH_DEFAULT_TEMPLATES>
  const missingTemplates = templateKeys.filter((key) => !sql.includes(GROWTH_DEFAULT_TEMPLATES[key]))
  check(
    '27e 六条默认模板与 SQL 一致',
    missingTemplates.length === 0,
    missingTemplates.length ? `缺：${missingTemplates.join(', ')}` : ''
  )
  check(
    '27f UTM 默认值与 SQL 一致',
    sql.includes(`'${GROWTH_DEFAULTS_FALLBACK.utm_medium}'`) &&
      sql.includes(`'${GROWTH_DEFAULTS_FALLBACK.utm_campaign}'`)
  )
}

/* ------------------------------------------------------------------ */

console.log('')
if (failed > 0) {
  console.error(`check-growth: ${failed} 项失败`)
  process.exit(1)
}
console.log('check-growth: 全部通过')




