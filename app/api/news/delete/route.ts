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

export async function POST(req: NextRequest) {
  const reqId = Math.random().toString(16).slice(2, 8)
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    const admin = getSupabaseAdminClient()
    const envInfo = admin.env

    if (!supabaseUrl || !anonKey) return new Response(JSON.stringify({ error: 'missing supabase env', env: envInfo }), { status: 500 })
    if (!admin.ok) return new Response(JSON.stringify({ error: admin.error || 'missing env: SUPABASE_SERVICE_ROLE_KEY', env: envInfo }), { status: 500 })

    const token = getBearer(req)
    if (!token) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    const { data: userData, error: userError } = await authClient.auth.getUser(token)
    if (userError || !userData?.user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })

    const body = await req.json().catch(() => ({}))
    const id = String(body?.id || '').trim()
    if (!id) return new Response(JSON.stringify({ error: 'missing id' }), { status: 400 })

    const adminClient = admin.client
    const { data, error } = await adminClient.from('articles').delete().eq('id', id).select('id')
    if (error) return new Response(JSON.stringify({ error: error.message || 'delete failed', code: error.code, details: error.details, hint: error.hint }), { status: 400 })
    const count = Array.isArray(data) ? data.length : 0
    console.log(`[news-delete:${reqId}] ok`, { id, count, user: userData.user.id })
    return Response.json({ ok: true, count })
  } catch (e: any) {
    console.log(`[news-delete:${reqId}] fatal`, e?.message)
    return new Response(JSON.stringify({ error: e?.message || 'delete failed' }), { status: 500 })
  }
}

