import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

let logged = false
let cachedFileKey: { key: string; role: string | null; loadedAt: number } | null = null

function decodeJwtRole(token?: string) {
  const t = String(token || '').trim()
  if (!t) return null
  const parts = t.split('.')
  if (parts.length < 2) return null
  try {
    const p = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = p + '='.repeat((4 - (p.length % 4)) % 4)
    const json = Buffer.from(padded, 'base64').toString('utf-8')
    const obj = JSON.parse(json) as any
    const role = typeof obj?.role === 'string' ? obj.role : null
    return role
  } catch {
    return null
  }
}

function readEnvFileKey() {
  const now = Date.now()
  if (cachedFileKey && now - cachedFileKey.loadedAt < 5000) return cachedFileKey
  try {
    const p1 = path.join(process.cwd(), '.env.local')
    const p2 = path.join(process.cwd(), '.env')
    const filePath = fs.existsSync(p1) ? p1 : fs.existsSync(p2) ? p2 : ''
    if (!filePath) {
      cachedFileKey = { key: '', role: null, loadedAt: now }
      return cachedFileKey
    }
    const text = fs.readFileSync(filePath, 'utf8')
    const m = text.match(/^SUPABASE_SERVICE_ROLE_KEY\s*=\s*(.*)$/m)
    let v = (m?.[1] || '').trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    cachedFileKey = { key: v, role: decodeJwtRole(v), loadedAt: now }
    return cachedFileKey
  } catch {
    cachedFileKey = { key: '', role: null, loadedAt: now }
    return cachedFileKey
  }
}

export function getAdminEnvInfo() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const envServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  const envServiceKeyRole = decodeJwtRole(envServiceKey)
  const file = readEnvFileKey()
  const preferFile = (!envServiceKey || (envServiceKeyRole && envServiceKeyRole !== 'service_role')) && file.key && file.role === 'service_role'
  const serviceKey = preferFile ? file.key : envServiceKey
  const serviceKeyRole = preferFile ? file.role : envServiceKeyRole
  const serviceKeySource = preferFile ? 'env_file' : 'process_env'

  // 缺哪个就记哪个：错误信息里点名，别让排查的人去翻一个其实配好了的变量
  const missing: string[] = []
  if (!supabaseUrl) missing.push('NEXT_PUBLIC_SUPABASE_URL')
  if (!anonKey) missing.push('NEXT_PUBLIC_SUPABASE_ANON_KEY')
  if (!serviceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY')

  return {
    supabaseUrl: supabaseUrl || '',
    anonKey: anonKey || '',
    serviceKey: serviceKey || '',
    env: {
      hasSupabaseUrl: Boolean(supabaseUrl),
      hasAnonKey: Boolean(anonKey),
      hasServiceKey: Boolean(serviceKey),
      serviceKeyLength: serviceKey ? String(serviceKey).length : 0,
      serviceKeyRole,
      serviceKeySource,
      missing,
    },
  }
}

/**
 * 缺哪个变量就点哪个名。
 *
 * 线上实际发生过（2026-10-16）：admin 这个 Vercel 项目**根本没配**
 * `SUPABASE_SERVICE_ROLE_KEY`（实测 GET https://admin.comebrief.com/api/articles
 * 返回 `{"error":"missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY",
 * "env":{"hasSupabaseUrl":true,"hasAnonKey":true,"hasServiceKey":false}}`），
 * 但老文案把两个变量一起摆出来 —— 排查的人会先去怀疑那个**其实好好的** URL，
 * 而站长看到的就是这句自相矛盾的「missing URL」（URL 明明配了）。
 * 按实际缺的那几个点名字。
 */
function describeMissingAdminEnv(env: { missing: string[] }) {
  return `missing env: ${env.missing.join(' / ')}`
}

/** 退路（调用者登录票）走不通的原因，说清楚是哪一环断的。 */
function describeUserClientFailure(accessToken: string, env: { hasSupabaseUrl: boolean; hasAnonKey: boolean }) {
  if (!env.hasSupabaseUrl || !env.hasAnonKey) return 'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY 也没配全'
  if (!String(accessToken || '').trim()) return '请求里没带 Authorization: Bearer <登录票>'
  return '未知原因'
}

export function getSupabaseAdminClient() {
  const info = getAdminEnvInfo()
  if (!logged) {
    logged = true
    console.log('[supabase-admin] env', info.env)
  }
  if (!info.supabaseUrl || !info.serviceKey) {
    return { ok: false as const, client: null as any, env: info.env, error: describeMissingAdminEnv(info.env) }
  }
  if (info.env.serviceKeyRole && info.env.serviceKeyRole !== 'service_role') {
    return {
      ok: false as const,
      client: null as any,
      env: info.env,
      error: `SUPABASE_SERVICE_ROLE_KEY role is ${info.env.serviceKeyRole}, expected service_role`,
    }
  }
  const client = createClient(info.supabaseUrl, info.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  return { ok: true as const, client, env: info.env, error: null as any }
}

/**
 * 「以调用者本人的身份」写库的客户端：anon key + 请求里那张登录票。
 *
 * 为什么需要它：service role key 只在**配得上**的时候才是首选。线上 admin 这个
 * Vercel 项目没配它（见 describeMissingAdminEnv 的注释），于是所有走
 * getSupabaseAdminClient() 的写接口一起 500 —— 站长在话题矩阵里拖动排序 /
 * 删话题永远失败，弹的还是那句自相矛盾的 missing env。
 *
 * 而这几条链路本来就不需要特权身份：后台浏览器一直就是拿同一张票直接写
 * `articles` / `categories` 的（见 app/admin/(protected)/trends/edit/page.tsx），
 * 数据库那边也给 authenticated 放行了（ComeBrief/supabase/20_visibility.sql
 * 第 6 节：这三张表 authenticated 读写全开）。所以「服务端没配 service role key」
 * 不该等于「功能不存在」—— 补配之前，先退回身份等价的那条路。
 *
 * 为什么在 `global.headers` 里放 Authorization 而不是用 `auth.setSession`：
 * 这里只想要 PostgREST 认得的那张票（auth.uid() / RLS 照常生效），
 * 不需要客户端自己会刷新会话、也不该把 token 落到任何存储里。
 */
export function createSupabaseUserClient(accessToken: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const token = String(accessToken || '').trim()
  if (!url || !anonKey || !token) return null
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

export type AdminWriteClient = {
  ok: boolean
  client: any
  /** 这次拿的是哪张票：service role（特权）还是调用者本人的登录票 */
  via: 'service_role' | 'user_token' | null
  env: ReturnType<typeof getAdminEnvInfo>['env']
  error: string | null
}

/**
 * 服务端写库的统一取票口 —— 后台写接口都用它，不要再直接
 * `getSupabaseAdminClient()` 然后 `if (!admin.ok) return 500`。
 *
 *   ① 配了 service role key → 用它（绕过 RLS，最确定）；
 *   ② 没配 → 退回调用者的登录票（授权结果与站长在浏览器里手动操作一致）；
 *   ③ 两条都不可用 → `ok: false` + 说清楚缺什么，由路由决定状态码。
 *
 * 调用方拿到 client 后仍然要**校验写入真的生效**：RLS 拦下的 UPDATE / DELETE
 * 是「200 但 0 行受影响」，不检查就会把失败当成功报给站长
 * （reorder 路由里那句 `.select('name')` 就是干这个的）。
 */
export function getSupabaseWriteClient(accessToken: string): AdminWriteClient {
  const admin = getSupabaseAdminClient()
  if (admin.ok) return { ok: true, client: admin.client, via: 'service_role', env: admin.env, error: null }

  const userClient = createSupabaseUserClient(accessToken)
  if (userClient) {
    console.log('[supabase-admin] 无 service role key，改用调用者的登录票写库（RLS: authenticated）')
    return { ok: true, client: userClient, via: 'user_token', env: admin.env, error: null }
  }

  return {
    ok: false,
    client: null,
    via: null,
    env: admin.env,
    error: `${admin.error || 'missing env'}；退回「调用者的登录票」也不通（${describeUserClientFailure(accessToken, admin.env)}）`,
  }
}
