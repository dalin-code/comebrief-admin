import type { NextRequest } from 'next/server'
import { isAbortError, jsonResponse, requireAdmin } from '@/lib/aiGemini'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { buildArticleSlug, countChineseChars, htmlToPlainText } from '@/lib/storyPrompt'

export const runtime = 'nodejs'
export const maxDuration = 60

const clean = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max)

/**
 * 批量创作的落库口：只创建草稿，绝不发布。
 *
 * 和 /api/news/save 的差别：
 *   · 这里固定 status=draft（批量生成的东西必须先让站长逐篇看过）；
 *   · 允许只带中文稿（英文三列留空，等编辑页翻译完再补）；
 *   · 遇到旧库缺列 / slug 撞车时自动降级重试，不把整批卡死在一篇上。
 */
export async function POST(req: NextRequest) {
  const reqId = Math.random().toString(16).slice(2, 8)
  try {
    const auth = await requireAdmin(req)
    if (auth.ok === false) return auth.response

    const admin = getSupabaseAdminClient()
    if (!admin.ok) return jsonResponse({ error: admin.error }, 500)

    const body = await req.json().catch(() => ({}))
    const title = clean(body?.title, 200)
    if (!title) return jsonResponse({ error: 'missing title' }, 400)

    const titleZh = clean(body?.title_zh, 200) || title
    const excerptZh = clean(body?.excerpt_zh ?? body?.excerpt, 800)
    const htmlZh = String(body?.content_zh_html ?? body?.html ?? '').trim()
    if (!htmlZh) return jsonResponse({ error: 'missing content_zh_html' }, 400)

    const storyCombo =
      body?.story_combo && typeof body.story_combo === 'object' ? (body.story_combo as Record<string, unknown>) : null
    const rawCategories = Array.isArray(body?.categories) ? body.categories : [body?.category]
    const categories = rawCategories
      .map((cat: unknown) => clean(cat, 80))
      .filter(Boolean)
    const primaryCategory = categories[0] || 'AI'
    const savedCategories = categories.length > 0 ? categories : [primaryCategory]
    const baseSlug = buildArticleSlug(title) || 'draft'
    const payload: Record<string, unknown> = {
      title,
      title_zh: titleZh,
      excerpt: clean(body?.excerpt, 800),
      excerpt_zh: excerptZh,
      content_html: '',
      content_zh_html: htmlZh,
      slug: baseSlug,
      status: 'draft',
      category: primaryCategory,
      categories: savedCategories,
      cover_url: '',
      cover_url_share: '',
      story_combo: storyCombo,
      translated_at: null,
    }

    let current = payload
    for (let i = 0; i < 10; i += 1) {
      const { data, error } = await admin.client.from('articles').insert(current).select('id,title,slug,status').maybeSingle()
      if (!error) {
        console.log(`[article-draft:${reqId}] ok`, {
          id: data?.id,
          chars: countChineseChars(htmlToPlainText(htmlZh)),
          user: auth.userId,
        })
        return jsonResponse({ ok: true, data: data || null })
      }

      const msg = String(error.message || '')
      const dupSlug =
        /duplicate key value violates unique constraint/i.test(msg) && /(slug|articles_slug_key|articles_slug_unique)/i.test(msg)
      if (dupSlug) {
        current = { ...current, slug: `${baseSlug}-${Math.random().toString(16).slice(2, 6)}` }
        continue
      }

      const m1 = msg.match(/Could not find the '([^']+)' column/i)
      const m2 = msg.match(/column\s+articles\.([a-zA-Z0-9_]+)\s+does\s+not\s+exist/i)
      const missing = (m1?.[1] || m2?.[1] || '').trim()
      if (missing && Object.prototype.hasOwnProperty.call(current, missing)) {
        const next = { ...current }
        delete next[missing]
        current = next
        continue
      }

      console.log(`[article-draft:${reqId}] insert failed`, { message: msg, code: error.code })
      return jsonResponse({ error: msg || 'create draft failed', code: error.code || null }, 400)
    }

    return jsonResponse({ error: 'create draft failed' }, 400)
  } catch (e: any) {
    if (isAbortError(e)) return jsonResponse({ error: '创建草稿超时，请重试' }, 504)
    console.log(`[article-draft:${reqId}] fatal`, e?.message)
    return jsonResponse({ error: e?.message || 'create draft failed' }, 500)
  }
}
