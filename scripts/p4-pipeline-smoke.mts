#!/usr/bin/env node
/**
 * P4 同 Seed 三版冒烟（会花模型额度：3 次分段写作）。
 *
 * 验四件事：
 *   1. 同 Seed + variant 0/1/2 的 skeletonHash 完全一致（骨架没有漂）；
 *   2. 三版的 fingerprint / 人名 / 地点 / 物件互不相同（表皮真的换了）；
 *   3. 三版写出的第 1 段不串人物、不串地点（Prompt 里的表皮约束生效）；
 *   4. 三版没有完全相同的场景对白 / 开篇（不是换皮重发同一段）。
 *
 * 用法：
 *   node --import ./scripts/_ts-resolve.mts scripts/p4-pipeline-smoke.mts [seed]
 *   node --import ./scripts/_ts-resolve.mts scripts/p4-pipeline-smoke.mts [seed] --offline
 *
 * --offline 只跑确定性表皮检查，不调用模型。
 * 报告落在 /tmp/p4/pipeline-smoke.txt，三段正文落在 /tmp/p4/variant-{0,1,2}.txt。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { callText } from '../lib/aiProvider.ts'
import { loadSkill } from '../lib/storySkills.ts'
import { countChineseChars, htmlToPlainText, parseDelimitedStory, toStoryHtml } from '../lib/storyPrompt.ts'
import { deriveSeeds, seedToInt } from '../lib/storySelection.ts'
import { fallbackSkeleton, normalizeSkeleton, surfaceForSkeleton, validateSkeleton } from '../lib/storyPlan.ts'
import { buildSectionSystemPrompt, buildSectionUserPrompt, enforceSectionBoundary } from '../lib/storyWrite.ts'

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

const OUT = '/tmp/p4'
mkdirSync(OUT, { recursive: true })
const report: string[] = []
const say = (t = '') => {
  console.log(t)
  report.push(t)
}

let failed = 0
const check = (name: string, cond: boolean, extra = '') => {
  const line = `${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` —— ${extra}` : ''}`
  console.log(line)
  report.push(line)
  if (!cond) failed += 1
}

const args = process.argv.slice(2)
const offline = args.includes('--offline')
const seed = args.find((x) => !x.startsWith('--')) || 'p4-smoke-2026'
const LENGTH = 1500
const VARIANTS = [0, 1, 2]
const MODEL = process.env.AI_STORY_MODEL || 'gemini:gemini-3-flash-preview'

say(`Seed：${seed} · 篇幅：${LENGTH} · 版本：${VARIANTS.map((v) => `v${v}`).join(' / ')} · 模型：${offline ? '不调用' : MODEL}`)

/* ---------------- 骨架：同一副，三个版本共用 ---------------- */

const baseSkeleton = normalizeSkeleton(fallbackSkeleton({ seed, length: LENGTH }), { seed, length: LENGTH })
const skeletonWarnings = validateSkeleton(baseSkeleton)
check('0a 骨架节拍数在 4–6', baseSkeleton.beats.length >= 4 && baseSkeleton.beats.length <= 6, String(baseSkeleton.beats.length))
check('0b 骨架没有具体人名/地名', skeletonWarnings.every((w) => !w.includes('人名/地名')), skeletonWarnings.join('；') || '无警告')

/* ---------------- 表皮：三版必须互不相同 ---------------- */

type Variant = {
  index: number
  seeds: ReturnType<typeof deriveSeeds>
  surface: ReturnType<typeof surfaceForSkeleton>
  text: string
  html: string
  chars: number
  warnings: string[]
}

const variants: Variant[] = VARIANTS.map((variantIndex) => {
  const seeds = deriveSeeds(seed, variantIndex)
  const surface = surfaceForSkeleton(baseSkeleton, seed, variantIndex)
  return { index: variantIndex, seeds, surface, text: '', html: '', chars: 0, warnings: [] }
})

const perVariantSkeletons = VARIANTS.map((variantIndex) =>
  normalizeSkeleton(fallbackSkeleton({ seed, length: LENGTH }), { seed, length: LENGTH })
)
check(
  '1a 三版 skeletonHash 完全一致',
  new Set([...perVariantSkeletons.map((s) => s.skeletonHash), baseSkeleton.skeletonHash]).size === 1,
  `${baseSkeleton.skeletonHash}`
)
check(
  '1a2 三版 skeletonSeed 完全一致',
  variants.every((v) => v.seeds.skeletonSeed === variants[0].seeds.skeletonSeed)
)
check(
  '1b 三版 fingerprint 互不相同',
  new Set(variants.map((v) => v.surface.fingerprint)).size === variants.length,
  variants.map((v) => v.surface.fingerprint).join(' / ')
)
check(
  '1c 三版主角名互不相同',
  new Set(variants.map((v) => v.surface.protagonistName)).size === variants.length,
  variants.map((v) => v.surface.protagonistName).join(' / ')
)
check(
  '1d 三版场景（城市·地点·时间）互不相同',
  new Set(variants.map((v) => `${v.surface.city}|${v.surface.place}|${v.surface.time}`)).size === variants.length,
  variants.map((v) => `${v.surface.city}·${v.surface.place}`).join(' / ')
)
check(
  '1e 三版关键物件组合互不相同',
  new Set(variants.map((v) => v.surface.objects.join('|'))).size === variants.length
)

/* ---------------- 写法：三版共用同一份，避免把“文风变化”误判成“骨架漂移” ---------------- */

let skill = null as Awaited<ReturnType<typeof loadSkill>>['row']
const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (supaUrl && supaKey) {
  const client = createClient(supaUrl, supaKey, { auth: { persistSession: false } })
  const chosen = await loadSkill(client, 'A')
  skill = chosen.row
  if (chosen.warning) say(`· 写法读取提示：${chosen.warning}`)
}
say(skill ? `写法：${skill.code} ${skill.name}` : '写法：（没有可用写法，按通用标准写）')

/* ---------------- 逐版写第 1 段 ---------------- */

if (!offline) {
  for (const v of variants) {
    const beat = baseSkeleton.beats[0]
    say(`\n===== v${v.index} · ${v.surface.protagonistName} · ${v.surface.city} / ${v.surface.place} =====`)
    const res = await callText({
      task: 'story',
      model: MODEL,
      system: buildSectionSystemPrompt(skill),
      prompt: buildSectionUserPrompt({
        skeleton: baseSkeleton,
        surface: v.surface,
        sectionIndex: 0,
        previousSections: [],
        length: LENGTH,
      }),
      temperature: 0.9,
      maxOutputTokens: 4096,
      timeoutMs: 50_000,
      retries: 0,
      thinkingBudget: 0,
      seed: seedToInt(`${v.seeds.proseSeed}:smoke`),
    })
    if (res.ok === false) {
      check(`2a v${v.index} 模型调用成功`, false, `${res.status} ${res.error}`)
      continue
    }
    const parsed = parseDelimitedStory(res.text)
    const html = toStoryHtml(parsed.body || parsed.excerpt || res.text)
    const boundary = enforceSectionBoundary({ html, beat, endingSignal: baseSkeleton.endingSignal, isFinal: false })
    v.html = boundary.html
    v.text = htmlToPlainText(boundary.html)
    v.chars = boundary.chars
    v.warnings = boundary.warnings
    writeFileSync(
      `${OUT}/variant-${v.index}.txt`,
      `Seed: ${seed}\nv${v.index}\n${v.surface.protagonistName} / ${v.surface.city} / ${v.surface.place}\n\n${v.text}\n`
    )
    say(`模型 ${res.model} ${res.ms}ms 截断=${res.truncated} · ${v.chars} 字（目标 ${beat.targetChars}，硬上限 ${beat.hardMaxChars}）`)
    say(`开篇：${v.text.slice(0, 90)}`)
    if (v.warnings.length) say(`边界提示：${v.warnings.join('；')}`)
    check(`2b v${v.index} 写出了有效正文`, v.chars >= 60, `${v.chars} 字`)
    check(`2c v${v.index} 没有越过硬上限`, v.chars <= beat.hardMaxChars, `${v.chars} / ${beat.hardMaxChars}`)
  }


  /* 人物 / 地点不能串版 */
  for (const v of variants) {
    const others = variants.filter((o) => o.index !== v.index)
    const leaks = others.flatMap((o) =>
      [o.surface.protagonistName, o.surface.antagonistName, o.surface.place]
        .filter(
          (token) =>
            token &&
            token !== v.surface.protagonistName &&
            token !== v.surface.antagonistName &&
            token !== v.surface.place
        )
        .filter((token) => v.text.includes(token))
    )
    check(`3a v${v.index} 没有串用别版的人名/地点`, leaks.length === 0, leaks.join('、') || '干净')
  }

  /* 对白 / 开篇不能重复 */
  const dialogueOf = (text: string) =>
    [...text.matchAll(/[「“"]([^」”"]{6,80})[」”"]/g)]
      .map((m) => m[1].replace(/[\s，。！？、；：,.!?;:…—]/g, ''))
      .filter((x) => x.length >= 6)

  const allDialogue = variants.flatMap((v) => dialogueOf(v.text).map((d) => ({ v: v.index, d })))
  const seen = new Map<string, number>()
  const dup: string[] = []
  for (const item of allDialogue) {
    if (seen.has(item.d)) dup.push(`「${item.d}」v${seen.get(item.d)}/v${item.v}`)
    else seen.set(item.d, item.v)
  }
  check('4a 三版没有重复的场景对白', dup.length === 0, dup.join('；') || `对白 ${allDialogue.length} 句，全部不同`)

  // 第 1 段经常以动作开场、没有引号对白；这时改看有没有整段复用的 12 字片段
  if (allDialogue.length === 0) {
    const grams = variants.map(
      (v) => new Set(Array.from({ length: Math.max(0, v.text.length - 11) }, (_, i) => v.text.slice(i, i + 12)))
    )
    const shared = [...grams[0]].filter((g) => grams.slice(1).some((s) => s.has(g)))
    check('4a2 没有对白时，三版没有共享的 12 字片段', shared.length === 0, shared.slice(0, 3).join(' / ') || '无共享片段')
  }

  const openings = variants.map((v) => v.text.replace(/\s+/g, '').slice(0, 60))
  check('4b 三版开篇不是同一段文字', new Set(openings).size === openings.length)
  say(`\n开篇样本：\n${variants.map((v) => `  v${v.index} ${v.text.slice(0, 50)}…`).join('\n')}`)
} else {
  say('\n（--offline：跳过模型写作，只验骨架 / 表皮确定性）')
}

writeFileSync(`${OUT}/pipeline-smoke.txt`, report.join('\n'))
if (failed) {
  console.error(`\n${failed} 项失败 · 报告 ${OUT}/pipeline-smoke.txt`)
  process.exit(1)
}
console.log(`\n全部通过 · 报告 ${OUT}/pipeline-smoke.txt`)

