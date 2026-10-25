import type { NextRequest } from 'next/server'
import { isAbortError, jsonResponse, requireAdmin } from '@/lib/aiGemini'
import { callText } from '@/lib/aiProvider'
import { countChineseChars, htmlToPlainText, parseDelimitedStory, toStoryHtml } from '@/lib/storyPrompt'
import { loadSkill } from '@/lib/storySkills'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { deriveSeeds, isMaterialFirst, MATERIAL_FIRST_LENGTH, normalizeSeed, seedToInt } from '@/lib/storySelection'
import { normalizeSkeleton } from '@/lib/storyPlan'
import { coerceSurface } from '@/lib/storyIdentity'
import {
  buildSectionRewritePrompt,
  buildSectionSystemPrompt,
  buildSectionUserPrompt,
  detectEnding,
  enforceSectionBoundary,
} from '@/lib/storyWrite'

export const runtime = 'nodejs'
export const maxDuration = 60

const cleanPrevious = (input: unknown) =>
  (Array.isArray(input) ? input : [])
    .slice(-3)
    .map((x: any) => ({ html: String(x?.html || '').slice(0, 12000) }))
    .filter((x) => x.html)

const cleanTagBrief = (input: unknown, resolvedTags: unknown) => {
  if (typeof input === 'string' && input.trim()) return input.trim().slice(0, 1200)
  if (!Array.isArray(resolvedTags)) return ''
  return resolvedTags
    .map((x: any) => `${String(x?.dimension || '')}：${(Array.isArray(x?.names) ? x.names : []).join('＋')}`)
    .filter((x) => x && !x.endsWith('：'))
    .join(' · ')
    .slice(0, 1200)
}

/**
 * 分段写作 / 单段重写。
 * 一次只处理一段：上下文小、边界清楚，也方便站长只重写写坏的那一段。
 */
export async function POST(req: NextRequest) {
  const reqId = Math.random().toString(16).slice(2, 8)
  try {
    const auth = await requireAdmin(req)
    if (auth.ok === false) return auth.response

    const body = await req.json().catch(() => ({}))
    const mode = String(body?.mode || 'write') === 'rewrite' ? 'rewrite' : 'write'
    const idea = String(body?.idea || '').trim().slice(0, 800)
    const materials = String(body?.materials || '').trim().slice(0, 4000)
    const rawLength = Number(body?.length ?? body?.skeleton?.targetChars)
    const requestedLength = [800, 1500, 2500].includes(rawLength) ? rawLength : 1500
    // 素材优先：骨架在 1500 字下会把底本后半段压成总结，这里兜一层保险
    const materialFirst = isMaterialFirst(materials)
    const length = materialFirst ? MATERIAL_FIRST_LENGTH : requestedLength
    const seed = normalizeSeed(body?.seed)
    const variantIndex = Math.max(0, Math.trunc(Number(body?.variantIndex) || 0))
    const seeds =
      body?.seeds && typeof body.seeds === 'object'
        ? body.seeds
        : deriveSeeds(seed, variantIndex, materials)
    const skeleton = normalizeSkeleton(body?.skeleton, { seed, length, idea, materials })
    const sectionIndex = Math.max(0, Math.min(skeleton.beats.length - 1, Math.trunc(Number(body?.sectionIndex) || 0)))
    const beat = skeleton.beats[sectionIndex]
    const isFinal = sectionIndex === skeleton.beats.length - 1
    const surface = coerceSurface(body?.surface, { seed, variantIndex, skeleton })
    const previousSections = cleanPrevious(body?.previousSections)
    const tagBrief = cleanTagBrief(body?.tagBrief, body?.resolvedTags)

    const admin = getSupabaseAdminClient()
    if (!admin.ok) return jsonResponse({ error: admin.error }, 500)
    // 素材优先且没选写法时，不回落默认写法：默认腔调会覆盖底本的叙述方式；
    // 前半篇若随机抽过写法，前端会把 preview.skill.code 传回来，仍能保持一致。
    const chosen: Awaited<ReturnType<typeof loadSkill>> =
      materialFirst && !String(body?.skill || '').trim()
        ? { row: null }
        : await loadSkill(admin.client, body?.skill)
    const warnings = chosen.warning ? [chosen.warning] : []

    const basePrompt = {
      skeleton,
      surface,
      sectionIndex,
      previousSections,
      idea,
      materials,
      length,
      tagBrief,
    }
    const currentHtml = String(body?.html || '').trim()
    const instruction = String(body?.notes || body?.instruction || '').trim().slice(0, 800)

    if (mode === 'rewrite' && countChineseChars(htmlToPlainText(currentHtml)) < 30) {
      return jsonResponse({ error: '这一段还没有足够正文，先写出来再重写' }, 400)
    }

    const call = async (prompt: string, temperature: number) =>
      callText({
        task: 'story',
        system: buildSectionSystemPrompt(chosen.row),
        prompt,
        temperature,
        maxOutputTokens: 4096,
        timeoutMs: 50_000,
        retries: 0,
        thinkingBudget: 0,
        seed: seedToInt(`${seeds.proseSeed}:${mode}:${sectionIndex}`),
      })

    const firstPrompt =
      mode === 'rewrite'
        ? buildSectionRewritePrompt({
            ...basePrompt,
            currentHtml,
            instruction: instruction || '把这一段写得更具体：删掉解释性句子，用动作和对话替代。',
          })
        : buildSectionUserPrompt(basePrompt)

    const first = await call(firstPrompt, mode === 'rewrite' ? 0.6 : 0.9)
    if (first.ok === false) {
      console.log(`[ai-story-section:${reqId}] 模型失败`, { status: first.status, error: first.error })
      return jsonResponse({ error: first.error }, first.status)
    }
    if (first.truncated) warnings.push('本段输出被长度上限截断，已按硬边界裁切')

    const parseDraft = (raw: string) => {
      const parsed = parseDelimitedStory(raw)
      const html = toStoryHtml(parsed.body || parsed.excerpt || raw)
      return { html, chars: countChineseChars(htmlToPlainText(html)) }
    }

    let draft = parseDraft(first.text)
    if (draft.chars < 30) {
      return jsonResponse({ error: '模型这一遍没写出有效正文，原稿已保留，可以再试一次' }, 502)
    }

    // 超过软上限 → 只重写一次，明确要求压回目标字数；仍超硬上限才裁句
    if (draft.chars > beat.softMaxChars) {
      const retryPrompt = buildSectionRewritePrompt({
        ...basePrompt,
        currentHtml: draft.html,
        instruction: `这一段现在 ${draft.chars} 字，超过软上限 ${beat.softMaxChars}。压到 ${beat.targetChars} 字左右，删掉重复动作与解释，保留本段必须发生的变化。`,
      })
      const retry = await call(retryPrompt, 0.5)
      if (retry.ok === true) {
        const next = parseDraft(retry.text)
        if (next.chars >= 30) draft = next
      } else {
        warnings.push(`压缩重写失败，按原文检查硬边界：${retry.error}`)
      }
    }

    const boundary = enforceSectionBoundary({
      html: draft.html,
      beat,
      endingSignal: skeleton.endingSignal,
      isFinal,
    })
    warnings.push(...boundary.warnings)

    const ended = isFinal && detectEnding(boundary.html, skeleton.endingSignal)
    if (isFinal && !ended) {
      warnings.push('最后一段还没有形成明确的结局画面，建议点「重写这段」再收一次')
    }

    const section = {
      index: sectionIndex,
      beatId: beat.id,
      function: beat.function,
      html: boundary.html,
      chars: boundary.chars,
      stateDelta: beat.stateDelta,
      isFinal,
      ended,
      warnings,
    }

    console.log(`[ai-story-section:${reqId}] ok`, {
      mode,
      index: sectionIndex,
      chars: section.chars,
      target: beat.targetChars,
      hardMax: beat.hardMaxChars,
      trimmed: boundary.trimmed,
      ended,
      skill: chosen.row?.code || '(无)',
      model: first.model,
    })

    return Response.json({
      ok: true,
      data: {
        mode,
        section,
        warnings: Array.from(new Set(warnings)),
        model: first.model,
      },
    })
  } catch (e: any) {
    if (isAbortError(e)) return jsonResponse({ error: '写这一段超时，请重试' }, 504)
    console.log(`[ai-story-section:${reqId}] fatal`, e?.message)
    return jsonResponse({ error: e?.message || '写这一段失败' }, 500)
  }
}
