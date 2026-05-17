// app/api/ads/route.ts (3001 后端总控项目 - 线上绝对零崩溃防封版)
import { NextResponse, NextRequest } from 'next/server'
// 🚀 核心修改：直接复用你项目中已经在线上跑通、绝对安全的 Supabase 客户端实例
import { supabase } from '@/lib/supabase'

export const runtime = 'nodejs'

// 🚀 核心修改：升级为动态回声 CORS 引擎，精准抓取请求来源并百分之百通过，消灭一切跨域拦截
function getCorsHeaders(req: NextRequest) {
  const origin = req.headers.get('origin') || '*'
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}

// ==========================================
// 🚀 1. 浏览器跨域探测通道 (OPTIONS)
// ==========================================
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: getCorsHeaders(req),
  })
}

// ==========================================
// 🚀 2. 前端/后台读取接口 (GET)
// ==========================================
export async function GET(req: NextRequest) {
  const headers = getCorsHeaders(req)
  try {
    const { searchParams } = new URL(req.url)
    const position = searchParams.get('position') || ''

    if (!position) {
      return NextResponse.json({ error: 'Missing position' }, { status: 400, headers })
    }

    // 使用经受过线上考验的常规 client 读数据
    const { data, error } = await supabase
      .from('ads')
      .select('id, title, image_url, dark_image_url, mobile_image_url, link, position, aspect_ratio, ad_code, mobile_ad_code, active')
      .eq('position', position)
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500, headers })
    }

    return NextResponse.json(data || null, { status: 200, headers })
  } catch (error: any) {
    console.error("GET 捕获异常:", error)
    return NextResponse.json({ error: error.message }, { status: 500, headers })
  }
}

// ==========================================
// 🚀 3. 后台管理保存/更新接口 (POST)
// ==========================================
export async function POST(req: NextRequest) {
  const headers = getCorsHeaders(req)
  try {
    const body = await req.json()
    const { 
      id, title, position, active,
      image_url, dark_image_url, mobile_image_url, 
      link, aspect_ratio, ad_code, mobile_ad_code 
    } = body

    let result;
    if (id) {
      // 常规修改
      result = await supabase
        .from('ads')
        .update({
          title, position, active: Boolean(active),
          image_url, dark_image_url, mobile_image_url,
          link, aspect_ratio, ad_code, mobile_ad_code,
          updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .select()
    } else {
      // 常规新增
      result = await supabase
        .from('ads')
        .insert([{
          title, position, active: Boolean(active),
          image_url, dark_image_url, mobile_image_url,
          link, aspect_ratio, ad_code, mobile_ad_code
        }])
        .select()
    }

    if (result.error) {
      return NextResponse.json({ error: result.error.message }, { status: 500, headers })
    }
    
    return NextResponse.json({ success: true, data: result.data }, { status: 200, headers })
  } catch (error: any) {
    console.error("POST 捕获异常:", error)
    return NextResponse.json({ error: error.message }, { status: 500, headers })
  }
}