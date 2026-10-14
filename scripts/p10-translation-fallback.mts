/**
 * P10 复验：分层翻译（方案 3）—— LLM 母语化重写优先，整条链全挂时降级传统 MT。
 * 顺带把「退出系统」按钮的接线也钉住。
 *
 * 背景（2026-10-13）：
 *   ① 站长问：LLM 都挂了，就不能让 DeepL 顶一下吗？
 *      于是翻译拆成两层：首选照旧走 LLM（红线：读者不能感觉这是翻译），只有当
 *      Gemini / OpenRouter Claude / DeepSeek 整条候选链都失败时，才降级到传统 MT
 *      （DeepL → Google → Microsoft → LibreTranslate），响应里标 degraded: true。
 *   ② 侧边栏底部的「退出系统」点了没反应 —— 它压根没接 onClick（纯装饰），
 *      唯一带登出的 Header.tsx 又是死代码。现在按钮接上 clientAuth.signOutAndRedirect()。
 *
 * 这个脚本测四段：
 *   A. 纯函数（引擎解析 / 语言码 / 四家回包形状 / 错误分类）—— 不联网、不花额度
 *   A2. 注入 fake fetch 跑通「LLM 全挂 → MT 兜底」这条链路（同样不联网）
 *   B. 真 HTTP 打 /api/ai/translate（会花额度；P10_SKIP_MODELS=1 跳过）
 *   C. 真 HTTP 打 /api/ai/status，确认兜底链的配置真被读出来了（不花额度）
 *   D. 退出按钮的接线（静态断言：读源码，不开浏览器）
 *
 * 用法：
 *   cd Sass && node --import ./scripts/_ts-resolve.mts scripts/p10-translation-fallback.mts
 *
 * 只想跑离线断言（额度紧张时）：
 *   P10_OFFLINE=1 node --import ./scripts/_ts-resolve.mts scripts/p10-translation-fallback.mts
 */
import { existsSync, readFileSync } from 'node:fs'
import {
  decodeEntities,
  describeMtError,
  extractMtText,
  langFor,
  mtCooldownLeftMs,
  parseMtChain,
  parseMtError,
  resolveMtTarget,
  translateWithMt,
} from '../lib/translationProvider.ts'

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const i = s.indexOf('=')
    if (i <= 0) continue
    const k = s.slice(0, i).trim()
    if (!process.env[k]) process.env[k] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
}

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

/* ---------------- A. 纯函数 ---------------- */

console.log('A. 纯函数（引擎解析 / 语言码 / 回包形状 / 错误分类）')

// —— AI_TRANSLATE_MT_FALLBACK 怎么拆 ——
ok('逗号分隔 + 去空格', JSON.stringify(parseMtChain('deepl, libretranslate')) === '["deepl","libretranslate"]')
ok('换行 / 分号也认', JSON.stringify(parseMtChain('deepl\nlibre;google')) === '["deepl","libre","google"]')
ok('重复项去掉（大小写不敏感）', JSON.stringify(parseMtChain('DeepL, deepl , DEEPL')) === '["DeepL"]')
const 空链 = [parseMtChain(''), parseMtChain(undefined), parseMtChain('  ,  ;  ')]
ok('空值 → 空数组（= 不启用兜底，不是错误）', 空链.every((c) => c.length === 0))

// —— 缺 Key 时不许抛异常，必须给一句人话（这是「未配置引擎优雅跳过」的底座） ——
const ENV_KEYS = [
  'DEEPL_API_KEY',
  'DEEPL_API_URL',
  'GOOGLE_TRANSLATE_API_KEY',
  'AZURE_TRANSLATOR_KEY',
  'AZURE_TRANSLATOR_REGION',
  'LIBRETRANSLATE_URL',
  'LIBRETRANSLATE_API_KEY',
]
for (const k of ENV_KEYS) delete process.env[k]

const 缺DeepL = resolveMtTarget('deepl')
ok('缺 DEEPL_API_KEY → 不抛异常，且点名缺哪个变量', 缺DeepL.ok === false && /DEEPL_API_KEY/.test(缺DeepL.error), JSON.stringify(缺DeepL))
ok(
  '没见过的引擎名 → 把可选值列出来',
  (() => {
    const r = resolveMtTarget('baidu')
    return r.ok === false && /deepl/.test(r.error) && /libretranslate/.test(r.error)
  })()
)
ok('空写法 → 一句人话', resolveMtTarget('').ok === false && resolveMtTarget('   ').ok === false)
ok(
  'LibreTranslate 缺 URL 也要说话',
  (() => {
    const r = resolveMtTarget('libretranslate')
    return r.ok === false && /LIBRETRANSLATE_URL/.test(r.error)
  })()
)

// —— 配齐 Key 之后：别名、免费版端点自动判 ——
process.env.DEEPL_API_KEY = 'abcd-1234:fx'
process.env.GOOGLE_TRANSLATE_API_KEY = 'g-key'
process.env.LIBRETRANSLATE_URL = 'https://libre.example.com/'
process.env.AZURE_TRANSLATOR_KEY = 'ms-key'
process.env.AZURE_TRANSLATOR_REGION = 'eastasia'

const 免费版 = resolveMtTarget('deepl')
ok('免费版 Key（结尾 :fx）自动走 api-free.deepl.com', 免费版.ok === true && 免费版.target.baseUrl === 'https://api-free.deepl.com')
ok(
  'azure 认成 microsoft，且带上 region',
  (() => {
    const r = resolveMtTarget('azure')
    return r.ok === true && r.target.provider === 'microsoft' && r.target.region === 'eastasia'
  })()
)
ok(
  'libre 认成 libretranslate，并去掉结尾的斜杠',
  (() => {
    const r = resolveMtTarget('libre')
    return r.ok === true && r.target.provider === 'libretranslate' && r.target.baseUrl === 'https://libre.example.com'
  })()
)
process.env.DEEPL_API_KEY = 'pro-key-1234'
const 专业版 = resolveMtTarget('deepl')
ok('Pro Key → api.deepl.com', 专业版.ok === true && 专业版.target.baseUrl === 'https://api.deepl.com')

// —— 语言码：每家的写法都不一样，出门前必须转 ——
ok('DeepL：中文寄成 ZH、英文寄成 EN-US（大写）', langFor('deepl', 'zh') === 'ZH' && langFor('deepl', 'en') === 'EN-US')
ok('Microsoft：中文要 zh-Hans（不然可能挑到繁体）', langFor('microsoft', 'zh') === 'zh-Hans')
ok('Google / Libre：直接用 zh / en', langFor('google', 'zh') === 'zh' && langFor('libretranslate', 'en') === 'en')

// —— 四家的成功回包形状（官方文档里的真实结构）钉住，改坏了立刻知道 ——
ok('DeepL 回包', extractMtText('deepl', { translations: [{ detected_source_language: 'ZH', text: 'Hello there' }] }) === 'Hello there')
ok('Google 回包', extractMtText('google', { data: { translations: [{ translatedText: 'Hello there' }] } }) === 'Hello there')
ok(
  'Microsoft 回包（最外层是数组）',
  extractMtText('microsoft', [{ detectedLanguage: { language: 'zh-Hans' }, translations: [{ text: 'Hello there', to: 'en' }] }]) ===
    'Hello there'
)
ok('LibreTranslate 回包', extractMtText('libretranslate', { translatedText: 'Hello there' }) === 'Hello there')
ok('空回包 → 空串（调用方据此判失败）', extractMtText('deepl', {}) === '' && extractMtText('libretranslate', null) === '')
// Google 在 format=html 时会把实体再转义一遍（<p> → &lt;p&gt;），用之前必须还原
ok(
  'Google 的 HTML 实体要还原回标签',
  decodeEntities('&lt;p&gt;Hello&lt;/p&gt;') === '<p>Hello</p>' && decodeEntities('A &amp; B') === 'A & B'
)

// —— 错误分类：先说人话，再决定要不要记冷却 ——
const e456 = parseMtError(456, JSON.stringify({ message: 'Quota exceeded. The character limit has been reached.' }))
ok('DeepL 的 456 不是 429，但同样是「额度用尽」', e456.kind === 'quota', JSON.stringify(e456))
ok('456 在提示里点名 456（站长搜得到）', /456/.test(describeMtError('DeepL', 456, '')))
const e429 = parseMtError(429, '{}', new Headers({ 'retry-after': '12' }))
ok('429 判成「限流」并读出 Retry-After', e429.kind === 'rate' && e429.retryAfterMs === 12000, JSON.stringify(e429))
ok('限流那句话里有「限流」两个字', /限流/.test(describeMtError('DeepL', 429, '{}')))
ok('401 那句里点名「Key」（指向能改的地方）', /Key/.test(describeMtError('DeepL', 401, '{}')))
ok('503 判成「服务端抽风」', parseMtError(503, '').kind === 'server')


/* ---------------- A2. 真跑一遍「LLM 全挂 → MT 兜底」（注入 fake fetch，不联网） ---------------- */

console.log('\nA2. 兜底链路（注入 fake fetch，不联网）')

/**
 * 假 fetch：按 URL 回一个预设响应。
 * 为什么不 monkey-patch 全局 fetch：translateWithMt 收一个 fetchImpl，
 * 注入比改全局干净，也不会污染同进程里别的断言。
 */
type FakeReply = { status: number; body: unknown }
const fakeFetch =
  (handler: (url: string, init: any) => FakeReply) =>
  (async (input: any, init: any) => {
    const r = handler(String(input), init)
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
    return new Response(text, { status: r.status, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch

// —— ① 第一家就成功，顺便把「出门时请求长什么样」钉住 ——
let seenUrl = ''
let seenHeader: any = {}
let seenBody = ''
const dlFetch = fakeFetch((url, init) => {
  seenUrl = url
  seenHeader = init.headers || {}
  seenBody = String(init.body || '')
  return { status: 200, body: { translations: [{ detected_source_language: 'ZH', text: '<p>Hello there</p>' }] } }
})
const r1 = await translateWithMt({
  text: '<p>你好</p>',
  sourceLang: 'zh',
  targetLang: 'en',
  format: 'html',
  context: '上一段讲的是加油站的夜晚。',
  chain: 'deepl',
  ignoreCooldown: true,
  fetchImpl: dlFetch,
})
ok('DeepL 兜底成功，返回的就是它的译文', r1.ok === true && r1.text === '<p>Hello there</p>', JSON.stringify(r1))
ok('打的是 /v2/translate', seenUrl.endsWith('/v2/translate'), seenUrl)
ok('带了 DeepL-Auth-Key 头', /DeepL-Auth-Key/.test(String(seenHeader.Authorization || seenHeader.authorization || '')))
ok('target_lang 转成了 EN-US', /target_lang=EN-US/.test(seenBody), seenBody)
ok('tag_handling=html（正文带 <p> 时必须）', /tag_handling=html/.test(seenBody), seenBody)
ok('context 带上了（给机翻一点上下文消歧）', /context=/.test(seenBody), seenBody)
ok('返回里写明了用的哪家引擎', r1.ok === true && r1.provider === 'deepl' && r1.spec === 'deepl')

// —— ② 第一家 429，自动换下一家 ——
const calls: string[] = []
const chainFetch = fakeFetch((url) => {
  calls.push(url)
  if (url.includes('api.deepl.com')) return { status: 429, body: { message: 'Too many requests' } }
  return { status: 200, body: { translatedText: 'Hello there' } }
})
const r2 = await translateWithMt({
  text: '你好',
  sourceLang: 'zh',
  targetLang: 'en',
  chain: 'deepl, libretranslate',
  ignoreCooldown: true,
  fetchImpl: chainFetch,
})
ok('DeepL 限流后自动换到 LibreTranslate', r2.ok === true && r2.provider === 'libretranslate', JSON.stringify(r2))
ok('两家都真的调了（顺序不能乱）', calls.length === 2 && calls[0].includes('deepl'), JSON.stringify(calls))
ok('tried 里记着「试过谁」（排查就看它）', r2.ok === true && r2.tried.join(',') === 'deepl,libretranslate')

// —— ③ 全挂：合并成一句，别把英文原文丢给站长 ——
const deadFetch = fakeFetch(() => ({ status: 401, body: { message: 'Invalid API key' } }))
const r3 = await translateWithMt({
  text: '你好',
  sourceLang: 'zh',
  targetLang: 'en',
  chain: 'deepl, libretranslate',
  ignoreCooldown: true,
  fetchImpl: deadFetch,
})
ok('全挂时 ok=false（不抛异常）', r3.ok === false)
ok('错误里点名了失败的引擎', r3.ok === false && /DeepL|LibreTranslate/.test(r3.error), r3.ok === false ? r3.error : '')
ok('tried 覆盖整条链', r3.ok === false && r3.tried.length === 2)
ok('401 是配置错 → retryable=false（重试一百次也没用）', r3.ok === false && r3.retryable === false)

// —— ④ 没配兜底链：给一句明确的话，而不是「网络错误」 ——
const r4 = await translateWithMt({ text: '你好', targetLang: 'en', chain: '', fetchImpl: deadFetch })
ok('没配 AI_TRANSLATE_MT_FALLBACK → 提示点名这个变量', r4.ok === false && /AI_TRANSLATE_MT_FALLBACK/.test(r4.error), JSON.stringify(r4))

// —— ⑤ 冷却：被限流过的引擎短期内别再撞墙 ——
const busyFetch = fakeFetch(() => ({ status: 429, body: { message: 'Rate limit exceeded' } }))
await translateWithMt({ text: '你好', sourceLang: 'zh', targetLang: 'en', chain: 'google', ignoreCooldown: true, fetchImpl: busyFetch })
ok('被限流后进入冷却（避免每次请求都撞一遍墙）', mtCooldownLeftMs('google') > 0)

let calledWhileCooling = 0
const counting = fakeFetch(() => {
  calledWhileCooling++
  return { status: 200, body: { data: { translations: [{ translatedText: 'Hi' }] } } }
})
const r5 = await translateWithMt({ text: '你好', sourceLang: 'zh', targetLang: 'en', chain: 'google', fetchImpl: counting })
ok('冷却中不再重复打同一个引擎', calledWhileCooling === 0, `called=${calledWhileCooling}`)
ok('冷却中跳过 → 老实说「一个引擎都没跑起来」', r5.ok === false && /没跑起来/.test(r5.error), JSON.stringify(r5))
const r6 = await translateWithMt({ text: '你好', sourceLang: 'zh', targetLang: 'en', chain: 'google', ignoreCooldown: true, fetchImpl: counting })
ok('自检探活时 ignoreCooldown 能绕过冷却', r6.ok === true && calledWhileCooling === 1, JSON.stringify(r6))

// —— ⑥ 连都连不上：也要说人话 ——
const boomFetch = (async () => {
  throw new TypeError('fetch failed')
}) as unknown as typeof fetch
const r7 = await translateWithMt({ text: '你好', sourceLang: 'zh', targetLang: 'en', chain: 'libretranslate', ignoreCooldown: true, fetchImpl: boomFetch })
ok('网络炸了 = 人话，不是把 TypeError 抛给站长', r7.ok === false && /连不上|网络/.test(r7.error), JSON.stringify(r7))


/* ---------------- B / C / D. 真 HTTP + 接线 ---------------- */

/**
 * 只跑离线断言（额度紧张时用这个）：
 *   P10_OFFLINE=1 node --import ./scripts/_ts-resolve.mts scripts/p10-translation-fallback.mts
 */
if (process.env.P10_OFFLINE === '1') {
  console.log(`\n（P10_OFFLINE=1：跳过真 HTTP 那几段）\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

const BASE = process.env.P10_BASE || 'http://localhost:3001'
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!

const ZH_BODY = `<p>${'夜里他在港口等了很久，风把外套吹得鼓起来，海面上没有一盏灯。'.repeat(10)}</p>`

const email = `zz-p10-${Date.now()}@example.com`
const password = 'Zz' + Math.random().toString(36).slice(2) + '!Aa1'
let uid = ''

async function main() {
  const headers = (withKey: boolean) => ({
    'Content-Type': 'application/json',
    apikey: withKey ? SERVICE : ANON,
    ...(withKey ? { Authorization: `Bearer ${SERVICE}` } : {}),
  })

  // 建一个临时管理员（requireAdmin 只认「登录过的用户」，不认具体是谁），跑完删掉
  const create = await fetch(`${SUPA}/auth/v1/admin/users`, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({ email, password, email_confirm: true }),
  })
  const cj: any = await create.json()
  uid = cj.id || cj.user?.id || ''
  const signIn = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: headers(false),
    body: JSON.stringify({ email, password }),
  })
  const token = (await signIn.json()).access_token
  if (!token) throw new Error('拿不到登录票（Supabase 不通？）')

  /* ---------------- B. 真 HTTP：正常路径仍然是 LLM 母语化重写 ---------------- */

  console.log('\nB. 真 HTTP（POST /api/ai/translate）')
  if (process.env.P10_SKIP_MODELS === '1') {
    console.log('（P10_SKIP_MODELS=1：跳过真调模型那一下）')
  } else {
    const t0 = Date.now()
    const resp = await fetch(`${BASE}/api/ai/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: '港口等风', excerpt: '一个在港口等风的人。', html: ZH_BODY }),
    })
    const json: any = await resp.json().catch(() => ({}))
    const ms = Date.now() - t0
    console.log(`   status ${resp.status} · ${ms}ms · model=${json?.data?.model || ''} · ${JSON.stringify(json?.data?.title || json?.error)}`)
    ok('整篇翻译成功', resp.status === 200 && json?.ok === true, JSON.stringify(json).slice(0, 300))
    ok('给了英文正文', String(json?.data?.html || '').length > 40, `len=${String(json?.data?.html || '').length}`)
    ok('给了英文标题', String(json?.data?.title || '').trim().length > 0)
    // 关键：有兜底链在，正常路径也必须还是 LLM —— 不能被 MT 抢走
    ok('走的是 LLM 母语化重写（不是机翻兜底）', json?.data?.degraded !== true, JSON.stringify({ engine: json?.data?.engine, degraded: json?.data?.degraded }))
  }

  /* ---------------- C. /api/ai/status：兜底链的配置真被读出来了 ---------------- */

  console.log('\nC. GET /api/ai/status（翻译兜底链的配置）')
  const st = await fetch(`${BASE}/api/ai/status`, { headers: { Authorization: `Bearer ${token}` } })
  const sj: any = await st.json().catch(() => ({}))
  const data: any = sj?.data || {}
  console.log(`   status ${st.status} · mt=${JSON.stringify(data.mt?.summary || {})}`)
  ok('自检接口 200', st.status === 200 && sj?.ok === true, `status ${st.status} ${JSON.stringify(sj).slice(0, 200)}`)
  ok('多了一块 mt（翻译兜底）', Boolean(data.mt) && Array.isArray(data.mt.chain))
  ok('mt.rows 每行都说清了能不能用', Array.isArray(data.mt?.rows) && data.mt.rows.every((r: any) => typeof r.ok === 'boolean'))
  ok('MT 的 Key 有没有配也列出来了', typeof data.mt?.keys === 'object' && 'DEEPL_API_KEY' in (data.mt?.keys || {}))
  ok('MT 也有一句总评', typeof data.mt?.summary?.text === 'string' && data.mt.summary.text.length > 4)
  ok('环境变量表里有 AI_TRANSLATE_MT_FALLBACK', 'AI_TRANSLATE_MT_FALLBACK' in (data.env || {}))
  ok(
    '没配兜底时是 info（不算配置错误，别吓站长）',
    data.mt?.chain?.length > 0 || data.mt?.summary?.level === 'info',
    JSON.stringify(data.mt?.summary)
  )
  ok('mtProbe 字段在（probe=1 时才填内容）', Array.isArray(data.mtProbe))
  ok('LLM 那半边没被改动（四个任务还在）', Array.isArray(data.routing) && data.routing.length === 4)

  /* ---------------- D. 「退出系统」接线（读源码，不开浏览器） ---------------- */

  console.log('\nD. 退出按钮接线（静态断言）')
  const clientAuth = readFileSync('lib/clientAuth.ts', 'utf8')
  const sidebar = readFileSync('app/admin/_components/Sidebar.tsx', 'utf8')
  ok('clientAuth 导出了 signOutAndRedirect', /export async function signOutAndRedirect/.test(clientAuth))
  ok('先正常 signOut，失败再降级 scope: local', /signOut\(\)/.test(clientAuth) && /scope:\s*'local'/.test(clientAuth))
  ok('最后是硬跳转（软跳转不会重跑客户端守卫）', /window\.location\.href\s*=\s*`\/admin\/login/.test(clientAuth))
  ok('回登录页时带上 redirect（登录后能回原处）', /redirect=\$\{encodeURIComponent/.test(clientAuth))
  ok('Sidebar 的「退出系统」真的接上了 onClick', /退出系统/.test(sidebar) && /onClick=\{\(\) => setConfirming\(true\)\}/.test(sidebar))
  ok('Sidebar 调的就是 signOutAndRedirect', /signOutAndRedirect/.test(sidebar))
  ok('退出前有二次确认（贴在菜单底部，防手滑）', /确定退出登录？/.test(sidebar))
  ok('死代码 Header.tsx 已删除', !existsSync('app/admin/_components/Header.tsx'))

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
}

try {
  await main()
} catch (e: any) {
  console.log('跑挂了：', e?.message)
  fail++
} finally {
  if (uid) {
    const del = await fetch(`${SUPA}/auth/v1/admin/users/${uid}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    })
    console.log(`清理临时测试账号 ${email} → ${del.status}`)
  }
  process.exit(fail ? 1 : 0)
}

