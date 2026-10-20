/**
 * story_recipes / story_recipe_variants 的读写层（P4）。
 *
 * 设计原则和 storySkills 一样：**永不挡出稿**。迁移没跑、表不存在、网络抖，
 * 一律返回 warning，让流水线继续走内存里的骨架/表皮。
 */
import { isMissingTableError } from './storySkills'
import type { StorySkeleton } from './storyPlan'
import type { StorySurface } from './storyIdentity'

export type RecipeRecord = {
  id: string
  seed: string
  skeleton_seed: string
  skeleton: StorySkeleton
  base_combo?: Record<string, unknown>
  idea?: string
  materials?: string
  skill_code?: string
  skeleton_hash?: string
}

export type VariantRecord = {
  id?: string
  recipe_id: string
  variant_index: number
  surface_seed: string
  prose_seed: string
  surface: StorySurface
  fingerprint: string
  share_code?: string | null
  source_article_id?: string | null
  story_combo?: Record<string, unknown>
}

export async function loadRecipe(client: any, skeletonSeed: string): Promise<{ row: RecipeRecord | null; warning?: string }> {
  try {
    const { data, error } = await client
      .from('story_recipes')
      .select('*')
      .eq('skeleton_seed', skeletonSeed)
      .maybeSingle()
    if (error) {
      if (isMissingTableError(error.message)) {
        return { row: null, warning: 'Seed 库还没建好：请先执行 supabase/44_story_recipes.sql（本次仍可生成，但无法跨会话复现）' }
      }
      return { row: null, warning: `读取 Seed 骨架失败：${error.message}` }
    }
    return { row: (data || null) as RecipeRecord | null }
  } catch (e: any) {
    return { row: null, warning: `读取 Seed 骨架异常：${e?.message || '未知错误'}` }
  }
}

export async function saveRecipe(
  client: any,
  input: {
    seed: string
    skeleton: StorySkeleton
    combo?: Record<string, unknown>
    idea?: string
    materials?: string
    skillCode?: string
  }
): Promise<{ row: RecipeRecord | null; warning?: string }> {
  try {
    const payload = {
      seed: input.seed,
      skeleton_seed: input.skeleton.skeletonSeed,
      skeleton: input.skeleton,
      base_combo: input.combo || {},
      idea: String(input.idea || '').slice(0, 4000),
      materials: String(input.materials || '').slice(0, 8000),
      skill_code: String(input.skillCode || '').slice(0, 24),
      skeleton_hash: input.skeleton.skeletonHash,
    }
    const { data, error } = await client
      .from('story_recipes')
      .upsert(payload, { onConflict: 'skeleton_seed' })
      .select('*')
      .maybeSingle()
    if (error) {
      if (isMissingTableError(error.message)) {
        return { row: null, warning: 'Seed 库还没建好：请先执行 supabase/44_story_recipes.sql（本次仍可生成，但无法跨会话复现）' }
      }
      return { row: null, warning: `保存 Seed 骨架失败：${error.message}` }
    }
    return { row: (data || null) as RecipeRecord | null }
  } catch (e: any) {
    return { row: null, warning: `保存 Seed 骨架异常：${e?.message || '未知错误'}` }
  }
}

export async function loadVariant(
  client: any,
  recipeId: string,
  variantIndex: number
): Promise<{ row: VariantRecord | null; warning?: string }> {
  try {
    const { data, error } = await client
      .from('story_recipe_variants')
      .select('*')
      .eq('recipe_id', recipeId)
      .eq('variant_index', variantIndex)
      .maybeSingle()
    if (error) {
      if (isMissingTableError(error.message)) {
        return { row: null, warning: 'Seed 变体表还没建好：请先执行 supabase/44_story_recipes.sql' }
      }
      return { row: null, warning: `读取 Seed 变体失败：${error.message}` }
    }
    return { row: (data || null) as VariantRecord | null }
  } catch (e: any) {
    return { row: null, warning: `读取 Seed 变体异常：${e?.message || '未知错误'}` }
  }
}

export async function saveVariant(
  client: any,
  input: VariantRecord
): Promise<{ row: VariantRecord | null; warning?: string }> {
  try {
    const payload = {
      recipe_id: input.recipe_id,
      variant_index: input.variant_index,
      surface_seed: input.surface_seed,
      prose_seed: input.prose_seed,
      surface: input.surface,
      fingerprint: input.fingerprint,
      share_code: input.share_code || null,
      source_article_id: input.source_article_id || null,
      story_combo: input.story_combo || {},
    }
    const { data, error } = await client
      .from('story_recipe_variants')
      .upsert(payload, { onConflict: 'recipe_id,variant_index' })
      .select('*')
      .maybeSingle()
    if (error) {
      if (isMissingTableError(error.message)) {
        return { row: null, warning: 'Seed 变体表还没建好：请先执行 supabase/44_story_recipes.sql' }
      }
      return { row: null, warning: `保存 Seed 变体失败：${error.message}` }
    }
    return { row: (data || null) as VariantRecord | null }
  } catch (e: any) {
    return { row: null, warning: `保存 Seed 变体异常：${e?.message || '未知错误'}` }
  }
}
