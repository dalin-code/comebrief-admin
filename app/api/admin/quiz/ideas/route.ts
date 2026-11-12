import type { NextRequest } from 'next/server'
import { jsonResponse, requireAdmin } from '@/lib/aiGemini'
import { callTextJson } from '@/lib/aiProvider'
import { buildIdeaSystemPrompt, buildIdeaUserPrompt, buildTrendBlock, normalizeIdeas } from '@/lib/quizAi'
import { buildVocabularyBlock, extractHotWords } from '@/lib/quizLexicon'
import type { TrendItem } from '@/lib/quizTrends'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * 选题：趋势标题 + 热词表 → 4 个可以马上写的方向。
 *
 * 入参刻意**只接受数据、不接受提示词**：前端不能自己拼一段话塞进来，
 * 否则「提示词是代码的一部分」这条就废了（改文案要能 diff、能回滚）。
 *
 * 出参：`{ ok, ideas, model }` —— `ideas` 已经被 `normalizeIdeas()` 洗过：
 * 认不出的分类留原文、没标题的整条丢掉，前端不用再判空。
 */
export async function POST(req: NextRequest) {
  const started = Date.now()
  try {
    const auth = await requireAdmin(req)
    if (auth.ok === false) return auth.response

    const body = await req.json().catch(() => ({}))
    const trends: TrendItem[] = (Array.isArray(body?.trends) ? body.trends : [])
      .filter((item: any) => item && typeof item === 'object' && String(item.title || '').trim())
      .slice(0, 60)
      .map((item: any) => ({
        id: String(item.id || ''),
        title: String(item.title).slice(0, 160),
        source: item.source,
        note: item.note ? String(item.note).slice(0, 160) : undefined,
        score: Number(item.score) || undefined,
      })) as TrendItem[]

    const pinned = (Array.isArray(body?.pinned) ? body.pinned : [])
      .map((value: unknown) => String(value ?? '').trim())
      .filter(Boolean)
      .slice(0, 12)
    const avoidTitles = (Array.isArray(body?.avoidTitles) ? body.avoidTitles : [])
      .map((value: unknown) => String(value ?? '').trim())
      .filter(Boolean)
      .slice(0, 12)
    const count = Math.max(1, Math.min(6, Number(body?.count) || 4))

    if (!trends.length && !pinned.length) {
      return jsonResponse({ error: '没有趋势数据也没有钉住的词：先抓一轮趋势，或直接粘贴两条' }, 400)
    }

    // 热词表在这里重算，而不是信任前端传上来的：
    // 同一个 key（标题 + 钉住词）算出来的词汇表必须稳定，否则同一份输入两次生成的卷风格会飘。
    const hot = extractHotWords(trends, { pinned, limit: 40 })
    const vocabularyBlock = buildVocabularyBlock(hot, 20)
    const trendBlock = buildTrendBlock(trends, 40)

    const userPrompt = buildIdeaUserPrompt({ trendBlock, vocabularyBlock, pinned, avoidTitles, count })
    /** 路由预算是 60 秒：每次调用都用「剩下的时间」，最多试三次也不会超时 */
    const deadline = started + 52_000
    const callIdeas = (maxOutputTokens: number) =>
      callTextJson<any>({
        task: 'util',
        system: buildIdeaSystemPrompt(),
        prompt: userPrompt,
        temperature: 0.9,
        // 4 条选题的 JSON 本身只要 ~600 token，剩下的都是推理模型的思考额度；
        // 1800 在 gpt-oss / Qwen3 这类「先想再写」的模型上实测会被思考吃光、JSON 断在半句。
        maxOutputTokens,
        timeoutMs: Math.max(8_000, deadline - Date.now()),
        jsonMode: true,
        // 供应商层面的重试（同一个额度打两次）只会让用户原地多等，这里自己做「加额度重试」
        retries: 0,
      })

    // 断在半句（`{"ideas":[{"title":"…","angle":"How do you han` 那种）不是「模型不好」，
    // 是额度不够：加 1000 token 再来一次，比让人对着一条 502 反复点「生成选题」有用。
    let ai = await callIdeas(2600)
    if (ai.ok === false && ai.status === 502 && /JSON|截断/.test(ai.error)) {
      console.log('[quiz/ideas] JSON 不完整，加额度重试一次')
      ai = await callIdeas(3600)
    }
    if (ai.ok === false) return jsonResponse({ error: ai.error, status: ai.status }, ai.status)

    let ideas = normalizeIdeas(ai.value, count)
    // 补括号后变成 `{"ideas":[]}`（第一条都没写完）：再给一次机会，仍然空就算了
    if (!ideas.length && ai.truncated) {
      console.log('[quiz/ideas] 补括号后没有可用条目，加额度再试一次')
      const second = await callIdeas(3600)
      if (second.ok === true) {
        ai = second
        ideas = normalizeIdeas(second.value, count)
      }
    }
    if (!ideas.length) {
      return jsonResponse(
        { error: '模型没给出可用的选题（返回里没有 title）：再点一次，或先钉两个热词' },
        502
      )
    }

    // `truncated` 让前端能说人话：「只拿到 2 条」比「4 条变成 2 条」好理解
    return jsonResponse({ ok: true, ideas, model: ai.model, truncated: ai.truncated, ms: Date.now() - started })
  } catch (error: any) {
    console.error('[quiz/ideas] 失败：', error)
    return jsonResponse({ error: `生成选题失败：${String(error?.message || error).slice(0, 120)}` }, 500)
  }
}
