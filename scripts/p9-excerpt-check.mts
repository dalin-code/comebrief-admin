/**
 * P9 复验：管理端「AI 摘要」乱码 + 「母语化重写 → 英文」误报「中文正文太短」这两条。
 *
 * 背景（2026-10-07 站长报的）：
 *   ① 摘要栏里出现 `99)经(100)蜕(101)变(102)的(103)彼(104)此(105)` 这种「编号+汉字」。
 *      —— Gemini 3.x 的思考 token 从 maxOutputTokens 里扣，模型为了核对「不超过 120 字」
 *      先花掉 980 token 数了一遍字，额度见底 → MAX_TOKENS，吐出来的就是那截数数草稿。
 *   ② 页面上一整篇中文，点翻译却说「中文正文太短了，先写完再翻译」。
 *      —— 新建稿默认停在英文页签，中文正文在那一边；翻译只读了 zhHtmlRef。
 *
 * 这个脚本两步都测：
 *   A. 纯函数（数数残渣识别 / 中文原稿挑选）—— 不需要网络、不需要额度
 *   A2/A3. 429 到底该判成「限流」还是「额度用尽」、兜底链怎么拆（P10 新增）—— 同样不用网络
 *   B. 真 HTTP 打 /api/ai/excerpt（会建一个临时管理员账号，跑完自动删掉）
 *   C. 真 HTTP 打 /api/ai/status 自检接口（只读配置，不花额度）
 *
 * 用法：
 *   cd Sass && node --import ./scripts/_ts-resolve.mts scripts/p9-excerpt-check.mts
 *
 * 只想跑离线断言（额度紧张时）：
 *   P9_OFFLINE=1 node --import ./scripts/_ts-resolve.mts scripts/p9-excerpt-check.mts
 *
 * 想验证接口通不通但不想花额度：
 *   P9_SKIP_MODELS=1 node --import ./scripts/_ts-resolve.mts scripts/p9-excerpt-check.mts
 *
 * 免费额度按分钟限流，两次真调用之间默认歇 25 秒（P9_GAP_MS 可改）。
 * 主模型额度用尽时会自动走 AI_MODEL_FALLBACK（响应里的 data.model 会写明用了哪个）。
 */
import { readFileSync, existsSync } from 'node:fs'
import {
  isCountLeak,
  isMostlyChinese,
  pickChineseOriginal,
  stripCountLeak,
} from '../lib/storyPrompt.ts'
import { describeProviderError, parseProviderError, parseRetryDelay } from '../lib/aiGemini.ts'
import { parseModelChain } from '../lib/aiProvider.ts'

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
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${extra}`) }
}

/* ---------------- A. 纯函数 ---------------- */

console.log('A. 纯函数（数数残渣 / 页签错位）')

// 站长截图里那串
const 截图那串 = '99)经(100)蜕(101)变(102)的(103)彼(104)此(105)'
ok('截图那串被判成数数残渣', isCountLeak(截图那串))
ok('截图那串被清成空', stripCountLeak(截图那串) === '', `→ ${JSON.stringify(stripCountLeak(截图那串))}`)
// 直连 Gemini 复现出来的那截
ok('复现那串被判成数数残渣', isCountLeak('101)接(102)与(103)紧(104)绷(105)张(106)力('))

// 好句子 + Count: 尾巴 → 只留前面那句
const 带尾巴 =
  '数字背后究竟藏着怎样的秘密？前往波特兰的晨光中，一段关于寻找与未知的旅程才刚刚拉开序幕。\n        Count:\n        那('
const 收尾 = stripCountLeak(带尾巴)
ok('好句子 + Count 尾巴 → 砍掉尾巴', 收尾.endsWith('拉开序幕。') && !收尾.includes('Count'), `→ ${JSON.stringify(收尾)}`)

// 正常摘要不能被误伤
const 正常中文 =
  '寒夜的偏僻加油站里，孤身一人的诺亚守在浓雾中，只为等一辆神秘皮卡送来写着地址与数字的收据。小说用冷峻克制的笔触勾勒出无声的张力与悬念，让人忍不住探寻那串数字背后的秘密。'
ok('正常中文摘要原样通过', stripCountLeak(正常中文) === 正常中文)
const 正常英文 =
  'The story follows a lone mechanic in 2024 (see part 2) who waits for a mysterious pickup truck carrying a receipt with an address and a number.'
ok('正常英文（含年份/括号）原样通过', stripCountLeak(正常英文) === 正常英文)
ok('正常英文没被判成残渣', !isCountLeak(正常英文))

ok('长中文正文 = 中文', isMostlyChinese(正常中文.repeat(3)))
ok('英文正文不是中文', !isMostlyChinese(正常英文.repeat(3)))
ok('短中文（<80 字）不算一篇原稿', !isMostlyChinese('这是一个很短的中文片段。'))

// 页签错位：中文停在英文页签里，中文原稿那一栏是空的
const 错位 = pickChineseOriginal({ official: '', others: ['', `<p>${正常中文}</p>`] })
ok('页签错位能捡回中文', 错位.recovered === true && 错位.html.includes('加油站'))
// 正常情况：中文原稿在 ref 里，英文页签是英文 → 不许乱捡
const 正常情况 = pickChineseOriginal({ official: `<p>${正常中文}</p>`, others: [`<p>${正常英文}</p>`] })
ok('正常情况不误报 recovered', 正常情况.recovered === false)
// 两边都没有中文 → 老实返回空，交给调用方报错
const 都空 = pickChineseOriginal({
  official: '',
  others: ['', '<p>Hello world, this is plain English text that goes on and on for a while.</p>'],
})
ok('两边都没中文 → 不硬编', 都空.recovered === false && 都空.html === '')


/* ---------------- A2. 429 到底是「限流」还是「额度用尽」 ---------------- */

/**
 * 这一段是 2026-10-10 那屏红字的核心：两个模型同时报 429，旧代码把「每分钟限流」
 * 也判成「今天的额度用完了」，于是提示框里那句「去换模型 / 等明天」把站长指错了方向。
 * 真正能分辨的是 details[] 里的 quotaId 和 RetryInfo.retryDelay，这里把它们钉住。
 */

/** Google 真实回包（每日额度用尽）：quotaId 里写着 PerDay */
const RPD_BODY = JSON.stringify({
  error: {
    code: 429,
    message:
      'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          {
            quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
            quotaValue: '20',
          },
        ],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '23s' },
    ],
  },
})
/** 同一套 message 文案，只有 quotaId 和 retryDelay 不同（每分钟限流）—— 这就是旧代码翻车的现场 */
const RPM_BODY = JSON.stringify({
  error: {
    code: 429,
    message:
      'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '20s' },
    ],
  },
})

ok('每日额度（RPD）判成 quota', parseProviderError(429, RPD_BODY).kind === 'quota', parseProviderError(429, RPD_BODY).kind)
ok('RPD 的 quotaId 被读出来了', /PerDay/.test(parseProviderError(429, RPD_BODY).code))
ok('每分钟限流（RPM）判成 rate —— 不再误判成「今天没了」', parseProviderError(429, RPM_BODY).kind === 'rate', parseProviderError(429, RPM_BODY).kind)
ok('RPM 的等待时间被读出来（20s）', parseProviderError(429, RPM_BODY).retryAfterMs === 20000, `${parseProviderError(429, RPM_BODY).retryAfterMs}ms`)
ok('没有任何线索的 429 默认当限流（让站长等，而不是让他去改配置）', parseProviderError(429, '{}').kind === 'rate')
ok('只给 Retry-After 响应头也认得', parseProviderError(429, '{"error":{"message":"rate limited"}}', new Headers({ 'retry-after': '7' })).retryAfterMs === 7000)

const rateMsg = describeProviderError('Gemini 直连', 429, RPM_BODY, { model: 'gemini-3.8-flash' })
ok('限流那句提示说「被限流了」', /被限流/.test(rateMsg), rateMsg)
ok('限流那句提示带上模型名', rateMsg.includes('gemini-3.8-flash'))
ok('提示很短（提示框只有一行宽，不能再糊住编辑区）', rateMsg.length < 60, `${rateMsg.length} 字：${rateMsg}`)
const quotaMsg = describeProviderError('Gemini 直连', 429, RPD_BODY, { model: 'gemini-3.8-flash' })
ok('额度用尽那句提示说「额度用完」并给出换模型的路', /额度用完/.test(quotaMsg) && /AI_MODEL_FALLBACK/.test(quotaMsg), quotaMsg)
// 上限 80：这条要塞下「是什么 + 去哪儿改」，比限流那条长一点是合理的，但绝不能再回到 150 字
ok('额度那句也短', quotaMsg.length < 80, `${quotaMsg.length} 字：${quotaMsg}`)

ok('401 → auth', parseProviderError(401, '{"error":{"message":"API key not valid"}}').kind === 'auth')
ok('404 → notfound', parseProviderError(404, '{}').kind === 'notfound')
ok('400 → badrequest', parseProviderError(400, '{}').kind === 'badrequest')
ok('503 → server', parseProviderError(503, '{}').kind === 'server')
ok('404 的提示不再带英文原文（那个以前会撑爆提示框）', describeProviderError('Gemini 直连', 404, '{"error":{"message":"models/xyz is not found for API version v1beta"}}').length < 60)

ok('parseRetryDelay: "23s" → 23000', parseRetryDelay('23s') === 23000)
ok('parseRetryDelay: "1.5s" → 1500', parseRetryDelay('1.5s') === 1500)
ok('parseRetryDelay: "500ms" → 500', parseRetryDelay('500ms') === 500)
ok('parseRetryDelay: "2m" → 120000', parseRetryDelay('2m') === 120000)
ok('parseRetryDelay: 纯数字按秒算', parseRetryDelay('120') === 120000)
ok('parseRetryDelay: 认不出来给 0（不瞎猜）', parseRetryDelay('soon') === 0 && parseRetryDelay(null) === 0 && parseRetryDelay('') === 0)

/* ---------------- A3. 兜底链（AI_MODEL_FALLBACK 现在支持一串） ---------------- */

ok('单个写法照旧能用（向后兼容）', JSON.stringify(parseModelChain('gemini-3.5-flash')) === '["gemini-3.5-flash"]')
ok('逗号分隔成一串', JSON.stringify(parseModelChain('gemini-3.5-flash, deepseek:deepseek-chat')) === '["gemini-3.5-flash","deepseek:deepseek-chat"]')
ok('换行 / 分号分隔也行', parseModelChain('a\nb;c').length === 3)
ok('重复项去掉（写两遍不叫兜底）', parseModelChain('a,a, a').length === 1)
ok('空值不炸', parseModelChain('').length === 0 && parseModelChain(null).length === 0 && parseModelChain(' , , ').length === 0)


/* ---------------- B. 真 HTTP ---------------- */

/**
 * 只跑离线断言：
 *   P9_OFFLINE=1 node --import ./scripts/_ts-resolve.mts scripts/p9-excerpt-check.mts
 * 额度紧张时用这个 —— B 段要真调模型，会花额度。
 */
if (process.env.P9_OFFLINE === '1') {
  console.log(`\n（P9_OFFLINE=1：跳过真 HTTP 那一段）\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

const BASE = process.env.P9_BASE || 'http://localhost:3001'
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!
const GAP = Number(process.env.P9_GAP_MS || 25000)

const ZH_BODY = `<p>那间没有暖气的房子</p><p>${'诺亚把那封信放在厨房的桌子上，窗外的雪一直在下。他数了数信封上的数字，又把它翻过来对着灯看了看。'.repeat(12)}</p>`
const EN_BODY = `<p>${'On a freezing night at a remote gas station, a lone mechanic named Noah waits in the fog. '.repeat(10)}</p>`

const email = `zz-p9v-${Date.now()}@example.com`
const password = 'Zz' + Math.random().toString(36).slice(2) + '!Aa1'
let uid = ''

async function main() {
  const authHeaders = (withKey: boolean) => ({
    'Content-Type': 'application/json',
    apikey: withKey ? SERVICE : ANON,
    ...(withKey ? { Authorization: `Bearer ${SERVICE}` } : {}),
  })

  // 建一个临时管理员（requireAdmin 只认「登录过的用户」，不认具体是谁），跑完删掉
  const create = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: 'POST',
    headers: authHeaders(true),
    body: JSON.stringify({ email, password, email_confirm: true }),
  })
  const cj: any = await create.json()
  uid = cj.id || cj.user?.id || ''
  const signIn = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: authHeaders(false),
    body: JSON.stringify({ email, password }),
  })
  const token = (await signIn.json()).access_token
  if (!token) throw new Error('拿不到登录票（Supabase 不通？）')

  const call = async (language: 'zh' | 'en', html: string, title: string, extra: Record<string, unknown> = {}) => {
    const t0 = Date.now()
    const resp = await fetch(`${BASE}/api/ai/excerpt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ language, title, html, ...extra }),
    })
    const json: any = await resp.json().catch(() => ({}))
    return { status: resp.status, json, ms: Date.now() - t0, model: String(json?.data?.model || '') }
  }

  console.log('\nB. 真 HTTP（POST /api/ai/excerpt）')
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  // ② 不调用模型（护栏直接拦下），先跑它不占额度
  console.log('\n② language=en + 长中文正文（页签错位）')
  const r2 = await call('en', ZH_BODY, '那间没有暖气的房子')
  console.log(`   status ${r2.status} · ${r2.ms}ms · ${JSON.stringify(r2.json?.error || r2.json?.data?.excerpt)}`)
  ok('en 栏拒绝拿中文正文生成', r2.status === 400)
  ok('提示信息指路了', /中文原稿/.test(String(r2.json?.error || '')))
  // 门槛放 3 秒：这一下不该碰模型（真调一次要 5～20 秒，差得很远），
  // 而 dev 首次编译这条路由自己就能吃掉 1～2 秒，卡 2 秒会误报
  ok('没白调模型（<3 秒就拒了）', r2.ms < 3000, `${r2.ms}ms`)

  // 下面三个是真调模型（要花额度）。只想验证接口通不通、不想用额度时：
  //   P9_SKIP_MODELS=1 node --import ./scripts/_ts-resolve.mts scripts/p9-excerpt-check.mts
  const skipModels = process.env.P9_SKIP_MODELS === '1'
  if (skipModels) console.log('\n（P9_SKIP_MODELS=1：跳过 ①②③ 三次真调用）')

  await sleep(skipModels ? 0 : GAP)
  if (!skipModels) {
  console.log('\n① language=zh + 长中文正文')
  const r1 = await call('zh', ZH_BODY, '那间没有暖气的房子')
  console.log(`   status ${r1.status} · ${r1.ms}ms · model=${r1.model} · ${JSON.stringify(r1.json?.data?.excerpt || r1.json?.error)}`)
  ok('zh 摘要成功', r1.status === 200 && r1.json?.ok === true, JSON.stringify(r1.json))
  ok('zh 摘要不含数数残渣', !/\(\d{1,4}\)[\u4e00-\u9fa5]/.test(String(r1.json?.data?.excerpt || '')))
  ok('zh 摘要够长（≥20 字）', String(r1.json?.data?.excerpt || '').length >= 20)
  ok('zh 摘要在 20 秒内返回（说明思考确实关掉了）', r1.ms < 20000, `${r1.ms}ms`)

  await sleep(GAP)
  console.log('\n③ language=en + 长英文正文')
  const r3 = await call('en', EN_BODY, 'The Gas Station')
  console.log(`   status ${r3.status} · ${r3.ms}ms · model=${r3.model} · ${JSON.stringify(r3.json?.data?.excerpt || r3.json?.error)}`)
  ok('en 摘要成功', r3.status === 200 && r3.json?.ok === true, JSON.stringify(r3.json))
  const enText = String(r3.json?.data?.excerpt || '')
  ok('en 摘要里没有中文', (enText.match(/[\u4e00-\u9fa5]/g) || []).length < 10, enText)
  ok('en 摘要不含数数残渣', !/\(\d{1,4}\)[A-Za-z]/.test(enText))
  }

  /* ---------------- C. /api/ai/status 自检接口（不花额度） ---------------- */

  console.log('\nC. GET /api/ai/status（只查配置，不调模型）')
  const st = await fetch(`${BASE}/api/ai/status`, { headers: { Authorization: `Bearer ${token}` } })
  const sj: any = await st.json().catch(() => ({}))
  const data = sj?.data || {}
  ok('自检接口返回 200', st.status === 200 && sj?.ok === true, `status ${st.status} ${JSON.stringify(sj).slice(0, 160)}`)
  ok('四个任务都在表里', Array.isArray(data.routing) && data.routing.length === 4, JSON.stringify(data.routing))
  ok('每个任务都说清了用哪个模型', (data.routing || []).every((r: any) => r.ok ? Boolean(r.model) : Boolean(r.error)))
  ok('兜底链是一个数组（看了才知道配没配）', Array.isArray(data.fallback))
  ok('有一句总评', typeof data.summary?.text === 'string' && data.summary.text.length > 4, JSON.stringify(data.summary))
  ok('Key 的「有没有配」列出来了', typeof data.keys === 'object' && 'GEMINI_API_KEY' in (data.keys || {}))
  ok('模型类环境变量都列出来了（排查配置要看的就是它）', 'AI_MODEL_FALLBACK' in (data.env || {}) && 'AI_UTIL_MODEL' in (data.env || {}))
  ok('冷却表也带出来了', Array.isArray(data.cooldowns))

  /* ---------------- D. 连点两下（结果记忆 + 并发去重） ---------------- */

  if (skipModels) {
    console.log('\n（P9_SKIP_MODELS=1：跳过「连点两下」那一段）')
  } else {
    await sleep(GAP)
    console.log('\nD. 同一段正文连点两下（第二次应该直接复用，不再花额度）')
    const memoBody = `<p>${'夜里他在港口等了很久，风把外套吹得鼓起来。'.repeat(12)}</p>`
    const d1 = await call('zh', memoBody, '港口等风')
    console.log(`   第 1 下 status ${d1.status} · ${d1.ms}ms · cached=${d1.json?.data?.cached}`)
    ok('第 1 下真的问了模型', d1.status === 200 && d1.json?.ok === true && d1.json?.data?.cached !== true, JSON.stringify(d1.json?.data || d1.json?.error))
    const d2 = await call('zh', memoBody, '港口等风')
    console.log(`   第 2 下 status ${d2.status} · ${d2.ms}ms · cached=${d2.json?.data?.cached}`)
    ok('第 2 下复用了上次结果（没再花额度）', d2.status === 200 && d2.json?.data?.cached === true, JSON.stringify(d2.json?.data || d2.json?.error))
    ok('第 2 下是秒回的（没走网络）', d2.ms < 1500, `${d2.ms}ms`)
    ok('两次的摘要一模一样', String(d1.json?.data?.excerpt || '') === String(d2.json?.data?.excerpt || ''))
    const d3 = await call('zh', memoBody, '港口等风', { fresh: true })
    console.log(`   第 3 下（fresh）status ${d3.status} · ${d3.ms}ms · cached=${d3.json?.data?.cached}`)
    ok('带 fresh: true 时绕开记忆、真的重新问模型', d3.status === 200 && d3.json?.data?.cached !== true, JSON.stringify(d3.json?.data || d3.json?.error))
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
}

try {
  await main()
} catch (e: any) {
  console.log('跑挂了：', e?.message)
  fail++
} finally {
  if (uid) {
    const del = await fetch(`${URL_}/auth/v1/admin/users/${uid}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    })
    console.log(`清理临时测试账号 ${email} → ${del.status}`)
  }
  process.exit(fail ? 1 : 0)
}
