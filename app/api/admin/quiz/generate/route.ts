import type { NextRequest } from 'next/server'
import { jsonResponse, requireAdmin } from '@/lib/aiGemini'
import { callTextJson } from '@/lib/aiProvider'
import {
  buildCopyUserPrompt,
  buildQuestionsUserPrompt,
  mergeQuizKit,
  normalizeCopy,
  normalizeQuestions,
  QUIZ_SYSTEM,
  type QuizIdea,
} from '@/lib/quizAi'
import { compileQuizKit, summarizeCompiled } from '@/lib/quizCompile'
import { KIT_ARCHETYPES, KIT_QUESTIONS, readQuizKit, type KitArchetype, type KitMeta } from '@/lib/quizKit'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * 分阶段生成：`stage=copy` 写四个原型的文案，`stage=questions` 写 8 道题。
 *
 * 为什么分成两次请求而不是一次：
 *   · 文案改一个字要重跑，题目不需要重跑（反之亦然）；
 *   · 题目那一步必须拿到**已经定下来的 4 个 id**，否则模型会自己造 id，
 *     四个结果里必有一个永远抽不到（`mapping` 规则会拦住，但那时已经浪费了一次调用）；
 *   · 两次调用的温度不一样：文案要个性（0.85），题目要稳（0.6）。
 *
 * `stage=questions` 的返回里带 `validation` / `summary`：
 *   校验来自 `validateQuizKit` 的 5 条规则，`summary` 来自 `enumerateAxe()` 的
 *   65,536 次全枚举 —— 前端因此可以**不重新计算**就显示命中分布与健康分。
 */
export async function POST(req: NextRequest) {
  const started = Date.now()
  try {
    const auth = await requireAdmin(req)
    if (auth.ok === false) return auth.response

    const body = await req.json().catch(() => ({}))
    const stage = String(body?.stage || 'copy')
    if (stage !== 'copy' && stage !== 'questions') {
      return jsonResponse({ error: 'stage 只能是 copy 或 questions' }, 400)
    }

    const ideaInput = body?.idea
    if (!ideaInput || typeof ideaInput !== 'object' || !String(ideaInput.title || '').trim()) {
      return jsonResponse({ error: '缺少选题（idea.title）' }, 400)
    }
    const idea: QuizIdea = {
      title: String(ideaInput.title).trim().slice(0, 120),
      angle: String(ideaInput.angle || '').trim().slice(0, 240),
      hook: String(ideaInput.hook || '').trim().slice(0, 140),
      topic: ideaInput.topic || null,
      topicLabel: String(ideaInput.topicLabel || '').trim().slice(0, 80),
      tags: (Array.isArray(ideaInput.tags) ? ideaInput.tags : [])
        .map((tag: unknown) => String(tag ?? '').trim())
        .filter(Boolean)
        .slice(0, 3),
      archetypes: (Array.isArray(ideaInput.archetypes) ? ideaInput.archetypes : [])
        .map((value: unknown) => String(value ?? '').trim())
        .filter(Boolean)
        .slice(0, 6),
      whyNow: ideaInput.whyNow ? String(ideaInput.whyNow).slice(0, 200) : undefined,
    }
    const vocabularyBlock = String(body?.vocabularyBlock || '').slice(0, 4000)

    if (stage === 'copy') {
      const ai = await callTextJson({
        task: 'util',
        system: QUIZ_SYSTEM,
        prompt: buildCopyUserPrompt({ idea, vocabularyBlock }),
        temperature: 0.85,
        // 4 个原型的文案（headline/quote/summary/stats/pills）比看上去长；
        // 推理模型的思考也算在 max_tokens 里，所以别贴着必需值给。
        maxOutputTokens: 2800,
        timeoutMs: 50000,
        jsonMode: true,
        retries: 0,
      })
      if (ai.ok === false) return jsonResponse({ error: ai.error, status: ai.status }, ai.status)

      const { archetypes } = normalizeCopy(ai.value)
      const problems: string[] = []
      if (archetypes.length !== KIT_ARCHETYPES) {
        problems.push(`原型数量是 ${archetypes.length}，必须是 ${KIT_ARCHETYPES}`)
      }
      const ids = archetypes.map((a) => a.id)
      if (new Set(ids).size !== ids.length) problems.push('原型 id 有重复')
      if (archetypes.some((a) => !a.name)) problems.push('有原型没有名字')

      return jsonResponse({
        ok: problems.length === 0,
        archetypes,
        problems,
        model: ai.model,
        truncated: ai.truncated,
        ms: Date.now() - started,
      })
    }

    /* stage === 'questions' */
    const rawArchetypes = Array.isArray(body?.archetypes) ? body.archetypes : []
    const archetypes: KitArchetype[] = rawArchetypes
      .filter((entry: any) => entry && typeof entry === 'object' && String(entry.id || '').trim())
      .slice(0, 8)
      .map((entry: any) => ({
        id: String(entry.id).trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''),
        name: String(entry.name || entry.id).trim().slice(0, 60),
        short: entry.short ? String(entry.short).slice(0, 24) : undefined,
        headline: entry.headline ? String(entry.headline).slice(0, 90) : undefined,
        quote: entry.quote ? String(entry.quote).slice(0, 140) : undefined,
        summary: entry.summary ? String(entry.summary).slice(0, 320) : undefined,
        stats: Array.isArray(entry.stats)
          ? entry.stats.map((s: unknown) => String(s ?? '')).filter(Boolean).slice(0, 4)
          : undefined,
        pills: Array.isArray(entry.pills)
          ? entry.pills.map((p: unknown) => String(p ?? '')).filter(Boolean).slice(0, 4)
          : undefined,
      }))
    if (archetypes.length !== KIT_ARCHETYPES) {
      return jsonResponse({ error: `写题前必须先有 ${KIT_ARCHETYPES} 个原型（现在 ${archetypes.length} 个）` }, 400)
    }

    const ai = await callTextJson({
      task: 'util',
      system: QUIZ_SYSTEM,
      prompt: buildQuestionsUserPrompt({ idea, archetypes, vocabularyBlock }),
      temperature: 0.6,
      // 8 题 × 4 选项 + scene，实测 2.4k 左右；留出思考额度到 4600。
      maxOutputTokens: 4600,
      timeoutMs: 55000,
      jsonMode: true,
      retries: 0,
    })
    if (ai.ok === false) return jsonResponse({ error: ai.error, status: ai.status }, ai.status)

    const { questions } = normalizeQuestions(ai.value)
    const meta: KitMeta = (body?.meta && typeof body.meta === 'object' ? body.meta : {}) as KitMeta
    const kit = mergeQuizKit({
      idea,
      archetypes,
      questions,
      meta: { ...meta, generatedAt: new Date().toISOString(), model: ai.model },
    })

    const read = readQuizKit(kit)
    const compiled = read.kit ? compileQuizKit(read.kit) : null

    return jsonResponse({
      ok: Boolean(read.validation?.ok),
      kit: read.kit,
      questions,
      expectedQuestions: KIT_QUESTIONS,
      issues: read.issues,
      validation: read.validation,
      summary: compiled ? summarizeCompiled(compiled) : null,
      model: ai.model,
      truncated: ai.truncated,
      ms: Date.now() - started,
    })
  } catch (error: any) {
    console.error('[quiz/generate] 失败：', error)
    return jsonResponse({ error: `生成失败：${String(error?.message || error).slice(0, 120)}` }, 500)
  }
}
