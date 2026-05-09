import type { NextRequest } from 'next/server'

const pick = (html: string, pattern: RegExp) => {
  const m = html.match(pattern)
  return m && m[1] ? m[1].trim() : null
}

export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json()
    if (!url || typeof url !== 'string') {
      return new Response(JSON.stringify({ error: 'missing url' }), { status: 400 })
    }
    const r = await fetch(url, { redirect: 'follow' })
    const html = await r.text()
    const title = pick(html, /<title[^>]*>([\s\S]*?)<\/title>/i)
    const metaDesc =
      pick(html, /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
      pick(html, /<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    const ogTitle = pick(html, /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    const ogImage = pick(html, /<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    const description = metaDesc || ''
    return Response.json({ title: ogTitle || title || '', description, image: ogImage || '' })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'scrape failed' }), { status: 500 })
  }
}
