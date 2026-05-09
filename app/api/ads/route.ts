import type { NextRequest } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'

export const runtime = 'nodejs'
export const maxDuration = 60

const toInt = (v: any, def: number) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.max(1, Math.trunc(n))
}

export async function GET(req: NextRequest) {
  const admin = getSupabaseAdminClient()
  const envInfo = admin.env
  if (!admin.ok) return new Response(JSON.stringify({ error: admin.error || 'missing env: SUPABASE_SERVICE_ROLE_KEY', env: envInfo }), { status: 500 })

  const url = new URL(req.url)
  const position = (url.searchParams.get('position') || '').trim()
  const limit = toInt(url.searchParams.get('limit'), 1)
  if (!position) return new Response(JSON.stringify({ error: 'missing position' }), { status: 400 })

  const r = await admin.client.rpc('get_active_ads', { pos: position, limit_n: limit })
  if (!r.error) return Response.json(r.data || [])

  const cols = 'id,title,image_url,link,position,start_at,end_at,weight,active,clicks,created_at,updated_at'
  const fallback = await admin.client
    .from('ads')
    .select(cols)
    .eq('position', position)
    .eq('active', true)
    .order('weight', { ascending: false })
    .limit(limit)

  if (fallback.error) return new Response(JSON.stringify({ error: fallback.error.message, code: fallback.error.code || null }), { status: 400 })
  return Response.json(fallback.data || [])
}
