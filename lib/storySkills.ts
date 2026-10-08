/**
 * 写法（story_skills）读取层。
 *
 * 为什么单独一个文件：P3 的三遍流水线里，**生成（draft）/ 评审（review）/
 * 重写（rewrite）三遍必须读到同一份写法**——否则评审按 A 的标准打分、
 * 重写按 B 的口径改，改完比原来还差。三处调用同一个 loadSkill 就不会走偏。
 *
 * 设计原则：**永不挡出稿**。
 *   表没建（迁移没跑）、code 不存在、库里没有可用的默认写法 ——
 *   一律返回 row: null + 一句人话 warning，调用方照常干活，只是少了写法这一层。
 *   写法是加分项，不该成为发布路上的单点故障。
 */
import type { StorySkill } from './storyPrompt'

export type LoadedSkill = {
  row: StorySkill | null
  /** 给站长看的提醒（表没建 / code 不存在 / 没设默认），进 warnings 或 toast */
  warning?: string
}

/** PostgREST 在「表不存在」时给的三种说法 */
const MISSING_TABLE = /does not exist|schema cache|relation/i

export function isMissingTableError(message: unknown) {
  return MISSING_TABLE.test(String(message || ''))
}

/**
 * 取本次要用的写法。
 *   skillCode 有值 → 按 code 取（且必须启用）
 *   skillCode 为空 → 取库里的默认写法（is_default，且启用）
 */
export async function loadSkill(client: any, skillCode: unknown): Promise<LoadedSkill> {
  const code = String(skillCode ?? '').trim()
  try {
    const base = client.from('story_skills').select('*').eq('is_active', true)
    const { data, error } = code
      ? await base.eq('code', code).maybeSingle()
      : await base.eq('is_default', true).maybeSingle()

    if (error) {
      if (isMissingTableError(error.message)) {
        return {
          row: null,
          warning: '写法库还没建好：请先在 Supabase 里执行 supabase/43_story_skills.sql（本次按无写法生成）',
        }
      }
      return { row: null, warning: `读取写法失败：${error.message}（本次按无写法生成）` }
    }
    if (!data) {
      // 没选 code 又取不到默认写法：多半是站长把默认那个停用/删了 —— 说清楚，
      // 否则他会以为「写法已生效」而实际这篇是模型默认腔调。
      return {
        row: null,
        warning: code
          ? `写法库里没有「${code}」，本次按无写法生成`
          : '写法库里没有可用的默认写法（被停用或删掉了？）—— 去「写作风格」页设一个，或直接选一个写法',
      }
    }
    return { row: data as StorySkill }
  } catch (e: any) {
    // 连不上、超时这类意外：不抛，按无写法继续
    return { row: null, warning: `读取写法异常：${e?.message || '未知错误'}（本次按无写法生成）` }
  }
}

/** 只想知道「这次用哪套写法」，不关心 warning 的场景用这个 */
export async function loadSkillRow(client: any, skillCode: unknown): Promise<StorySkill | null> {
  return (await loadSkill(client, skillCode)).row
}
