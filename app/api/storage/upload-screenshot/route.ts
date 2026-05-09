import type { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import sharp from 'sharp' 

const maxBytes = 10 * 1024 * 1024

const getBearer = (req: NextRequest) => {
  const h = req.headers.get('authorization') || ''
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m?.[1]?.trim() || ''
}

export async function POST(req: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    const admin = getSupabaseAdminClient()

    if (!supabaseUrl || !anonKey || !admin.ok) {
      return new Response(JSON.stringify({ error: 'Env config error' }), { status: 500 })
    }

    const token = getBearer(req)
    if (!token) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    const { data: userData, error: userError } = await authClient.auth.getUser(token)
    if (userError || !userData?.user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })

    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return new Response(JSON.stringify({ error: 'missing file' }), { status: 400 })

    // 🚀 强制设置桶名为 IMAGES
    const bucketName = 'IMAGES' 
    const key = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.webp`
    const path = `news-${key}` 

    const originalBuf = Buffer.from(await file.arrayBuffer())
    const webpBuf = await sharp(originalBuf)
      .webp({ quality: 80 })
      .resize(1200, null, { withoutEnlargement: true, fit: 'inside' })
      .toBuffer()

    const adminClient = admin.client

    // 🚀 核心修复逻辑：先尝试上传，如果失败报 Bucket not found，则自动创建并重试
    let { error: uploadError } = await adminClient.storage
      .from(bucketName)
      .upload(path, webpBuf, {
        contentType: 'image/webp',
        upsert: false
      })

    // 如果报错找不到桶，自动尝试创建桶
    if (uploadError && uploadError.message.includes('not found')) {
      console.log(`Bucket ${bucketName} not found, attempting to create...`)
      await adminClient.storage.createBucket(bucketName, {
        public: true, // 确保是公开的
        fileSizeLimit: maxBytes
      })
      
      // 创建完立即重试上传
      const retry = await adminClient.storage
        .from(bucketName)
        .upload(path, webpBuf, {
          contentType: 'image/webp',
          upsert: false
        })
      uploadError = retry.error
    }

    if (uploadError) {
      return new Response(JSON.stringify({ error: uploadError.message }), { status: 400 })
    }

    const { data } = adminClient.storage.from(bucketName).getPublicUrl(path)
    
    return Response.json({ 
      ok: true, 
      url: data.publicUrl, 
      path, 
      bucket: bucketName 
    })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'fatal error' }), { status: 500 })
  }
}