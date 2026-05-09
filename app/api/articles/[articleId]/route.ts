import type { NextRequest } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(_req: NextRequest, ctx: { params: Promise<{ articleId: string }> }) {
  const admin = getSupabaseAdminClient()
  const envInfo = admin.env
  if (!admin.ok) return new Response(JSON.stringify({ error: admin.error || 'missing env: SUPABASE_SERVICE_ROLE_KEY', env: envInfo }), { status: 500 })

  const { articleId } = await ctx.params
  const key = String(articleId || '').trim()
  if (!key) return new Response(JSON.stringify({ error: 'missing key' }), { status: 400 })

  const adminClient = admin.client

  let item: any = null
  const itemCols =
    'id,slug,title,excerpt,author_name,author_role,author_avatar,published_at,reading_time,views_count,cover_url,image_source,content_md'
  const bySlug = await adminClient.from('articles').select(itemCols).eq('slug', key).maybeSingle()
  if (!bySlug.error && bySlug.data) item = bySlug.data

  if (!item) {
    const byId = await adminClient.from('articles').select(itemCols).eq('id', key).maybeSingle()
    if (byId.error) return new Response(JSON.stringify({ error: byId.error.message, code: byId.error.code || null }), { status: 400 })
    item = byId.data || null
  }

  if (!item) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })

  const relatedCols = 'id,slug,title,excerpt,published_at,reading_time,cover_url,author_name,views_count'
  const related = await adminClient
    .from('articles')
    .select(relatedCols)
    .neq('id', item.id)
    .order('published_at', { ascending: false })
    .limit(6)

  if (related.error) return new Response(JSON.stringify({ error: related.error.message, code: related.error.code || null }), { status: 400 })

  return Response.json({ item, related: related.data || [] })
}
