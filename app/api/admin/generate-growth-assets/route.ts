import type { NextRequest } from 'next/server'
import { jsonResponse, requireAdmin } from '@/lib/aiGemini'
import { callTextJson } from '@/lib/aiProvider'
import {
  buildGrowthSystemPrompt,
  buildGrowthUserPrompt,
  normalizeGrowthAiResult,
  normalizeGrowthTasks,
  type GrowthAiInput,
  type GrowthAiScope,
} from '@/lib/growthAi'

export const runtime = 'nodejs'
export const maxDuration = 60
/** 「现在生成一次」的动作，缓存住等于点了没反应。 */
export const dynamic = 'force-dynamic'

/** 正文只取前 6000 字符（≈1500 token）：一条详情页的开头足够写 TL;DR 与 FAQ。 */
const MAX_BODY_CHARS = 6000
const MAX_SUMMARY_CHARS = 1200

/**
 * 增长物料的一键生成：标题 / 正文 / 分类 → SEO 标题 + 描述、TL;DR、
 * GEO 问答、目标实体、四平台社媒文案。
 *
 * 与 `/api/admin/quiz/ideas` 同一套骨架，因为它解决的是同一类问题：
 *   ① **入参只收数据不收提示词**（提示词在 `lib/growthAi.ts`，要能 diff）；
 *   ② 模型返回 JSON 断在半句时**加额度重试一次**，而不是让人对着 502 反复点；
 *   ③ 输出必须先过 `normalizeGrowthAiResult()`：切长度、修 a/an、去重问答。
 *      前端拿到的一定是可入库的形状，不需要再判空。
 *
 * `brand_suffix` 由前端从 `/admin/growth/defaults` 带上来（不在这里再查一次库）：
 * 少一次数据库往返，也少一个「默认值读失败」的分支。
 */
export async function POST(req: NextRequest) {
  const started = Date.now()
  try {
    const auth = await requireAdmin(req)
    if (auth.ok === false) return auth.response

    const payload = await req.json().catch(() => ({}))
    const title = String(payload?.title ?? '').trim().slice(0, 200)
    if (!title) {
      return jsonResponse({ error: '缺少 title：先把页面标题或测验标题传上来' }, 400)
    }

    const scope: GrowthAiScope = payload?.scope === 'page' ? 'page' : 'content'
    const tasks = normalizeGrowthTasks(payload?.tasks)
    const keywords = (Array.isArray(payload?.focusKeywords) ? payload.focusKeywords : [])
      .map((value: unknown) => String(value ?? '').trim())
      .filter(Boolean)
      .slice(0, 5)

    const input: GrowthAiInput = {
      scope,
      title,
      category: String(payload?.category ?? '').trim().slice(0, 60) || undefined,
      summary: String(payload?.summary ?? '').trim().slice(0, MAX_SUMMARY_CHARS) || undefined,
      body: String(payload?.body ?? '').trim().slice(0, MAX_BODY_CHARS) || undefined,
      pagePath: String(payload?.pagePath ?? '').trim().slice(0, 200) || undefined,
      url: String(payload?.url ?? '').trim().slice(0, 300) || undefined,
      brandSuffix: String(payload?.brandSuffix ?? '').trim().slice(0, 40) || undefined,
      focusKeywords: keywords.length ? keywords : undefined,
    }

    const system = buildGrowthSystemPrompt()
    const prompt = buildGrowthUserPrompt(input, tasks)

    /** 路由预算 60 秒：每次调用都用「剩下的时间」，重试也不会把函数挂死。 */
    const deadline = started + 52_000
    const call = (maxOutputTokens: number) =>
      callTextJson<any>({
        task: 'util',
        system,
        prompt,
        // 0.6：太随意会写出营销腔，太低会复读原文。
        temperature: 0.6,
        maxOutputTokens,
        timeoutMs: Math.max(8_000, deadline - Date.now()),
        jsonMode: true,
        // 供应商层面的重试只会让人原地多等，这里自己做「加额度重试」。
        retries: 0,
      })

    // 五项全要时（6 条社媒 + 5 组问答 + 摘要）大约 1800 token；给 3000 是留给
    // 推理模型「先想再写」的思考额度 —— 纯 1800 在 gpt-oss 这类模型上会被吃光。
    let ai = await call(3000)
    if (ai.ok === false && ai.status === 502 && /JSON|截断/.test(ai.error)) {
      console.log('[growth/generate] JSON 不完整，加额度重试一次')
      ai = await call(4200)
    }
    if (ai.ok === false) return jsonResponse({ error: ai.error, status: ai.status }, ai.status)

    let normalized = normalizeGrowthAiResult(ai.value, tasks)
    // 补括号后可能只剩 `{}`（一条都没写完）：再给一次机会，仍然空才报错。
    if (Object.keys(normalized.fields).length === 0 && ai.truncated) {
      console.log('[growth/generate] 补括号后没有可用字段，加额度再试一次')
      const second = await call(4200)
      if (second.ok === true) {
        ai = second
        normalized = normalizeGrowthAiResult(second.value, tasks)
      }
    }
    if (Object.keys(normalized.fields).length === 0) {
      return jsonResponse({ error: '模型没给出可用字段：再点一次，或先补两段正文' }, 502)
    }

    return jsonResponse({
      ok: true,
      scope,
      tasks,
      fields: normalized.fields,
      warnings: normalized.warnings,
      model: ai.model,
      truncated: ai.truncated,
      ms: Date.now() - started,
    })
  } catch (error: any) {
    console.error('[growth/generate] 失败：', error)
    return jsonResponse({ error: `生成失败：${String(error?.message || error).slice(0, 120)}` }, 500)
  }
}