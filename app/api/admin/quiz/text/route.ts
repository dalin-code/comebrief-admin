import type { NextRequest } from 'next/server'
import { isAbortError, jsonResponse, requireAdmin, stripFences } from '@/lib/aiGemini'
import { callText } from '@/lib/aiProvider'
import { inspectQuizText, summarizeQuizText } from '@/lib/quizText'
import { buildQuizTextTidyPrompt, QUIZ_TEXT_SYSTEM } from '@/lib/quizTextPrompt'

export const runtime = 'nodejs'
export const maxDuration = 60

/** 一次最多整理这么多字：再多就不是「整理」，该先拆成几篇。 */
const MAX_INPUT_CHARS = 20000

/**
 * ✨「AI 整理」：把一段不规整的稿子改写成严格模板。
 *
 * 三道关，缺一不可：
 *   ① **进来先解析**：把当前文本的毛病（缺象限 / 中文 / 少 (b)…）当成提示词的一部分喂给模型。
 *      让它看着错误清单改，比让它猜「哪里不对」准得多；
 *   ② **出去再解析**：模型返回的东西必须能被 `inspectQuizText` 读成至少一篇，否则
 *      这个接口就是「把好东西换成一段没人能解析的文字」，宁可 502；
 *   ③ **回写文本、不回写对象**：前端拿到的是同一套模板的文本，作者逐行看得见、能撤销。
 *      直接写库就成了「点一下按钮，草稿箱多了一卷我没读过的卷」。
 *
 * 于是**失败一律返回 `ok: false` + `code`，并且不带 `text`** —— 前端因此不存在
 * 「用半截稿覆盖全文」这条路径。四种 code：
 *
 *   PROVIDER     供应商层失败（429 / 余额 / 超时），原样转发 ai.error；
 *   TRUNCATED    模型写到一半撞上 maxOutputTokens。这一条以前是 200，是
 *                「AI 整理之后内容变短」的真凶，现在单独成一个错误；
 *   PARSE_FAILED 模型回来了但没按模板写（认不出 TITLE）；
 *   EMPTY / TOO_LONG / TIMEOUT / FATAL  其余入口与兜底。
 *
 * 注意这里**不保证零 blocker**：模型可能只翻译了一半、或者把象限写重了。那种情况下
 * 仍然把文本还给前端（`issues` + `summary` 一起给），让作者看着「2 → 4 个结果」
 * 自己决定是采用还是放弃 —— 比在这里替他丢掉一次调用要好。
 */
export async function POST(req: NextRequest) {
  const started = Date.now()
  const reqId = Math.random().toString(16).slice(2, 8)

  try {
    const auth = await requireAdmin(req)
    if (auth.ok === false) return auth.response

    const body = await req.json().catch(() => ({}))
    const text = String(body?.text || '')
    if (!text.trim()) return jsonResponse({ ok: false, code: 'EMPTY', error: '框里没有内容' }, 400)
    if (text.length > MAX_INPUT_CHARS) {
      return jsonResponse(
        { ok: false, code: 'TOO_LONG', error: `这一段有 ${text.length} 字，超过 ${MAX_INPUT_CHARS}：先拆成几篇再整理` },
        400
      )
    }

    const before = inspectQuizText(text)
    const prompt = buildQuizTextTidyPrompt({
      text,
      issues: before.entries.flatMap((entry) => entry.issues),
    })

    const ai = await callText({
      task: 'util',
      system: QUIZ_TEXT_SYSTEM,
      prompt,
      // 整理是收敛型任务：要它照着模板填空，不是要它发挥。
      temperature: 0.3,
      /**
       * ⚠️ 这一行是「内容变短」的真正原因，别再删。
       *
       * Gemini 3.x 的**思考 token 与答案共用** `maxOutputTokens`：不传 thinkingBudget，
       * 它会先花掉大半额度「盘算怎么改」，剩下的额度只够写完前两篇 —— finishReason
       * 变成 MAX_TOKENS，接口却照样 200 把半截文本还回去，前端的「AI 整理」一按，
       * 八道题就剩四道。`thinkingBudget: 0` 是唯一能让输出额度全给正文的开关
       * （同一个坑在 `app/api/ai/excerpt/route.ts` 踩过一次，注释写在那边）。
       */
      thinkingBudget: 0,
      // 4 结果 + 8 题的完整模板大约是 2.4k token；40k 字的长稿也落在 8k 以内。
      maxOutputTokens: 8000,
      timeoutMs: 50000,
      retries: 0,
    })
    if (ai.ok === false) {
      console.log(`[quiz-text:${reqId}] 供应商层失败 → ${ai.status} ${ai.kind} ${ai.error}`)
      return jsonResponse(
        {
          ok: false,
          code: 'PROVIDER',
          error: ai.error,
          kind: ai.kind,
          retryable: ai.retryable,
          retryAfterMs: ai.retryAfterMs,
          details: ai.details,
        },
        ai.status
      )
    }

    /**
     * 截断是**失败**，不是成功。
     *
     * 以前这里只把 `truncated` 塞进 200 的响应，前端弹一句「可能缺尾巴」然后照样回写 ——
     * 作者点一下按钮，八道题变四道，还要自己发现。现在改为 502：**一个字符都不返回**，
     * 前端因此没有「用半截稿覆盖全文」这条路径。
     */
    if (ai.truncated) {
      console.log(`[quiz-text:${reqId}] 模型输出被截断 → 不返回文本`, { chars: ai.text.length, model: ai.model })
      return jsonResponse(
        {
          ok: false,
          code: 'TRUNCATED',
          error: '模型这次没写完就断了（原稿没有被改动）：再点一次，或把这一段拆成两篇分别整理',
          retryable: true,
          retryAfterMs: 0,
        },
        502
      )
    }

    const next = stripFences(ai.text).trim()
    const after = inspectQuizText(next)
    if (!after.entries.length) {
      console.log(`[quiz-text:${reqId}] 返回内容解析不出任何一篇`, { head: next.slice(0, 120) })
      return jsonResponse(
        {
          ok: false,
          code: 'PARSE_FAILED',
          error: '模型回来了，但没按模板写（一段都认不出来）：原稿没有被改动，再点一次',
          retryable: true,
          retryAfterMs: 0,
          /** 只回 160 字给前端折叠查看 —— 排查用，别把一坨未解析文本塞进 UI */
          sample: next.slice(0, 160),
        },
        502
      )
    }

    const issues = after.entries.flatMap((entry) => entry.issues)
    const blockers = issues.filter((item) => item.level === 'blocker').length
    /**
     * 「整理前 2 结果 0 题、整理后 4 结果 8 题」这种对比，由这里算好再给前端。
     * 前端如果自己再 inspect 一遍，遇到「半篇能读半篇不能读」时两边会被
     * 不同的截断规则算出不同的题数 —— 数字对不上的对比条比没有对比条更糟。
     */
    const beforeStats = summarizeQuizText(before)
    const afterStats = summarizeQuizText(after)
    /** 输入 2 篇、输出只剩 1 篇：不是失败，但**必须**在采用前说出来。 */
    const partial = after.entries.length < before.entries.length

    console.log(`[quiz-text:${reqId}] ok`, {
      before: beforeStats,
      after: afterStats,
      partial,
      model: ai.model,
      ms: Date.now() - started,
    })

    return jsonResponse({
      ok: true,
      code: 'OK',
      text: next,
      issues,
      blockers,
      warnings: issues.length - blockers,
      /** 采用前对比用：整理前 / 整理后的数字，同一份 `summarizeQuizText` 算的 */
      summary: { before: beforeStats, after: afterStats },
      partial,
      model: ai.model,
      ms: Date.now() - started,
    })
  } catch (error: any) {
    if (isAbortError(error)) return jsonResponse({ ok: false, code: 'TIMEOUT', error: '整理超时，请重试' }, 504)
    console.log(`[quiz-text:${reqId}] fatal`, error?.message)
    return jsonResponse({ ok: false, code: 'FATAL', error: error?.message || 'AI 整理失败' }, 500)
  }
}
