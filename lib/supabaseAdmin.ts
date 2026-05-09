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
    },
  }
}

export function getSupabaseAdminClient() {
  const info = getAdminEnvInfo()
  if (!logged) {
    logged = true
    console.log('[supabase-admin] env', info.env)
  }
  if (!info.supabaseUrl || !info.serviceKey) {
    return { ok: false as const, client: null as any, env: info.env, error: 'missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' }
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
