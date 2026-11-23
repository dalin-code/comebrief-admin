// app/api/ads/route.ts —— 前台读取接口（只读，写走 /api/admin/ads）
import { NextResponse, NextRequest } from 'next/server'
import { supabase } from '@/lib/supabase'
import { coerceAdSlot } from '@/lib/adsSlots'
import { adsCorsHeaders } from '@/lib/adsCors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * CORS 口径集中在 `lib/adsCors.ts`，和 `/api/ads/impression` 共用一份白名单。
 * 预览域名用 `ADS_ALLOWED_ORIGINS`（逗号分隔）追加。
 */
function corsHeaders(req: NextRequest) {
  return adsCorsHeaders(req, 'GET, OPTIONS')
}

/** `null` / `"null"` / 空串都算「没配」——历史数据里三种都出现过。 */
function nonEmpty(v: unknown) {
  const s = String(v ?? '').trim()
  return Boolean(s) && s !== 'null' && s !== 'undefined'
}

/**
 * 「有素材」才算一条广告。
 *
 * 线上真实踩过的坑：后台点一下开关就 insert 了一行全空的 active=true，
 * 前台拿到对象后开始渲染包装 div —— 首页头部就成了一大块空白。
 * 判定口径与后台 `lib/adsAdmin.ts#hasCreative` 保持一致：
 *   代码类素材（PC / 移动任一）或「图片 + 链接」。
 */
function hasCreative(row: any) {
  if (!row) return false
  if (nonEmpty(row.ad_code) || nonEmpty(row.mobile_ad_code)) return true
  const hasImage = nonEmpty(row.image_url) || nonEmpty(row.mobile_image_url) || nonEmpty(row.dark_image_url)
  return hasImage && nonEmpty(row.link)
}

function withinWindow(row: any, now: number) {
  const start = row.start_at ? Date.parse(row.start_at) : NaN
  const end = row.end_at ? Date.parse(row.end_at) : NaN
  if (!Number.isNaN(start) && start > now) return false
  if (!Number.isNaN(end) && end < now) return false
  return true
}

/**
 * 分类定向：`ads.categories` 为空 = 全站投放；非空则要求命中（忽略大小写）。
 * 列不存在时（迁移没跑）视为「没有定向能力」，不做过滤。
 */
function matchesCategory(row: any, category: string) {
  if (!category) return true
  const list = Array.isArray(row.categories) ? row.categories : []
  if (!list.length) return true
  const needle = category.trim().toLowerCase()
  return list.some((c: any) => String(c || '').trim().toLowerCase() === needle)
}

/** 按 weight 加权随机抽一条；weight 缺失/非法按 1 算。 */
function pickWeighted(rows: any[]) {
  if (rows.length <= 1) return rows[0] || null
  const weights = rows.map((r) => {
    const n = Number(r.weight)
    return Number.isFinite(n) && n > 0 ? n : 1
  })
  const total = weights.reduce((a, b) => a + b, 0)
  let roll = Math.random() * total
  for (let i = 0; i < rows.length; i++) {
    roll -= weights[i]
    if (roll <= 0) return rows[i]
  }
  return rows[rows.length - 1]
}

const BASE_COLS =
  'id, title, image_url, dark_image_url, mobile_image_url, link, position, aspect_ratio, ad_code, mobile_ad_code, active, weight, start_at, end_at, clicks'

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) })
}

export async function GET(req: NextRequest) {
  const headers = {
    ...corsHeaders(req),
    'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  }
  try {
    const { searchParams } = new URL(req.url)
    const position = coerceAdSlot(searchParams.get('position'))
    const category = (searchParams.get('category') || '').trim()

    if (!position) {
      return NextResponse.json(
        {
          error: 'Missing or unknown position',
          allowed: ['HOME_MID', 'DETAIL_BOTTOM', 'QUIZ_FOOTER', 'SIDEBAR_PROMO'],
        },
        { status: 400, headers }
      )
    }

    // 先带 categories 查；列还没迁移（42703 / PGRST204）就退回不含它的列。
    let { data, error } = await supabase
      .from('ads')
      .select(`${BASE_COLS}, categories`)
      .eq('position', position)
      .eq('active', true)
      .order('created_at', { ascending: false })

    if (error && (error.code === '42703' || error.code === 'PGRST204')) {
      const retry = await supabase
        .from('ads')
        .select(BASE_COLS)
        .eq('position', position)
        .eq('active', true)
        .order('created_at', { ascending: false })
      data = retry.data as any
      error = retry.error
    }

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500, headers })
    }

    const now = Date.now()
    const candidates = (data || []).filter(
      (row: any) => hasCreative(row) && withinWindow(row, now) && matchesCategory(row, category)
    )

    const ad = pickWeighted(candidates as any[])
    // 没素材回 null（而不是空对象）：前端据此直接 return null，不产生空 DOM。
    return NextResponse.json(ad || null, { status: 200, headers })
  } catch (error: any) {
    console.error('[ads] GET 异常:', error)
    return NextResponse.json({ error: error?.message || 'ads fetch failed' }, { status: 500, headers })
  }
}

/**
 * 写操作已迁到 `/api/admin/ads`（带登录态校验）。
 * 这里保留 405，是为了让还在打旧地址的脚本立刻暴露出来，而不是「看起来成功」。
 */
export async function POST(req: NextRequest) {
  return NextResponse.json(
    { error: 'POST /api/ads 已停用，请使用后台 /api/admin/ads（需要登录态）' },
    { status: 405, headers: corsHeaders(req) }
  )
}
