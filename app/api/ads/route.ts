// app/api/ads/route.ts (3001 后端总控项目 - 线上绝对防崩版)
import { NextResponse, NextRequest } from 'next/server'
// 🚀 核心修改：直接引入 Supabase 官方标准客户端构建器
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

// 🚀 核心修改：使用你线上绝对已经配置好的公网环境变量，免去对 Service Role 私钥的依赖
const getSafeSupabaseClient = () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
  return createClient(url, anonKey)
}

// ==========================================
// 🚀 1. 前端/后台读取接口 (GET)
// ==========================================
export async function GET(req: NextRequest) {
  try {
    const supabaseClient = getSafeSupabaseClient()
    const { searchParams } = new URL(req.url)
    const position = searchParams.get('position') || ''

    if (!position) {
      return addCorsHeaders(NextResponse.json({ error: 'Missing position' }, { status: 400 }), req)
    }

    // 🚀 核心修改：换成 .maybeSingle()。找不到数据时直接返回 null，绝对不会抛出 Postgres 异常导致 500
    const { data, error } = await supabaseClient
      .from('ads')
      .select('id, title, image_url, dark_image_url, mobile_image_url, link, position, aspect_ratio, ad_code, mobile_ad_code, active')
      .eq('position', position)
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) throw error

    return addCorsHeaders(NextResponse.json(data || null), req)
  } catch (error: any) {
    // 🚀 核心修改：给 GET 加上全包裹捕获，就算报错也强制带上跨域通行证返回，方便前端排查
    console.error("Online Backend GET error:", error)
    return addCorsHeaders(NextResponse.json({ error: error.message }, { status: 500 }), req)
  }
}

// ==========================================
// 🚀 2. 后台管理保存/更新接口 (POST)
// ==========================================
export async function POST(req: NextRequest) {
  try {
    const supabaseClient = getSafeSupabaseClient()
    const body = await req.json()
    
    const { 
      id, title, position, active,
      image_url, dark_image_url, mobile_image_url, 
      link, aspect_ratio, ad_code, mobile_ad_code 
    } = body

    if (id) {
      // 修改老广告
      const { data, error } = await supabaseClient
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
      // 新增广告坑位
      const { data, error } = await supabaseClient
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
    console.error("Online Backend save error:", error)
    return addCorsHeaders(NextResponse.json({ error: error.message }, { status: 500 }), req)
  }
}

// ==========================================
// 🚀 3. 浏览器跨域探测通道 (OPTIONS)
// ==========================================
export async function OPTIONS(req: NextRequest) {
  return addCorsHeaders(new NextResponse(null, { status: 204 }), req)
}

// ==========================================
// 🚀 4. 动态双向安全跨域白名单过滤器
// ==========================================
function addCorsHeaders(response: NextResponse, req: NextRequest) {
  const origin = req.headers.get('origin') || ''
  
  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://comebrief.com',
    'https://www.comebrief.com',
    'https://admin.comebrief.com'
  ];
  
  if (allowedOrigins.includes(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin)
  } else {
    response.headers.set('Access-Control-Allow-Origin', 'https://comebrief.com')
  }
  
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  return response
}