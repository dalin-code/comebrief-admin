import type { NextRequest } from 'next/server'
import { isAbortError, jsonResponse, requireAdmin } from '@/lib/aiGemini'
import { callText } from '@/lib/aiProvider'
import { countChineseChars, htmlToPlainText, parseDelimitedStory, toStoryHtml } from '@/lib/storyPrompt'
import { loadSkill } from '@/lib/storySkills'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import {
  deriveSeeds,
  hashString,
  isMaterialFirst,
  MATERIAL_FIRST_LENGTH,
  normalizeSeed,
  seedToInt,
} from '@/lib/storySelection'
import { normalizeSkeleton } from '@/lib/storyPlan'
import { coerceSurface } from '@/lib/storyIdentity'
import { buildFinalizeSystemPrompt, buildFinalizeUserPrompt } from '@/lib/storyWrite'
import { loadRecipe, saveVariant } from '@/lib/storyRecipes'

export const runtime = 'nodejs'
export const maxDuration = 60

const cleanTitle = (raw: string, fallback: string) => {
  const title = String(raw || '')
    .replace(/[《》「」"'“”]/g, '')
    .replace(/\s+/g, '')
    .trim()
    .slice(0, 24)
  return title || fallback
}

const cleanExcerpt = (raw: string, fallback: string) => {
  const text = String(raw || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return fallback
  if (text.length <= 180) return text
  return `${text.slice(0, 170).replace(/[，、；：\s]+$/g, '')}……`
}

/**
 * 收尾：把已经分段写完的正文合成一篇，生成标题 + 摘要，并把
 * source_article_id / share_code 记到 story_recipe_variants。
 */
export async function POST(req: NextRequest) {
  const reqId = Math.random().toString(16).slice(2, 8)
  try {
    const auth = await requireAdmin(req)
    if (auth.ok === false) return auth.response

    const body = await req.json().catch(() => ({}))
    const idea = String(body?.idea || '').trim().slice(0, 800)
    const materials = String(body?.materials || '').trim().slice(0, 4000)
    const rawLength = Number(body?.length ?? body?.skeleton?.targetChars)
    const requestedLength = [800, 1500, 2500].includes(rawLength) ? rawLength : 1500
    const materialFirst = isMaterialFirst(materials)
    const length = materialFirst ? MATERIAL_FIRST_LENGTH : requestedLength
    const seed = normalizeSeed(body?.seed)
    const variantIndex = Math.max(0, Math.trunc(Number(body?.variantIndex) || 0))
    const seeds =
      body?.seeds && typeof body.seeds === 'object'
        ? body.seeds
        : deriveSeeds(seed, variantIndex, materials)
    const skeleton = normalizeSkeleton(body?.skeleton, { seed, length, idea, materials })
    const surface = coerceSurface(body?.surface, { seed, variantIndex, skeleton })

    const sections = (Array.isArray(body?.sections) ? body.sections : [])
      .slice(0, 10)
      .map((s: any, i: number) => {
        const html = toStoryHtml(String(s?.html || '').trim())
        return {
          index: i,
          beatId: String(s?.beatId || skeleton.beats[i]?.id || `B${i + 1}`),
          html,
          chars: countChineseChars(htmlToPlainText(html)),
          stateDelta: String(s?.stateDelta || skeleton.beats[i]?.stateDelta || 'additive'),
        }
      })
      .filter((s: any) => s.html && s.chars > 0)

    const html = sections.map((s: any) => s.html).join('\n')
    const chars = countChineseChars(htmlToPlainText(html))
    if (chars < 100) return jsonResponse({ error: '正文太短了（不足 100 字），先把故事写完再收尾' }, 400)

    const admin = getSupabaseAdminClient()
    if (!admin.ok) return jsonResponse({ error: admin.error }, 500)
    const chosen: Awaited<ReturnType<typeof loadSkill>> =
      materialFirst && !String(body?.skill || '').trim()
        ? { row: null }
        : await loadSkill(admin.client, body?.skill)
    const warnings: string[] = []
    if (chosen.warning) warnings.push(chosen.warning)

    const ai = await callText({
      task: 'util',
      system: buildFinalizeSystemPrompt(),
      prompt: buildFinalizeUserPrompt({ html, skeleton, idea }),
      temperature: 0.35,
      maxOutputTokens: 1200,
      timeoutMs: 25_000,
      retries: 0,
      thinkingBudget: 0,
      seed: seedToInt(`${seeds.proseSeed}:finalize`),
    })

    let title = ''
    let excerpt = ''
    if (ai.ok === true) {
      const parsed = parseDelimitedStory(ai.text)
      title = cleanTitle(parsed.title, '')
      excerpt = cleanExcerpt(parsed.excerpt, '')
      if (ai.truncated) warnings.push('标题/摘要输出被截断，已使用能读到的部分')
    } else {
      warnings.push(`标题/摘要模型失败，已用本地兜底：${ai.error}`)
    }

    const fallbackTitle = cleanTitle(
      String(idea.split(/[，。！？、\s]/)[0] || skeleton.conflictType || '未命名短篇'),
      '未命名短篇'
    )
    const plain = htmlToPlainText(html).replace(/\s+/g, ' ').trim()
    const fallbackExcerpt = cleanExcerpt(plain.slice(0, 170), '一篇没有留下摘要的短篇。')
    if (!title) warnings.push('模型没有给出可用标题，已用构思首句兜底')
    if (!excerpt) warnings.push('模型没有给出可用摘要，已用正文开头兜底')

    const finalTitle = title || fallbackTitle
    const finalExcerpt = excerpt || fallbackExcerpt
    const shareCode = hashString(`${seeds.surfaceSeed}|${skeleton.skeletonHash}`).toString(36).slice(0, 8)

    const sourceArticleId = body?.sourceArticleId ? String(body.sourceArticleId) : null
    const loaded = body?.recipeId
      ? { row: { id: String(body.recipeId) } }
      : await loadRecipe(admin.client, seeds.skeletonSeed)
    if (loaded.row?.id) {
      const saved = await saveVariant(admin.client, {
        recipe_id: loaded.row.id,
        variant_index: variantIndex,
        surface_seed: seeds.surfaceSeed,
        prose_seed: seeds.proseSeed,
        surface,
        fingerprint: surface.fingerprint,
        share_code: shareCode,
        source_article_id: sourceArticleId,
        story_combo: { seed, variantIndex, length, skill: chosen.row?.code || '' },
      })
      if (saved.warning) warnings.push(saved.warning)
    }

    console.log(`[ai-story-finalize:${reqId}] ok`, {
      chars,
      sections: sections.length,
      title: finalTitle,
      shareCode,
      sourceArticleId: sourceArticleId || '(未关联)',
      model: ai.ok ? ai.model : '(fallback)',
    })

    return Response.json({
      ok: true,
      data: {
        title: finalTitle,
        excerpt: finalExcerpt,
        html,
        chars,
        sections: sections.map((s: any) => ({
          ...s,
          isFinal: s.index === skeleton.beats.length - 1,
          ended: s.index === skeleton.beats.length - 1,
          warnings: [],
        })),
        seed,
        variantIndex,
        seeds,
        shareCode,
        recipeId: loaded.row?.id || null,
        sourceArticleId,
        skill: chosen.row ? { code: chosen.row.code, name: chosen.row.name } : null,
        warnings: Array.from(new Set(warnings)),
        model: ai.ok ? ai.model : null,
      },
    })
  } catch (e: any) {
    if (isAbortError(e)) return jsonResponse({ error: '收尾超时，请重试' }, 504)
    console.log(`[ai-story-finalize:${reqId}] fatal`, e?.message)
    return jsonResponse({ error: e?.message || '收尾失败' }, 500)
  }
}
