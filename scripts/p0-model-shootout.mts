#!/usr/bin/env node
/**
 * P0 · 模型盲测脚本（一次性调研工具，不属于产品代码）
 *
 * 目的：用**同一个标签组合 + 同一份提示词**（直接复用 lib/storyPrompt.ts 的
 * buildStoryPrompt，也就是线上正在用的那份），跑多个模型各写一篇，
 * 输出匿名样本供人工盲选 —— 用眼睛决定换哪个模型，而不是靠猜。
 *
 * 用法：
 *   node scripts/p0-model-shootout.ts                    # 默认组合（悬疑/第一人称/快节奏）
 *   node scripts/p0-model-shootout.ts --list             # 只列出标签库里有哪些标签
 *   node scripts/p0-model-shootout.ts --combo '{"genre":["悬疑"],"length":1500}'
 *
 * 说明：
 *   - key 一律从 .env.local 读，脚本自己解析，不依赖 dotenv。
 *   - 缺哪个 key 就跳过哪个供应商（例：没有 OPENROUTER_API_KEY 就只跑 Gemini）。
 *   - 输出：/tmp/p0/samples/sample-N.md（匿名）+ /tmp/p0/ANSWER-KEY.txt（对照表）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { callText } from '../lib/aiProvider.ts'
import {
  buildStoryPrompt,
  buildStorySystemPrompt,
  buildStoryUserPrompt,
  countChineseChars,
  parseDelimitedStory,
  toStoryHtml,
} from '../lib/storyPrompt.ts'

/* ---------------- 环境 ---------------- */

function loadEnvLocal(): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync('.env.local')) return out
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const i = s.indexOf('=')
    if (i === -1) continue
    const k = s.slice(0, i).trim()
    const v = s.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    if (k) out[k] = v
  }
  return out
}

const ENV = { ...process.env, ...loadEnvLocal() } as Record<string, string>
// callText 从 process.env 读 key 与 AI_MODEL_FALLBACK —— 把脚本加载到的值灌进去
for (const [k, v] of Object.entries(ENV)) if (!process.env[k]) process.env[k] = v
const OUT_DIR = '/tmp/p0'

/* ---------------- 参数 ---------------- */

const argv = process.argv.slice(2)
const hasFlag = (f: string) => argv.includes(f)
const argValue = (f: string) => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : ''
}

const ONLY = argValue('--only')
/** 每次跑用一个独立子目录，避免多次运行互相覆盖样本 */
const RUN = argValue('--run') || String(Date.now()).slice(-6)
const SAMPLE_DIR = `${OUT_DIR}/samples/${RUN}`
/** 默认组合 —— 标签名必须与 story_tags 里完全一致（库里是「快/中/慢」，不是「快节奏」） */
const DEFAULT_COMBO = {
  genre: ['悬疑'],
  pov: ['第一人称'],
  pace: ['快'],
  style: ['白描'],
  ending: ['留白'],
  length: 1500,
}
const DEFAULT_IDEA =
  '一个小卖部的老板娘，连续三年每天把一包烟摆在柜台最左边。她自己也不记得为什么。'
let COMBO: any = DEFAULT_COMBO
const comboArg = argValue('--combo')
if (comboArg) {
  try {
    COMBO = JSON.parse(comboArg)
  } catch {
    console.error('--combo 不是合法 JSON')
    process.exit(1)
  }
}
const IDEA = argValue('--idea')
const LENGTH = Number(COMBO.length) || 1500
/**
 * Gemini 3.x 的思考预算。默认 0（关掉）—— 实测开着会让思考 token 抢走正文额度，
 * 1500 字的目标只写出 208 字就被截断。这与线上路由（app/api/ai/story）保持一致。
 */
const THINKING = argv.includes('--thinking') ? Number(argValue('--thinking')) : 0

/* ---------------- 供应商清单 ---------------- */

type Target = { provider: 'gemini' | 'openai-compat'; model: string; label: string; keyEnv: string; baseUrl?: string }

const GEMINI_TARGETS: Target[] = [
  { provider: 'gemini', model: 'gemini-3-flash-preview', label: 'gemini-3-flash-preview（线上现行基线）', keyEnv: 'GEMINI_API_KEY' },
  { provider: 'gemini', model: 'gemini-3.5-flash', label: 'gemini-3.5-flash', keyEnv: 'GEMINI_API_KEY' },
  { provider: 'gemini', model: 'gemini-3.6-flash', label: 'gemini-3.6-flash', keyEnv: 'GEMINI_API_KEY' },
  { provider: 'gemini', model: 'gemini-3.8-flash', label: 'gemini-3.8-flash（最新 Flash）', keyEnv: 'GEMINI_API_KEY' },
  { provider: 'gemini', model: 'gemini-3.1-pro-preview', label: 'gemini-3.1-pro-preview（Pro 档，免费额度会 429）', keyEnv: 'GEMINI_API_KEY' },
]

/** OpenRouter 一个 key 打通全部 —— 有 key 就自动加上这几家 */
const OR_TARGETS: Target[] = [
  { provider: 'openai-compat', model: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5（英文散文强）', keyEnv: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1' },
  { provider: 'openai-compat', model: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash（中文向/极便宜）', keyEnv: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1' },
  { provider: 'openai-compat', model: 'z-ai/glm-5.3', label: 'GLM 5.3（中文强）', keyEnv: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1' },
  { provider: 'openai-compat', model: 'moonshotai/kimi-k3', label: 'Kimi K3（长文中文）', keyEnv: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1' },
]

/** 这几家直连也行（有独立 key 才算） */
const DIRECT_TARGETS: Target[] = [
  { provider: 'openai-compat', model: 'deepseek-chat', label: 'DeepSeek 直连', keyEnv: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com/v1' },
  { provider: 'openai-compat', model: 'glm-4.6', label: '智谱 GLM 直连', keyEnv: 'ZHIPU_API_KEY', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
]

/* ---------------- 调用参数 ---------------- */
// 调用本身不再自己拼 URL 和重试：走 lib/aiProvider.ts 的 callText()。
// 盲测和线上是同一条代码路径，「盲测里跑出来的样子」才等于「站长点生成时看到的样子」。
// 这里只留三样盲测必须自己定的东西：

const TEMPERATURE = 0.95 // 与 app/api/ai/story/route.ts 保持一致
const MAX_OUTPUT_TOKENS = 8192 // 同上
/** 盲测要的是「这个模型此刻行不行」：不重试、不兜底，故障就让它原样失败 */
const RETRIES = 0
const TIMEOUT_MS = 150_000

/* ---------------- 标签 ---------------- */

async function fetchTags() {
  const url = ENV.NEXT_PUBLIC_SUPABASE_URL
  const key = ENV.SUPABASE_SERVICE_ROLE_KEY || ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) throw new Error('.env.local 里缺 Supabase 配置')
  const supabase = createClient(url, key, { auth: { persistSession: false } })
  const { data, error } = await supabase
    .from('story_tags')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
  if (error) throw new Error(`读取标签失败：${error.message}`)
  return (data || []) as any[]
}

/* ---------------- 主流程 ---------------- */

async function main() {
  mkdirSync(SAMPLE_DIR, { recursive: true })
  const all = await fetchTags()

  // 1) 标签清单（顺便检查默认组合里的标签名是否真实存在）
  const byDim: Record<string, string[]> = {}
  for (const t of all) (byDim[t.dimension] ||= []).push(t.name)
  const tagLines = Object.entries(byDim)
    .map(([d, names]) => `${d}（${names.length}）：${names.join(' / ')}`)
    .join('\n')
  writeFileSync(`${OUT_DIR}/tags.txt`, tagLines + '\n')

  if (hasFlag('--list')) {
    console.log(tagLines)
    console.log(`\n已写入 ${OUT_DIR}/tags.txt`)
    return
  }

  // 2) 把 combo 里的标签名匹配成完整注解
  const DIMENSION_KEYS = ['genre', 'era', 'pov', 'style', 'structure', 'ending', 'pace']
  const tagsByDimension: Record<string, any[]> = {}
  const missing: string[] = []
  for (const dim of DIMENSION_KEYS) {
    const wanted: string[] = Array.isArray(COMBO[dim]) ? COMBO[dim] : []
    if (!wanted.length) continue
    const picked = wanted.map((n) => all.find((t) => t.dimension === dim && t.name === n)).filter(Boolean) as any[]
    if (picked.length) tagsByDimension[dim] = picked
    for (const n of wanted) if (!picked.some((p) => p.name === n)) missing.push(`${dim}/${n}`)
  }

  const promptInput = {
    combo: COMBO,
    tagsByDimension: tagsByDimension as any,
    idea: IDEA || DEFAULT_IDEA,
    materials: '',
    length: LENGTH,
  }
  // 与线上完全一致的两半：稳定的写作宪法走 system（可缓存），本篇设定走 user
  const systemPrompt = buildStorySystemPrompt(null)
  const userPrompt = buildStoryUserPrompt(promptInput)
  // 另存一份拼好的整段，方便肉眼核对提示词
  writeFileSync(`${OUT_DIR}/prompt-used.txt`, `=== SYSTEM（走 systemInstruction）===\n${systemPrompt}\n\n=== USER ===\n${userPrompt}`)
  writeFileSync(`${OUT_DIR}/prompt-joined.txt`, buildStoryPrompt(promptInput))

  console.log(
    '组合：' + Object.entries(tagsByDimension).map(([d, ts]) => `${d}=${ts.map((t: any) => t.name).join('+')}`).join(' , ')
  )
  if (missing.length) console.log(`⚠️ 标签库里没找到（已跳过）：${missing.join(', ')}`)

  // 3) 组装要跑的目标 —— 缺 key 的自动跳过
  let targets: Target[] = [...GEMINI_TARGETS, ...OR_TARGETS, ...DIRECT_TARGETS]
  if (ONLY) {
    targets = targets.filter((t) => t.provider === ONLY || t.model.includes(ONLY) || t.keyEnv.toLowerCase().includes(ONLY))
  }
  const runnable = targets.filter((t) => !!ENV[t.keyEnv])
  const skipped = targets.filter((t) => !ENV[t.keyEnv])
  if (skipped.length) console.log(`跳过（缺 key）：${[...new Set(skipped.map((t) => t.keyEnv))].join(', ')}`)
  if (!runnable.length) throw new Error('没有任何可跑的模型：.env.local 里连 GEMINI_API_KEY 都没有')

  console.log(`开跑 ${runnable.length} 个模型（并行）：${runnable.map((t) => t.model).join(', ')}\n`)

  // 4) 并行调用 —— 直接走 lib/aiProvider.ts，与线上是同一条代码路径
  const results = await Promise.all(
    runnable.map(async (t) => {
      const startedAt = Date.now()
      try {
        const r = await callText({
          model: t.model,
          task: 'story',
          system: systemPrompt,
          prompt: userPrompt,
          temperature: TEMPERATURE,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          timeoutMs: TIMEOUT_MS,
          retries: RETRIES,
          // 盲测绝不允许兜底：否则「3.8-flash」那一格其实是老模型写的，样本就串味了
          fallbackModel: null,
          thinkingBudget: THINKING,
        })
        if (r.ok === true) {
          return { target: t, ok: true as const, ms: r.ms, text: r.text, truncated: r.truncated }
        }
        return { target: t, ok: false as const, ms: r.ms, error: r.error }
      } catch (e: any) {
        return { target: t, ok: false as const, ms: Date.now() - startedAt, error: e?.message || String(e) }
      }
    })
  )

  // 5) 匿名化 + 打乱顺序（盲测的关键：样本文件里不出现模型名）
  const shuffled = [...results].sort(() => Math.random() - 0.5)
  const keyLines: string[] = []
  const previewLines: string[] = []
  let n = 0

  for (const r of shuffled) {
    if (r.ok === false) {
      keyLines.push(`（失败）${r.target.label}  →  ${r.error}`)
      const hint = /free_tier/i.test(r.error)
        ? '   ← 这个 key 目前是免费额度档（要对比新模型：给 Google 开结算，或加一个 OPENROUTER_API_KEY）'
        : ''
      console.log(`✗ ${r.target.model}  ${Math.round(r.ms / 1000)}s  ${r.error}${hint}`)
      continue
    }
    n += 1
    const parsed = parseDelimitedStory(r.text)
    const html = toStoryHtml(parsed.body || parsed.excerpt)
    const chars = countChineseChars(html.replace(/<[^>]+>/g, ''))
    const body = html
      .replace(/<\/p>/g, '\n\n')
      .replace(/<h3>/g, '\n### ')
      .replace(/<\/h3>/g, '\n')
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    writeFileSync(
      `${SAMPLE_DIR}/sample-${n}.md`,
      [
        `# 样本 ${n}`,
        '',
        `标题：${parsed.title || '（无标题）'}`,
        `摘要：${parsed.excerpt || '（无摘要）'}`,
        `字数：${chars}（目标 ${LENGTH}）    耗时：${Math.round(r.ms / 1000)}s${r.truncated ? '  ⚠️ 被长度上限截断' : ''}`,
        '',
        '---- 正文 ----',
        '',
        body,
        '',
      ].join('\n')
    )

    keyLines.push(`样本 ${n}  →  ${r.target.label}  [${r.target.model}]   ${chars}字  ${Math.round(r.ms / 1000)}s`)
    previewLines.push(`【样本 ${n}】${parsed.title || '（无标题）'} · ${chars}字\n${body.slice(0, 170).replace(/\n+/g, ' ')}\n`)
    console.log(`✓ 样本 ${n}  ${Math.round(r.ms / 1000)}s  ${chars}字  《${parsed.title || '无标题'}》`)
  }

  writeFileSync(`${OUT_DIR}/ANSWER-KEY-${RUN}.txt`, `盲测对照表（先把样本读完，再回来看这里）\n\n${keyLines.join('\n')}\n`)
  writeFileSync(`${OUT_DIR}/preview-${RUN}.txt`, previewLines.join('\n'))
  console.log(`\n样本目录：${SAMPLE_DIR}`)
  console.log(`速览：${OUT_DIR}/preview-${RUN}.txt`)
  console.log(`对照表：${OUT_DIR}/ANSWER-KEY-${RUN}.txt`)
}

main().catch((e) => {
  console.error('P0 脚本失败：', e?.message || e)
  process.exit(1)
})
