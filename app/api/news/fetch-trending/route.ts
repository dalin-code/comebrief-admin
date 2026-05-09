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

const looksLikeJinaBlock = (bodyText: string) => {
  const t = String(bodyText || '').trim()
  if (!t) return false
  if (!(t.startsWith('{') && t.endsWith('}'))) return false
  if (t.includes('"SecurityCompromiseError"')) return true
  if (/"code"\s*:\s*451\b/.test(t)) return true
  if (/"status"\s*:\s*451/.test(t)) return true
  return false
}

const fetchJinaMarkdown = async (targetUrl: string, ms: number) => {
  const r = await fetchWithTimeout(`https://r.jina.ai/${targetUrl}`, { redirect: 'follow' }, ms)
  const text = await r.text()
  if (looksLikeJinaBlock(text)) throw new Error('jina blocked')
  return text
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

const normalizeTargetUrl = (input: string) => {
  const cleaned = (input || '')
    .trim()
    .replace(/^[<("'“‘\s]+/g, '')
    .replace(/[)\]>“’"'。．，,;；!！?？\s]+$/g, '')
  const withScheme = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`
  return withScheme
}

const getBearer = (req: NextRequest) => {
  const h = req.headers.get('authorization') || ''
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m?.[1]?.trim() || ''
}

function collapseText(md: string) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*_~\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildFallbackArticle(params: {
  language: string
  articleUrl: string
  seedTitle: string
  listingName: string
  listingText: string
  articleText?: string
}) {
  const title = String(params.seedTitle || '').trim() || (params.language === 'en' ? 'AI News' : 'AI 资讯')
  const meta_title = title
  const meta_description = String(params.articleText || params.listingText || '').trim().slice(0, 160)
  const srcLine =
    params.language === 'en'
      ? `Source: [${params.articleUrl}](${params.articleUrl})`
      : `来源：[${params.articleUrl}](${params.articleUrl})`
  const excerpt = String(params.articleText || params.listingText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900)
  const markdown =
    params.language === 'en'
      ? [
          srcLine,
          '',
          '## Lead',
          'This article was generated from a public source link. Please verify key details before publishing.',
          '',
          '## Extract',
          excerpt ? excerpt : '(No extract available)',
          '',
          '## Key Points',
          '- What happened',
          '- Why it matters',
          '- What to watch next',
          '',
          '## Takeaways',
          '- Practical implications for builders and teams',
          '',
          `Source feed: ${params.listingName}`,
        ].join('\n')
      : [
          srcLine,
          '',
          '## 导语',
          '本文基于公开来源链接整理生成，发布前请核对关键事实与细节。',
          '',
          '## 摘录',
          excerpt ? excerpt : '（暂无可用摘录）',
          '',
          '## 要点',
          '- 发生了什么',
          '- 为什么重要',
          '- 接下来值得关注什么',
          '',
          '## 影响与建议',
          '- 对产品/团队的可执行建议',
          '',
          `来源站点：${params.listingName}`,
        ].join('\n')
  const tags: string[] = []
  return { title, meta_title, meta_description, markdown, tags }
}

const isAbortError = (e: any) => e?.name === 'AbortError' || String(e?.message || '').toLowerCase().includes('aborted')

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

const pickArticleCandidatesFromHtml = (html: string, listingUrl: string) => {
  let listingHost = ''
  let base: URL | null = null
  try {
    base = new URL(listingUrl)
    listingHost = normalizeHost(base.hostname)
  } catch {
    base = null
    listingHost = ''
  }

  const candidates: Array<{ title: string; url: string; score: number }> = []
  const seen = new Set<string>()
  const hrefRe = /href=["']([^"'\s>]+)["']/gi
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
      if (host.includes('r.jina.ai')) continue
      const pathLower = (u.pathname || '').toLowerCase()
      if (shouldSkipPath(pathLower)) continue

      let score = 0
      if (listingHost && (host === listingHost || host.endsWith(`.${listingHost}`) || listingHost.endsWith(`.${host}`))) score += 10
      if (/\/20\d{2}\//.test(pathLower)) score += 3
      if (pathLower.split('/').filter(Boolean).length >= 3) score += 2
      if (u.search) score -= 1

      candidates.push({ title: '', url: absUrl, score })
    } catch {
      continue
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  return candidates
}

const pickArticleCandidatesFromListing = (md: string, listingUrl: string) => {
  let listingHost = ''
  try {
    listingHost = normalizeHost(new URL(listingUrl).hostname)
  } catch {
    listingHost = ''
  }

  const candidates: Array<{ title: string; url: string; score: number }> = []
  const seen = new Set<string>()

  const consider = (rawUrl: string, rawTitle: string) => {
    const url = String(rawUrl || '').trim()
    if (!url) return
    if (!/^https?:\/\//i.test(url)) return
    if (seen.has(url)) return
    seen.add(url)
    try {
      const u = new URL(url)
      const host = normalizeHost(u.hostname)
      if (!host) return
      if (host.includes('r.jina.ai')) return
      const pathLower = (u.pathname || '').toLowerCase()
      if (shouldSkipPath(pathLower)) return

      let score = 0
      if (listingHost && (host === listingHost || host.endsWith(`.${listingHost}`) || listingHost.endsWith(`.${host}`))) score += 10
      if (/\/20\d{2}\//.test(pathLower)) score += 3
      if (pathLower.split('/').filter(Boolean).length >= 3) score += 2
      if (u.search) score -= 1

      candidates.push({ title: String(rawTitle || '').replace(/\s+/g, ' ').trim(), url, score })
    } catch {
      return
    }
  }

  const linkRe = /\[([^\]]{4,160})\]\((https?:\/\/[^)\s]+)\)/g
  for (const m of md.matchAll(linkRe)) consider(String(m[2] || ''), String(m[1] || ''))

  const hrefRe = /href="(https?:\/\/[^"\s>]+)"/g
  for (const m of md.matchAll(hrefRe)) consider(String(m[1] || ''), '')

  const urlRe = /https?:\/\/[^\s)"]+/g
  for (const m of md.matchAll(urlRe)) consider(String(m[0] || ''), '')

  if (!candidates.length) return []
  candidates.sort((a, b) => b.score - a.score)
  return candidates
}

const isListingLikeText = (candidateText: string, listingText: string) => {
  const a = String(candidateText || '').trim()
  const b = String(listingText || '').trim()
  if (!a || !b) return false
  const aHead = a.slice(0, 900)
  const bHead = b.slice(0, 900)
  if (aHead && bHead && aHead === bHead) return true
  const key = b.slice(0, 520)
  if (key && a.includes(key)) return true
  return false
}

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

    const sources = [
      { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/' },
      { name: 'TechCrunch AI', url: 'https://techcrunch.com/tag/artificial-intelligence/' },
      { name: 'The Verge AI', url: 'https://www.theverge.com/ai-artificial-intelligence' },
    ]
    const model = process.env.GEMINI_MODEL || 'gemini-3-flash-preview'

    const listingPromises = sources.map(async (s) => {
      const url = normalizeTargetUrl(s.url)
      let md = ''
      let html = ''
      try {
        md = await fetchJinaMarkdown(url, 8000).then((t) => String(t || '').slice(0, 12000))
      } catch {
        md = ''
      }
      if (!md.trim()) {
        html = await fetchWithTimeout(url, { redirect: 'follow' }, 9000).then((r) => r.text())
      }
      const text = md.trim() ? md : html
      if (!String(text || '').trim()) throw new Error('empty listing')
      return { name: s.name, url, md: String(md || '').slice(0, 12000), html: String(html || '').slice(0, 160000) }
    })

    let listing: { name: string; url: string; md: string; html: string }
    try {
      listing = await Promise.any(listingPromises)
    } catch {
      listing = { name: sources[sources.length - 1]!.name, url: normalizeTargetUrl(sources[sources.length - 1]!.url), md: '', html: '' }
    }

    if (!listing.md && !listing.html) {
      try {
        listing.md = String(await fetchJinaMarkdown(listing.url, 8000)).slice(0, 12000)
      } catch {
        listing.md = ''
      }
      if (!listing.md.trim()) {
        listing.html = String(await fetchWithTimeout(listing.url, { redirect: 'follow' }, 9000).then((r) => r.text())).slice(0, 160000)
      }
    }

    const listingText = (listing.md.trim() ? collapseText(listing.md) : textFromHtml(listing.html)).slice(0, 2500)
    const candidates = [
      ...pickArticleCandidatesFromListing(listing.md || '', listing.url),
      ...pickArticleCandidatesFromHtml(listing.html || '', listing.url),
    ]
      .map((c) => ({ title: c.title, url: normalizeTargetUrl(c.url), score: c.score }))
      .filter((c) => c.url && c.url !== normalizeTargetUrl(listing.url))
      .reduce((acc: Array<{ title: string; url: string; score: number }>, cur) => {
        const exists = acc.findIndex((x) => x.url === cur.url)
        if (exists >= 0) {
          const prev = acc[exists]!
          acc[exists] = { title: prev.title || cur.title, url: cur.url, score: Math.max(prev.score, cur.score) }
          return acc
        }
        acc.push(cur)
        return acc
      }, [])
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)

    let selectedUrl = normalizeTargetUrl(listing.url)
    let selectedTitle = String(listing.name || '').trim()
    let articleText = ''
    let articleMd = ''
    const tryTargets = [...candidates, { title: selectedTitle, url: selectedUrl, score: -999 }]
    for (const t of tryTargets) {
      const url = normalizeTargetUrl(t.url)
      if (!url) continue
      if (url === normalizeTargetUrl(listing.url) && candidates.length) continue
      try {
        let mdText = ''
        let text = ''
        try {
          mdText = String(await fetchJinaMarkdown(url, 8000)).slice(0, 20000)
          text = collapseText(mdText).slice(0, 8000)
        } catch {
          const html = await fetchWithTimeout(url, { redirect: 'follow' }, 10000).then((r) => r.text())
          text = collapseText(textFromHtml(html)).slice(0, 8000)
        }
        if (text.length < 1200) continue
        if (isListingLikeText(text, listingText)) continue
        selectedUrl = url
        selectedTitle = String(t.title || '').trim() || selectedTitle
        articleText = text.slice(0, 5000)
        if (mdText) articleMd = mdText
        break
      } catch {
        continue
      }
    }

    const articleUrl = selectedUrl
    const seedTitle = selectedTitle

    const detailMd = String(articleMd || '').trim()
    if (detailMd && articleText.length >= 1200) {
      const srcLine =
        language === 'en'
          ? `Source: [${articleUrl}](${articleUrl})`
          : `来源：[${articleUrl}](${articleUrl})`
      const merged = [srcLine, '', detailMd].join('\n').trim().slice(0, 18000).trim()
      const title = seedTitle || (language === 'en' ? 'AI News' : 'AI 资讯')
      const meta_title = title
      const meta_description = collapseText(merged).slice(0, 160)
      console.log(`[news-fetch:${reqId}] detail`, { source: listing.name, articleUrl, chars: merged.length })
      return Response.json({
        ok: true,
        data: { title, meta_title, meta_description, markdown: merged, tags: [], source_url: articleUrl, source_name: listing.name, mode: 'detail' },
      })
    }

    const geminiKey = process.env.GEMINI_API_KEY
    if (!geminiKey) return new Response(JSON.stringify({ error: 'Missing env: GEMINI_API_KEY' }), { status: 500 })

    const composePrompt = [
      '你是“内容工厂”的资深编辑。',
      '我会给你一条 AI 相关新闻的来源链接，以及列表页文本（可能含标题/摘要），有时还会提供抓取到的文章正文片段。',
      '请生成一篇“可发布”的文章稿（避免照抄原文，用自己的话总结并重写；不要捏造事实与具体数字/引用）。',
      '只返回一个 JSON（不要 Markdown，不要解释）：',
      '{',
      '  "title": string,',
      '  "meta_title": string,',
      '  "meta_description": string,',
      '  "markdown": string,',
      '  "tags": string[]',
      '}',
      '',
      '约束：',
      '- markdown 使用 Markdown 格式，包含：导语、要点（列表）、影响/建议、小结',
      '- markdown 第一段包含 “来源：<url>” 的可点击链接',
      '- meta_description 120-160 字左右',
      '- tags 最多 8 个，简短关键词',
      language === 'en' ? '- 使用英文输出' : '- 使用中文输出（zh-CN）',
      '',
      `source_url: ${articleUrl}`,
      `seed_title: ${seedTitle}`,
      `source_name: ${listing.name}`,
      'listing_text:',
      listingText,
      articleText ? 'article_text:' : '',
      articleText ? articleText : '',
    ].join('\n')

    const composeResp = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: composePrompt }] }], generationConfig: { temperature: 0.55 } }),
      },
      20000
    )
    const composeRaw = (await composeResp.json().catch(() => ({}))) as GeminiResponse
    const composeText = composeRaw?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    let parsed = safeParseModelJson(composeText)
    if (!parsed.ok) {
      const repairPrompt = [
        '请把下方内容转换为严格 JSON。',
        '必须以 { 开头，以 } 结尾；不要使用 Markdown 代码块；不要输出多余文字。',
        'JSON 结构：',
        '{',
        '  "title": string,',
        '  "meta_title": string,',
        '  "meta_description": string,',
        '  "markdown": string,',
        '  "tags": string[]',
        '}',
        '',
        `source_url: ${articleUrl}`,
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

    let out: any
    if (parsed.ok) {
      out = parsed.value
    } else {
      out = buildFallbackArticle({ language, articleUrl, seedTitle, listingName: listing.name, listingText, articleText })
    }

    const title = String(out?.title || seedTitle || 'AI 资讯').trim()
    const meta_title = String(out?.meta_title || title).trim()
    const meta_description = String(out?.meta_description || '').trim()
    const markdown = String(out?.markdown || '').trim()
    const tags = Array.isArray(out?.tags) ? out.tags.map((x: any) => String(x || '').trim()).filter(Boolean).slice(0, 8) : []
    if (!title || !markdown) {
      const fb = buildFallbackArticle({ language, articleUrl, seedTitle, listingName: listing.name, listingText, articleText })
      return Response.json({
        ok: true,
        data: { ...fb, source_url: articleUrl, source_name: listing.name },
      })
    }

    console.log(`[news-fetch:${reqId}] ok`, { source: listing.name, articleUrl, articleChars: articleText.length })
    return Response.json({
      ok: true,
      data: { title, meta_title, meta_description, markdown, tags, source_url: articleUrl, source_name: listing.name },
    })
  } catch (e: any) {
    if (isAbortError(e)) {
      return new Response(JSON.stringify({ error: '抓取超时，请重试' }), { status: 504 })
    }
    console.log(`[news-fetch] fatal`, e?.message)
    return new Response(JSON.stringify({ error: e?.message || 'fetch failed' }), { status: 500 })
  }
}
