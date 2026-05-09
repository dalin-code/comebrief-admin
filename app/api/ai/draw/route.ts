import type { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'

export const runtime = 'nodejs'
export const maxDuration = 60

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> }
  }>
}

const getBearer = (req: NextRequest) => {
  const h = req.headers.get('authorization') || ''
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m?.[1]?.trim() || ''
}

const fetchWithTimeout = async (url: string, init: RequestInit, ms: number) => {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(id)
  }
}

const parseJsonLoose = (content: string) => {
  const trimmed = content.trim()
  const stripped = trimmed.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/g, '').trim()
  try {
    return JSON.parse(stripped)
  } catch {
    const m = stripped.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('invalid json')
    return JSON.parse(m[0])
  }
}

const safeParseModelJson = (text: string) => {
  try {
    return { ok: true as const, value: parseJsonLoose(text) }
  } catch (e: any) {
    return { ok: false as const, error: e }
  }
}

function stripMd(md: string) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*_~\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const base64ToBuffer = (b64: string) => {
  const s = String(b64 || '').trim()
  if (!s) return Buffer.alloc(0)
  const cleaned = s.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
  return Buffer.from(cleaned, 'base64')
}

const isAbortError = (e: any) => e?.name === 'AbortError' || String(e?.message || '').toLowerCase().includes('aborted')

const getCfErrorMessage = (raw: any) => {
  const r = raw as any
  if (!r) return ''
  const errors = Array.isArray(r?.errors) ? r.errors : Array.isArray(r?.error) ? r.error : null
  if (errors?.length) {
    const first = errors[0] as any
    const msg = String(first?.message || first?.error || '').trim()
    const code = first?.code != null ? String(first.code).trim() : ''
    if (msg && code) return `[${code}] ${msg}`
    if (msg) return msg
  }
  const msg = String(r?.message || r?.error || r?.detail || '').trim()
  if (msg) return msg
  const nested = r?.result?.error || r?.result?.errors
  if (typeof nested === 'string') return nested.trim()
  if (Array.isArray(nested) && nested.length) return String((nested[0] as any)?.message || '').trim()
  return ''
}

const readCfError = async (resp: Response) => {
  const ct = resp.headers.get('content-type') || ''
  const cfRay = resp.headers.get('cf-ray') || resp.headers.get('cf-ray-id') || ''
  const reqId = resp.headers.get('x-request-id') || resp.headers.get('x-trace-id') || ''
  if (ct.includes('application/json')) {
    const raw = (await resp.json().catch(() => null)) as any
    const message = getCfErrorMessage(raw) || ''
    return { message, raw, cfRay, reqId }
  }
  const text = await resp.text().catch(() => '')
  const message = String(text || '').trim().slice(0, 400)
  return { message, raw: text, cfRay, reqId }
}

const shouldRetryCfMinimal = (status: number, message: string) => {
  if (!(status === 400 || status === 422)) return false
  const m = String(message || '').toLowerCase()
  return (
    m.includes('unknown') ||
    m.includes('unexpected') ||
    m.includes('invalid') ||
    m.includes('unrecognized') ||
    m.includes('schema') ||
    m.includes('parameter') ||
    m.includes('num_steps') ||
    m.includes('negative_prompt') ||
    m.includes('width') ||
    m.includes('height')
  )
}

const verifyCfToken = async (token: string) => {
  const t = String(token || '').trim()
  if (!t) return { ok: false as const, error: 'missing token' }
  try {
    const resp = await fetchWithTimeout(
      'https://api.cloudflare.com/client/v4/user/tokens/verify',
      { method: 'GET', headers: { Authorization: `Bearer ${t}` } },
      8000
    )
    const raw = (await resp.json().catch(() => ({}))) as any
    const success = Boolean(raw?.success)
    const msg = getCfErrorMessage(raw) || ''
    if (!resp.ok || !success) {
      return { ok: false as const, status: resp.status, message: msg || `HTTP ${resp.status}`, raw }
    }
    return { ok: true as const }
  } catch (e: any) {
    return { ok: false as const, error: e?.message || 'verify failed' }
  }
}

const cfEnvFiles = ['.env.local', '.env.production', '.env'] as const
const envFileCache = new Map<string, { mtimeMs: number; parsed: Record<string, string> }>()

const normalizeEnvValue = (v: any) => {
  let s = String(v || '').trim()
  if (!s) return ''
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim()
  return s
}

const getCfAccountId = () =>
  normalizeEnvValue(process.env.CLOUDFLARE_ACCOUNT_ID || process.env.NEXT_PUBLIC_CLOUDFLARE_ACCOUNT_ID || '')

const getCfToken = () => {
  const raw = normalizeEnvValue(process.env.CLOUDFLARE_API_TOKEN || process.env.NEXT_PUBLIC_CLOUDFLARE_API_TOKEN || '')
  return raw.replace(/^Bearer\s+/i, '').trim()
}

const parseEnvFile = (text: string) => {
  const out: Record<string, string> = {}
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    if (key) out[key] = val
  }
  return out
}

let dotenvTried = false
const maybeLoadDotenv = async () => {
  if (dotenvTried) return false
  dotenvTried = true
  try {
    const require = createRequire(import.meta.url)
    const dotenv: any = require('dotenv')
    for (const rel of cfEnvFiles) {
      const fp = path.join(process.cwd(), rel)
      if (fs.existsSync(fp)) dotenv.config({ path: fp })
    }
    return true
  } catch {
    return false
  }
}

const patchCloudflareEnvFromFiles = () => {
  const sources: string[] = []
  for (const rel of cfEnvFiles) {
    const fp = path.join(process.cwd(), rel)
    if (!fs.existsSync(fp)) continue
    try {
      const st = fs.statSync(fp)
      const cached = envFileCache.get(fp)
      const parsed =
        cached && cached.mtimeMs === st.mtimeMs ? cached.parsed : parseEnvFile(fs.readFileSync(fp, 'utf8'))
      if (!cached || cached.mtimeMs !== st.mtimeMs) envFileCache.set(fp, { mtimeMs: st.mtimeMs, parsed })

      const fileAccount = parsed.CLOUDFLARE_ACCOUNT_ID || parsed.NEXT_PUBLIC_CLOUDFLARE_ACCOUNT_ID
      const fileToken = parsed.CLOUDFLARE_API_TOKEN || parsed.NEXT_PUBLIC_CLOUDFLARE_API_TOKEN
      const curAccount = normalizeEnvValue(process.env.CLOUDFLARE_ACCOUNT_ID || process.env.NEXT_PUBLIC_CLOUDFLARE_ACCOUNT_ID || '')
      const curToken = normalizeEnvValue(process.env.CLOUDFLARE_API_TOKEN || process.env.NEXT_PUBLIC_CLOUDFLARE_API_TOKEN || '')
      if (fileAccount && normalizeEnvValue(fileAccount) && normalizeEnvValue(fileAccount) !== curAccount) {
        process.env.CLOUDFLARE_ACCOUNT_ID = normalizeEnvValue(fileAccount)
        process.env.NEXT_PUBLIC_CLOUDFLARE_ACCOUNT_ID = normalizeEnvValue(fileAccount)
        sources.push(rel)
      }
      if (fileToken && normalizeEnvValue(fileToken) && normalizeEnvValue(fileToken) !== curToken) {
        process.env.CLOUDFLARE_API_TOKEN = normalizeEnvValue(fileToken)
        process.env.NEXT_PUBLIC_CLOUDFLARE_API_TOKEN = normalizeEnvValue(fileToken)
        sources.push(rel)
      }
    } catch {
      continue
    }
  }
  return { patched: sources.length > 0, sources }
}

export async function POST(req: NextRequest) {
  const reqId = Math.random().toString(16).slice(2, 8)
  console.log('Env Check:', !!process.env.NEXT_PUBLIC_CLOUDFLARE_ACCOUNT_ID)
  const dotenvLoaded = await maybeLoadDotenv()
  if (dotenvLoaded) console.log(`[ai-draw:${reqId}] dotenv loaded`)
  const patched = patchCloudflareEnvFromFiles()
  if (patched.patched) {
    console.log(`[ai-draw:${reqId}] env patched`, { sources: Array.from(new Set(patched.sources)) })
  }
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
    if (!token) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    const { data: userData, error: userError } = await authClient.auth.getUser(token)
    if (userError || !userData?.user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })

    const body = await req.json().catch(() => ({}))
    const title = String(body?.title || '').trim()
    const markdown = String(body?.markdown || '').trim()
    const language = body?.language === 'en' ? 'en' : 'zh-CN'
    if (!markdown) return new Response(JSON.stringify({ error: 'missing markdown' }), { status: 400 })

    const geminiKey = process.env.GEMINI_API_KEY
    if (!geminiKey) return new Response(JSON.stringify({ error: 'Missing env: GEMINI_API_KEY' }), { status: 500 })

    const cfAccountId = getCfAccountId()
    const cfToken = getCfToken()
    if (!cfAccountId || !cfToken) {
      console.log(`[ai-draw:${reqId}] env missing`, {
        hasAccountId: Boolean(cfAccountId),
        hasToken: Boolean(cfToken),
        nodeEnv: process.env.NODE_ENV || '',
      })
      return new Response(
        JSON.stringify({
          error: 'Missing env: CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN',
          env: {
            hasAccountId: Boolean(cfAccountId),
            hasToken: Boolean(cfToken),
            nodeEnv: process.env.NODE_ENV || '',
            patchedFromFiles: patched.patched,
            patchedSources: Array.from(new Set(patched.sources)),
          },
        }),
        { status: 500 }
      )
    }

    const model = process.env.GEMINI_MODEL || 'gemini-3-flash-preview'
    const sourceText = stripMd(markdown).slice(0, 7000)
    const styleHint = language === 'en' ? 'clean editorial cover, modern, cinematic lighting' : '现代编辑封面风格，简洁高级，电影感光影'
    const promptIn = [
      'You are a prompt engineer for Stable Diffusion XL.',
      'Turn the provided article into an English prompt for a blog/news cover image.',
      'Return only a JSON object (no markdown, no explanation):',
      '{ "prompt": string, "negative_prompt": string }',
      '',
      'Constraints:',
      '- prompt must be English, <= 280 characters',
      '- avoid any text, letters, logos, watermarks, UI, screenshots in the image',
      `- style: ${styleHint}`,
      '- include subject + composition + environment + lighting + camera/style keywords',
      '',
      `seed_title: ${title || 'AI news'}`,
      'article_text:',
      sourceText,
    ].join('\n')

    const composeResp = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: promptIn }] }], generationConfig: { temperature: 0.3 } }),
      },
      20000
    )
    const composeRaw = (await composeResp.json().catch(() => ({}))) as GeminiResponse
    const composeText = composeRaw?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    let parsed = safeParseModelJson(composeText)
    if (!parsed.ok) {
      const repairPrompt = [
        'Convert the following into strict JSON.',
        'Return only JSON (no markdown, no explanations).',
        'Schema:',
        '{ "prompt": string, "negative_prompt": string }',
        '',
        'Constraints:',
        '- prompt must be English, <= 280 characters',
        '- avoid any text, letters, logos, watermarks, UI, screenshots in the image',
        '- negative_prompt should include text, watermark, logo, letters',
        '',
        'raw_output:',
        composeText.slice(0, 12000),
      ].join('\n')
      const repairResp = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: repairPrompt }] }], generationConfig: { temperature: 0.2 } }),
        },
        20000
      )
      const repairRaw = (await repairResp.json().catch(() => ({}))) as GeminiResponse
      const repairText = repairRaw?.candidates?.[0]?.content?.parts?.[0]?.text || ''
      parsed = safeParseModelJson(repairText)
    }

    const fallbackNegative =
      'text, letters, watermark, logo, signature, caption, subtitles, UI, screenshot, blurry, lowres, jpeg artifacts'
    let out: any
    if (parsed.ok) {
      out = parsed.value
    } else {
      const seed = String(title || 'AI news').trim()
      const gist = stripMd(markdown).slice(0, 240)
      out = {
        prompt: `${seed}, ${gist || 'editorial cover photo'}, ${styleHint}, ultra detailed, cinematic lighting, shallow depth of field`,
        negative_prompt: fallbackNegative,
      }
    }

    const prompt = String(out?.prompt || '').trim()
    const negative_prompt = String(out?.negative_prompt || fallbackNegative).trim()
    if (!prompt) {
      return new Response(JSON.stringify({ error: 'invalid prompt output' }), { status: 500 })
    }

    const cfModel = '@cf/bytedance/stable-diffusion-xl-lightning'
    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfAccountId)}/ai/run/${encodeURIComponent(cfModel)}`
    const cfHeaders = {
      Authorization: `Bearer ${cfToken}`,
      'Content-Type': 'application/json',
      Accept: 'image/png,application/json;q=0.9',
    }
    const primaryBody = {
      prompt,
      negative_prompt: negative_prompt || undefined,
      width: 1024,
      height: 576,
      num_steps: 4,
    }
    let cfResp = await fetchWithTimeout(
      cfUrl,
      {
        method: 'POST',
        headers: cfHeaders,
        body: JSON.stringify(primaryBody),
      },
      25000
    )

    if (!cfResp.ok) {
      let err = await readCfError(cfResp)
      const maybeRetry = shouldRetryCfMinimal(cfResp.status, err.message)
      if (maybeRetry) {
        cfResp = await fetchWithTimeout(
          cfUrl,
          {
            method: 'POST',
            headers: cfHeaders,
            body: JSON.stringify({ prompt, negative_prompt: negative_prompt || undefined }),
          },
          25000
        )
        if (!cfResp.ok) err = await readCfError(cfResp)
      }

      const msg = err.message || `HTTP ${cfResp.status}`
      console.log(`[ai-draw:${reqId}] cloudflare error`, { status: cfResp.status, cfRay: err.cfRay, reqId: err.reqId, msg })
      const extra = err.cfRay || err.reqId ? ` (cfRay=${String(err.cfRay || '-')}, reqId=${String(err.reqId || '-')})` : ''
      let hint = ''
      let tokenVerify: any = undefined
      if (cfResp.status === 401 || cfResp.status === 403) {
        const verified = await verifyCfToken(cfToken)
        tokenVerify = verified.ok
          ? { ok: true }
          : {
              ok: false,
              status: typeof (verified as any).status === 'number' ? (verified as any).status : undefined,
              message: typeof (verified as any).message === 'string' ? (verified as any).message : (verified as any).error,
            }
        if (!verified.ok) {
          hint = 'Cloudflare Token 校验失败：请确认使用的是 Workers AI 的 API Token（不是 Global API Key），且未过期'
        } else {
          hint = 'Cloudflare Token 有效但无权调用该 Account/Workers AI：请用 Workers AI 页面生成的 REST API Token，并确认 Account ID 属于同一账号'
        }
      }
      return new Response(
        JSON.stringify({
          error: `cloudflare ai failed: ${msg}${extra}`,
          hint: hint || undefined,
          token_verify: tokenVerify,
          detail: err.raw,
          status: cfResp.status,
        }),
        { status: 502 }
      )
    }

    const contentType = cfResp.headers.get('content-type') || 'image/png'
    let imgBuf = Buffer.alloc(0)
    if (contentType.includes('application/json')) {
      const raw = (await cfResp.json().catch(() => ({}))) as any
      const result = raw?.result
      if (typeof result === 'string') {
        imgBuf = base64ToBuffer(result)
      } else if (typeof result?.image_b64 === 'string') {
        imgBuf = base64ToBuffer(result.image_b64)
      } else if (Array.isArray(result?.image)) {
        imgBuf = Buffer.from(Uint8Array.from(result.image))
      } else if (typeof result?.image === 'string') {
        imgBuf = base64ToBuffer(result.image)
      }
      if (!imgBuf.length) return new Response(JSON.stringify({ error: 'cloudflare ai returned empty image' }), { status: 502 })
    } else {
      imgBuf = Buffer.from(await cfResp.arrayBuffer())
      if (!imgBuf.length) return new Response(JSON.stringify({ error: 'cloudflare ai returned empty image' }), { status: 502 })
    }

    const bucket = process.env.SUPABASE_IMAGES_BUCKET || 'images'
    const key = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.png`
    const path = `images/news-${key}`

    const adminClient = admin.client
    const uploadOnce = async () => {
      return await adminClient.storage.from(bucket).upload(path, imgBuf, {
        contentType: 'image/png',
        cacheControl: '3600',
        upsert: false,
      })
    }
    let { error: uploadError } = await uploadOnce()
    if (uploadError) {
      const msg = String(uploadError.message || '')
      const bucketMissing = /bucket/i.test(msg) && /not found/i.test(msg)
      if (bucketMissing) {
        await adminClient.storage.createBucket(bucket, { public: true }).catch(() => null)
        ;({ error: uploadError } = await uploadOnce())
      }
    }
    if (uploadError) return new Response(JSON.stringify({ error: uploadError.message }), { status: 400 })

    const { data } = adminClient.storage.from(bucket).getPublicUrl(path)
    console.log(`[ai-draw:${reqId}] ok`, { bytes: imgBuf.length, bucket })
    return Response.json({ ok: true, url: data.publicUrl, prompt, negative_prompt, bucket, path })
  } catch (e: any) {
    if (isAbortError(e)) return new Response(JSON.stringify({ error: '绘图超时，请重试' }), { status: 504 })
    console.log(`[ai-draw:${reqId}] fatal`, e?.message)
    return new Response(JSON.stringify({ error: e?.message || 'draw failed' }), { status: 500 })
  }
}
