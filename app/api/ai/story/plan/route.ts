import type { NextRequest } from 'next/server'
import { isAbortError, jsonResponse, requireAdmin } from '@/lib/aiGemini'
import { callText } from '@/lib/aiProvider'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { loadRandomSkill } from '@/lib/storySkills'
import {
  clampVariantIndex,
  deriveSeeds,
  normalizeSeed,
  resolveComboTags,
  seedToInt,
} from '@/lib/storySelection'
import {
  buildSkeletonSystemPrompt,
  buildSkeletonUserPrompt,
  fallbackSkeleton,
  normalizeSkeleton,
  parseSkeleton,
  surfaceForSkeleton,
  validateSkeleton,
} from '@/lib/storyPlan'
import { coerceSurface } from '@/lib/storyIdentity'
import { loadRecipe, loadVariant, saveRecipe, saveVariant } from '@/lib/storyRecipes'
import { DIMENSIONS, type DimensionKey, type StoryTag } from '@/lib/storyPrompt'

export const runtime = 'nodejs'
export const maxDuration = 60

const MODES = ['full', 'skeleton', 'surface'] as const

/**
 * P4 规划路由。
 *   mode=full     生成 / 读取骨架，再生成表皮（正常创作）
 *   mode=skeleton 只生成 / 读取骨架（调试、分享 Seed）
 *   mode=surface  用已有骨架换一版表皮（「同骨架，换一版」）
 *
 * 同 Seed 的骨架优先从 story_recipes 读，读不到才叫模型；这样即便供应商的
 * seed 参数不生效，同一个 Seed 也不会漂成另一副骨架。
 */
export async function POST(req: NextRequest) {
  const reqId = Math.random().toString(16).slice(2, 8)
  try {
    const auth = await requireAdmin(req)
    if (auth.ok === false) return auth.response

    const body = await req.json().catch(() => ({}))
    const mode = MODES.includes(String(body?.mode || 'full') as any) ? (String(body.mode) as (typeof MODES)[number]) : 'full'
    const rawLength = Number(body?.length ?? body?.combo?.length)
    const length = [800, 1500, 2500].includes(rawLength) ? rawLength : 1500
    const idea = String(body?.idea ?? body?.combo?.idea ?? '').trim().slice(0, 800)
    const materials = String(body?.materials ?? body?.combo?.materials ?? '').trim().slice(0, 4000)
    const seed = normalizeSeed(body?.seed)
    const variantIndex = clampVariantIndex(body?.variantIndex)
    const seeds = deriveSeeds(seed, variantIndex)
    const avoidTitles = Array.isArray(body?.avoidTitles)
      ? (body.avoidTitles as unknown[]).map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 12)
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
    const tagsByDimension: Partial<Record<DimensionKey, StoryTag[]>> = {}
    for (const t of all) {
      if (!tagsByDimension[t.dimension]) tagsByDimension[t.dimension] = []
      tagsByDimension[t.dimension]!.push(t)
    }
    const resolved = resolveComboTags({ combo: body?.combo, tagsByDimension })
    const warnings = [...resolved.warnings]

    const chosen = await loadRandomSkill(admin.client, body?.skill)
    if (chosen.warning) warnings.push(chosen.warning)

    const opts = { seed, length, idea, materials }
    let recipe = null as Awaited<ReturnType<typeof loadRecipe>>['row']
    let skeleton = null as ReturnType<typeof normalizeSkeleton> | null

    if (mode === 'surface') {
      if (body?.skeleton && typeof body.skeleton === 'object') {
        skeleton = normalizeSkeleton(body.skeleton, opts)
      } else {
        const loaded = await loadRecipe(admin.client, seeds.skeletonSeed)
        if (loaded.warning) warnings.push(loaded.warning)
        recipe = loaded.row
        if (loaded.row?.skeleton) skeleton = normalizeSkeleton(loaded.row.skeleton, opts)
      }
      if (!skeleton) {
        return jsonResponse({ error: '这一版没有可用的骨架：请先跑一次完整生成，或带上 skeleton 再换表皮' }, 400)
      }
    } else {
      const loaded = await loadRecipe(admin.client, seeds.skeletonSeed)
      if (loaded.warning) warnings.push(loaded.warning)
      recipe = loaded.row
      if (loaded.row?.skeleton) {
        skeleton = normalizeSkeleton(loaded.row.skeleton, opts)
        warnings.push('这个 Seed 已有骨架，直接复用了同一条故事逻辑')
      } else {
        const ai = await callText({
          task: 'story',
          system: buildSkeletonSystemPrompt(),
          prompt: buildSkeletonUserPrompt({
            tagsByDimension: resolved.tagsByDimension,
            idea,
            materials,
            length,
            avoidTitles,
            seed,
          }),
          temperature: 0.7,
          maxOutputTokens: 2048,
          timeoutMs: 35_000,
          retries: 0,
          thinkingBudget: 0,
          jsonMode: true,
          seed: seedToInt(seeds.skeletonSeed),
        })
        if (ai.ok === false) {
          warnings.push(`骨架模型调用失败，已用本地兜底骨架：${ai.error}`)
          skeleton = fallbackSkeleton(opts)
        } else {
          if (ai.truncated) warnings.push('骨架输出被长度上限截断，已按已解析的节拍继续')
          const parsed = parseSkeleton(ai.text, opts)
          skeleton = parsed.skeleton
          warnings.push(...parsed.warnings)
        }
        warnings.push(...validateSkeleton(skeleton))
        const saved = await saveRecipe(admin.client, {
          seed,
          skeleton,
          combo: resolved.combo as Record<string, unknown>,
          idea,
          materials,
          skillCode: chosen.row?.code || '',
        })
        if (saved.warning) warnings.push(saved.warning)
        if (saved.row) recipe = saved.row
      }
    }

    if (mode === 'skeleton') {
      return Response.json({
        ok: true,
        data: {
          mode,
          seed,
          variantIndex,
          seeds,
          recipeId: recipe?.id || null,
          resolved: {
            combo: resolved.pickedNames,
            skill: chosen.row ? { code: chosen.row.code, name: chosen.row.name } : null,
            seed,
            variantIndex,
          },
          resolvedTags: DIMENSIONS.map((d) => ({ dimension: d.key, names: resolved.pickedNames[d.key] || [] })).filter(
            (x) => x.names.length
          ),
          skeleton,
          warnings: Array.from(new Set(warnings)),
        },
      })
    }

    let surface = null as ReturnType<typeof surfaceForSkeleton> | null
    if (recipe?.id) {
      const existing = await loadVariant(admin.client, recipe.id, variantIndex)
      if (existing.warning) warnings.push(existing.warning)
      if (existing.row?.surface) {
        surface = coerceSurface(existing.row.surface, { seed, variantIndex, skeleton })
        warnings.push('这个 Seed + 版本号已有表皮，直接复用了同一组人名与地点')
      }
    }
    if (!surface) surface = surfaceForSkeleton(skeleton, seed, variantIndex)

    if (recipe?.id && mode === 'full') {
      const saved = await saveVariant(admin.client, {
        recipe_id: recipe.id,
        variant_index: variantIndex,
        surface_seed: seeds.surfaceSeed,
        prose_seed: seeds.proseSeed,
        surface,
        fingerprint: surface.fingerprint,
        source_article_id: body?.sourceArticleId ? String(body.sourceArticleId) : null,
        story_combo: { ...resolved.combo, seed, variantIndex, skill: chosen.row?.code || '' },
      })
      if (saved.warning) warnings.push(saved.warning)
    }

    console.log(`[ai-story-plan:${reqId}] ok`, {
      mode,
      seed,
      variant: variantIndex,
      beats: skeleton.beats.length,
      fingerprint: surface.fingerprint,
      randomDims: resolved.randomFilled.length,
      skill: chosen.row?.code || '(无)',
    })

    return Response.json({
      ok: true,
      data: {
        mode,
        seed,
        variantIndex,
        seeds,
        recipeId: recipe?.id || null,
        skeleton,
        surface,
        fingerprint: surface.fingerprint,
        resolved: {
          combo: resolved.pickedNames,
          skill: chosen.row ? { code: chosen.row.code, name: chosen.row.name } : null,
          seed,
          variantIndex,
        },
        resolvedTags: DIMENSIONS.map((d) => ({ dimension: d.key, names: resolved.pickedNames[d.key] || [] })).filter(
          (x) => x.names.length
        ),
        warnings: Array.from(new Set(warnings)),
      },
    })
  } catch (e: any) {
    if (isAbortError(e)) return jsonResponse({ error: '规划超时，请重试' }, 504)
    console.log(`[ai-story-plan:${reqId}] fatal`, e?.message)
    return jsonResponse({ error: e?.message || '规划失败' }, 500)
  }
}
