import type { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'

export const runtime = 'nodejs'
export const maxDuration = 60

const getBearer = (req: NextRequest) => {
  const h = req.headers.get('authorization') || ''
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m?.[1]?.trim() || ''
}

const uniquifySlug = (base: string) => {
  const b = String(base || '').trim().replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'post'
  return `${b}-${Math.random().toString(16).slice(2, 6)}`
}

export async function POST(req: NextRequest) {
  const reqId = Math.random().toString(16).slice(2, 8)
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    const admin = getSupabaseAdminClient()
    const envInfo = admin.env

    if (!supabaseUrl || !anonKey) return new Response(JSON.stringify({ error: 'missing supabase env', env: envInfo }), { status: 500 })
    if (!admin.ok) return new Response(JSON.stringify({ error: admin.error || 'missing env: SUPABASE_SERVICE_ROLE_KEY', env: envInfo }), { status: 500 })

    const token = getBearer(req)
    if (!token) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    const { data: userData, error: userError } = await authClient.auth.getUser(token)
    if (userError || !userData?.user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })

    const body = await req.json().catch(() => ({}))
    const mode = body?.mode === 'update' ? 'update' : 'insert'
    const id = String(body?.id || '').trim()
    const payload = body?.payload && typeof body.payload === 'object' ? (body.payload as any) : null
    if (!payload) return new Response(JSON.stringify({ error: 'missing payload' }), { status: 400 })
    if (mode === 'update' && !id) return new Response(JSON.stringify({ error: 'missing id' }), { status: 400 })

    const adminClient = admin.client
    let current: any = payload
    if (mode === 'update') current = { ...current, id }

    for (let i = 0; i < 10; i += 1) {
      const res =
        mode === 'update'
          ? await adminClient.from('articles').update(current).eq('id', id).select('*').maybeSingle()
          : await adminClient.from('articles').insert(current).select('*').maybeSingle()

      const data = res.data as any
      const error = res.error as any
      if (!error) {
        const out = data || null
        console.log(`[news-save:${reqId}] ok`, { mode, id: out?.id || id, user: userData.user.id })
        return Response.json({ ok: true, data: out })
      }

      const msg = String(error?.message || '')
      const dupSlug =
        /duplicate key value violates unique constraint/i.test(msg) && /(slug|articles_slug_key|articles_slug_unique)/i.test(msg)
      if (dupSlug) {
        const base = String(current?.slug || '').trim()
        current = { ...current, slug: uniquifySlug(base) }
        continue
      }

      const m1 = msg.match(/Could not find the '([^']+)' column/i)
      const m2 = msg.match(/column\s+articles\.([a-zA-Z0-9_]+)\s+does\s+not\s+exist/i)
      const missing = (m1?.[1] || m2?.[1] || '').trim()
      if (missing && Object.prototype.hasOwnProperty.call(current, missing)) {
        const next: any = { ...current }
        delete next[missing]
        current = next
        continue
      }

      return new Response(
        JSON.stringify({ error: msg || 'save failed', code: error?.code || null, details: error?.details || null, hint: error?.hint || null }),
        { status: 400 }
      )
    }

    return new Response(JSON.stringify({ error: 'save failed' }), { status: 400 })
  } catch (e: any) {
    console.log(`[news-save:${reqId}] fatal`, e?.message)
    return new Response(JSON.stringify({ error: e?.message || 'save failed' }), { status: 500 })
  }
}

