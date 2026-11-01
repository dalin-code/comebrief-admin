/**
 * P12 诊断：候选模型「谁挂了、为什么挂」。
 *
 * 背景（2026-10-26 站长报的）：
 *   点「AI 生成」一律失败，提示框只有一句「gemini-3.5-flash 都刚失败过，还在冷却：最快 4 秒后可以再点」，
 *   等 4 秒再点还是这句。逐个直连才发现四个候选没有一个是真「被限流」：
 *     · Gemini 两个 Flash        429 / PerDayPerProjectPerModel（当日额度）
 *     · Groq gpt-oss-20b         413（免费档 8000 TPM，长提示词 + max_tokens 8192 一次就顶爆）
 *     · OpenRouter deepseek      402（只能 afford 3386 token，我们要 8192）
 *     · 硅基流动 DeepSeek        402 / code 30001（余额 0）
 *   根因是代码不诚实，不是模型集体罢工：
 *     ① 402 / 413 以前落进 `unknown`：不进冷却、提示语照抄英文原文；
 *     ② `composeFailure()` 按 kind 优先级挑主因，而上一轮留下的 `cold` 条目挂在优先级更高的
 *        `rate` 上 —— 于是「冷却剩 4 秒」把「余额不足 / 超 TPM」全盖住了。
 *   现在：402 → `quota`（冷却 10 分钟，提示语直说「余额不足，去充值」），
 *         413 → `toolarge`（60 秒，「调小 maxOutputTokens」），`cold` 条目永不担任主因。
 *
 * 三段：
 *   A. 离线分类断言（不联网、不花额度）：402 / 413 / 429-日额度 / 401 / 404 / 400 / 503 → kind + 提示语
 *   B. 配置解析：主模型 + `AI_MODEL_FALLBACK` 的每个 spec 解析成哪家、走哪个协议、当前冷却与否
 *   C. 真调每个候选（会花极少量额度；`P12_SKIP_MODELS=1` 跳过）
 *
 * 用法：
 *   cd Sass && node --import ./scripts/_ts-resolve.mts scripts/p12-ai-candidates-probe.mts
 *
 * 额度紧张时只跑离线部分：
 *   P12_OFFLINE=1 node --import ./scripts/_ts-resolve.mts scripts/p12-ai-candidates-probe.mts
 *
 * 想按「写正文」的真实形状测（story 路由就是 maxOutputTokens 8192）：
 *   P12_MAX=8192 node --import ./scripts/_ts-resolve.mts scripts/p12-ai-candidates-probe.mts
 */
import { existsSync, readFileSync } from 'node:fs'
import { describeProviderError, parseProviderError } from '../lib/aiGemini.ts'
import {
  callText,
  describeAiRouting,
  parseModelChain,
  resolveModelSpec,
  resolveTarget,
  snapshotCooldowns,
} from '../lib/aiProvider.ts'

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

/* ---------------- A. 离线分类断言 ---------------- */

console.log('A. 错误分类（真实回包片段，不联网）')

const kindOf = (status: number, raw: string) => parseProviderError(status, raw).kind

const 硅基402 = parseProviderError(402, '{"code":30001,"message":"Sorry, your account balance is insufficient"}')
ok('402（硅基流动 30001）→ quota', 硅基402.kind === 'quota', 硅基402.kind)
ok('402 把 code 抠出来（终端日志要用）', 硅基402.code === '30001', 硅基402.code)
ok(
  '402（OpenRouter 按 max_tokens 预扣额度）→ quota',
  kindOf(402, '{"error":{"message":"This request requires more credits, or fewer max_tokens.","code":402}}') === 'quota'
)
ok(
  '413（Groq rate_limit_exceeded）→ toolarge',
  kindOf(413, '{"error":{"code":"rate_limit_exceeded","message":"Request too large for model"}}') === 'toolarge'
)
ok(
  '429 + quotaId=PerDay → quota（不是 rate）',
  kindOf(
    429,
    '{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}'
  ) === 'quota'
)
ok('429 普通限流 → rate', kindOf(429, '{"error":{"message":"rate limit exceeded"}}') === 'rate')
ok('401 → auth（改 Key 立刻能试，不该冷却）', kindOf(401, '{"error":{"message":"invalid api key"}}') === 'auth')
ok('404 → notfound', kindOf(404, '{"error":{"message":"model not found"}}') === 'notfound')
ok('400 → badrequest', kindOf(400, '{"error":{"message":"bad request"}}') === 'badrequest')
ok('503 → server', kindOf(503, '<html>high demand</html>') === 'server')
ok('没见过的 418 → unknown（不硬塞）', kindOf(418, '') === 'unknown')

const 余额 = describeProviderError('硅基流动', 402, '{"code":30001,"message":"Sorry, your account balance is insufficient"}')
ok('402 提示语说「余额不足」', /余额不足/.test(余额), 余额)
ok('402 提示语不再出现「冷却」（旧 bug：真死因被冷却盖住）', !/冷却/.test(余额), 余额)
const 太大 = describeProviderError('Groq', 413, '{"error":{"message":"Request too large for model"}}')
ok('413 提示语点出 maxOutputTokens', /maxOutputTokens/.test(太大), 太大)

// 模型写法压根解析不了（供应商名打错）：一次网络都不发，也不能在 details 里编一个 HTTP 码
const 假供应商 = await callText({ model: 'nosuchprovider:x', fallbackModel: null, prompt: 'hi', retries: 0 })
ok(
  '写法解析失败 → 500，但 details 不编 HTTP 码',
  假供应商.ok === false && 假供应商.status === 500 && !/HTTP \d/.test(假供应商.details.join(' ')),
  假供应商.ok === false ? JSON.stringify(假供应商.details) : 'ok'
)


/* ---------------- B. 配置解析 ---------------- */

console.log('\nB. 配置解析（读 .env.local，不联网）')

const storySpec = resolveModelSpec('story')
const chain = parseModelChain(process.env.AI_MODEL_FALLBACK)
ok(`story 主模型能解析（${storySpec}）`, resolveTarget(storySpec).ok)
ok('AI_MODEL_FALLBACK 不是空的', chain.length > 0, JSON.stringify(chain))
const 坏链 = chain.filter((s) => resolveTarget(s).ok === false)
ok('每个兜底 spec 都能解析（前缀写错当场就报）', 坏链.length === 0, JSON.stringify(坏链))

// 硅基流动的模型 ID 全是 `org/model`，和 OpenRouter 的 slug 长得一模一样 → 前缀不是可选项
const 裸写 = resolveTarget('deepseek-ai/DeepSeek-V3.2')
const 带前缀 = resolveTarget('siliconflow:deepseek-ai/DeepSeek-V3.2')
ok('裸写 `deepseek-ai/...` 会被当成 OpenRouter（所以必须带前缀）', 裸写.ok === true && 裸写.target.provider === 'openrouter')
ok(
  '`siliconflow:` 前缀 → 硅基流动，且只走国际站 .com（.cn 回 30014 Token is invalid）',
  带前缀.ok === true && 带前缀.target.provider === 'siliconflow' && 带前缀.target.baseUrl.includes('api.siliconflow.com'),
  带前缀.ok === true ? 带前缀.target.baseUrl : 带前缀.error
)

const routing = describeAiRouting()
for (const t of routing.tasks) {
  console.log(
    `   ${t.task.padEnd(9)} ${t.spec.padEnd(26)} ${
      t.ok ? `${t.provider} / ${t.protocol}${t.cooldown ? ` / ${t.cooldown}` : ''}` : `✗ ${t.error}`
    }`
  )
}
for (const f of routing.fallback) {
  console.log(`   兜底       ${f.spec.padEnd(26)} ${f.ok ? `${f.label}${f.cooldown ? ` / ${f.cooldown}` : ''}` : `✗ ${f.error}`}`)
}

if (process.env.P12_OFFLINE === '1') {
  console.log('\n（P12_OFFLINE=1）跳过真调；上面 B 段已经能看出「写的哪个模型」对不对')
} else if (process.env.P12_SKIP_MODELS === '1') {
  console.log('\n（P12_SKIP_MODELS=1）跳过真调，不花额度')
} else {
  /* ---------------- C. 真调每个候选 ---------------- */

  const maxOutputTokens = Number(process.env.P12_MAX || 1024)
  const specs = [storySpec, ...chain].filter((s, i, a) => s && a.indexOf(s) === i)
  console.log(`\nC. 真调（maxOutputTokens=${maxOutputTokens}，会花少量额度）`)

  for (const spec of specs) {
    const t0 = Date.now()
    const r = await callText({
      model: spec,
      // 只看这一个模型自己行不行：兜底链在 B 段已经列清楚了，这里不叠
      fallbackModel: null,
      prompt: '用一句话介绍你自己（不超过 20 个字）',
      maxOutputTokens,
      retries: 0,
      timeoutMs: 25_000,
      totalBudgetMs: 30_000,
      // 诊断必须无视冷却，否则永远只能看到「剩 N 秒」—— 这正是 2026-10-26 的假象来源
      ignoreCooldown: true,
      thinkingBudget: 0,
    })
    const ms = Date.now() - t0
    if (r.ok === true) {
      console.log(`   ✅ ${spec.padEnd(30)} ${String(ms).padStart(5)}ms  「${r.text.replace(/\s+/g, ' ').slice(0, 24)}」`)
    } else {
      console.log(`   ❌ ${spec.padEnd(30)} ${String(ms).padStart(5)}ms  ${r.status} ${r.kind} — ${r.error}`)
    }
  }

  const cold = snapshotCooldowns()
  if (cold.length > 0) {
    console.log('\n   冷却表（刚失败过的）：')
    for (const c of cold) console.log(`     ${c.spec.padEnd(30)} 剩 ${Math.ceil(c.leftMs / 1000)} 秒（${c.reason}）`)
  }
}

/* ---------------- D. 真 HTTP：后台「AI 创作」的真实路径 ---------------- */

if (process.env.P12_HTTP === '1') {
  console.log('\nD. 真 HTTP（临时管理员 → POST /api/ai/story，验的是站长真点的那条路）')
  const supa = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  const base = process.env.P12_BASE || 'http://localhost:3001'
  if (!supa || !anon || !service) {
    console.log('   缺 Supabase 配置（NEXT_PUBLIC_SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY）—— 跳过')
  } else {
    // requireAdmin 只认「登录过的用户」，不认具体是谁 → 建个临时的，跑完删掉
    const email = `zz-p12-${Date.now()}@example.com`
    const password = 'Zz' + Math.random().toString(36).slice(2) + '!Aa1'
    let uid = ''
    try {
      const created: any = await (
        await fetch(`${supa}/auth/v1/admin/users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: service, Authorization: `Bearer ${service}` },
          body: JSON.stringify({ email, password, email_confirm: true }),
        })
      ).json()
      uid = created?.id || created?.user?.id || ''
      const signed: any = await (
        await fetch(`${supa}/auth/v1/token?grant_type=password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: anon },
          body: JSON.stringify({ email, password }),
        })
      ).json()
      const token = signed?.access_token
      if (!token) {
        console.log(`   拿不到登录票：${JSON.stringify(signed).slice(0, 200)}`)
      } else {
        const t0 = Date.now()
        const resp = await fetch(`${base}/api/ai/story`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ idea: '黄昏的公交站，一个人等一辆不会来的车', length: 800 }),
        })
        const json: any = await resp.json().catch(() => ({}))
        const ms = Date.now() - t0
        const text = String(json?.data?.html || '')
        console.log(`   status ${resp.status} · ${ms}ms · model=${json?.data?.model || ''} · 正文 ${text.length} 字符`)
        if (resp.status !== 200) {
          console.log(`   ${JSON.stringify({ error: json?.error, kind: json?.kind, details: json?.details }).slice(0, 400)}`)
        }
        ok('POST /api/ai/story 返回 200', resp.status === 200 && json?.ok === true, JSON.stringify(json).slice(0, 300))
        ok('真写出正文（路由自己要求 ≥120 字）', text.replace(/<[^>]+>/g, '').length >= 120, `len=${text.length}`)

        const st = await fetch(`${base}/api/ai/status`, { headers: { Authorization: `Bearer ${token}` } })
        const sj: any = await st.json().catch(() => ({}))
        ok('GET /api/ai/status 200（加了 details/kind 之后自检没炸）', st.status === 200 && sj?.ok === true)
        ok('自检里四个任务的模型分配还在', Array.isArray(sj?.data?.routing) && sj.data.routing.length === 4)
        ok(
          '环境变量表里能看到 SILICONFLOW_API_KEY',
          Object.prototype.hasOwnProperty.call(sj?.data?.keys || {}, 'SILICONFLOW_API_KEY'),
          JSON.stringify(Object.keys(sj?.data?.keys || {}))
        )
      }
    } finally {
      if (uid) {
        const del = await fetch(`${supa}/auth/v1/admin/users/${uid}`, {
          method: 'DELETE',
          headers: { apikey: service, Authorization: `Bearer ${service}` },
        })
        console.log(`   清理临时测试账号 → ${del.status}`)
      }
    }
  }
} else {
  console.log('\n（要看真实点击路径：P12_HTTP=1，前提是 dev server 已开在 :3001）')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1

