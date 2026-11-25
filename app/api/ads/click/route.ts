import type { NextRequest } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { supabase as anonClient } from '@/lib/supabase'
import { SITE_URL } from '@/lib/siteUrl'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 广告点击统计 + 302 到目标。
 *
 * 这条路由是「用户真的点了一下」的那一步，因此铁律是：
 * **无论统计成不成功，都必须把人送到目标页，绝不回 500。**
 * 旧版在没有 service role key 时直接 `return 500`，线上 admin 项目恰好没配
 * 这个 key —— 结果所有广告点击都撞成一屏 JSON。
 *
 * 现在的策略：
 *   ① 有 service role → 用它（RPC 失败再手工补记，双保险）；
 *   ② 没有 → 用 anon 客户端调 RPC（`track_ad_click` 已 grant 给 anon，
 *      SECURITY DEFINER 会绕过 ad_click_events 的 RLS）；
 *   ③ 统计整段失败 → 只打日志，继续 302。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FALLBACK_URL = `${SITE_URL}/`

/** 只允许站内绝对路径或 http(s) 外链，别把广告接口变成任意跳转器。 */
function safeTarget(raw: string | null | undefined): string | null {
  const v = String(raw || '').trim()
  if (!v) return null
  if (v.startsWith('/')) return v
  try {
    const u = new URL(v)
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString()
  } catch {
    /* 非法 URL，落到下一个候选 */
  }
  return null
}

function redirectTo(target: string, _requestUrl: string) {
  // 站内相对路径要基于**前台站点**解析：这条路由跑在 admin 域名上，
  // 用 requestUrl 解析会把用户送到 admin.comebrief.com/trends/xxx。
  const dest = target.startsWith('/') ? new URL(target, SITE_URL) : new URL(target)
  return new Response(null, {
    status: 302,
    headers: {
      Location: dest.toString(),
      // 302 不应被浏览器 / CDN 缓存，否则同一个人后续点击会被直接复用旧跳转
      'Cache-Control': 'no-store, max-age=0',
    },
  })
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const adId = String(url.searchParams.get('ad_id') || '').trim()
  const to = safeTarget(url.searchParams.get('to'))
  const pageUrl = url.searchParams.get('page_url') || req.headers.get('referer') || ''

  if (!UUID_RE.test(adId)) {
    return redirectTo(to || FALLBACK_URL, req.url)
  }

  const admin = getSupabaseAdminClient()
  const db = admin.ok ? admin.client : anonClient

  let link: string | null = null
  try {
    const { data, error } = await db.from('ads').select('link').eq('id', adId).maybeSingle()
    if (error) console.error('[ads/click] 读取广告失败:', error.message)
    else link = safeTarget((data as any)?.link)
  } catch (err) {
    console.error('[ads/click] 读取广告异常:', err)
  }

  // 统计失败不影响跳转
  try {
    const { error } = await db.rpc('track_ad_click', {
      p_ad_id: adId,
      p_page_url: pageUrl || null,
    })
    if (error && admin.ok) {
      // RPC 不存在 / 报错时，用 admin 客户端手工补记
      await admin.client.from('ad_click_events').insert({ ad_id: adId, page_url: pageUrl || null })
      const { data: row } = await admin.client.from('ads').select('clicks').eq('id', adId).maybeSingle()
      const clicks = Number((row as any)?.clicks || 0) || 0
      await admin.client.from('ads').update({ clicks: clicks + 1 }).eq('id', adId)
    } else if (error) {
      console.warn('[ads/click] 点击统计失败（无 service role）:', error.message)
    }
  } catch (err) {
    console.warn('[ads/click] 点击统计异常:', err)
  }

  const target = to || link || FALLBACK_URL
  return redirectTo(target, req.url)
}
