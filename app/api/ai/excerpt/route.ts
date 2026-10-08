import type { NextRequest } from 'next/server'
import { callGeminiText, htmlToPlainText, isAbortError, jsonResponse, requireAdmin, stripFences } from '@/lib/aiGemini'
import { buildExcerptPrompt } from '@/lib/storyPrompt'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * ✨ 真的 AI 摘要。
 *
 * 编辑页右上角那颗「AI 一键生成摘要」以前只是把正文前 130 个字截下来 ——
 * 那个按钮的文案是假的。这个接口才是真的：把正文发给模型，让它写一段摘要。
 *
 * language 跟随当前的编辑页签：
 *   'zh' → 生成中文摘要（写进 excerpt_zh）
 *   'en' → 生成英文摘要（写进 excerpt，也就是前台显示的那一栏）
 */
export async function POST(req: NextRequest) {
  const reqId = Math.random().toString(16).slice(2, 8)
  try {
    const auth = await requireAdmin(req)
    if (auth.ok === false) return auth.response

    const body = await req.json().catch(() => ({}))
    const language = body?.language === 'en' ? 'en' : 'zh'
    const title = String(body?.title || '').trim().slice(0, 300)
    const html = String(body?.html || '')
    const bodyText = htmlToPlainText(html)

    if (bodyText.length < 80) {
      return jsonResponse({ error: '正文太短了，写点内容再生成摘要' }, 400)
    }

    const gemini = await callGeminiText({
      prompt: buildExcerptPrompt({ language, title, bodyText }),
      // 摘要是收敛型任务，温度压得很低，避免它自己编情节
      temperature: 0.35,
      timeoutMs: 30000,
      maxOutputTokens: 1024,
    })
    if (gemini.ok === false) return jsonResponse({ error: gemini.error }, gemini.status)

    const excerpt = stripFences(gemini.text)
      .split(/\n{2,}/)[0]
      .replace(/\s*\n+\s*/g, ' ')
      .replace(/^(摘要|Summary|Excerpt)[:：]\s*/i, '')
      .replace(/^["'“”「『]|["'“”」』]$/g, '')
      .trim()
      .slice(0, language === 'en' ? 400 : 300)

    if (!excerpt) return jsonResponse({ error: '模型没有给出摘要，请重试' }, 502)

    console.log(`[ai-excerpt:${reqId}] ok`, { language, chars: excerpt.length })
    return Response.json({ ok: true, data: { excerpt, language } })
  } catch (e: any) {
    if (isAbortError(e)) return jsonResponse({ error: '生成摘要超时，请重试' }, 504)
    console.log(`[ai-excerpt:${reqId}] fatal`, e?.message)
    return jsonResponse({ error: e?.message || '生成摘要失败' }, 500)
  }
}
