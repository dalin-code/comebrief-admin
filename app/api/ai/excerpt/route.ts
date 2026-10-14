import type { NextRequest } from 'next/server'
import { htmlToPlainText, isAbortError, jsonResponse, requireAdmin, stripFences } from '@/lib/aiGemini'
import { callText, parseModelChain } from '@/lib/aiProvider'
import { freshKey, memoAiCall, sha1 } from '@/lib/aiMemo'
import {
  buildExcerptPrompt,
  countChineseChars,
  isCountLeak,
  isMostlyChinese,
  stripCountLeak,
} from '@/lib/storyPrompt'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * ✨ 真的 AI 摘要。
 *
 * 编辑页右上角那颗「AI 一键生成摘要」以前只是把正文前 130 个字截下来 ——
 * 那个按钮的文案是假的。这个接口才是真的：把正文发给模型，让它写一段摘要。
 *
 * language 跟随当前的编辑页签：
 *   'zh' → 生成中文摘要（写进 excerpt_zh）
 *   'en' → 生成英文摘要（写进 excerpt，也就是前台显示的那一栏）
 *
 * 两道护栏，都是真踩过的坑：
 *   ① 必须传 thinkingBudget: 0。Gemini 3.x 的思考 token 和答案共用 maxOutputTokens，
 *      它为了核对「不超过 120 字」自己数了 980 个 token 的字，额度见底之后
 *      finishReason 变成 MAX_TOKENS —— 摘要栏里出现的就是那半截「数数草稿」：
 *      `99)经(100)蜕(101)变(102)的…`。
 *   ② 英文页签不能拿中文正文去生成。模型会顺着正文语言吐一段中文回来，
 *      写进 excerpt 就是前台挂一段中文。这种情况直接指路，不浪费一次调用。
 *
 * 另外它跟其他 AI 接口一样走 lib/aiProvider 的候选链：主模型不可用（429 / 503 / 404）时
 * 自动按 AI_MODEL_FALLBACK（可以配成逗号分隔的一串）兜底，只是被限流的话还会等几秒重试一次 ——
 * 而不是让站长对着报错发呆。
 *
 * 还有一个「止损」：同一段正文 + 同一个页签在 5 分钟内再点，直接复用上次的结果
 * （lib/aiMemo），并挡掉并发重复请求。要强制换一版就在请求体里带 `fresh: true`。
 * 翻译故意不这么做 —— 那个按钮的语义就是「换一版」，命中记忆会让人以为按钮坏了。
 */
export async function POST(req: NextRequest) {
  const reqId = Math.random().toString(16).slice(2, 8)
  try {
    const auth = await requireAdmin(req)
    if (auth.ok === false) return auth.response

    const body = await req.json().catch(() => ({}))
    const language = body?.language === 'en' ? 'en' : 'zh'
    const title = String(body?.title || '').trim().slice(0, 300)
    const html = String(body?.html || '')
    const bodyText = htmlToPlainText(html)
    /** fresh: true = 这次一定要重新问模型，别拿记忆里的结果糊弄我 */
    const fresh = body?.fresh === true

    if (bodyText.length < 80) {
      return jsonResponse({ error: '正文太短了，写点内容再生成摘要' }, 400)
    }

    // 页签停在英文、正文却是中文：这时候生成不出「英文摘要」，只会得到一段中文。
    // 与其把中文写进前台那一栏（还要等站长自己发现），不如说清楚该去哪儿点。
    if (language === 'en' && isMostlyChinese(bodyText)) {
      return jsonResponse(
        { error: '这段正文还是中文：英文摘要等翻译完再生成，中文摘要请切到「中文原稿」页签' },
        400
      )
    }

    const prompt = buildExcerptPrompt({ language, title, bodyText })

    /** 清洗 + 修剪：模型给的原文不能直接进栏目，数数残渣、包裹、引号都要处理掉 */
    const cleanExcerpt = (raw: string) =>
      stripCountLeak(stripFences(raw))
        .split(/\n{2,}/)[0]
        .replace(/\s*\n+\s*/g, ' ')
        .replace(/^(摘要|Summary|Excerpt)[:：]\s*/i, '')
        .replace(/^["'“”「『]|["'“”」』]$/g, '')
        .trim()
        .slice(0, language === 'en' ? 400 : 300)

    // 摘要是收敛型任务，温度压得很低，避免它自己编情节。
    //
    // 调模型这件事交给 lib/aiProvider 的 callText —— 不再在这里自己拼「主模型 + 兜底」：
    //   · 候选链、模型冷却、超时预算、报错收敛都在那一层，这里只要结果；
    //   · 任务名用 util（摘要属于杂活）→ 认 AI_UTIL_MODEL，和 docs 里写的分配一致；
    //   · 兜底配成别的供应商（`deepseek:deepseek-chat`）也真的能用 —— 以前这里是拼
    //     `models/<spec>:generateContent`，跨供应商的兜底会变成 404（这是真踩过的坑）。
    //
    // 时间预算：主模型 22s，整条链 45s，最多再等 8s 重试一次（都是 429 时的救场），
    // 全部压在 maxDuration=60 之内。慢失败比失败更糟 —— 站长会一直盯着转圈。
    const askModel = (opts: { model?: string; timeoutMs: number; budgetMs: number }) =>
      callText({
        task: 'util',
        model: opts.model,
        prompt,
        temperature: 0.35,
        maxOutputTokens: 1024,
        // ← 关键的一行：不让思考吃掉输出额度（详见 aiGemini 里那段 MAX_TOKENS 的注释）
        thinkingBudget: 0,
        // 一分钟的总预算经不起层层重试，失败就交给候选链
        retries: 0,
        timeoutMs: opts.timeoutMs,
        totalBudgetMs: opts.budgetMs,
        autoWaitMs: opts.model ? 0 : 8000,
      })

    /** 输出验收：短得不像摘要 / 把「数字数」的过程写出来了 / 被长度上限截成半句 —— 一律不算数 */
    const judge = (text: string, raw: string, truncated: boolean) =>
      text.length < 20
        ? `只有 ${text.length} 个字`
        : isCountLeak(raw)
          ? '把数数字的过程写出来了'
          : truncated && text.length < 40
            ? '被长度上限截断了'
            : ''

    // 同一段正文 + 同一个页签，5 分钟内再点就复用上次结果；请求体带 `fresh: true` 则强制重问。
    // 摘要属于「同样输入 → 同样输出」的任务：复用既省额度，也挡掉「以为没点着就连点三下」烧三份额度。
    const baseKey = `excerpt|${language}|${sha1(`${title}\n${bodyText}`)}`
    const run = await memoAiCall(
      // fresh 时给 key 缀个序号 → 这次一定真的去问模型（「同一段正文想换一版」的出路）
      fresh ? freshKey(baseKey) : baseKey,
      5 * 60 * 1000,
      () => askModel({ timeoutMs: 22000, budgetMs: 45000 }),
      // 失败的绝不记住：把一次 429 记 5 分钟的话，站长改完配置回来点，看到的还是那句「被限流了」
      { cache: (r) => r.ok === true }
    )
    const ai = run.value
    if (run.cached) console.log(`[ai-excerpt:${reqId}] 复用上次结果（5 分钟内问过同一段正文），这次没花额度`)
    if (ai.ok === false) {
      console.log(`[ai-excerpt:${reqId}] 供应商层失败 → ${ai.status} ${ai.kind} ${ai.error}`)
      return jsonResponse(
        { error: ai.error, kind: ai.kind, retryable: ai.retryable, retryAfterMs: ai.retryAfterMs, tried: ai.tried },
        ai.status
      )
    }

    let excerpt = cleanExcerpt(ai.text)
    let usedModel = ai.model
    let truncated = ai.truncated
    let why = judge(excerpt, ai.text, truncated)

    // 处理成功了但内容不合格 → 再问一次「兜底链里的第一个模型」（跨供应商也能用）。
    // 注意这跟「API 失败换模型」是两条路：API 失败由 callText 兜，内容不合格得由这里决定要不要再问。
    if (why) {
      const second = parseModelChain(process.env.AI_MODEL_FALLBACK)[0]
      console.log(`[ai-excerpt:${reqId}] ${ai.model} 的输出不合格（${why}）`, { chars: excerpt.length, second: second || '(没配兜底)' })
      if (second) {
        const retry = await askModel({ model: second, timeoutMs: 18000, budgetMs: 18000 })
        if (retry.ok === true) {
          const text2 = cleanExcerpt(retry.text)
          const why2 = judge(text2, retry.text, retry.truncated)
          if (!why2) {
            excerpt = text2
            usedModel = retry.model
            truncated = retry.truncated
            why = ''
          }
        }
      }
    }

    if (why) {
      return jsonResponse({ error: `模型这次没给出合格的摘要（${why}），再点一次`, retryable: true, retryAfterMs: 0 }, 502)
    }

    // 语言对不上也算失败：中文栏里没有中文、英文栏里全是中文，
    // 这两种都是不该写进库的东西（英文栏里偶尔出现一两个中文专名是正常的，
    // 所以门槛放到 10 个字）。
    const zhChars = countChineseChars(excerpt)
    if (language === 'zh' && zhChars < 10) {
      return jsonResponse({ error: '模型这次没给出中文摘要，请重试' }, 502)
    }
    if (language === 'en' && zhChars >= 10) {
      return jsonResponse({ error: '模型把英文摘要写成了中文，请重试一次' }, 502)
    }

    console.log(`[ai-excerpt:${reqId}] ok`, {
      language,
      chars: excerpt.length,
      model: usedModel,
      truncated,
      attempts: ai.attempts,
      cached: run.cached,
    })
    return Response.json({ ok: true, data: { excerpt, language, model: usedModel, truncated, cached: run.cached } })
  } catch (e: any) {
    if (isAbortError(e)) return jsonResponse({ error: '生成摘要超时，请重试' }, 504)
    console.log(`[ai-excerpt:${reqId}] fatal`, e?.message)
    return jsonResponse({ error: e?.message || '生成摘要失败' }, 500)
  }
}

