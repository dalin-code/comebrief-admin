import type { NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/aiGemini'
import { getSupabaseAdminClient, getSupabaseWriteClient } from '@/lib/supabaseAdmin'
import { AD_SLOTS, coerceAdSlot } from '@/lib/adsSlots'
import { sanitizeAdPatch, upsertAdSlot, type AdPatch } from '@/lib/adsAdmin'

/**
 * 后台广告管理接口（唯一的写入口）。
 *
 * 以前后台页面是**拿浏览器里的 anon key 直接写 `ads`** 的：
 *   ① 谁能拿到发布密钥（它就在前端 bundle 里）谁就能往 `ad_code` 里塞任何 HTML；
 *   ② 保存走 `ads.find(position===slot)` 随便抓一行 update，重复行越攒越多，
 *      改了半天线上接口还是返回另一行。
 *
 * 现在：
 *   ① requireAdmin —— 必须带后台登录票（Supabase access token）；
 *   ② 写入优先 service role，没配就退回「调用者自己的登录票」（RLS: authenticated）；
 *   ③ 按坑位 upsert，顺手把同坑位的重复行清掉。
 */

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store, max-age=0' } })
}

function getBearer(req: NextRequest) {
  const header = req.headers.get('authorization') || ''
  return header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || ''
}

/** PostgREST：列不存在（迁移还没跑）—— 降级而不是 500。 */
function isMissingColumn(message: string | undefined) {
  return /column .* does not exist|could not find the '.*' column/i.test(String(message || ''))
}

/**
 * 写一行，遇到「categories 列还没迁移」就剥掉该字段重试一次。
 * 返回 note 让后台能提示「跑一下 51_ads_slots.sql」。
 */
async function writeWithColumnFallback(
  client: any,
  slot: string,
  patch: AdPatch,
  notes: string[]
): Promise<{ ok: boolean; row?: any; error?: string; removed?: number }> {
  const first = await upsertAdSlot(client, slot as any, patch, { note: (m) => notes.push(m) })
  if (first.ok || !('categories' in patch)) return first
  if (!isMissingColumn(first.error)) return first

  const { categories, ...rest } = patch
  notes.push(
    '`ads.categories` 列尚不存在（分类定向暂不可用），本次已跳过该字段；请在 Supabase SQL Editor 执行 51_ads_slots.sql'
  )
  return upsertAdSlot(client, slot as any, rest, { note: (m) => notes.push(m) })
}


/** 近 7 天点击 / 曝光统计（需要 service role；没有就只给累计点击数）。 */
async function loadStats(ads: any[]) {
  const stats: Record<
    string,
    { clicks7d: number; impressions7d: number; clicksTotal: number; ctr: number | null }
  > = {}
  for (const ad of ads) {
    stats[ad.id] = { clicks7d: 0, impressions7d: 0, clicksTotal: Number(ad.clicks || 0), ctr: null }
  }

  const admin = getSupabaseAdminClient()
  if (!admin.ok) return { stats, notes: ['未配置 service role key，点击/曝光明细读不到（只显示累计 clicks 列）'] }

  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
  const notes: string[] = []

  const clicks = await admin.client.from('ad_click_events').select('ad_id').gte('created_at', since).limit(50000)
  if (clicks.error) notes.push('点击事件表读取失败：' + clicks.error.message)
  else for (const row of clicks.data || []) if (stats[row.ad_id]) stats[row.ad_id].clicks7d += 1

  const impressions = await admin.client
    .from('ad_impressions')
    .select('ad_id')
    .gte('created_at', since)
    .limit(50000)
  if (impressions.error) {
    if (!/does not exist|42P01/i.test(impressions.error.message)) {
      notes.push('曝光表读取失败：' + impressions.error.message)
    } else {
      notes.push('曝光表尚未创建（51_ads_slots.sql），曝光数按 0 显示')
    }
  } else for (const row of impressions.data || []) if (stats[row.ad_id]) stats[row.ad_id].impressions7d += 1

  for (const id of Object.keys(stats)) {
    const s = stats[id]
    s.ctr = s.impressions7d > 0 ? s.clicks7d / s.impressions7d : null
  }

  return { stats, notes }
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (auth.ok === false) return auth.response

  const write = getSupabaseWriteClient(getBearer(req))
  if (!write.ok) return json({ ok: false, error: write.error, env: write.env }, 500)

  const { data, error } = await write.client.from('ads').select('*').order('position', { ascending: true })
  if (error) return json({ ok: false, error: error.message, code: error.code || null }, 500)

  const ads = data || []
  const { stats, notes } = await loadStats(ads)

  return json({
    ok: true,
    via: write.via,
    slots: AD_SLOTS,
    ads,
    stats,
    notes,
    /** 数据库里存在、但不在 4 个主力清单里的 position（迁移前会看到） */
    unknownPositions: Array.from(new Set(ads.map((a: any) => a.position))).filter(
      (p) => !AD_SLOTS.some((s) => s.id === p)
    ),
  })
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (auth.ok === false) return auth.response

  let body: any = null
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, error: 'invalid json body' }, 400)
  }

  const slot = coerceAdSlot(body?.position)
  if (!slot) {
    return json(
      {
        ok: false,
        error: `unknown position: ${String(body?.position || '')}`,
        allowed: AD_SLOTS.map((s) => s.id),
      },
      400
    )
  }

  const action = String(body?.action || 'save')
  const notes: string[] = []
  let patch: AdPatch = {}
  let warnings: string[] = []

  if (action === 'clear') {
    patch = {
      ad_code: null,
      mobile_ad_code: null,
      image_url: null,
      mobile_image_url: null,
      dark_image_url: null,
      link: null,
      active: false,
    }
  } else if (action === 'save') {
    const sanitized = sanitizeAdPatch(body?.patch)
    patch = sanitized.patch
    warnings = sanitized.warnings
    if (!Object.keys(patch).length) return json({ ok: false, error: 'empty patch' }, 400)
  } else {
    return json({ ok: false, error: `unknown action: ${action}` }, 400)
  }

  const write = getSupabaseWriteClient(getBearer(req))
  if (!write.ok) return json({ ok: false, error: write.error, env: write.env }, 500)

  const result = await writeWithColumnFallback(write.client, slot, patch, notes)
  if (!result.ok) return json({ ok: false, error: result.error, warnings }, 502)

  return json({
    ok: true,
    via: write.via,
    slot,
    action,
    row: result.row,
    removed: result.removed || 0,
    warnings: [...warnings, ...notes],
  })
}
