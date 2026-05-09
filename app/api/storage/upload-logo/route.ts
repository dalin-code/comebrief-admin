import type { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'

const maxBytes = 5 * 1024 * 1024

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

    if (!supabaseUrl || !anonKey) {
      return new Response(JSON.stringify({ error: 'missing supabase env', env: admin.env }), { status: 500 })
    }
    if (!admin.ok) {
      return new Response(JSON.stringify({ error: admin.error || 'missing env: SUPABASE_SERVICE_ROLE_KEY', env: admin.env }), { status: 500 })
    }

    const token = getBearer(req)
    if (!token) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
    }

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    const { data: userData, error: userError } = await authClient.auth.getUser(token)
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
    }

    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return new Response(JSON.stringify({ error: 'missing file' }), { status: 400 })
    }
    if (!file.type?.startsWith('image/')) {
      return new Response(JSON.stringify({ error: 'invalid file type' }), { status: 400 })
    }
    if (file.size > maxBytes) {
      return new Response(JSON.stringify({ error: 'file too large' }), { status: 400 })
    }

    const extFromName = file.name.split('.').pop() || ''
    const ext = extFromName.replace(/[^a-z0-9]+/gi, '').slice(0, 8) || 'png'
    const key = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`
    const path = `logos/tool-${key}`

    const buf = Buffer.from(await file.arrayBuffer())
    const adminClient = admin.client
    const { error: uploadError } = await adminClient.storage.from('logos').upload(path, buf, {
      contentType: file.type,
      cacheControl: '3600',
      upsert: false,
    })
    if (uploadError) {
      return new Response(JSON.stringify({ error: uploadError.message }), { status: 400 })
    }

    const { data } = adminClient.storage.from('logos').getPublicUrl(path)
    return Response.json({ ok: true, url: data.publicUrl, path })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'upload failed' }), { status: 500 })
  }
}
