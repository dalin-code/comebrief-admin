import type { NextRequest } from 'next/server'
import { htmlToPlainText, isAbortError, jsonResponse, requireAdmin } from '@/lib/aiGemini'
import { callText } from '@/lib/aiProvider'
import {
  buildContinueSystemPrompt,
  buildContinueUserPrompt,
  buildStorySystemPrompt,
  buildStoryUserPrompt,
  countChineseChars,
  DIMENSIONS,
  parseDelimitedStory,
  toStoryHtml,
  type DimensionKey,
  type StoryCombo,
  type StoryTag,
} from '@/lib/storyPrompt'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { loadRandomSkill, loadSkill } from '@/lib/storySkills'
import { resolveComboTags } from '@/lib/storySelection'

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
    /**
     * 最近已经写过的标题（编辑页从数据库里捞的 + 本次会话里刚生成的）。
     * 用来对抗"文章同质化"：把往期标题贴回提示词，模型才会主动换开场、换主角配置。
     * 前端不传就当作没有 —— 生成照常进行，只是少一层去重。
     */
    const avoidTitles = Array.isArray(body?.avoidTitles)
      ? (body.avoidTitles as unknown[])
          .map((t) => String(t ?? '').trim())
          .filter(Boolean)
          .slice(0, 16)
      : []

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
    const warnings: string[] = []

    const tagsByDimension: Partial<Record<DimensionKey, StoryTag[]>> = {}
    for (const key of DIMENSION_KEYS) {
      const picked = all.filter((t) => t.dimension === key)
      if (picked.length) tagsByDimension[key] = picked
    }

    /**
     * 未选的维度在这里一次性随机补齐 —— 不读上一版的 lastResolved，也不把
     * 随机结果写回前端选择。旧版这里是「不选就交给模型」，模型会反复写同一套；
     * 现在每次换一组具体标签，至少保证输入不同。
     */
    const resolved = resolveComboTags({ combo, tagsByDimension })
    warnings.push(...resolved.warnings)

    if (!continueFrom && !Object.keys(tagsByDimension).length && !idea) {
      return jsonResponse({ error: '至少选一个标签，或者写一句构思' }, 400)
    }

    // 写法层（story_skills）：body.skill 传 code；不传就用库里的默认写法。
    // 迁移没跑、或 code 不存在，都只进 warnings，不挡生成 —— 先把稿子写出来要紧。
    // 续写 / 回写必须沿用同一支笔；只有「新写一篇」才在未选写法时随机抽 A–F
    const chosen = continueFrom
      ? await loadSkill(admin.client, body?.skill)
      : await loadRandomSkill(admin.client, body?.skill)
    if (chosen.warning) warnings.push(chosen.warning)

    // 提示词分两半发：稳定不变的「写作宪法 + 写法 + 范文」走 system（可被缓存），本篇设定走 user
    const system = continueFrom ? buildContinueSystemPrompt(chosen.row) : buildStorySystemPrompt(chosen.row)
    const prompt = continueFrom
      ? buildContinueUserPrompt({
          tagsByDimension,
          idea,
          // 续写也要带上改编底本：不带的话，「接着写下去」会把它拐回模型默认的那一套情节
          materials,
          tailText: continueFrom,
          remainingWords: Math.max(300, length - countChineseChars(continueFrom)),
        })
      : buildStoryUserPrompt({ combo: resolved.combo, tagsByDimension, idea, materials, length, avoidTitles })

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
      // 把 truncated 一起回给前端：前端据此决定要不要自动再续一轮。
      // 以前这里什么都不说，站长只能看到"点了一次就没动静了"，还得自己判断写没写完。
      const continueWarnings = ai.truncated
        ? ['这一轮又被长度上限截断了 —— 可以再点一次「接着写下去」，或者把篇幅调大']
        : []
      console.log(`[ai-story:${reqId}] continue ok`, { chars, truncated: ai.truncated, model: ai.model })
      return Response.json({
        ok: true,
        data: {
          mode: 'continue',
          html,
          chars,
          warnings: [...warnings, ...continueWarnings],
          truncated: ai.truncated,
          model: ai.model,
          skill: chosen.row ? { code: chosen.row.code, name: chosen.row.name } : null,
        },
      })
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
        /** 这一篇是不是写到模型的输出上限就断了 —— 前端据此自动「接着写下去」 */
        truncated: ai.truncated,
        model: ai.model,
        skill: chosen.row ? { code: chosen.row.code, name: chosen.row.name } : null,
        /** 本次实际用到的组合（随机补全后的结果）—— 只给前端展示，不回填选择 */
        resolvedCombo: resolved.combo,
        resolvedTags: DIMENSIONS.map((d) => ({
          dimension: d.key,
          names: resolved.pickedNames[d.key] || [],
        })).filter((x) => x.names.length),
      },
    })
  } catch (e: any) {
    if (isAbortError(e)) return jsonResponse({ error: '生成超时，请重试' }, 504)
    console.log(`[ai-story:${reqId}] fatal`, e?.message)
    return jsonResponse({ error: e?.message || '生成失败' }, 500)
  }
}
