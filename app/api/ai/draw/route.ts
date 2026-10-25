import type { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { pngDimensions, toMaskPng } from '@/lib/inpaintMask'

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
  const cleaned = s.replace(/^data:[a-zA-Z0-9./+-]+;base64,/, '')
  return Buffer.from(cleaned, 'base64')
}

const cleanBase64 = (b64: string) => String(b64 || '').trim().replace(/^data:[a-zA-Z0-9./+-]+;base64,/, '')

/**
 * Cloudflare 的图片模型可能返回 PNG，也可能直接返回 JPEG（SDXL-Lightning 目前是
 * image/jpeg）。上传时必须按真实字节写 MIME 和扩展名，否则 Supabase 里会出现
 * 「.png 文件装着 JPEG」的情况，部分代理/浏览器会拒绝显示。
 */
const detectImageMeta = (buf: Buffer, contentType = '') => {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: 'image/png', ext: 'png' }
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' }
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' }
  }
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) {
    return { mime: 'image/gif', ext: 'gif' }
  }
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (ct.startsWith('image/')) {
    const ext = ct === 'image/jpeg' ? 'jpg' : (ct.slice('image/'.length).replace(/[^a-z0-9]+/g, '') || 'png')
    return { mime: ct, ext }
  }
  return { mime: 'image/png', ext: 'png' }
}

const clampInt = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/**
 * 话题矩阵是站长在编辑页选的，会作为语义锚点交给 Gemini，而不是画进图里。
 *
 * 只收字符串 / 数字，限制数量与长度，并把换行和控制字符压成空格：
 * 这些标签最终会进入提示词正文，不能让一个多行标签伪造出新的 prompt 段落。
 * `Other` 是兜底话题，没有信息量；只选它时等同于没传话题。
 */
const COVER_TOPIC_LIMIT = 5
const COVER_TOPIC_MAX_CHARS = 40
const COVER_TOPIC_SKIP = new Set(['other', 'uncategorized', '其他', '未分类'])

const normalizeCoverTopics = (input: unknown) => {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[,，]/)
      : []
  const seen = new Set<string>()
  const topics: string[] = []

  for (const item of raw) {
    if (typeof item !== 'string' && typeof item !== 'number') continue
    const value = String(item)
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, COVER_TOPIC_MAX_CHARS)
    if (!value) continue

    const key = value.toLowerCase()
    if (COVER_TOPIC_SKIP.has(key) || seen.has(key)) continue
    seen.add(key)
    topics.push(value)
    if (topics.length >= COVER_TOPIC_LIMIT) break
  }

  return topics
}

/** 摘要 / 开场段落的清洗：压成单段纯文本，并限制长度，避免挤掉画面主体。 */
const cleanPromptField = (value: unknown, maxChars: number) =>
  String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)

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

/**
 * Workers AI 的模型 ID 是路径的一部分，必须原样保留 `/`。
 *
 * 不能对整个 model 做 encodeURIComponent：`@cf/bytedance/...` 会变成
 * `%40cf%2Fbytedance%2F...`，Cloudflare 不会把 `%2F` 还原成路径分隔符，
 * 直接返回 `[7000] No route for that URI`。
 */
const cfRunUrl = (accountId: string, model: string) => {
  const cleanModel = String(model || '').trim().replace(/^\/+/, '')
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${cleanModel}`
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
  // 这里不做 dotenv 补丁：Next.js 自己会加载 .env.local，本项目也从未安装 dotenv
  // （动态 require 只会给构建日志添一行警告，那段死代码已删）。
  // 只补 Cloudflare 那几个变量 —— 它们在部分部署环境里读不到，见 patchCloudflareEnvFromFiles。
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
    // 摘要和正文第一段比整篇正文更适合决定画面：先由前端取出来，服务端再兜底。
    const excerpt = cleanPromptField(body?.excerpt, 600)
    const opening = cleanPromptField(body?.opening, 700) || stripMd(markdown).slice(0, 700)
    const language = body?.language === 'en' ? 'en' : 'zh-CN'
    // 话题矩阵只参与「生成封面」的提示词；局部重绘直接使用站长填的 prompt。
    const topics = normalizeCoverTopics(body?.categories)
    const inpaint = body?.mode === 'inpaint' || Boolean(body?.image || body?.image_b64)
    if (!inpaint && !markdown) return new Response(JSON.stringify({ error: 'missing markdown' }), { status: 400 })

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

    /* ---------------- 局部重绘（inpainting） ---------------- */
    // 前端传原图 + 同尺寸 mask（白色 = 要重画的区域）。不需要 Gemini 出提示词：
    // 站长已经把自己想要的画面写在 prompt 里了，再让模型转述一遍只会丢细节。
    if (inpaint) {
      const imageInput = body?.image_b64 ?? body?.image
      const imageB64 =
        typeof imageInput === 'string'
          ? cleanBase64(imageInput)
          : Array.isArray(imageInput) || ArrayBuffer.isView(imageInput)
            ? Buffer.from(imageInput as any).toString('base64')
            : ''
      const imageBuf = base64ToBuffer(imageB64)
      if (!imageB64 || !imageBuf.length) {
        return new Response(JSON.stringify({ error: 'missing image' }), { status: 400 })
      }
      const maskInput = body?.mask ?? body?.mask_b64
      if (!maskInput) return new Response(JSON.stringify({ error: 'missing mask' }), { status: 400 })

      const prompt = String(body?.prompt || title || '').trim().slice(0, 1200)
      if (!prompt) return new Response(JSON.stringify({ error: 'missing prompt' }), { status: 400 })
      const negative_prompt = String(
        body?.negative_prompt ||
          'text, watermark, logo, letters, blurry, lowres, deformed, extra limbs, bad anatomy'
      )
        .trim()
        .slice(0, 600)
      const imageSize = pngDimensions(imageBuf)
      const width = clampInt(body?.width, 256, 2048, imageSize?.width || 512)
      const height = clampInt(body?.height, 256, 2048, imageSize?.height || 512)
      if (imageSize && (imageSize.width !== width || imageSize.height !== height)) {
        return new Response(
          JSON.stringify({
            error: `原图是 ${imageSize.width}×${imageSize.height}，inpainting 的 width/height 必须与它一致（且不超过 2048）；请先缩放原图和 mask`,
          }),
          { status: 400 }
        )
      }
      const mask = toMaskPng(maskInput, width, height)
      if (!mask) {
        return new Response(
          JSON.stringify({
            error: `mask 无法识别：请传 PNG 字节数组，或按 ${width}×${height} 传单通道 / RGBA 像素数组`,
          }),
          { status: 400 }
        )
      }
      // PNG mask 会原样透传，尺寸不看一眼就会由模型报一句看不懂的尺寸错误。
      const maskSize = pngDimensions(Buffer.from(mask))
      if (maskSize && (maskSize.width !== width || maskSize.height !== height)) {
        return new Response(
          JSON.stringify({
            error: `mask 是 ${maskSize.width}×${maskSize.height}，必须与原图 ${width}×${height} 一致；请先缩放 mask`,
          }),
          { status: 400 }
        )
      }
      const num_steps = clampInt(body?.num_steps, 1, 20, 20)
      const guidanceRaw = Number(body?.guidance)
      const guidance = Number.isFinite(guidanceRaw) ? Math.max(1, Math.min(20, guidanceRaw)) : 7.5
      const strengthRaw = Number(body?.strength)
      const strength = Number.isFinite(strengthRaw) ? Math.max(0.05, Math.min(1, strengthRaw)) : 1
      const seed = clampInt(body?.seed, 1, 2_147_483_646, Math.floor(Math.random() * 2_000_000_000) + 1)

      const cfModel = '@cf/runwayml/stable-diffusion-v1-5-inpainting'
      const cfUrl = cfRunUrl(cfAccountId, cfModel)
      const cfResp = await fetchWithTimeout(
        cfUrl,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfToken}`,
            'Content-Type': 'application/json',
            Accept: 'image/png,application/json;q=0.9',
          },
          body: JSON.stringify({
            prompt,
            negative_prompt: negative_prompt || undefined,
            image_b64: imageB64,
            mask,
            width,
            height,
            num_steps,
            guidance,
            strength,
            seed,
          }),
        },
        50_000
      )

      if (!cfResp.ok) {
        const err = await readCfError(cfResp)
        const msg = err.message || `HTTP ${cfResp.status}`
        console.log(`[ai-draw:${reqId}] inpaint cloudflare error`, {
          status: cfResp.status,
          cfRay: err.cfRay,
          reqId: err.reqId,
          msg,
        })
        let hint = ''
        if (cfResp.status === 401 || cfResp.status === 403) {
          const verified = await verifyCfToken(cfToken)
          hint = verified.ok
            ? 'Cloudflare Token 有效但无权调用该 Account/Workers AI：请用 Workers AI 页面生成的 REST API Token，并确认 Account ID 属于同一账号'
            : 'Cloudflare Token 校验失败：请确认使用的是 Workers AI 的 API Token（不是 Global API Key），且未过期'
        }
        return new Response(
          JSON.stringify({
            error: `cloudflare inpaint failed: ${msg}`,
            hint: hint || undefined,
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
        if (typeof result === 'string') imgBuf = base64ToBuffer(result)
        else if (typeof result?.image_b64 === 'string') imgBuf = base64ToBuffer(result.image_b64)
        else if (Array.isArray(result?.image)) imgBuf = Buffer.from(Uint8Array.from(result.image))
        else if (typeof result?.image === 'string') imgBuf = base64ToBuffer(result.image)
      } else {
        imgBuf = Buffer.from(await cfResp.arrayBuffer())
      }
      if (!imgBuf.length) return new Response(JSON.stringify({ error: 'cloudflare ai returned empty image' }), { status: 502 })
      const imageMeta = detectImageMeta(imgBuf, contentType)

      const bucket = process.env.SUPABASE_IMAGES_BUCKET || 'images'
      const path = `images/inpaint-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${imageMeta.ext}`
      let { error: uploadError } = await admin.client.storage.from(bucket).upload(path, imgBuf, {
        contentType: imageMeta.mime,
        cacheControl: '3600',
        upsert: false,
      })
      if (uploadError) {
        const msg = String(uploadError.message || '')
        if (/bucket/i.test(msg) && /not found/i.test(msg)) {
          await admin.client.storage.createBucket(bucket, { public: true }).catch(() => null)
          ;({ error: uploadError } = await admin.client.storage.from(bucket).upload(path, imgBuf, {
            contentType: imageMeta.mime,
            cacheControl: '3600',
            upsert: false,
          }))
        }
      }
      if (uploadError) return new Response(JSON.stringify({ error: uploadError.message }), { status: 400 })

      const { data } = admin.client.storage.from(bucket).getPublicUrl(path)
      const image_base64 = imgBuf.toString('base64')
      console.log(`[ai-draw:${reqId}] inpaint ok`, { bytes: imgBuf.length, bucket })
      return Response.json({
        ok: true,
        mode: 'inpaint',
        url: data.publicUrl,
        image_base64,
        prompt,
        negative_prompt,
        width,
        height,
        seed,
        bucket,
        path,
      })
    }

    const geminiKey = process.env.GEMINI_API_KEY
    if (!geminiKey) return new Response(JSON.stringify({ error: 'Missing env: GEMINI_API_KEY' }), { status: 500 })

    const model = process.env.GEMINI_MODEL || 'gemini-3-flash-preview'
    const sourceText = stripMd(markdown).slice(0, 7000)
    const styleHint = language === 'en' ? 'clean editorial cover, modern, cinematic lighting' : '现代编辑封面风格，简洁高级，电影感光影'
    const [primaryTopic, ...secondaryTopics] = topics
    const storyContext = [
      'story_source:',
      `- story_summary: ${excerpt || '(not provided)'}`,
      `- opening_paragraph: ${opening || '(not provided)'}`,
      '- Build the image primarily from story_summary and opening_paragraph; use article_text only as supporting context.',
      '- Choose one concrete scene, character moment, object, or visual metaphor that captures the central conflict.',
      '- Keep details specific to this story; avoid a generic genre poster or a collage of multiple events.',
    ]
    const topicContext = topics.length
      ? [
          'topic_context:',
          `- primary_topic: ${primaryTopic}`,
          `- secondary_topics: ${secondaryTopics.length > 0 ? secondaryTopics.join(', ') : 'none'}`,
          '- Use primary_topic as the main subject and visual metaphor.',
          '- Use secondary topics only to inform setting, props and mood; do not give them equal weight.',
          '- Interpret topics semantically. Never render topic words, category labels, title or any other text in the image.',
          '- The specific story and conflict in the article outrank generic category imagery.',
        ]
      : ['topic_context: none (infer only from the title and article text)']
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
      ...storyContext,
      ...topicContext,
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
      const storyLead =
        [excerpt, opening].filter(Boolean).join(' ').slice(0, 420) ||
        stripMd(markdown).slice(0, 240)
      const topicHint = topics.length > 0 ? `visual themes: ${topics.join(', ')}, ` : ''
      out = {
        prompt: `${seed}, ${storyLead || 'editorial cover photo'}, ${topicHint}${styleHint}, ultra detailed, cinematic lighting, shallow depth of field`,
        negative_prompt: fallbackNegative,
      }
    }

    const prompt = String(out?.prompt || '').trim()
    const negative_prompt = String(out?.negative_prompt || fallbackNegative).trim()
    if (!prompt) {
      return new Response(JSON.stringify({ error: 'invalid prompt output' }), { status: 500 })
    }

    const cfModel = '@cf/bytedance/stable-diffusion-xl-lightning'
    const cfUrl = cfRunUrl(cfAccountId, cfModel)
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

    const imageMeta = detectImageMeta(imgBuf, contentType)
    const bucket = process.env.SUPABASE_IMAGES_BUCKET || 'images'
    const key = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${imageMeta.ext}`
    const path = `images/news-${key}`

    const adminClient = admin.client
    const uploadOnce = async () => {
      return await adminClient.storage.from(bucket).upload(path, imgBuf, {
        contentType: imageMeta.mime,
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
    return Response.json({ ok: true, url: data.publicUrl, prompt, negative_prompt, topics, bucket, path })
  } catch (e: any) {
    if (isAbortError(e)) return new Response(JSON.stringify({ error: '绘图超时，请重试' }), { status: 504 })
    console.log(`[ai-draw:${reqId}] fatal`, e?.message)
    return new Response(JSON.stringify({ error: e?.message || 'draw failed' }), { status: 500 })
  }
}
