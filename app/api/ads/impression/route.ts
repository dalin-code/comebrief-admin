import { NextResponse, type NextRequest } from 'next/server'
import { coerceAdSlot } from '@/lib/adsSlots'
import { adsCorsHeaders } from '@/lib/adsCors'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { supabase as anonClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 曝光上报（写入 `ad_impressions`）。
 *
 * 触发方是前台 `components/ads/AdRenderer.tsx`：进视口 ≥50% 且停留 1s，
 * 一次挂载只报一次。这里是跨域 POST，必须回 CORS，否则浏览器会静默吞掉。
 *
 * 表由 `ComeBrief/supabase/51_ads_slots.sql` 创建，RLS 只给 anon insert。
 * 迁移没跑时（42P01 / PGRST204）返回 202 + reason，不报 500 ——
 * 曝光统计不该把前台搞出一屏红字。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function cors(req: NextRequest) {
  return adsCorsHeaders(req, 'POST, OPTIONS')
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: cors(req) })
}

export async function POST(req: NextRequest) {
  const headers = cors(req)

  let payload: Record<string, unknown> = {}
  try {
    const raw = await req.text()
    if (raw) payload = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400, headers })
  }

  const adId = String(payload.ad_id || '').trim()
  if (!UUID_RE.test(adId)) {
    return NextResponse.json({ error: 'invalid ad_id' }, { status: 400, headers })
  }

  const position = coerceAdSlot(typeof payload.position === 'string' ? payload.position : null)
  if (!position) {
    return NextResponse.json({ error: 'invalid position' }, { status: 400, headers })
  }

  const pagePath = String(payload.page_path || '').slice(0, 512) || null
  const category = payload.category ? String(payload.category).slice(0, 80) : null

  const admin = getSupabaseAdminClient()
  const db = admin.ok ? admin.client : anonClient

  const { error } = await db.from('ad_impressions').insert({
    ad_id: adId,
    position,
    page_path: pagePath,
    category,
  })

  if (error) {
    if (/does not exist|42P01|PGRST204|PGRST205|schema cache|Could not find the table/i.test(error.message)) {
      return NextResponse.json({ ok: false, reason: 'impressions_table_missing' }, { status: 202, headers })
    }
    console.warn('[ads/impression] 写入失败:', error.message)
    return NextResponse.json({ ok: false, reason: 'insert_failed' }, { status: 202, headers })
  }

  return new NextResponse(null, { status: 204, headers })
}

export async function GET(req: NextRequest) {
  return NextResponse.json({ error: 'method not allowed' }, { status: 405, headers: cors(req) })
}
