import type { NextRequest } from 'next/server'
import { jsonResponse, requireAdmin } from '@/lib/aiGemini'
import {
  callText,
  describeAiRouting,
  parseModelChain,
  resolveModelSpec,
  snapshotCooldowns,
  type AiTask,
} from '@/lib/aiProvider'
import { memoStats } from '@/lib/aiMemo'
import { describeMtRouting, probeMt } from '@/lib/translationProvider'

export const runtime = 'nodejs'
/** 逐个探测很花时间：4 个任务各一次、每次最多 10 秒（MT 兜底探测是毫秒级，可以忽略） */
export const maxDuration = 60

/**
 * 🩺 AI 自检（P2）。
 *
 * 为什么要有这个接口：
 *   2026-10-10 那屏红字暴露的最大问题不是「模型挂了」，而是**站长完全不知道到底哪儿挂了** ——
 *   是主模型没额度？兜底没配上？还是 AI_MODEL_FALLBACK 写成了别的供应商所以根本没用上？
 *   这些信息全在服务端的环境变量里，而站长手上只有一个报错弹窗。
 *
 * 两种模式：
 *   GET /api/ai/status          → 只看配置（一个字节的额度都不花）：每个任务用哪个模型、
 *                                 兜底链配了没有、哪把 Key 缺了、谁在冷却、记忆里存了几条
 *   GET /api/ai/status?probe=1  → 再分别真调一次模型，告诉你「现在到底能不能写」
 *
 * probe 会真花额度（每个不同的模型一次，prompt 只有两个字），所以必须显式带参数；
 * 也已经去重：4 个任务都配成同一个模型时只会探测一次。
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (auth.ok === false) return auth.response

  const probe = req.nextUrl.searchParams.get('probe') === '1'
  const routing = describeAiRouting()
  /** 翻译兜底链（方案 3）：LLM 全挂时才会用到的传统 MT 引擎 */
  const mt = describeMtRouting()

  /** 环境变量一览：模型名不是秘密，缺了哪把 Key 才是站长要看的 */
  const env = {
    GEMINI_MODEL: process.env.GEMINI_MODEL || '',
    AI_MODEL: process.env.AI_MODEL || '',
    AI_STORY_MODEL: process.env.AI_STORY_MODEL || '',
    AI_REVISE_MODEL: process.env.AI_REVISE_MODEL || '',
    AI_TRANSLATE_MODEL: process.env.AI_TRANSLATE_MODEL || '',
    AI_UTIL_MODEL: process.env.AI_UTIL_MODEL || '',
    AI_MODEL_FALLBACK: process.env.AI_MODEL_FALLBACK || '',
    AI_TRANSLATE_MT_FALLBACK: process.env.AI_TRANSLATE_MT_FALLBACK || '',
  }
  const keys = {
    GEMINI_API_KEY: Boolean(process.env.GEMINI_API_KEY),
    OPENROUTER_API_KEY: Boolean(process.env.OPENROUTER_API_KEY),
    ANTHROPIC_API_KEY: Boolean(process.env.ANTHROPIC_API_KEY),
    OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY),
    DEEPSEEK_API_KEY: Boolean(process.env.DEEPSEEK_API_KEY),
    ZHIPU_API_KEY: Boolean(process.env.ZHIPU_API_KEY),
    MOONSHOT_API_KEY: Boolean(process.env.MOONSHOT_API_KEY),
  }
  /**
   * 翻译兜底的凭据。
   * 为什么和上面那张表分开：上面是「LLM 生成的 Key」，这里是「专业翻译 API 的 Key」，
   * 一个都没有也能正常跑（只是 LLM 全挂时没兜底），不属于配置错误。
   */
  const mtKeys = {
    DEEPL_API_KEY: Boolean(process.env.DEEPL_API_KEY),
    GOOGLE_TRANSLATE_API_KEY: Boolean(process.env.GOOGLE_TRANSLATE_API_KEY),
    AZURE_TRANSLATOR_KEY: Boolean(process.env.AZURE_TRANSLATOR_KEY),
    AZURE_TRANSLATOR_REGION: Boolean(process.env.AZURE_TRANSLATOR_REGION),
    LIBRETRANSLATE_URL: Boolean(process.env.LIBRETRANSLATE_URL),
  }

  /** 探测哪几个：每个任务的模型 + 兜底链，按写法去重（同一个模型问一次就够） */
  const tasks: AiTask[] = ['story', 'revise', 'translate', 'util']
  const specs = [...new Set([...tasks.map((t) => resolveModelSpec(t)), ...parseModelChain(env.AI_MODEL_FALLBACK)])]

  const probeResults: Array<Record<string, unknown>> = []
  if (probe) {
    /**
     * 并行探测 + 每个模型 20 秒。
     *
     * 这两条都是被实测教出来的：先写成串行 10 秒，结果 gemini-3.8-flash 回了
     * 「AI 超时（超过 10 秒没回应）」—— 它其实只是**慢**（真实写摘要那条路给的是 22 秒），
     * 于是一个能用的模型被自检判成红的。自检页给错答案比不给答案更糟。
     * 并行则是因为 4 个模型串行 × 20 秒 = 80 秒，直接顶爆 maxDuration=60。
     */
    const probeOne = async (spec: string) => {
      const t0 = Date.now()
      // 不带兜底（要的就是「这个模型自己行不行」），不吃重试，输出压到最短
      const r = await callText({
        model: spec,
        fallbackModel: null,
        prompt: '回复两个字：可用',
        maxOutputTokens: 32,
        thinkingBudget: 0,
        retries: 0,
        timeoutMs: 20000,
        totalBudgetMs: 20000,
        // 自检要的是「此刻的真实状态」，不能被上一次失败留下的冷却挡住
        ignoreCooldown: true,
      })
      return r.ok === true
        ? { spec, ok: true, ms: Date.now() - t0, provider: r.provider, model: r.model }
        : {
            spec,
            ok: false,
            ms: Date.now() - t0,
            status: r.status,
            kind: r.kind,
            retryAfterMs: r.retryAfterMs,
            error: r.error,
          }
    }
    probeResults.push(...(await Promise.all(specs.map(probeOne))))
  }

  /** MT 兜底也一起探：各翻「你好」两个字，毫秒级，比 LLM 那边便宜得多 */
  const mtProbeResults: Array<Record<string, unknown>> = []
  if (probe && mt.chain.length) {
    mtProbeResults.push(...(await Promise.all(mt.chain.map((spec) => probeMt(spec)))))
  }

  return jsonResponse({
    ok: true,
    data: {
      env,
      keys,
      routing: routing.tasks,
      fallback: routing.fallback,
      cooldowns: snapshotCooldowns(specs),
      memo: memoStats(),
      /** 翻译兜底链（方案 3）：链、每个引擎能不能用、缺哪把 Key、谁在冷却 */
      mt: { ...mt, keys: mtKeys, summary: summarizeMt(mt) },
      probed: probe,
      probe: probeResults,
      mtProbe: mtProbeResults,
      /** 给前端一句话的总评（它自己就别再判断了，规则在这儿） */
      summary: summarize({ keys, routing: routing.tasks, fallback: routing.fallback, cooldowns: snapshotCooldowns(specs), probeResults }),
    },
  })
}

/**
 * 翻译兜底链的一句话总评。
 *
 * 注意口径：**没配兜底不算错**（level 用 info 而不是 error）—— 方案 3 的定位是
 * 「LLM 全挂时的救命绳」，不是必需品。没配只意味着 LLM 全挂时翻译会直接报错，
 * 而这本来就是以前一直以来的行为。
 */
function summarizeMt(mt: ReturnType<typeof describeMtRouting>) {
  if (!mt.chain.length) {
    return {
      level: 'info' as const,
      text: '没配 AI_TRANSLATE_MT_FALLBACK：LLM 全挂时翻译会直接报错（想加救命绳就填一下，见 docs/translation-layered-architecture.md）',
    }
  }
  const bad = mt.rows.filter((r) => !r.ok)
  if (bad.length === mt.rows.length) {
    return { level: 'error' as const, text: `兜底链里的 ${bad.length} 个引擎都用不了：${bad[0]?.error || ''}` }
  }
  if (bad.length) {
    return { level: 'warn' as const, text: `${bad.length} / ${mt.rows.length} 个兜底引擎用不了：${bad[0]?.error || ''}` }
  }
  return { level: 'ok' as const, text: `兜底链就绪：${mt.chain.join(' → ')}` }
}

/**
 * 一句话总评。
 *
 * 判断顺序刻意按「站长该先修哪个」排：连 Key 都没有 → 兜底没配 → 有模型在冷却 → 一切正常。
 * 前端只负责把这句显示成红/黄/绿三个色，不重复实现一遍规则。
 */
function summarize(input: {
  keys: Record<string, boolean>
  routing: ReturnType<typeof describeAiRouting>['tasks']
  fallback: ReturnType<typeof describeAiRouting>['fallback']
  cooldowns: Array<{ spec: string; leftMs: number; reason: string }>
  probeResults: Array<Record<string, unknown>>
}) {
  const bad = input.routing.filter((t) => !t.ok)
  if (bad.length) {
    return { level: 'error' as const, text: `有 ${bad.length} 个任务的模型配错了：${bad.map((t) => t.error).join('；')}` }
  }
  if (!input.fallback.length) {
    return { level: 'warn' as const, text: '没配 AI_MODEL_FALLBACK：主模型一挂就没退路，建议配「不同供应商」的模型' }
  }
  if (input.probeResults.length) {
    const dead = input.probeResults.filter((r) => r.ok === false)
    if (!dead.length) return { level: 'ok' as const, text: `全部可用（探测了 ${input.probeResults.length} 个模型）` }
    const all = dead.length === input.probeResults.length
    return {
      level: all ? ('error' as const) : ('warn' as const),
      text: all
        ? `试过的 ${dead.length} 个模型都不能用：${dead[0]?.error || ''}`
        : `${dead.length} / ${input.probeResults.length} 个模型不可用：${dead[0]?.error || ''}`,
    }
  }
  const cooling = input.cooldowns.filter((c) => c.leftMs > 0)
  if (cooling.length) {
    return {
      level: 'warn' as const,
      text: `${cooling.length} 个模型在冷却中（最快 ${Math.ceil(Math.min(...cooling.map((c) => c.leftMs)) / 1000)} 秒后恢复），配置本身没问题`,
    }
  }
  return { level: 'ok' as const, text: '配置看起来没问题（想确认真能不能写，点「真调一次」）' }
}
