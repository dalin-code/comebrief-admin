#!/usr/bin/env node
/**
 * 把「上线必需、代码里没有兜底」的远端配置一次性配好：
 *   ① Vercel 项目（admin.comebrief.com）的环境变量：
 *        CRON_SECRET / SUPABASE_SERVICE_ROLE_KEY —— 定时发布
 *        CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN —— AI 封面（Workers AI）
 *        GROQ_API_KEY —— Groq 供应商（选填；写 `groq:模型` 时才用得上）
 *        SILICONFLOW_API_KEY —— 硅基流动供应商（选填；写 `siliconflow:模型` 时才用得上，只认 .com 国际站）
 *   ② GitHub Actions 的仓库 Secret：CRON_SECRET（与 ① 同值，靠 gh CLI 写入）
 *
 * 为什么非配不可：
 *   /api/cron/publish 这条链路**没有请求者身份可以退** —— 缺 CRON_SECRET 直接 503、
 *   缺 SUPABASE_SERVICE_ROLE_KEY 只会 500，定时稿就永远停在 status='scheduled' + published_at=NULL。
 *   （后台写接口不一样，它们能在缺 key 时退回站长的登录票，见 lib/supabaseAdmin.ts。）
 *   /api/ai/draw 的 Cloudflare 两项同样只在服务端读 process.env；仓库根的 .env.local
 *   在 .gitignore 里，不会随代码上传，所以线上点「AI 生成」只会得到一句 Missing env。
 *
 * 用法：
 *   cd Sass
 *   # 只想配 Vercel（GitHub Secret 自己点网页）：
 *   VERCEL_TOKEN=xxx node scripts/set-deploy-env.mts
 *   # 顺手把 GitHub Secret 也写了（本机装了 gh 且已登录，或在环境里给 GH_TOKEN）：
 *   VERCEL_TOKEN=xxx GH_TOKEN=xxx node scripts/set-deploy-env.mts
 *
 * 密钥从哪来：
 *   · CRON_SECRET            —— 环境变量 CRON_SECRET → ~/.comebrief-cron-secret → 都没有就随机生成
 *                               64 位十六进制（32 字节）并落盘到 ~/.comebrief-cron-secret
 *                               （0600、**不带尾换行** —— 手工粘进后台时不会多带一个空行）
 *   · SUPABASE_SERVICE_ROLE_KEY / CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN / GROQ_API_KEY
 *                            —— 读仓库根的 .env.local，**不会**打印出来
 *
 * 可调环境变量：
 *   VERCEL_TOKEN      必填（Vercel → Account Settings → Tokens → Create）
 *   GH_TOKEN          选填；有 gh CLI 时用它写 GitHub Actions Secret（gh 自己已登录也可不给）
 *   VERCEL_PROJECT    选填；跳过「按域名找项目」，直接给项目名或 id
 *   VERCEL_DOMAIN     选填；默认 admin.comebrief.com
 *   VERCEL_TARGETS    选填；默认 production,preview
 *   GH_REPO           选填；默认 dalin-code/comebrief-admin
 *   SKIP_REDEPLOY=1   选填；配完不触发重新部署（默认触发一次 —— 环境变量的改动要重新部署才生效）
 *   ONLY_CLOUDFLARE=1 选填；只同步 AI 封面用的 Cloudflare 两项，不碰 CRON_SECRET / GitHub Secret
 *                     （只修「线上 AI 生成封面报 Missing env」时用这个，避免顺带改写定时发布的密钥）
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const API = 'https://api.vercel.com'
const VERCEL_TOKEN = process.env.VERCEL_TOKEN?.trim() || ''
const DOMAIN = process.env.VERCEL_DOMAIN?.trim() || 'admin.comebrief.com'
const TARGETS = (process.env.VERCEL_TARGETS?.trim() || 'production,preview')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const GH_REPO = process.env.GH_REPO?.trim() || 'dalin-code/comebrief-admin'
const ONLY_CLOUDFLARE = process.env.ONLY_CLOUDFLARE === '1'
const SECRET_FILE = join(homedir(), '.comebrief-cron-secret')
const KEY_CRON = 'CRON_SECRET'
const KEY_SERVICE = 'SUPABASE_SERVICE_ROLE_KEY'
const KEY_CF_ACCOUNT = 'CLOUDFLARE_ACCOUNT_ID'
const KEY_CF_TOKEN = 'CLOUDFLARE_API_TOKEN'
const KEY_GROQ = 'GROQ_API_KEY'
const KEY_SILICONFLOW = 'SILICONFLOW_API_KEY'
/**
 * 「线上缺了只少一项能力」的选填变量：有就同步，没有就提示一句，**绝不中断脚本**。
 *   CLOUDFLARE_*  —— AI 生成封面 / 重绘（Workers AI）
 *   GROQ_API_KEY  —— Groq 供应商（环境变量里写 `groq:xxx` 的模型时才需要）
 *   SILICONFLOW_API_KEY —— 硅基流动（写 `siliconflow:xxx` 的模型时才需要；只认国际站 .com）
 */
const OPTIONAL_LOCAL_KEYS = [KEY_CF_ACCOUNT, KEY_CF_TOKEN, KEY_GROQ, KEY_SILICONFLOW] as const
/** 缺了之后「站长会看到什么」—— 提示必须说人话，别只说一句「跳过」 */
const OPTIONAL_SKIP_HINT: Record<string, string> = {
  [KEY_CF_ACCOUNT]: '线上点「AI 生成」仍会报 Missing env',
  [KEY_CF_TOKEN]: '线上点「AI 生成」仍会报 Missing env',
  [KEY_GROQ]: '线上用不了 groq: 前缀的模型（主模型是 Gemini 的话暂时没影响）',
  [KEY_SILICONFLOW]: '线上用不了 siliconflow: 前缀的模型（主模型是 Gemini 的话暂时没影响）',
}
/** 全部从 .env.local 抄过去、以 encrypted 写进 Vercel 的变量（CRON_SECRET 单独生成） */
const LOCAL_ENV_KEYS = [KEY_SERVICE, ...OPTIONAL_LOCAL_KEYS] as const

const say = (s = '') => console.log(s)

/** 统一的 Vercel REST 调用：非 2xx 直接把接口原话抛出来，别吞。 */
async function vercel(path: string, init: RequestInit = {}, teamId?: string) {
  const url = new URL(API + path)
  if (teamId) url.searchParams.set('teamId', teamId)
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${VERCEL_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // 非 JSON（比如网关的 HTML 报错页），下面按文本报
  }
  if (!res.ok) {
    const detail = json?.error?.message ?? text.slice(0, 300)
    throw new Error(`Vercel ${init.method ?? 'GET'} ${path} → ${res.status}：${detail}`)
  }
  return json
}

/** 项目可能挂在个人名下，也可能挂在某个 team 下 —— 两边都翻一遍。 */
async function listScopes(): Promise<(string | undefined)[]> {
  const scopes: (string | undefined)[] = [undefined]
  try {
    const teams = await vercel('/v2/teams?limit=100')
    for (const t of teams?.teams ?? []) scopes.push(t.id)
  } catch {
    // 个人 token 读不到 teams 也无所谓
  }
  return scopes
}

async function listProjects(teamId?: string) {
  const out: { id: string; name: string }[] = []
  let until: string | undefined
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({ limit: '100' })
    if (until) qs.set('until', until)
    const data = await vercel(`/v9/projects?${qs.toString()}`, {}, teamId)
    out.push(...(data?.projects ?? []))
    until = data?.pagination?.next ? String(data.pagination.next) : undefined
    if (!until) break
  }
  return out
}

async function hasDomain(projectId: string, teamId?: string) {
  try {
    const data = await vercel(`/v9/projects/${projectId}/domains?limit=100`, {}, teamId)
    return (data?.domains ?? []).some((d: { name: string }) => d.name === DOMAIN)
  } catch {
    return false
  }
}

/** 找 admin.comebrief.com 落在哪个项目上 —— 不靠人工猜项目名。 */
async function findProject() {
  const explicit = process.env.VERCEL_PROJECT?.trim()
  for (const teamId of await listScopes()) {
    for (const p of await listProjects(teamId)) {
      if (explicit) {
        if (p.name !== explicit && p.id !== explicit) continue
      } else if (!(await hasDomain(p.id, teamId))) {
        continue
      }
      return { id: p.id as string, name: p.name as string, teamId }
    }
  }
  throw new Error(
    explicit
      ? `在 Vercel 里找不到名为 ${explicit} 的项目（当前 token 可见的范围都翻过了）`
      : `没有任何项目挂着 ${DOMAIN} 这个域名；可用 VERCEL_PROJECT=<项目名> 直接指定`,
  )
}

/**
 * CRON_SECRET 从哪来：环境变量 → ~/.comebrief-cron-secret → 随机生成。
 * 无论哪种来源，都保证 ~/.comebrief-cron-secret 里存着同一个值 —— 后面那两条手工步骤
 * （GitHub 网页填 Secret、curl 验证）都要从这里取，值不进 shell 历史、不进聊天记录。
 */
function resolveCronSecret() {
  const fromEnv = process.env.CRON_SECRET?.trim()
  if (fromEnv) {
    if (!existsSync(SECRET_FILE) || readFileSync(SECRET_FILE, 'utf8').trim() !== fromEnv) {
      writeFileSync(SECRET_FILE, fromEnv, { mode: 0o600 })
    }
    return { value: fromEnv, source: '环境变量 CRON_SECRET（已同步到 ' + SECRET_FILE + '）' }
  }
  if (existsSync(SECRET_FILE)) {
    const saved = readFileSync(SECRET_FILE, 'utf8').trim()
    if (saved) return { value: saved, source: SECRET_FILE }
  }
  const fresh = randomBytes(32).toString('hex')
  writeFileSync(SECRET_FILE, fresh, { mode: 0o600 })
  chmodSync(SECRET_FILE, 0o600)
  return { value: fresh, source: `${SECRET_FILE}（本次新建，64 位十六进制）` }
}

/**
 * 从本地 .env.local 读一个变量，全程不打印值。
 * `missingOk` 用于「缺了只是少一项能力」的变量（Cloudflare 两项）：返回空串，
 * 由调用方决定是跳过还是提示，别让整脚本因为一项没配就什么都不做。
 */
function readLocalEnv(key: string, missingOk = false) {
  const file = '.env.local'
  if (!existsSync(file)) {
    if (missingOk) return ''
    throw new Error('仓库根没有 .env.local —— 先照 .env.example 配好本地环境再跑')
  }
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const i = s.indexOf('=')
    if (i <= 0) continue
    if (s.slice(0, i).trim() !== key) continue
    const v = s.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    if (v) return v
  }
  if (missingOk) return ''
  throw new Error(`.env.local 里没找到 ${key}`)
}

type Project = { id: string; name: string; teamId?: string }

async function upsertEnv(project: Project, key: string, value: string) {
  await vercel(
    `/v10/projects/${project.id}/env?upsert=true`,
    { method: 'POST', body: JSON.stringify({ key, value, type: 'encrypted', target: TARGETS }) },
    project.teamId,
  )
}

/** 回读项目变量清单（接口只回加密块，看不到值）—— 证明「真的写进去了」。 */
async function printEnvState(project: Project, keys: string[] = [KEY_CRON, ...LOCAL_ENV_KEYS]) {
  const data = await vercel(`/v9/projects/${project.id}/env?decrypt=false&limit=100`, {}, project.teamId)
  const rows: { key: string; target?: string[] }[] = data?.envs ?? []
  for (const key of keys) {
    const hit = rows.find((r) => r.key === key)
    say(`   ${hit ? '✅' : '❌'} ${key.padEnd(26)} ${hit ? (hit.target ?? []).join(',') : '不在项目里'}`)
  }
}

function setGithubSecret(value: string) {
  let hasGh = false
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' })
    hasGh = true
  } catch {
    hasGh = false
  }
  if (!hasGh) {
    say('   ⚠️ 本机没有 gh CLI —— 这个 Secret 只能手工点一次（Vercel 那边的变量已在上一步处理）：')
    say(`      ① 打开 https://github.com/${GH_REPO}/settings/secrets/actions`)
    say(`      ② New repository secret → Name 填 ${KEY_CRON}`)
    say(`      ③ Secret 里粘这一串：pbcopy < ${SECRET_FILE}   # 文件不带尾换行，直接 ⌘V`)
    say('      或者先 brew install gh，再重跑本脚本（gh 已登录即可，也可用 GH_TOKEN=xxx）')
    return false
  }
  execFileSync('gh', ['secret', 'set', KEY_CRON, '--repo', GH_REPO, '--body-file', '-'], {
    input: value,
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  return true
}

/** 环境变量改完要重新部署才生效 —— 按项目自带的 git 链接重发一次生产部署。 */
async function redeploy(project: Project) {
  const full = await vercel(`/v9/projects/${project.id}`, {}, project.teamId)
  const link = full?.link
  if (!link?.repoId) {
    say('   ⚠️ 这个项目没有可供 API 复用的 git 链接信息 —— 请到 Vercel 后台点一次 Redeploy')
    return
  }
  const dep = await vercel(
    '/v13/deployments?forceNew=1',
    {
      method: 'POST',
      body: JSON.stringify({
        name: project.name,
        project: project.id,
        target: 'production',
        gitSource: { type: link.type || 'github', repoId: link.repoId, ref: link.productionBranch || 'main' },
      }),
    },
    project.teamId,
  )
  say(`   ✅ 已触发重新部署：https://${dep?.url ?? dep?.id}`)
}

async function main() {
  const cron = ONLY_CLOUDFLARE ? null : resolveCronSecret()
  say('【1/3】密钥来源')
  if (cron) {
    say(`   ${KEY_CRON} ← ${cron.source}`)
    say(`   ${LOCAL_ENV_KEYS.join(' / ')} ← .env.local（值不打印）`)
  } else {
    say('   ONLY_CLOUDFLARE=1：只同步 Cloudflare 两项，不碰 CRON_SECRET / GitHub Secret')
    say(`   ${KEY_CF_ACCOUNT} / ${KEY_CF_TOKEN} ← .env.local（值不打印）`)
  }
  const envValues: Array<[string, string]> = []
  if (VERCEL_TOKEN && cron) envValues.push([KEY_SERVICE, readLocalEnv(KEY_SERVICE)])
  // Cloudflare 两项缺了只是「AI 封面不可用」、Groq 缺了只是少一个供应商 ——
  // 都不该让定时发布那部分也配不成，所以统一按「选填」处理。
  if (VERCEL_TOKEN) {
    for (const key of OPTIONAL_LOCAL_KEYS) {
      const value = readLocalEnv(key, true)
      if (value) envValues.push([key, value])
      else say(`   ⚠️ .env.local 里没有 ${key} —— 这次跳过；${OPTIONAL_SKIP_HINT[key] ?? ''}`)
    }
  }

  say('【2/3】Vercel 环境变量')
  let project: Project | null = null
  if (!VERCEL_TOKEN) {
    say('   ⚠️ 没给 VERCEL_TOKEN，这一步跳过。补齐办法：')
    say('      Vercel → Account Settings → Tokens → Create，再重跑：')
    say('      VERCEL_TOKEN=xxx node scripts/set-deploy-env.mts')
  } else {
    project = await findProject()
    say(`   项目：${project.name}（${project.id}）${project.teamId ? ' team=' + project.teamId : ''}`)
    if (cron) await upsertEnv(project, KEY_CRON, cron.value)
    for (const [key, value] of envValues) await upsertEnv(project, key, value)
    say(`   已写入 target=${TARGETS.join(',')}，回读清单：`)
    await printEnvState(project, ONLY_CLOUDFLARE ? [KEY_CF_ACCOUNT, KEY_CF_TOKEN] : undefined)
    if (process.env.SKIP_REDEPLOY === '1') {
      say('   ℹ️ SKIP_REDEPLOY=1，没触发重新部署 —— 记得自己 Redeploy 一次，否则新变量不生效')
    } else {
      await redeploy(project)
    }
  }

  say('【3/3】GitHub Actions Secret')
  let ghOk = true
  if (!cron) {
    say('   已跳过（ONLY_CLOUDFLARE=1，没动定时发布那套配置）')
  } else {
    ghOk = setGithubSecret(cron.value)
  }

  say()
  if (cron) {
    say('验证（dry=1 不写库，只报「会翻哪几篇」）：')
    say(`   curl -sS -H "Authorization: Bearer $(cat ${SECRET_FILE})" \\`)
    say(`     "https://${DOMAIN}/api/cron/publish?dry=1"`)
    say('   或 GitHub → Actions → Publish scheduled content → Run workflow')
  } else {
    say('验证 AI 封面：编辑页点一次「AI 生成」，或右侧「🩺 AI 自检 → 只查配置」')
    say('   看 Cloudflare 两项是否为 ✓（缺变量时按钮会直接报 Missing env）')
  }
  say()
  // 有项没配完就退出码非 0：免得脚本自己「看起来成功了」，实际定时任务还是跑不起来。
  const coverReady =
    envValues.some(([key]) => key === KEY_CF_ACCOUNT) && envValues.some(([key]) => key === KEY_CF_TOKEN)
  const ready = Boolean(project && ghOk && coverReady)
  if (project && ghOk && !coverReady) say('   定时发布已就绪；AI 封面仍缺 Cloudflare 两项（见上面的 ⚠️）')
  say(ready ? '全部就绪 ✅' : '有没配完的项 ⚠️（见上面提示）')
  if (!ready) process.exitCode = 1
}

main().catch((err) => {
  console.error('❌', err instanceof Error ? err.message : err)
  process.exit(1)
})
