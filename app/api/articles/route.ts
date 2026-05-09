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
  const q = (url.searchParams.get('q') || '').trim()
  const sort = (url.searchParams.get('sort') || 'newest').trim()
  const page = toInt(url.searchParams.get('page'), 1)
  const pageSize = toInt(url.searchParams.get('pageSize'), 18)
  const excludeId = (url.searchParams.get('excludeId') || '').trim()
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  const cols = 'id,slug,title,excerpt,published_at,reading_time,cover_url,author_name,views_count'
  let query = admin.client.from('articles').select(cols, { count: 'exact' })

  if (excludeId) query = query.neq('id', excludeId)

  if (q) {
    const like = `%${q}%`
    query = query.or(`title.ilike.${like},excerpt.ilike.${like}`)
  }

  if (sort === 'views') query = query.order('views_count', { ascending: false })
  else query = query.order('published_at', { ascending: false })

  const { data, error, count } = await query.range(from, to)
  if (error) return new Response(JSON.stringify({ error: error.message, code: error.code || null }), { status: 400 })

  return Response.json({
    items: data || [],
    total: typeof count === 'number' ? count : 0,
    page,
    pageSize,
  })
}

