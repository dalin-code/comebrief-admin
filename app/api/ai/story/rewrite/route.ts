import type { NextRequest } from 'next/server'
import { htmlToPlainText, isAbortError, jsonResponse, requireAdmin } from '@/lib/aiGemini'
import { callText } from '@/lib/aiProvider'
import { countChineseChars, parseDelimitedStory, toStoryHtml } from '@/lib/storyPrompt'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { loadSkill } from '@/lib/storySkills'
import { REVIEW_DIMENSIONS, type ReviewDimensionKey, type ReviewIssue } from '@/lib/storyReview'
import { buildRewriteSystemPrompt, buildRewriteUserPrompt } from '@/lib/storyRewrite'

export const runtime = 'nodejs'
export const maxDuration = 60

const SEVERITIES = ['high', 'mid', 'low'] as const

/**
 * 前端传上来的清单只信「维度 / 严重度 / 引句 / 问题 / 改法」这五个字段，其余一律重建。
 * 不信任前端的理由和标签一样：清单是要写进提示词去命令模型的，不能是任意字符串。
 */
function normalizeIssues(input: unknown): ReviewIssue[] {
  if (!Array.isArray(input)) return []
  const out: ReviewIssue[] = []
  for (const raw of input.slice(0, 8)) {
    const item = raw as any
    const dimension = String(item?.dimension || '') as ReviewDimensionKey
    if (!REVIEW_DIMENSIONS.some((d) => d.key === dimension)) continue
    const problem = String(item?.problem || '').trim().slice(0, 300)
    const fix = String(item?.fix || '').trim().slice(0, 400)
    if (!problem && !fix) continue
    const sev = String(item?.severity || 'mid').toLowerCase()
    out.push({
      id: `I${out.length + 1}`,
      dimension,
      severity: (SEVERITIES as readonly string[]).includes(sev) ? (sev as ReviewIssue['severity']) : 'mid',
      evidence: String(item?.evidence || '').trim().slice(0, 120),
      problem,
      fix,
    })
  }
  return out
}

/**
 * ✨ 定向重写（P3 第三遍）—— 只改点名的那几处，别的逐字保留。
 *
 * 入参：{ html 或 text, title, excerpt, issues: ReviewIssue[], notes, skill }
 *   issues = AI 自评的清单（勾选过的）；notes = 站长自己写的评价与想法。
 *   两者至少给一个 —— 只有站长意见时，模型照样按他的意见定向改。
 * 出参：{ ok, data: { title, excerpt, html, chars, before, after, rewrites, warnings, model, ms } }
 *
 * 和第一遍同一套写作宪法（角色 + 写法 + 禁忌），所以改完不会换一种腔调。
 */
export async function POST(req: NextRequest) {
  const reqId = Math.random().toString(16).slice(2, 8)
  try {
    const auth = await requireAdmin(req)
    if (auth.ok === false) return auth.response

    const body = await req.json().catch(() => ({}))
    const title = String(body?.title || '').trim().slice(0, 60)
    const excerpt = String(body?.excerpt || '').trim().slice(0, 400)
    const text = String(body?.text || '').trim()
    const html = String(body?.html || '').trim()
    const bodyText = (text || htmlToPlainText(html) || '').trim()
    // 站长自己写的评价与想法 —— 和勾选的清单一起当改稿依据（上限与前端 textarea 的 maxLength 对齐）
    const notes = String(body?.notes || '').trim().slice(0, 800)

    if (bodyText.length < 80) return jsonResponse({ error: '正文太短了（至少 80 字才值得重写）' }, 400)
    if (bodyText.length > 12000) return jsonResponse({ error: '正文太长了，重写只适用于单篇短篇（12000 字以内）' }, 400)

    const issues = normalizeIssues(body?.issues)
    // 只有站长意见、没勾任何条目也允许改 —— 「我自己看出来的问题，凭什么非得 AI 先点头」
    if (!issues.length && !notes) {
      return jsonResponse({ error: '没有要改的地方：先跑一次自评勾选条目，或在「你的评价与想法」里写几句' }, 400)
    }

    const admin = getSupabaseAdminClient()
    if (!admin.ok) return jsonResponse({ error: admin.error }, 500)

    const chosen = await loadSkill(admin.client, body?.skill)

    const ai = await callText({
      task: 'revise',
      system: buildRewriteSystemPrompt(chosen.row),
      prompt: buildRewriteUserPrompt({ title, bodyText, excerpt, issues, notes }),
      // 改稿要贴着原文走：温度比初稿低一档，太高会「顺手发挥」
      temperature: 0.6,
      maxOutputTokens: 8192,
      timeoutMs: 55000,
      retries: 0,
      thinkingBudget: 0,
    })
    if (ai.ok === false) {
      console.log(`[ai-rewrite:${reqId}] 模型调用失败`, { status: ai.status, error: ai.error })
      return jsonResponse({ error: ai.error }, ai.status)
    }

    const parsed = parseDelimitedStory(ai.text)
    const nextHtml = toStoryHtml(parsed.body || parsed.excerpt)
    const chars = countChineseChars(htmlToPlainText(nextHtml))

    if (chars < 80) {
      console.log(`[ai-rewrite:${reqId}] 内容过短`, { chars, model: ai.model })
      return jsonResponse({ error: '模型这一遍没改出有效正文，原稿已保留，可以再试一次' }, 502)
    }

    const warnings: string[] = []
    if (chosen.warning) warnings.push(chosen.warning)
    // 定向改稿不该大幅改变篇幅：偏太多说明它顺手重写了，提醒站长比对一下
    if (chars < bodyText.length * 0.7) warnings.push(`改完比原稿短了不少（${bodyText.length} → ${chars} 字），留意有没有被删段`)
    if (chars > bodyText.length * 1.3) warnings.push(`改完比原稿长了不少（${bodyText.length} → ${chars} 字），留意有没有被加料`)
    if (ai.truncated) warnings.push('模型输出被长度上限截断了，建议重试一次')

    const nextTitle =
      (parsed.title || '').replace(/[《》「」"'“”]/g, '').trim().slice(0, 40) || title || '未命名短篇'

    console.log(`[ai-rewrite:${reqId}] ok`, {
      before: bodyText.length,
      after: chars,
      issues: issues.length,
      notes: notes.length,
      dims: Array.from(new Set(issues.map((i) => i.dimension))).join(','),
      skill: chosen.row?.code || '(无)',
      model: ai.model,
      ms: ai.ms,
    })

    return Response.json({
      ok: true,
      data: {
        title: nextTitle,
        excerpt: (parsed.excerpt || excerpt || '').slice(0, 400),
        html: nextHtml,
        chars,
        before: bodyText.length,
        after: chars,
        rewrites: issues.length,
        warnings,
        model: ai.model,
        ms: ai.ms,
      },
    })
  } catch (e: any) {
    if (isAbortError(e)) return jsonResponse({ error: '重写超时，请重试' }, 504)
    console.log(`[ai-rewrite:${reqId}] fatal`, e?.message)
    return jsonResponse({ error: e?.message || '重写失败' }, 500)
  }
}
