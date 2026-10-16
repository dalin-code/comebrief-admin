#!/usr/bin/env node
/**
 * 把「定时发布」必需的两个**远端配置**一次性配好（这是线上唯一没有代码兜底的地方）：
 *   ① Vercel 项目（admin.comebrief.com）的环境变量：CRON_SECRET / SUPABASE_SERVICE_ROLE_KEY
 *   ② GitHub Actions 的仓库 Secret：CRON_SECRET（与 ① 同值，靠 gh CLI 写入）
 *
 * 为什么非配不可：
 *   /api/cron/publish 这条链路**没有请求者身份可以退** —— 缺 CRON_SECRET 直接 503、
 *   缺 SUPABASE_SERVICE_ROLE_KEY 只会 500，定时稿就永远停在 status='scheduled' + published_at=NULL。
 *   （后台写接口不一样，它们能在缺 key 时退回站长的登录票，见 lib/supabaseAdmin.ts。）
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
 *                               64 位十六进制（32 字节）并落盘到 ~/.comebrief-cron-secret（0600）
 *   · SUPABASE_SERVICE_ROLE_KEY —— 读仓库根的 .env.local，**不会**打印出来
 *
 * 可调环境变量：
 *   VERCEL_TOKEN      必填（Vercel → Account Settings → Tokens → Create）
 *   GH_TOKEN          选填；有 gh CLI 时用它写 GitHub Actions Secret（gh 自己已登录也可不给）
 *   VERCEL_PROJECT    选填；跳过「按域名找项目」，直接给项目名或 id
 *   VERCEL_DOMAIN     选填；默认 admin.comebrief.com
 *   VERCEL_TARGETS    选填；默认 production,preview
 *   GH_REPO           选填；默认 dalin-code/comebrief-admin
 *   SKIP_REDEPLOY=1   选填；配完不触发重新部署（默认触发一次 —— 环境变量的改动要重新部署才生效）
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
const SECRET_FILE = join(homedir(), '.comebrief-cron-secret')
const KEY_CRON = 'CRON_SECRET'
const KEY_SERVICE = 'SUPABASE_SERVICE_ROLE_KEY'

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
      writeFileSync(SECRET_FILE, fromEnv + '\n', { mode: 0o600 })
    }
    return { value: fromEnv, source: '环境变量 CRON_SECRET（已同步到 ' + SECRET_FILE + '）' }
  }
  if (existsSync(SECRET_FILE)) {
    const saved = readFileSync(SECRET_FILE, 'utf8').trim()
    if (saved) return { value: saved, source: SECRET_FILE }
  }
  const fresh = randomBytes(32).toString('hex')
  writeFileSync(SECRET_FILE, fresh + '\n', { mode: 0o600 })
  chmodSync(SECRET_FILE, 0o600)
  return { value: fresh, source: `${SECRET_FILE}（本次新建，64 位十六进制）` }
}

/** 服务端 key 从本地 .env.local 拿，全程不打印值。 */
function readServiceKey() {
  const file = '.env.local'
  if (!existsSync(file)) throw new Error('仓库根没有 .env.local —— 先照 .env.example 配好本地环境再跑')
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const i = s.indexOf('=')
    if (i <= 0) continue
    if (s.slice(0, i).trim() !== KEY_SERVICE) continue
    const v = s.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    if (v) return v
  }
  throw new Error(`.env.local 里没找到 ${KEY_SERVICE}`)
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
async function printEnvState(project: Project) {
  const data = await vercel(`/v9/projects/${project.id}/env?decrypt=false&limit=100`, {}, project.teamId)
  const rows: { key: string; target?: string[] }[] = data?.envs ?? []
  for (const key of [KEY_CRON, KEY_SERVICE]) {
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
    say('   ⚠️ 本机没有 gh CLI —— 这个 Secret 只能手工点一次（Vercel 那两个变量已配好）：')
    say(`      ① 打开 https://github.com/${GH_REPO}/settings/secrets/actions`)
    say(`      ② New repository secret → Name 填 ${KEY_CRON}`)
    say(`      ③ Secret 里粘这一行的输出：cat ${SECRET_FILE}`)
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
  const cron = resolveCronSecret()
  say('【1/3】密钥来源')
  say(`   ${KEY_CRON} ← ${cron.source}`)
  say(`   ${KEY_SERVICE} ← .env.local（值不打印）`)
  const serviceKey = VERCEL_TOKEN ? readServiceKey() : ''

  say('【2/3】Vercel 环境变量')
  let project: Project | null = null
  if (!VERCEL_TOKEN) {
    say('   ⚠️ 没给 VERCEL_TOKEN，这一步跳过。补齐办法：')
    say('      Vercel → Account Settings → Tokens → Create，再重跑：')
    say('      VERCEL_TOKEN=xxx node scripts/set-deploy-env.mts')
  } else {
    project = await findProject()
    say(`   项目：${project.name}（${project.id}）${project.teamId ? ' team=' + project.teamId : ''}`)
    await upsertEnv(project, KEY_CRON, cron.value)
    await upsertEnv(project, KEY_SERVICE, serviceKey)
    say(`   已写入 target=${TARGETS.join(',')}，回读清单：`)
    await printEnvState(project)
    if (process.env.SKIP_REDEPLOY === '1') {
      say('   ℹ️ SKIP_REDEPLOY=1，没触发重新部署 —— 记得自己 Redeploy 一次，否则新变量不生效')
    } else {
      await redeploy(project)
    }
  }

  say('【3/3】GitHub Actions Secret')
  const ghOk = setGithubSecret(cron.value)

  say()
  say('验证（dry=1 不写库，只报「会翻哪几篇」）：')
  say(`   curl -sS -H "Authorization: Bearer $(cat ${SECRET_FILE})" \\`)
  say(`     "https://${DOMAIN}/api/cron/publish?dry=1"`)
  say('   或 GitHub → Actions → Publish scheduled content → Run workflow')
  say()
  // 有项没配完就退出码非 0：免得脚本自己「看起来成功了」，实际定时任务还是跑不起来。
  const ready = Boolean(project && ghOk)
  say(ready ? '全部就绪 ✅' : '有没配完的项 ⚠️（见上面提示）')
  if (!ready) process.exitCode = 1
}

main().catch((err) => {
  console.error('❌', err instanceof Error ? err.message : err)
  process.exit(1)
})
