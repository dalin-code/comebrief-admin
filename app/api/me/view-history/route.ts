import type { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'

export const runtime = 'nodejs'
export const maxDuration = 60

const getBearer = (req: NextRequest) => {
  const h = req.headers.get('authorization') || ''
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m?.[1]?.trim() || ''
}

const getUserId = async (req: NextRequest) => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !anonKey) return null
  const token = getBearer(req)
  if (!token) return null
  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const { data, error } = await authClient.auth.getUser(token)
  if (error || !data?.user) return null
  return data.user.id
}

const toInt = (v: any, def: number) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.max(1, Math.trunc(n))
}

export async function POST(req: NextRequest) {
  const admin = getSupabaseAdminClient()
  const envInfo = admin.env
  if (!admin.ok) return new Response(JSON.stringify({ error: admin.error || 'missing env: SUPABASE_SERVICE_ROLE_KEY', env: envInfo }), { status: 500 })

  const userId = await getUserId(req)
  if (!userId) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })

  const body = await req.json().catch(() => ({}))
  const entity_type = String(body?.entity_type || '').trim()
  const entity_id = String(body?.entity_id || '').trim()
  if (entity_type !== 'tool' && entity_type !== 'article') return new Response(JSON.stringify({ error: 'invalid entity_type' }), { status: 400 })
  if (!entity_id) return new Response(JSON.stringify({ error: 'missing entity_id' }), { status: 400 })

  const r = await admin.client.from('view_history').insert({ user_id: userId, entity_type, entity_id } as any)
  if (r.error) return new Response(JSON.stringify({ error: r.error.message, code: r.error.code || null }), { status: 400 })
  return Response.json({ ok: true })
}

export async function GET(req: NextRequest) {
  const admin = getSupabaseAdminClient()
  const envInfo = admin.env
  if (!admin.ok) return new Response(JSON.stringify({ error: admin.error || 'missing env: SUPABASE_SERVICE_ROLE_KEY', env: envInfo }), { status: 500 })

  const userId = await getUserId(req)
  if (!userId) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })

  const url = new URL(req.url)
  const limit = toInt(url.searchParams.get('limit'), 30)

  const r = await admin.client
    .from('view_history')
    .select('id,user_id,entity_type,entity_id,visited_at')
    .eq('user_id', userId)
    .order('visited_at', { ascending: false })
    .limit(limit)

  if (r.error) return new Response(JSON.stringify({ error: r.error.message, code: r.error.code || null }), { status: 400 })
  return Response.json({ items: r.data || [] })
}

export async function DELETE(req: NextRequest) {
  const admin = getSupabaseAdminClient()
  const envInfo = admin.env
  if (!admin.ok) return new Response(JSON.stringify({ error: admin.error || 'missing env: SUPABASE_SERVICE_ROLE_KEY', env: envInfo }), { status: 500 })

  const userId = await getUserId(req)
  if (!userId) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })

  const r = await admin.client.from('view_history').delete().eq('user_id', userId)
  if (r.error) return new Response(JSON.stringify({ error: r.error.message, code: r.error.code || null }), { status: 400 })
  return Response.json({ ok: true })
}

