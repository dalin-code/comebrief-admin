#!/usr/bin/env node
/**
 * P3 三遍流水线实跑冒烟（草稿 → 自评 → 定向重写）。
 *
 * 验三件事：
 *   1. loadSkill 能从线上 story_skills 取到写法（线上有 6 种，默认 A）
 *   2. 自评这一遍：模型真的按 JSON 契约返回，parseStoryReview 能解析出 6 维 + 问题清单
 *   3. 重写这一遍：只动点名的地方 —— 用「二字组重合率」量原文被保留了多少（定向改稿理想 75–95%）
 *
 * 用法：
 *   node --import ./scripts/_ts-resolve.mts scripts/p3-pipeline-smoke.mts [草稿文件]
 *
 * 草稿文件格式（标题/摘要可省，正文标记必须有；与 P0 盲测产物一致）：
 *   标题：…
 *   摘要：…
 *   ---- 正文 ----
 *   …
 * 省略则用 /tmp/p0/samples/sample-1.md。花额度：两遍模型调用（约 20 秒）。
 * 报告落在 /tmp/p3/pipeline-report.txt、review.json、rewrite-body.txt。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { callText } from '../lib/aiProvider.ts'
import { loadSkill } from '../lib/storySkills.ts'
import { parseDelimitedStory, countChineseChars } from '../lib/storyPrompt.ts'
import {
  buildReviewSystemPrompt,
  buildReviewUserPrompt,
  parseStoryReview,
  pickDefaultIssueIds,
} from '../lib/storyReview.ts'
import { buildRewriteSystemPrompt, buildRewriteUserPrompt } from '../lib/storyRewrite.ts'

// node 直接跑脚本不会自动加载 .env.local
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const i = s.indexOf('=')
    if (i <= 0) continue
    const k = s.slice(0, i).trim()
    const v = s.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    if (k && !process.env[k]) process.env[k] = v
  }
}

const OUT = '/tmp/p3'
mkdirSync(OUT, { recursive: true })
const report: string[] = []
const say = (t = '') => {
  console.log(t)
  report.push(t)
}

/* ---------------- 素材：从 P0 样本里抠出标题 / 摘要 / 正文 ---------------- */

const raw = (() => {
  const draftPath = process.argv[2] || '/tmp/p0/samples/sample-1.md'
  if (!existsSync(draftPath)) {
    console.error(
      `找不到草稿文件：${draftPath}\n` +
        '用法：node --import ./scripts/_ts-resolve.mts scripts/p3-pipeline-smoke.mts [草稿文件]'
    )
    process.exit(1)
  }
  console.log(`草稿：${draftPath}`)
  return readFileSync(draftPath, 'utf8')
})()
const bodyIdx = raw.indexOf('---- 正文 ----')
const head = bodyIdx === -1 ? '' : raw.slice(0, bodyIdx)
const draftBody = (bodyIdx === -1 ? raw : raw.slice(bodyIdx + '---- 正文 ----'.length)).trim()
const draftTitle = (head.match(/标题：(.+)/)?.[1] || '').trim()
const draftExcerpt = (head.match(/摘要：(.+)/)?.[1] || '').trim()

const MODEL = process.env.AI_REVISE_MODEL || 'gemini:gemini-3-flash-preview'

/* ---------------- 保真度：原文的二字组有多少还在新稿里 ---------------- */

function bigrams(s: string) {
  const m = new Map<string, number>()
  for (let i = 0; i < s.length - 1; i += 1) {
    const g = s.slice(i, i + 2)
    m.set(g, (m.get(g) || 0) + 1)
  }
  return m
}
function overlap(a: string, b: string) {
  const A = bigrams(a)
  const B = bigrams(b)
  let total = 0
  let hit = 0
  for (const [g, n] of A) {
    total += n
    hit += Math.min(n, B.get(g) || 0)
  }
  return total ? hit / total : 0
}

const finish = (code = 0) => {
  writeFileSync(`${OUT}/pipeline-report.txt`, report.join('\n'))
  process.exit(code)
}

/* ---------------- 开跑 ---------------- */

say(`素材：${draftTitle} · ${countChineseChars(draftBody)} 字 · 模型 ${MODEL}`)

const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!supaUrl || !supaKey) {
  say('✗ 缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  finish(1)
}
const client = createClient(supaUrl, supaKey, { auth: { persistSession: false } })

/* 第 0 步：写法（三遍共用同一份，这里验 loadSkill） */
const chosen = await loadSkill(client, 'A')
say(chosen.row ? `✓ 写法 ${chosen.row.code} ${chosen.row.name}（范文 ${(chosen.row.exemplar || '').length} 字）` : `✗ 取不到写法：${chosen.warning}`)

/* 第二遍：自评 */
say('\n===== 第二遍：自评（要 JSON，不许客气） =====')
const r1 = await callText({
  task: 'revise',
  model: MODEL,
  system: buildReviewSystemPrompt(chosen.row),
  prompt: buildReviewUserPrompt({ title: draftTitle, bodyText: draftBody, targetLength: 1500 }),
  temperature: 0.2,
  jsonMode: true,
  maxOutputTokens: 2048,
  timeoutMs: 60000,
  retries: 0,
  thinkingBudget: 0,
})
if (!r1.ok) {
  say(`✗ 自评请求失败 ${r1.status} ${r1.error}`)
  finish(1)
}
say(`模型 ${r1.provider}/${r1.model} ${r1.ms}ms 截断=${r1.truncated}`)
const parsed = parseStoryReview(r1.text, r1.model)
if (!parsed.ok) {
  say(`✗ 解析失败：${parsed.error}`)
  say(`原文前 400 字：${parsed.raw.slice(0, 400)}`)
  finish(1)
}
const review = parsed.review
say(`✓ 均分 ${review.total} · ${review.issues.length} 条待改`)
say(`总评：${review.verdict}`)
for (const s of review.scores) say(`  ${s.label.padEnd(8, '　')} ${String(s.score).padStart(4)}  ${s.comment}`)
for (const it of review.issues) {
  say(`  [${it.id} / ${it.severity} / ${it.dimension}]`)
  if (it.evidence) say(`      原文：${it.evidence}`)
  say(`      问题：${it.problem}`)
  say(`      改法：${it.fix}`)
}
writeFileSync(`${OUT}/review.json`, JSON.stringify(review, null, 2))

const pick = pickDefaultIssueIds(review)
say(`\n默认勾选：${pick.join(', ') || '（无）'}`)

/* 第三遍：定向重写 */
say('\n===== 第三遍：定向重写（只改点名的地方） =====')
const issues = review.issues.filter((i) => pick.includes(i.id))
if (!issues.length) {
  say('没有勾选任何问题，重写这一步被跳过（正常：说明这篇已经够好）')
  finish(0)
}
const r2 = await callText({
  task: 'revise',
  model: MODEL,
  system: buildRewriteSystemPrompt(chosen.row),
  prompt: buildRewriteUserPrompt({ title: draftTitle, bodyText: draftBody, excerpt: draftExcerpt, issues }),
  temperature: 0.6,
  maxOutputTokens: 8192,
  timeoutMs: 60000,
  retries: 0,
  thinkingBudget: 0,
})
if (!r2.ok) {
  say(`✗ 重写请求失败 ${r2.status} ${r2.error}`)
  finish(1)
}
const out = parseDelimitedStory(r2.text)
const next = (out.body || out.excerpt).trim()
say(`模型 ${r2.provider}/${r2.model} ${r2.ms}ms 截断=${r2.truncated}`)
say(`标题：${out.title || '（沿用原题）'}`)
say(`字数：${countChineseChars(draftBody)} → ${countChineseChars(next)}`)
const keep = overlap(draftBody, next)
say(`原文二字组保留率：${(keep * 100).toFixed(1)}%  （定向改稿理想 75–95%；<60% 说明它顺手重写了全篇）`)
say(`新稿开头：${next.slice(0, 24)}`)
say(`新稿结尾：${next.slice(-24)}`)
writeFileSync(`${OUT}/rewrite-body.txt`, next)

say('\n===== 抽查：点名的位置真的动了吗 =====')
for (const it of issues) {
  if (!it.evidence) {
    say(`  · [${it.id}] 没有引句（整维调整），跳过`)
    continue
  }
  say(`  · [${it.id}] 原句${next.includes(it.evidence) ? '仍在（模型判断不该改）' : '已改掉'}：${it.evidence.slice(0, 28)}`)
}

say('\n完成。产物：/tmp/p3/review.json、/tmp/p3/rewrite-body.txt')
finish(0)

