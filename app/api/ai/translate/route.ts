import type { NextRequest } from 'next/server'
import { callGeminiText, htmlToPlainText, isAbortError, jsonResponse, requireAdmin } from '@/lib/aiGemini'
import { buildTranslatePrompt, countChineseChars, countWords, parseDelimitedStory, toStoryHtml } from '@/lib/storyPrompt'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * 🌐 中文 → 英文（母语化重写）。
 *
 * 站长的工作方式是「后台看中文、前台显示英文」：这一篇中文定稿之后再点翻译，
 * 出来的英文会写进 articles 的 title / excerpt / content_html（前台读这三列），
 * 中文则留在 title_zh / excerpt_zh / content_zh_html —— 两边都在，随时能回去改。
 *
 * 红线：情节、人物、情绪、结局、伏笔位置不许动；允许句子重组、比喻本地化。
 */
export async function POST(req: NextRequest) {
  const reqId = Math.random().toString(16).slice(2, 8)
  try {
    const auth = await requireAdmin(req)
    if (auth.ok === false) return auth.response

    const body = await req.json().catch(() => ({}))
    const zhTitle = String(body?.title || '').trim().slice(0, 200)
    const zhExcerpt = String(body?.excerpt || '').trim().slice(0, 600)
    const zhHtml = String(body?.html || '')
    const zhBodyText = htmlToPlainText(zhHtml)

    if (zhBodyText.length < 50) {
      return jsonResponse({ error: '中文正文太短了，先写完再翻译' }, 400)
    }

    const zhLength = countChineseChars(zhBodyText)
    const gemini = await callGeminiText({
      prompt: buildTranslatePrompt({ zhTitle, zhExcerpt, zhBodyText, zhLength }),
      // 0.85：够它把句子重写成地道英语，又不至于自己加戏
      temperature: 0.85,
      timeoutMs: 55000,
      maxOutputTokens: 8192,
    })
    if (gemini.ok === false) return jsonResponse({ error: gemini.error }, gemini.status)

    const warnings: string[] = []
    if (gemini.truncated) warnings.push('英文输出被长度上限截断了，建议重试或把中文删短一点')

    const parsed = parseDelimitedStory(gemini.text)
    const html = toStoryHtml(parsed.body || parsed.excerpt)
    const title = String(parsed.title || '').replace(/^["'“”《]|["'“”》]$/g, '').trim().slice(0, 200)
    const excerpt = String(parsed.excerpt || '').replace(/\s*\n+\s*/g, ' ').trim().slice(0, 400)

    if (!title) return jsonResponse({ error: '模型没有给出英文标题，请重试一次' }, 502)
    const words = countWords(htmlToPlainText(html))
    if (words < Math.max(120, zhLength * 0.35)) {
      warnings.push(`英文只有 ${words} 词（中文 ${zhLength} 字），可能被写短了，建议重译一遍`)
    }

    console.log(`[ai-translate:${reqId}] ok`, { zhLength, words })
    return Response.json({ ok: true, data: { title, excerpt, html, words, warnings } })
  } catch (e: any) {
    if (isAbortError(e)) return jsonResponse({ error: '翻译超时，请重试' }, 504)
    console.log(`[ai-translate:${reqId}] fatal`, e?.message)
    return jsonResponse({ error: e?.message || '翻译失败' }, 500)
  }
}
