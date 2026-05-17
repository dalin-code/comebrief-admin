// app/api/ads/route.ts (3001 端口后端项目)
import { NextResponse, NextRequest } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'

export const runtime = 'nodejs'

// ==========================================
// 🚀 1. 前端/后台读取接口 (GET)
// ==========================================
export async function GET(req: NextRequest) {
  const admin = getSupabaseAdminClient()
  const { searchParams } = new URL(req.url)
  const position = searchParams.get('position') || ''

  if (!position) {
    return addCorsHeaders(NextResponse.json({ error: 'Missing position' }, { status: 400 }), req)
  }

  const { data, error } = await admin.client
    .from('ads')
    .select('id, title, image_url, dark_image_url, mobile_image_url, link, position, aspect_ratio, ad_code, mobile_ad_code, active')
    .eq('position', position)
    .eq('active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (error && error.code !== 'PGRST116') {
    return addCorsHeaders(NextResponse.json({ error: error.message }, { status: 500 }), req)
  }

  return addCorsHeaders(NextResponse.json(data || null), req)
}

// ==========================================
// 🚀 2. 后台管理保存/更新接口 (POST)
// ==========================================
export async function POST(req: NextRequest) {
  const admin = getSupabaseAdminClient()
  try {
    const body = await req.json()
    
    // 严格对照你数据库里的字段名进行抓取
    const { 
      id, title, position, active,
      image_url, dark_image_url, mobile_image_url, 
      link, aspect_ratio, ad_code, mobile_ad_code 
    } = body

    if (id) {
      // 如果带了 id，说明是修改已有广告
      const { data, error } = await admin.client
        .from('ads')
        .update({
          title, position, active: Boolean(active),
          image_url, dark_image_url, mobile_image_url,
          link, aspect_ratio, ad_code, mobile_ad_code,
          updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .select()

      if (error) throw error
      return addCorsHeaders(NextResponse.json({ success: true, data }), req)
    } else {
      // 如果没带 id，说明是新增广告条目
      const { data, error } = await admin.client
        .from('ads')
        .insert([{
          title, position, active: Boolean(active),
          image_url, dark_image_url, mobile_image_url,
          link, aspect_ratio, ad_code, mobile_ad_code
        }])
        .select()

      if (error) throw error
      return addCorsHeaders(NextResponse.json({ success: true, data }), req)
    }
  } catch (error: any) {
    console.error("Backend save error:", error)
    return addCorsHeaders(NextResponse.json({ error: error.message }, { status: 500 }), req)
  }
}

// 🚀 3. 浏览器跨域探测通道
export async function OPTIONS(req: NextRequest) {
  return addCorsHeaders(new NextResponse(null, { status: 204 }), req)
}

// 🚀 4. 动态双向跨域清道夫
function addCorsHeaders(response: NextResponse, req: NextRequest) {
  const origin = req.headers.get('origin') || ''
  if (origin === 'http://localhost:3000' || origin === 'http://localhost:3001') {
    response.headers.set('Access-Control-Allow-Origin', origin)
  } else {
    response.headers.set('Access-Control-Allow-Origin', 'http://localhost:3000')
  }
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  return response
}