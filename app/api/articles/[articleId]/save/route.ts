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

const readCount = async (adminClient: any, articleId: string) => {
  const r = await adminClient.from('article_saves').select('*', { head: true, count: 'exact' }).eq('article_id', articleId)
  if (r.error) return { ok: false as const, error: r.error }
  const n = typeof r.count === 'number' ? r.count : 0
  return { ok: true as const, saves_count: n }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ articleId: string }> }) {
  const admin = getSupabaseAdminClient()
  const envInfo = admin.env
  if (!admin.ok) return new Response(JSON.stringify({ error: admin.error || 'missing env: SUPABASE_SERVICE_ROLE_KEY', env: envInfo }), { status: 500 })

  const userId = await getUserId(req)
  if (!userId) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })

  const { articleId } = await ctx.params
  const id = String(articleId || '').trim()
  if (!id) return new Response(JSON.stringify({ error: 'missing articleId' }), { status: 400 })

  const ins = await admin.client.from('article_saves').insert({ user_id: userId, article_id: id } as any)
  if (ins.error) {
    const code = String((ins.error as any)?.code || '')
    if (code !== '23505') return new Response(JSON.stringify({ error: ins.error.message, code }), { status: 400 })
  }

  const cnt = await readCount(admin.client, id)
  if (!cnt.ok) return new Response(JSON.stringify({ error: cnt.error.message, code: cnt.error.code || null }), { status: 400 })
  return Response.json({ saves_count: cnt.saves_count, saved: true })
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ articleId: string }> }) {
  const admin = getSupabaseAdminClient()
  const envInfo = admin.env
  if (!admin.ok) return new Response(JSON.stringify({ error: admin.error || 'missing env: SUPABASE_SERVICE_ROLE_KEY', env: envInfo }), { status: 500 })

  const userId = await getUserId(req)
  if (!userId) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })

  const { articleId } = await ctx.params
  const id = String(articleId || '').trim()
  if (!id) return new Response(JSON.stringify({ error: 'missing articleId' }), { status: 400 })

  const del = await admin.client.from('article_saves').delete().eq('user_id', userId).eq('article_id', id)
  if (del.error) return new Response(JSON.stringify({ error: del.error.message, code: del.error.code || null }), { status: 400 })

  const cnt = await readCount(admin.client, id)
  if (!cnt.ok) return new Response(JSON.stringify({ error: cnt.error.message, code: cnt.error.code || null }), { status: 400 })
  return Response.json({ saves_count: cnt.saves_count, saved: false })
}
