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

export async function GET(req: NextRequest) {
  const admin = getSupabaseAdminClient()
  const envInfo = admin.env
  if (!admin.ok) return new Response(JSON.stringify({ error: admin.error || 'missing env: SUPABASE_SERVICE_ROLE_KEY', env: envInfo }), { status: 500 })

  const userId = await getUserId(req)
  if (!userId) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })

  const url = new URL(req.url)
  const type = (url.searchParams.get('type') || '').trim()
  const limit = toInt(url.searchParams.get('limit'), 60)

  if (type === 'tools') {
    const r = await admin.client
      .from('tool_saves')
      .select(
        'created_at, tools(id,slug,name,tagline,description,logo_url,website_url,screenshot_url,price,rating,review_count,saves_count,likes_count)'
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (r.error) return new Response(JSON.stringify({ error: r.error.message, code: r.error.code || null }), { status: 400 })
    return Response.json({ items: r.data || [] })
  }

  if (type === 'articles') {
    const r = await admin.client
      .from('article_saves')
      .select('created_at, articles(id,slug,title,excerpt,published_at,reading_time,cover_url,author_name,views_count)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (r.error) return new Response(JSON.stringify({ error: r.error.message, code: r.error.code || null }), { status: 400 })
    return Response.json({ items: r.data || [] })
  }

  return new Response(JSON.stringify({ error: 'invalid type' }), { status: 400 })
}

