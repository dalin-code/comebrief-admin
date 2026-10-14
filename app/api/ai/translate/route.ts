import type { NextRequest } from 'next/server'
import { htmlToPlainText, isAbortError, jsonResponse, requireAdmin } from '@/lib/aiGemini'
import { callText } from '@/lib/aiProvider'
import {
  buildTranslateChunkPrompt,
  buildTranslatePrompt,
  countChineseChars,
  countWords,
  parseDelimitedStory,
  toStoryHtml,
} from '@/lib/storyPrompt'
import { parseMtChain, translateWithMt } from '@/lib/translationProvider'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * 单次翻译的时间预算。
 *
 * 为什么是 36 秒而不是把 60 秒用满：callText 在主模型失败后还会用兜底模型再试一次
 * （兜底最多 20 秒），36 + 20 + 收尾 = 刚好不越过 maxDuration。慢失败比失败更糟 ——
 * 站长会一直盯着转圈等到超时白屏。
 */
const TRANSLATE_TIMEOUT_MS = 36000

/**
 * 兜底（传统 MT）的时间预算。
 *
 * 为什么留得这么小：MT 是「一次 HTTP 就回」的同步接口，正常几百毫秒，给 6 秒已经是
 * 「对面快挂了」的量级。留得小还有个关键好处 —— LLM 链往往把 60 秒预算啃掉大半才认输，
 * 剩给兜底的时间本来就不多，这里必须能在夹缝里跑完。
 */
const MT_TIMEOUT_MS = 6000
const MT_TOTAL_BUDGET_MS = 10000

/**
 * MT 返回的是纯文本（它不认识 <p> 这种「排版」概念），这里补回段落标签，
 * 好让编辑器拿到一份能直接用的 HTML —— 不然整篇会挤成一段。
 */
function textToParagraphHtml(text: string): string {
  return String(text || '')
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join('')
}

function escapeHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 🌐 中文 → 英文（母语化重写）。
 *
 * 站长的工作方式是「后台看中文、前台显示英文」：这一篇中文定稿之后再点翻译，
 * 出来的英文会写进 articles 的 title / excerpt / content_html（前台读这三列），
 * 中文则留在 title_zh / excerpt_zh / content_zh_html —— 两边都在，随时能回去改。
 *
 * 红线：情节、人物、情绪、结局、伏笔位置不许动；允许句子重组、比喻本地化。
 *
 * 两种调用方式：
 *   ① 整篇翻译（短文章，老路子）：{ title, excerpt, html }
 *   ② 分段翻译（长文章）：{ text, part, parts, prevTail?, glossary?, fullText? }
 *      切块在客户端做（lib/storyPrompt 的 splitTranslationChunks）：编辑器那边先知道
 *      一共几块，才能显示「正在翻译 2/5」，也才能一块失败只重试那一块。
 *      这里只负责翻它收到的那一块。
 *
 * 分层（方案 3，2026-10）：
 *   ① 首选 LLM 母语化重写（callText → Gemini / OpenRouter Claude / DeepSeek 候选链）；
 *   ② 整条 LLM 链都失败时，自动降级到传统 MT（lib/translationProvider：DeepL → Google
 *      → Microsoft → LibreTranslate），带 degraded: true 返回，并在 warnings 里劝站长重译。
 *   ③ MT 也没配或也全挂 → 才把错误丢给站长（错误里会写清两边都试过什么）。
 */
export async function POST(req: NextRequest) {
  const reqId = Math.random().toString(16).slice(2, 8)
  try {
    /** 整条链路（LLM → MT 兜底）共用的起点，用来算「还剩多少时间」 */
    const t0 = Date.now()
    const auth = await requireAdmin(req)
    if (auth.ok === false) return auth.response

    const body = await req.json().catch(() => ({}))
    const zhTitle = String(body?.title || '').trim().slice(0, 200)
    const zhExcerpt = String(body?.excerpt || '').trim().slice(0, 600)
    /** 原始 HTML —— MT 兜底会带 tag_handling=html 直接翻它，比翻纯文本更能保住分段 */
    const zhHtmlRaw = String(body?.html || '')
    const zhHtmlText = htmlToPlainText(zhHtmlRaw)
    /** 客户端切好的「这一段」的纯文本 */
    const chunkText = String(body?.text || '').trim()
    const part = Math.max(1, Math.floor(Number(body?.part) || 1))
    const parts = Math.max(part, Math.floor(Number(body?.parts) || 1))
    const prevTail = String(body?.prevTail || '')
    const glossary = String(body?.glossary || '').slice(0, 6000)
    /** 全文中文 —— 用来算字数、写标题/摘要/名词对照表（只有第 1 段会用到正文以外的部分） */
    const fullText = String(body?.fullText || '').trim() || zhHtmlText

    const isChunked = parts > 1
    const bodyText = chunkText || zhHtmlText

    if (fullText.length < 50 || bodyText.length < 10) {
      return jsonResponse({ error: '中文正文太短了，先写完再翻译' }, 400)
    }

    const zhLength = countChineseChars(fullText)
    const prompt = isChunked
      ? buildTranslateChunkPrompt({
          part,
          parts,
          zhText: bodyText,
          zhFullText: fullText,
          zhTitle,
          zhExcerpt,
          prevTail,
          glossary,
        })
      : buildTranslatePrompt({ zhTitle, zhExcerpt, zhBodyText: fullText, zhLength })

    // thinkingBudget: 0 —— 这一条最容易被忽略，但它就是"文章一长就翻译不了"的元凶之一。
    // Gemini 3.x 的思考 token 是从 maxOutputTokens 里扣的，翻长文时思考会把额度吃光，
    // 表现就是英文只出来一半、或者干脆失败。写正文那条路由早就关掉了思考；
    // 翻译这里以前走的是 callGeminiText（不认 thinkingBudget），所以一直带着这个坑。
    const ai = await callText({
      task: 'translate',
      prompt,
      temperature: isChunked ? 0.8 : 0.85,
      timeoutMs: TRANSLATE_TIMEOUT_MS,
      // 整条候选链的时间上限：36 秒（主）+ 后面最多 ~16 秒兜底，压在 maxDuration=60 之内。
      // 不设的话默认就是 36 秒 —— 主模型「慢慢失败」之后就再没机会试兜底了。
      totalBudgetMs: 52000,
      maxOutputTokens: isChunked ? 4096 : 8192,
      // 一分钟的总预算经不起重试；失败直接交给 AI_MODEL_FALLBACK 的兜底模型
      retries: 0,
      thinkingBudget: 0,
    })
    if (ai.ok === false) {
      // ── 方案 3：LLM 母语化重写整条候选链都倒了，兜底交给传统 MT ──────────────
      //
      // 产品取舍（写在这里免得以后有人问「为什么不全走 DeepL」）：
      //   翻译这条路的红线是「读者不能感觉这是翻译」，只有 LLM 会重组句子、本地化比喻；
      //   机翻是忠实的，但不做这些，所以它只配当救命绳 —— 有总比没有强，站长看到
      //   degraded 提示后重译一遍即可。
      const mtChain = parseMtChain(process.env.AI_TRANSLATE_MT_FALLBACK)
      if (mtChain.length) {
        const mtStart = Date.now()
        console.log(`[ai-translate:${reqId}] LLM 链全挂，转 MT 兜底：${mtChain.join(' → ')}`)

        // 正文：整篇翻译时把**原始 HTML** 直接交给 MT（tag_handling=html 保住 <p>）；
        // 分批翻译时这一段本来就是纯文本，翻完再补回段落标签。
        const bodyRes = await translateWithMt({
          text: isChunked ? bodyText : zhHtmlRaw || zhHtmlText,
          sourceLang: 'zh',
          targetLang: 'en',
          format: isChunked ? 'text' : 'html',
          context: prevTail || undefined,
          timeoutMs: MT_TIMEOUT_MS,
          totalBudgetMs: Math.max(MT_TOTAL_BUDGET_MS - (mtStart - t0), 3000),
        })

        if (bodyRes.ok === true) {
          const mtHtml = isChunked ? textToParagraphHtml(bodyRes.text) : bodyRes.text
          const mtWarnings = [
            `LLM 母语化重写整条链都挂了（试过 ${ai.tried.join('、')}），已用 ${bodyRes.label} 机翻兜底 —— 这一版是忠实直译、可能有翻译腔，建议稍后重译`,
          ]

          // 标题和摘要 MT 不会顺带给你（它不知道什么是一篇稿子），得单独再翻两句。
          // 分批翻译时跟 LLM 路径保持一致：只有第 1 段负责给标题 / 摘要。
          let mtTitle = ''
          let mtExcerpt = ''
          if (!isChunked || part === 1) {
            if (zhTitle) {
              const t = await translateWithMt({
                text: zhTitle,
                sourceLang: 'zh',
                targetLang: 'en',
                timeoutMs: 4000,
                totalBudgetMs: 4000,
              })
              if (t.ok === true) mtTitle = t.text
            }
            if (zhExcerpt) {
              const x = await translateWithMt({
                text: zhExcerpt,
                sourceLang: 'zh',
                targetLang: 'en',
                timeoutMs: 4000,
                totalBudgetMs: 4000,
              })
              if (x.ok === true) mtExcerpt = x.text
            }
          }
          const mtTitleClean = mtTitle.replace(/^["'“”《]|["'“”》]$/g, '').trim().slice(0, 200)
          const mtExcerptClean = mtExcerpt.replace(/\s*\n+\s*/g, ' ').trim().slice(0, 400)
          if (isChunked && part === 1 && !mtTitleClean) {
            mtWarnings.push('机翻没给出英文标题，保存前请手动填一个（否则网址会是一串横杠）')
          }
          const mtWords = countWords(htmlToPlainText(mtHtml))
          if (!isChunked && mtWords < Math.max(120, zhLength * 0.35)) {
            mtWarnings.push(`英文只有 ${mtWords} 词（中文 ${zhLength} 字），机翻可能被截短了，建议重译一遍`)
          }

          console.log(`[ai-translate:${reqId}] mt-fallback ok`, {
            engine: bodyRes.provider,
            part,
            parts,
            ms: Date.now() - mtStart,
            words: mtWords,
          })
          return Response.json({
            ok: true,
            data: {
              mode: isChunked ? 'chunk' : 'whole',
              part,
              parts,
              html: mtHtml,
              words: mtWords,
              title: mtTitleClean,
              excerpt: mtExcerptClean,
              /** MT 没有名词对照表（那是 LLM 读完全文才写得出来的东西） */
              glossary: '',
              warnings: mtWarnings,
              truncated: false,
              model: `${bodyRes.label}（机翻兜底）`,
              /** 下面三个字段给前端和排查用：这一版不是 LLM 母语化重写的产物 */
              engine: bodyRes.provider,
              degraded: true,
              fallbackFrom: 'llm',
            },
          })
        }

        // MT 也全挂了 —— 把两边的话合成一句，让人一眼看到「两种都试过了」
        console.log(`[ai-translate:${reqId}] mt-fallback 也失败`, bodyRes.error)
        return jsonResponse(
          {
            error: `${bodyRes.error}（连机翻兜底也没成。LLM 那边试过：${ai.tried.join('、')}）`,
            kind: bodyRes.kind,
            retryable: bodyRes.retryable,
            retryAfterMs: bodyRes.retryAfterMs,
            tried: [...ai.tried, ...bodyRes.tried],
            degraded: true,
          },
          bodyRes.status
        )
      }

      // 没配兜底引擎（AI_TRANSLATE_MT_FALLBACK 为空）→ 保持原样，把 LLM 的错原封不动报上去
      // 结构化字段一起给出去：前端靠 retryAfterMs 决定「等一会儿自动重发这一段」还是直接报错
      return jsonResponse(
        {
          error: ai.error,
          kind: ai.kind,
          retryable: ai.retryable,
          retryAfterMs: ai.retryAfterMs,
          tried: ai.tried,
        },
        ai.status
      )
    }

    const warnings: string[] = []
    if (ai.truncated) {
      warnings.push(
        isChunked
          ? `第 ${part}/${parts} 段的英文被长度上限截断了，重试这一段即可`
          : '英文输出被长度上限截断了，建议重试或把中文删短一点'
      )
    }

    const parsed = parseDelimitedStory(ai.text)
    const html = toStoryHtml(parsed.body || parsed.excerpt)
    const title = String(parsed.title || '').replace(/^["'“”《]|["'“”》]$/g, '').trim().slice(0, 200)
    const excerpt = String(parsed.excerpt || '').replace(/\s*\n+\s*/g, ' ').trim().slice(0, 400)
    const words = countWords(htmlToPlainText(html))

    if (!html.trim()) {
      return jsonResponse(
        { error: isChunked ? `第 ${part} 段没有翻出有效英文，请重试这一段` : '翻译返回了空内容，请重试一次' },
        502
      )
    }
    // 整篇翻译时必须有标题 —— 否则会把站长已经填好的英文标题清成空
    if (!isChunked && !title) return jsonResponse({ error: '模型没有给出英文标题，请重试一次' }, 502)
    if (isChunked && part === 1 && !title) {
      warnings.push('模型没给出英文标题，保存前请手动填一个（否则网址会是一串横杠）')
    }

    // 「是不是被写短了」只在整篇翻译时判断；分批时每一段本来就短，查了全是误报
    if (!isChunked && words < Math.max(120, zhLength * 0.35)) {
      warnings.push(`英文只有 ${words} 词（中文 ${zhLength} 字），可能被写短了，建议重译一遍`)
    }

    console.log(`[ai-translate:${reqId}] ok`, {
      part,
      parts,
      zhLength,
      words,
      truncated: ai.truncated,
      model: ai.model,
    })
    return Response.json({
      ok: true,
      data: {
        mode: isChunked ? 'chunk' : 'whole',
        part,
        parts,
        html,
        words,
        title,
        excerpt,
        /** 名词对照表：只有分批翻译的第 1 段会给，客户端要一路带给后面几段 */
        glossary: parsed.glossary || '',
        warnings,
        truncated: ai.truncated,
        model: ai.model,
      },
    })
  } catch (e: any) {
    if (isAbortError(e)) return jsonResponse({ error: '翻译超时，请重试' }, 504)
    console.log(`[ai-translate:${reqId}] fatal`, e?.message)
    return jsonResponse({ error: e?.message || '翻译失败' }, 500)
  }
}

