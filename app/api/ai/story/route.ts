import type { NextRequest } from 'next/server'
import { htmlToPlainText, isAbortError, jsonResponse, requireAdmin } from '@/lib/aiGemini'
import { callText } from '@/lib/aiProvider'
import {
  buildContinueSystemPrompt,
  buildContinueUserPrompt,
  buildStorySystemPrompt,
  buildStoryUserPrompt,
  countChineseChars,
  parseDelimitedStory,
  toStoryHtml,
  type DimensionKey,
  type StoryCombo,
  type StoryTag,
} from '@/lib/storyPrompt'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { loadSkill } from '@/lib/storySkills'

export const runtime = 'nodejs'
export const maxDuration = 60

const DIMENSION_KEYS: DimensionKey[] = ['genre', 'era', 'pov', 'style', 'structure', 'ending', 'pace']

/**
 * ✨ AI 创作 —— 按选中的标签写一篇中文短篇。
 *
 * 两种模式：
 *   普通模式      body = { combo, idea, materials, length }
 *   续写模式      body 里多带一个 continueFrom（当前已写好的正文纯文本）
 *
 * 标签注解一律从数据库读（story_tags），不信任前端传上来的文案 ——
 * 这样站长在「故事标签」页改完注解，下一次生成立刻生效。
 */
export async function POST(req: NextRequest) {
  const reqId = Math.random().toString(16).slice(2, 8)
  try {
    const auth = await requireAdmin(req)
    if (auth.ok === false) return auth.response

    const body = await req.json().catch(() => ({}))
    const combo: StoryCombo = body?.combo && typeof body.combo === 'object' ? body.combo : {}
    const rawLength = Number(body?.length ?? combo.length)
    const length = [800, 1500, 2500].includes(rawLength) ? rawLength : 1500
    const idea = String(body?.idea ?? (combo as any).idea ?? '').trim().slice(0, 800)
    const materials = String(body?.materials ?? (combo as any).materials ?? '').trim().slice(0, 4000)
    const continueFrom = String(body?.continueFrom || '').trim()

    const admin = getSupabaseAdminClient()
    if (!admin.ok) return jsonResponse({ error: admin.error }, 500)

    const { data: rows, error: tagError } = await admin.client
      .from('story_tags')
      .select('id,dimension,name,summary,example,usage_note,sort_order,is_active')
      .eq('is_active', true)

    if (tagError) {
      const missing = /does not exist|schema cache|relation/i.test(tagError.message || '')
      return jsonResponse(
        {
          error: missing
            ? '标签库还没建好：请先在 Supabase 里执行 supabase/42_story_tags.sql'
            : `读取标签失败：${tagError.message}`,
        },
        missing ? 424 : 500
      )
    }

    const all = (rows || []) as StoryTag[]
    const tagsByDimension: Partial<Record<DimensionKey, StoryTag[]>> = {}
    const warnings: string[] = []

    for (const key of DIMENSION_KEYS) {
      const wanted = Array.isArray(combo[key]) ? (combo[key] as string[]) : []
      if (!wanted.length) continue
      const picked = wanted
        .map((name) => all.find((t) => t.dimension === key && t.name === name))
        .filter(Boolean) as StoryTag[]
      if (picked.length) tagsByDimension[key] = picked
      if (picked.length !== wanted.length) {
        const gone = wanted.filter((n) => !picked.some((p) => p.name === n))
        warnings.push(`标签库里找不到「${gone.join('、')}」，已跳过`)
      }
    }

    if (!continueFrom && !Object.keys(tagsByDimension).length && !idea) {
      return jsonResponse({ error: '至少选一个标签，或者写一句构思' }, 400)
    }

    // 写法层（story_skills）：body.skill 传 code；不传就用库里的默认写法。
    // 迁移没跑、或 code 不存在，都只进 warnings，不挡生成 —— 先把稿子写出来要紧。
    const chosen = await loadSkill(admin.client, body?.skill)
    if (chosen.warning) warnings.push(chosen.warning)

    // 提示词分两半发：稳定不变的「写作宪法 + 写法 + 范文」走 system（可被缓存），本篇设定走 user
    const system = continueFrom ? buildContinueSystemPrompt(chosen.row) : buildStorySystemPrompt(chosen.row)
    const prompt = continueFrom
      ? buildContinueUserPrompt({
          tagsByDimension,
          idea,
          tailText: continueFrom,
          remainingWords: Math.max(300, length - countChineseChars(continueFrom)),
        })
      : buildStoryUserPrompt({ combo, tagsByDimension, idea, materials, length })

    const ai = await callText({
      task: 'story',
      system,
      prompt,
      // 写小说要给它一点自由度；续写时稍微收一点，避免跑偏
      temperature: continueFrom ? 0.9 : 0.95,
      timeoutMs: 55000,
      maxOutputTokens: 8192,
      // 不重试：这条路由的总预算就 60 秒，重试会把预算耗光。失败直接交给下面的兜底模型。
      retries: 0,
      // Gemini 3.x 必须关掉思考：思考 token 会和正文抢输出额度，实测会让正文只剩两百字
      thinkingBudget: 0,
    })
    if (ai.ok === false) {
      // 以前这里静默返回：终端一个字都不打，站长只能拿着前端那句话猜
      console.log(`[ai-story:${reqId}] 模型调用失败`, { status: ai.status, error: ai.error })
      return jsonResponse({ error: ai.error }, ai.status)
    }
    if (ai.truncated) warnings.push('模型输出被长度上限截断了，建议用「接着写下去」补完')

    const parsed = parseDelimitedStory(ai.text)
    const html = toStoryHtml(parsed.body || parsed.excerpt)
    const chars = countChineseChars(htmlToPlainText(html))

    if (continueFrom) {
      if (chars < 120) return jsonResponse({ error: '模型没有续写出有效内容，请再试一次' }, 502)
      console.log(`[ai-story:${reqId}] continue ok`, { chars, model: ai.model })
      return Response.json({ ok: true, data: { mode: 'continue', html, chars, model: ai.model } })
    }

    const fallbackTitle = idea.split(/[，。！？、\s]/)[0]?.slice(0, 14) || '未命名短篇'
    const title = (parsed.title || '').replace(/[《》「」"'“”]/g, '').trim().slice(0, 40) || fallbackTitle

    if (chars < length * 0.6) {
      warnings.push(`这次只写了 ${chars} 字（目标 ${length} 字），偏短，可以点「接着写下去」补完`)
    }

    console.log(`[ai-story:${reqId}] ok`, {
      chars,
      dims: Object.keys(tagsByDimension).length,
      model: ai.model,
      skill: chosen.row?.code || '(无)',
    })
    return Response.json({
      ok: true,
      data: {
        mode: 'create',
        title,
        excerpt: (parsed.excerpt || '').slice(0, 400),
        html,
        chars,
        warnings,
        model: ai.model,
        skill: chosen.row ? { code: chosen.row.code, name: chosen.row.name } : null,
      },
    })
  } catch (e: any) {
    if (isAbortError(e)) return jsonResponse({ error: '生成超时，请重试' }, 504)
    console.log(`[ai-story:${reqId}] fatal`, e?.message)
    return jsonResponse({ error: e?.message || '生成失败' }, 500)
  }
}
