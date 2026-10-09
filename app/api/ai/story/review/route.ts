import type { NextRequest } from 'next/server'
import { htmlToPlainText, isAbortError, jsonResponse, requireAdmin } from '@/lib/aiGemini'
import { callText } from '@/lib/aiProvider'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { loadSkill } from '@/lib/storySkills'
import { buildReviewSystemPrompt, buildReviewUserPrompt, parseStoryReview } from '@/lib/storyReview'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * ✨ AI 自评（P3 第二遍）—— 拿草稿换一份 6 维体检报告（JSON）。
 *
 * 入参：{ html 或 text, title, length, notes, skill }
 *   notes = 站长自己写的评价与想法（可留空）：他关心的位置必须被评到，但打分锚点照旧。
 * 出参：{ ok, data: { review, skill, warnings, model, ms } }
 *
 * 这一层**绝不改稿**，也不阻塞出稿：评审失败只回报错误，草稿原样留在前端。
 * 提示词见 lib/storyReview.ts；模型不支持 jsonMode 时靠 parseStoryReview 宽松解析兜底。
 */
export async function POST(req: NextRequest) {
  const reqId = Math.random().toString(16).slice(2, 8)
  try {
    const auth = await requireAdmin(req)
    if (auth.ok === false) return auth.response

    const body = await req.json().catch(() => ({}))
    const title = String(body?.title || '').trim().slice(0, 60)
    const text = String(body?.text || '').trim()
    const html = String(body?.html || '').trim()
    const bodyText = (text || htmlToPlainText(html) || '').trim()
    const targetLength = Number(body?.length) || 0
    // 站长自己写的评价与想法 —— 让 AI 在报告里正面回应他关心的位置（打分锚点不变）
    const notes = String(body?.notes || '').trim().slice(0, 800)

    if (bodyText.length < 80) return jsonResponse({ error: '正文太短了（至少 80 字才值得评审）' }, 400)
    if (bodyText.length > 12000) return jsonResponse({ error: '正文太长了，自评只适用于单篇短篇（12000 字以内）' }, 400)

    const admin = getSupabaseAdminClient()
    if (!admin.ok) return jsonResponse({ error: admin.error }, 500)

    // 评审也要知道「这篇按哪套写法写的」—— style 这一维就是拿它当尺子
    const chosen = await loadSkill(admin.client, body?.skill)

    const ai = await callText({
      task: 'revise',
      system: buildReviewSystemPrompt(chosen.row),
      prompt: buildReviewUserPrompt({ title, bodyText, targetLength, notes }),
      // 审稿要稳：温度压低，别让它发挥创意
      temperature: 0.2,
      jsonMode: true,
      maxOutputTokens: 2048,
      timeoutMs: 45000,
      // 评审是流水线中间站，重试会把总时长耗光；失败就让站长点一次重试
      retries: 0,
      // 思考 token 会抢 JSON 的额度，导致 JSON 被截断 —— 必须关
      thinkingBudget: 0,
    })
    if (ai.ok === false) {
      console.log(`[ai-review:${reqId}] 模型调用失败`, { status: ai.status, error: ai.error })
      return jsonResponse({ error: ai.error }, ai.status)
    }

    const parsed = parseStoryReview(ai.text, ai.model)
    if (parsed.ok === false) {
      console.log(`[ai-review:${reqId}] parse failed`, {
        model: ai.model,
        error: parsed.error,
        raw: parsed.raw.slice(0, 200),
      })
      return jsonResponse({ error: `自评失败：${parsed.error}（可直接重试，或先手动改稿）`, raw: parsed.raw }, 502)
    }

    const review = parsed.review
    console.log(`[ai-review:${reqId}] ok`, {
      total: review.total,
      issues: review.issues.length,
      chars: bodyText.length,
      notes: notes.length,
      skill: chosen.row?.code || '(无)',
      model: ai.model,
      ms: ai.ms,
    })

    return Response.json({
      ok: true,
      data: {
        review,
        skill: chosen.row ? { code: chosen.row.code, name: chosen.row.name } : null,
        warnings: chosen.warning ? [chosen.warning] : [],
        model: ai.model,
        ms: ai.ms,
      },
    })
  } catch (e: any) {
    if (isAbortError(e)) return jsonResponse({ error: '自评超时，请重试' }, 504)
    console.log(`[ai-review:${reqId}] fatal`, e?.message)
    return jsonResponse({ error: e?.message || '自评失败' }, 500)
  }
}
