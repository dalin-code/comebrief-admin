import type { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const maxDuration = 60

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> }
  }>
}

const textFromHtml = (html: string) =>
  String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const fetchWithTimeout = async (url: string, init: RequestInit, ms: number) => {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(id)
  }
}

const normalizeTargetUrl = (input: string) => {
  const cleaned = (input || '')
    .trim()
    .replace(/^[<("'“‘\s]+/g, '')
    .replace(/[)\]>“’"'。．，,;；!！?？\s]+$/g, '')
  const withScheme = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`
  return withScheme
}

const extractFirstUrl = (text: string) => {
  const m = String(text || '').match(/https?:\/\/[^\s)"]+/i)
  return m?.[0]?.trim() || ''
}

const normalizeHost = (h: string) => String(h || '').trim().toLowerCase().replace(/^www\./, '')

const shouldSkipPath = (pathLower: string) => {
  if (!pathLower) return true
  const bad = [
    '/tag/',
    '/tags/',
    '/category/',
    '/topics/',
    '/topic/',
    '/author/',
    '/authors/',
    '/page/',
    '/search',
    '/privacy',
    '/terms',
    '/about',
    '/contact',
    '/sitemap',
    '/newsletter',
    '/subscribe',
    '/feed',
    '/rss',
    '/wp-json',
  ]
  return bad.some((x) => pathLower.includes(x))
}

const pickCandidateFromHtml = (html: string, listingUrl: string) => {
  let base: URL | null = null
  let listingHost = ''
  try {
    base = new URL(listingUrl)
    listingHost = normalizeHost(base.hostname)
  } catch {
    base = null
    listingHost = ''
  }
  const hrefRe = /href=["']([^"'\s>]+)["']/gi
  const seen = new Set<string>()
  const candidates: Array<{ url: string; score: number }> = []
  for (const m of String(html || '').matchAll(hrefRe)) {
    const raw = String(m[1] || '').trim()
    if (!raw) continue
    let absUrl = raw
    try {
      absUrl = base ? new URL(raw, base).toString() : raw
    } catch {
      absUrl = raw
    }
    if (!/^https?:\/\//i.test(absUrl)) continue
    if (seen.has(absUrl)) continue
    seen.add(absUrl)
    try {
      const u = new URL(absUrl)
      const host = normalizeHost(u.hostname)
      if (!host) continue
      if (listingHost && !(host === listingHost || host.endsWith(`.${listingHost}`) || listingHost.endsWith(`.${host}`))) continue
      const pathLower = (u.pathname || '').toLowerCase()
      if (shouldSkipPath(pathLower)) continue
      let score = 0
      if (/\/20\d{2}\//.test(pathLower)) score += 5
      if (pathLower.includes('/news/')) score += 3
      if (pathLower.split('/').filter(Boolean).length >= 3) score += 2
      if (u.search) score -= 1
      candidates.push({ url: absUrl, score })
    } catch {
      continue
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.url || ''
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

const stripFences = (text: string) => {
  const trimmed = String(text || '').trim()
  return trimmed.replace(/^```[a-zA-Z0-9_-]*\s*/i, '').replace(/```$/g, '').trim()
}

const getBearer = (req: NextRequest) => {
  const h = req.headers.get('authorization') || ''
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m?.[1]?.trim() || ''
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

const isAbortError = (e: any) => e?.name === 'AbortError' || String(e?.message || '').toLowerCase().includes('aborted')

export async function POST(req: NextRequest) {
  const reqId = Math.random().toString(16).slice(2, 8)
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!supabaseUrl || !anonKey) {
      return new Response(JSON.stringify({ error: 'missing supabase env' }), { status: 500 })
    }

    const token = getBearer(req)
    if (!token) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    const { data: userData, error: userError } = await authClient.auth.getUser(token)
    if (userError || !userData?.user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })

    const body = await req.json().catch(() => ({}))
    const language = body?.language === 'en' ? 'en' : 'zh-CN'
    const title = String(body?.title || '').trim()
    const markdown = String(body?.markdown || '').trim()
    const style = typeof body?.style === 'string' ? body.style.trim().slice(0, 60) : ''

    if (!markdown) return new Response(JSON.stringify({ error: 'missing markdown' }), { status: 400 })

    const geminiKey = process.env.GEMINI_API_KEY
    if (!geminiKey) return new Response(JSON.stringify({ error: 'Missing env: GEMINI_API_KEY' }), { status: 500 })

    const model = process.env.GEMINI_MODEL || 'gemini-3-flash-preview'
    const rawText = stripMd(markdown)
    const maybeSourceUrl = extractFirstUrl(markdown)
    const looksTemplate =
      markdown.includes('发布前请核对') ||
      markdown.includes('- 发生了什么') ||
      markdown.includes('- 为什么重要') ||
      markdown.includes('- 接下来值得关注什么')
    let sourceText = rawText.slice(0, 9000)
    let fetchedFromUrl = ''
    if (maybeSourceUrl && (looksTemplate || rawText.length < 1200)) {
      const url = normalizeTargetUrl(maybeSourceUrl)
      try {
        const html = await fetchWithTimeout(url, { redirect: 'follow' }, 12000).then((r) => r.text())
        let text = textFromHtml(html)
        if (text.length < 1200) {
          const candidate = pickCandidateFromHtml(html, url)
          if (candidate) {
            const html2 = await fetchWithTimeout(candidate, { redirect: 'follow' }, 12000).then((r) => r.text())
            const t2 = textFromHtml(html2)
            if (t2.length > text.length) {
              text = t2
              fetchedFromUrl = candidate
            }
          }
        }
        if (text.length >= 800) {
          sourceText = text.slice(0, 9000)
          if (!fetchedFromUrl) fetchedFromUrl = url
        }
      } catch {
        // keep existing sourceText
      }
    }

    const prompt = [
      '你是“内容工厂”的资深编辑。',
      '请将我提供的文章内容重新整理为一篇全新的文章：结构更清晰、表述更顺畅、段落更合理，但不要捏造事实。',
      '只返回一个 JSON（不要 Markdown，不要解释）：',
      '{',
      '  "title": string,',
      '  "meta_title": string,',
      '  "meta_description": string,',
      '  "markdown": string',
      '}',
      '',
      '约束：',
      '- 保留核心信息点，但措辞与结构必须明显不同',
      '- markdown 使用 Markdown（含导语、分段小标题、要点列表、结尾总结）',
      fetchedFromUrl ? '- markdown 第一段保留来源链接（可点击）' : '',
      '- meta_description 120-160 字左右',
      language === 'en' ? '- 使用英文输出' : '- 使用中文输出（zh-CN）',
      style ? `- 写作风格：${style}` : '',
      '',
      `seed_title: ${title}`,
      fetchedFromUrl ? `source_url: ${fetchedFromUrl}` : maybeSourceUrl ? `source_url: ${normalizeTargetUrl(maybeSourceUrl)}` : '',
      'source_text:',
      sourceText,
    ]
      .filter(Boolean)
      .join('\n')

    const resp = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7 } }),
      },
      20000
    )
    const raw = (await resp.json().catch(() => ({}))) as GeminiResponse
    const text = raw?.candidates?.[0]?.content?.parts?.[0]?.text || ''

    let parsed = safeParseModelJson(text)
    if (!parsed.ok) {
      const repairPrompt = [
        '请把下方内容转换为严格 JSON。',
        '必须以 { 开头，以 } 结尾；不要使用 Markdown 代码块；不要输出多余文字。',
        'JSON 结构：',
        '{',
        '  "title": string,',
        '  "meta_title": string,',
        '  "meta_description": string,',
        '  "markdown": string',
        '}',
        '',
        'raw_output:',
        text.slice(0, 12000),
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

    if (!parsed.ok) {
      const candidate = stripFences(text)
      const fallbackMarkdown = candidate.length >= 120 ? candidate : markdown
      const fallbackTitle = title || '新文章'
      const fallbackMetaTitle = fallbackTitle
      const fallbackMetaDesc = ''
      console.log(`[news-rewrite:${reqId}] fallback`, { chars: markdown.length })
      return Response.json({
        ok: true,
        fallback: true,
        data: { title: fallbackTitle, meta_title: fallbackMetaTitle, meta_description: fallbackMetaDesc, markdown: fallbackMarkdown },
      })
    }

    const out = parsed.value as any
    const newTitle = String(out?.title || title || '新文章').trim()
    const meta_title = String(out?.meta_title || newTitle).trim()
    const meta_description = String(out?.meta_description || '').trim()
    const newMarkdown = String(out?.markdown || '').trim()
    if (!newTitle || !newMarkdown) return new Response(JSON.stringify({ error: 'invalid model output' }), { status: 500 })

    console.log(`[news-rewrite:${reqId}] ok`, { chars: markdown.length })
    return Response.json({ ok: true, data: { title: newTitle, meta_title, meta_description, markdown: newMarkdown } })
  } catch (e: any) {
    if (isAbortError(e)) {
      return new Response(JSON.stringify({ error: '改写超时，请重试' }), { status: 504 })
    }
    console.log(`[news-rewrite] fatal`, e?.message)
    return new Response(JSON.stringify({ error: e?.message || 'rewrite failed' }), { status: 500 })
  }
}
