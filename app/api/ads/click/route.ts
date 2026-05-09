import type { NextRequest } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const admin = getSupabaseAdminClient()
  const envInfo = admin.env
  if (!admin.ok) return new Response(JSON.stringify({ error: admin.error || 'missing env: SUPABASE_SERVICE_ROLE_KEY', env: envInfo }), { status: 500 })

  const url = new URL(req.url)
  const adId = String(url.searchParams.get('ad_id') || '').trim()
  const pageUrl = String(url.searchParams.get('page_url') || '').trim()
  if (!adId) return new Response('missing ad_id', { status: 400 })

  const adminClient = admin.client

  const tracked = await adminClient.rpc('track_ad_click', { p_ad_id: adId, p_page_url: pageUrl || null })
  if (tracked.error) {
    const ins = await adminClient.from('ad_click_events').insert({ ad_id: adId, page_url: pageUrl || null } as any)
    if (ins.error) return new Response(ins.error.message, { status: 400 })
    const current = await adminClient.from('ads').select('clicks').eq('id', adId).maybeSingle()
    if (current.error) return new Response(current.error.message, { status: 400 })
    const clicks = typeof (current.data as any)?.clicks === 'number' ? (current.data as any).clicks : Number((current.data as any)?.clicks || 0) || 0
    const upd = await adminClient.from('ads').update({ clicks: clicks + 1 } as any).eq('id', adId)
    if (upd.error) return new Response(upd.error.message, { status: 400 })
  }

  const ad = await adminClient.from('ads').select('link').eq('id', adId).maybeSingle()
  if (ad.error) return new Response(ad.error.message, { status: 400 })
  const link = String((ad.data as any)?.link || '').trim()
  if (!link) return new Response('ad link not found', { status: 404 })
  return Response.redirect(link, 302)
}

