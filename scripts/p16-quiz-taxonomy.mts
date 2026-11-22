#!/usr/bin/env node
/**
 * P16 · 测验分类词表统一 + 20 篇原型卷上线（2026-11-22）
 *
 * 三件事，一次做完，全部幂等：
 *   ① `quiz_topics` 收敛成 6 个分类（love → relationships、trivia → mindset 改名，
 *      名字 / 别名 / legacy_name / 排序 / 配色全部对齐 `lib/quizKit.ts` 的 QUIZ_TOPICS）；
 *   ② 每篇卷的 `categories` 改成**统一词表的展示名**（一篇一个分类），
 *      `topic_id` 指到对应分类；
 *   ③ 20 篇已经写完但停在 draft 的原型卷，按「最近 20 天、一天一篇」回填
 *      `published_at` 并上线；只清掉 AI 起草带出来的非法 tag（只在这 20 篇上清）。
 *
 * 为什么分类要一次性对齐：前台页签、结果页配色、相关测验、`/quizzes/topic/<slug>`
 * 全按 `categories[0]` / `topic_id` 走。词表不改，就会出现「后台 6 个分类、
 * 前台 10 个页签、4 个页签点进去是空的」。
 *
 * 用法：
 *   node --import ./scripts/_ts-resolve.mts scripts/p16-quiz-taxonomy.mts           # DRY-RUN
 *   node --import ./scripts/_ts-resolve.mts scripts/p16-quiz-taxonomy.mts --apply   # 真写库
 *
 * 幂等：重跑时第二次应该打印「没有需要变更的地方」。
 */
import { readFileSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { QUIZ_TOPICS, resolveQuizTopic, type QuizTopicKey } from '../lib/quizKit.ts'
import { auditAxeQuiz, normalizeAxeQuiz } from '../lib/quizAxes.ts'

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const i = s.indexOf('=')
    if (i <= 0) continue
    const k = s.slice(0, i).trim()
    if (!process.env[k]) process.env[k] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
}

const APPLY = process.argv.includes('--apply')
const FORCE = process.argv.includes('--force')
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!URL || !KEY) {
  console.error('缺少 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const db = createClient(URL, KEY, { auth: { persistSession: false } })

/* ──────────────────────────── 分类词表 ──────────────────────────── */

const NAME_BY_KEY = new Map<QuizTopicKey, string>(QUIZ_TOPICS.map((t) => [t.key, t.name]))

/**
 * 旧 topic slug → 新 topic key。
 *
 * 只有这两个需要显式改名：`love` 的新词是 `Relationships`；`trivia` 整档并进
 * `Mindset`（内容判断：知识类只剩电影竞猜一篇，已归 Pop Culture）。
 */
const LEGACY_TOPIC_SLUG: Record<string, QuizTopicKey> = {
  love: 'relationships',
  trivia: 'mindset',
}


/* ──────────────────────── 逐篇分类（人工定稿） ──────────────────────── */

const C = (key: QuizTopicKey) => NAME_BY_KEY.get(key) as string

/** 已发布 27 篇：按「这篇到底在讲什么」归到 6 个分类之一。 */
const PUBLISHED_ASSIGNMENTS: Record<string, string> = {
  '2026-cyber-sports-persona-which-level-of-world-cup-fan-are-you': C('pop-culture'),
  'are-you-a-corporate-sheep': C('career'),
  'can-you-guess-the-movie-from-just-one-frame': C('pop-culture'),
  'the-color-of-your-aura': C('mindset'),
  'what-is-your-delusional-money-era': C('personality'),
  'what-is-your-villain-origin-story': C('personality'),
  'what-is-your-actual-2026-cyber-sports-persona': C('pop-culture'),
  'what-is-your-core-internet-aesthetic': C('lifestyle'),
  'what-is-your-doomscrolling-persona': C('pop-culture'),
  'what-is-your-main-character-era-right-now': C('lifestyle'),
  'what-is-your-personal-roman-empire-obsession-test': C('pop-culture'),
  'what-is-your-psychological-shadow-animal': C('mindset'),
  'what-is-your-true-relationship-vibe-magnetic-field-test': C('relationships'),
  'what-is-your-true-spiritual-element': C('mindset'),
  'what-is-your-ultimate-emotional-defense-mechanism': C('mindset'),
  'what-kind-of-digital-nomad-will-you-be-in-2030': C('career'),
  'what-role-do-you-play-in-the-group-chat': C('relationships'),
  'what-type-of-npc-are-you': C('pop-culture'),
  'whats-your-ai-productivity-persona-work-survival-style': C('career'),
  'whats-your-dating-app-persona': C('relationships'),
  'whats-your-toxic-friendship-trait': C('relationships'),
  'whats-your-ultimate-gen-z-vibe-archetype': C('pop-culture'),
  'whats-your-walking-red-flag': C('relationships'),
  'which-cozy-era-aesthetic-are-you-actually-living-in': C('lifestyle'),
  'why-would-you-get-canceled-on-the-internet': C('pop-culture'),
  'your-corporate-survival-persona-gen-z-edition': C('career'),
  'your-silicon-valley-founder-archetype': C('career'),
}

/** 20 篇 AI 起草的原型卷：分类定稿（数组顺序 = 上线排期，从新到旧）。 */
const DRAFT_ASSIGNMENTS: Record<string, string> = {
  'how-do-you-actually-protect-your-energy': C('mindset'),
  'what-is-your-taste-archetype': C('lifestyle'),
  'how-do-you-show-up-when-someone-actually-needs-you': C('relationships'),
  'what-is-your-true-daily-rhythm': C('lifestyle'),
  'what-is-your-secret-online-persona': C('pop-culture'),
  'how-do-you-make-decisions-when-nobody-is-watching': C('mindset'),
  'what-kind-of-plot-twist-are-you-in-real-life': C('personality'),
  'what-kind-of-creative-brain-are-you-running': C('personality'),
  'what-happens-to-your-brain-under-a-tight-deadline': C('mindset'),
  'what-is-your-hidden-superpower-at-work': C('career'),
  'what-actually-makes-you-happy-at-work': C('career'),
  'what-kind-of-work-environment-do-you-actually-thrive-in': C('career'),
  'what-kind-of-side-hustle-builder-are-you': C('career'),
  'how-do-you-actually-master-a-new-skill-fastest': C('career'),
  'how-do-coworkers-actually-read-your-messages': C('career'),
  'who-are-you-really-in-every-work-meeting': C('career'),
  'what-kind-of-leader-would-you-be-in-charge': C('career'),
  'how-do-you-make-big-career-decisions': C('career'),
  'what-is-your-actual-career-plot-twist': C('career'),
  'are-you-ready-for-the-next-big-shift': C('career'),
}

const ASSIGNMENTS: Record<string, string> = { ...PUBLISHED_ASSIGNMENTS, ...DRAFT_ASSIGNMENTS }

/** 上线排期：11-03 → 11-22，一天一篇；时间三档轮转，避免同一时刻刷屏。 */
const PUBLISH_START = Date.UTC(2026, 10, 3)
// 三档都排在「当天已经过去」的时刻，否则 newest 会被前台当成定时稿藏起来。
const PUBLISH_TIMES = ['04:10', '12:20', '18:30']
const PUBLISH_ORDER = Object.keys(DRAFT_ASSIGNMENTS)

/** 前台主推：只留一篇（现在一篇都没有）。 */
const FEATURED_SLUG = 'how-do-you-actually-protect-your-energy'

/**
 * 运营 tag 白名单。只清这 20 篇新上线卷上 AI 带出来的内容词（`Internet Lore`），
 * 已发布卷上的 tag 是人工加的，不动。
 */
const OPERATIONAL_TAGS = new Set(['hot', 'featured', 'hardcore', 'official', 'limited'])

function publishAt(slug: string): string | null {
  const index = PUBLISH_ORDER.indexOf(slug)
  if (index === -1) return null
  // index 0 = 最新（11-22），index 19 = 最早（11-03）
  const day = new Date(PUBLISH_START + (PUBLISH_ORDER.length - 1 - index) * 86_400_000)
  const date = day.toISOString().slice(0, 10)
  return `${date}T${PUBLISH_TIMES[index % PUBLISH_TIMES.length]}:00.000Z`
}

/* ──────────────────────────── 结构 ──────────────────────────── */

type TopicRow = {
  id: string
  slug: string
  name: string
  legacy_name: string | null
  aliases: string[] | null
  color: string | null
  blurb: string | null
  sort_order: number | null
}

type QuizRow = {
  id: string
  title: string
  slug: string | null
  status: string | null
  active: boolean | null
  categories: unknown
  category: string | null
  topic_id: string | null
  published_at: string | null
  is_featured: boolean | null
  tags: unknown
  raw_data: Record<string, unknown> | null
}

function categoryList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  }
  return []
}

function topicKeyOf(row: TopicRow): QuizTopicKey | null {
  if (LEGACY_TOPIC_SLUG[row.slug]) return LEGACY_TOPIC_SLUG[row.slug]
  return (
    resolveQuizTopic(row.slug)?.key ??
    resolveQuizTopic(row.name)?.key ??
    resolveQuizTopic(row.legacy_name)?.key ??
    null
  )
}

async function main() {
  const { data: topicRows, error: topicError } = await db
    .from('quiz_topics')
    .select('id, slug, name, legacy_name, aliases, color, blurb, sort_order')
    .order('sort_order')
  if (topicError) throw new Error(`quiz_topics: ${topicError.message}`)
  const topics = (topicRows || []) as TopicRow[]

  const { data: quizRows, error: quizError } = await db
    .from('quizzes')
    .select(
      'id, title, slug, status, active, categories, category, topic_id, published_at, is_featured, tags, raw_data'
    )
    .order('title')
  if (quizError) throw new Error(`quizzes: ${quizError.message}`)
  const quizzes = (quizRows || []) as QuizRow[]

  console.log(`模式：${APPLY ? 'APPLY（会写库）' : 'DRY-RUN（只打印）'}`)
  console.log(`quiz_topics ${topics.length} 行 · quizzes ${quizzes.length} 篇\n`)

  /* ① 分类行：认领 → 改名 / 改字段 */
  const claimed = new Map<QuizTopicKey, TopicRow>()
  for (const [index, def] of QUIZ_TOPICS.entries()) {
    const used = [...claimed.values()]
    const row =
      topics.find((r) => r.slug === def.slug) ||
      topics.find((r) => LEGACY_TOPIC_SLUG[r.slug] === def.key && !used.includes(r)) ||
      topics.find((r) => !used.includes(r) && topicKeyOf(r) === def.key)
    if (row && !used.includes(row)) claimed.set(def.key, row)
    const picked = claimed.get(def.key)
    console.log(
      `${picked ? '✓' : '+'} ${String(index + 1).padStart(2)}. ${def.name.padEnd(14)} ${
        picked ? `${picked.slug} → ${def.slug}（${picked.name}）` : '新增'
      }`
    )
  }

  const claimedRows = [...claimed.values()]
  const leftovers = topics.filter((row) => !claimedRows.includes(row))
  for (const row of leftovers) console.log(`! 多余分类行 ${row.slug}（${row.name}）—— 并入目标分类后删除`)


  /* ② 每篇卷的目标分类 / topic_id / 排期 / tag */
  const topicIdByName = new Map<string, string>()
  for (const [key, row] of claimed) topicIdByName.set(NAME_BY_KEY.get(key) as string, row.id)
  for (const row of leftovers) {
    const key = topicKeyOf(row)
    const target = key ? claimed.get(key) : null
    if (target) topicIdByName.set(NAME_BY_KEY.get(key as QuizTopicKey) as string, target.id)
  }

  type Plan = {
    row: QuizRow
    categories: string[]
    topicId: string
    publishAt: string | null
    tags: string[] | null
    featured: boolean
  }

  const quizPlan: Plan[] = []
  const skipped: QuizRow[] = []

  for (const row of quizzes) {
    const current = categoryList(row.categories)
    const explicit = row.slug ? ASSIGNMENTS[row.slug] : undefined
    const target = explicit ?? (current.length ? resolveQuizTopic(current[0])?.name : undefined)
    const topicId = target ? topicIdByName.get(target) : undefined

    if (!target || !topicId) {
      skipped.push(row)
      continue
    }

    const tags = categoryList(row.tags)
    const cleanTags = tags.filter((tag) => OPERATIONAL_TAGS.has(tag))
    // 只清这 20 篇新上线卷的 tag（AI 起草带的内容词）；人工维护的卷不碰。
    const cleanTagsForRow =
      row.slug && row.slug in DRAFT_ASSIGNMENTS && cleanTags.length !== tags.length ? cleanTags : null

    quizPlan.push({
      row,
      categories: [target],
      topicId,
      publishAt: row.slug ? publishAt(row.slug) : null,
      tags: cleanTagsForRow,
      featured: row.slug === FEATURED_SLUG,
    })
  }

  const catChanged = (p: Plan) => {
    const current = categoryList(p.row.categories)
    return current.length !== 1 || current[0] !== p.categories[0] || p.row.topic_id !== p.topicId
  }
  const willPublish = (p: Plan) =>
    Boolean(p.publishAt) &&
    (p.row.status !== 'published' ||
      p.row.active !== true ||
      !String(p.row.published_at || '').startsWith(String(p.publishAt).slice(0, 10)))

  const catChanges = quizPlan.filter(catChanged)
  const publishChanges = quizPlan.filter(willPublish)
  const tagChanges = quizPlan.filter((p) => p.tags !== null)
  const featureChanges = quizPlan.filter((p) => p.featured && p.row.is_featured !== true)

  console.log(`\n— 分类变更 ${catChanges.length} 篇 —`)
  for (const p of catChanges) {
    console.log(
      `  ${(categoryList(p.row.categories).join('|') || '(空)').padEnd(30)} → ${p.categories[0].padEnd(14)} ${p.row.slug}`
    )
  }

  console.log(`\n— 上线 ${publishChanges.length} 篇 —`)
  for (const p of [...publishChanges].sort((a, b) => String(b.publishAt).localeCompare(String(a.publishAt)))) {
    console.log(`  ${p.publishAt}  ${p.categories[0].padEnd(14)} ${p.row.slug}`)
  }

  if (tagChanges.length) {
    console.log(`\n— 清 tag ${tagChanges.length} 篇 —`)
    for (const p of tagChanges) {
      console.log(`  ${p.row.slug}: ${categoryList(p.row.tags).join('|')} → ${(p.tags || []).join('|') || '(空)'}`)
    }
  }
  if (featureChanges.length) {
    console.log(`\n— 主推 ${featureChanges.length} 篇 —`)
    for (const p of featureChanges) console.log(`  ${p.row.slug}`)
  }
  if (skipped.length) {
    console.log(`\n— 认不出分类、跳过 ${skipped.length} 篇 —`)
    for (const row of skipped) console.log(`  ${row.slug || '(no-slug)'}  ${row.title}`)
  }


  /* 发布前体检：axes 卷的 blocker 必须清零；缺 color / 缺 quadrant 不拦（前台会兜底） */
  const blockers: string[] = []
  for (const p of publishChanges) {
    const raw = p.row.raw_data
    if (!raw) {
      blockers.push(`${p.row.slug}: 没有 raw_data`)
      continue
    }
    const normalized = normalizeAxeQuiz(raw)
    if (!normalized) continue
    const audit = auditAxeQuiz({ ...normalized.quiz, model: 'axes' })
    for (const b of audit.blockers) blockers.push(`${p.row.slug}: ${b.label}`)
  }
  if (blockers.length) {
    console.log(`\n— 发布 blocker ${blockers.length} 项 —`)
    for (const b of blockers) console.log(`  ✗ ${b}`)
  } else if (publishChanges.length) {
    console.log('\n— 发布体检：0 项 blocker —')
  }

  const total = catChanges.length + publishChanges.length + tagChanges.length + featureChanges.length
  if (total === 0 && leftovers.length === 0) {
    console.log('\n没有需要变更的地方（幂等）。')
    return
  }

  if (blockers.length && !FORCE) {
    console.error(`\n有 ${blockers.length} 项 blocker，未写库。确认无误后可加 --force。`)
    process.exitCode = 1
    return
  }

  if (!APPLY) {
    console.log('\nDRY-RUN 结束，未写库。确认无误后加 --apply。')
    return
  }

  /* 写库：先分类表，再卷 */
  for (const [index, def] of QUIZ_TOPICS.entries()) {
    const payload = {
      slug: def.slug,
      name: def.name,
      legacy_name: def.name,
      aliases: def.aliases,
      color: def.color,
      blurb: def.blurb,
      sort_order: (index + 1) * 10,
      is_active: true,
    }
    const row = claimed.get(def.key)
    if (row) {
      const { error } = await db.from('quiz_topics').update(payload).eq('id', row.id)
      if (error) throw new Error(`update quiz_topics ${def.slug}: ${error.message}`)
      console.log(`✓ 分类更新 ${def.name}`)
    } else {
      const { error } = await db.from('quiz_topics').insert(payload)
      if (error) throw new Error(`insert quiz_topics ${def.slug}: ${error.message}`)
      console.log(`✓ 分类新增 ${def.name}`)
    }
  }

  for (const row of leftovers) {
    const key = topicKeyOf(row)
    const target = key ? claimed.get(key) : null
    if (!target || target.id === row.id) continue
    const { error: repointError } = await db.from('quizzes').update({ topic_id: target.id }).eq('topic_id', row.id)
    if (repointError) throw new Error(`repoint ${row.slug}: ${repointError.message}`)
    const { error: deleteError } = await db.from('quiz_topics').delete().eq('id', row.id)
    if (deleteError) throw new Error(`delete quiz_topics ${row.slug}: ${deleteError.message}`)
    console.log(`✓ 分类并入 ${row.slug} → ${target.slug} 并删除旧行`)
  }

  let written = 0
  for (const p of quizPlan) {
    const payload: Record<string, unknown> = {}
    const current = categoryList(p.row.categories)
    if (current.length !== 1 || current[0] !== p.categories[0]) {
      payload.categories = p.categories
      payload.category = p.categories[0]
    }
    if (p.row.topic_id !== p.topicId) payload.topic_id = p.topicId
    if (p.tags !== null) payload.tags = p.tags
    if (p.featured && p.row.is_featured !== true) payload.is_featured = true
    if (p.publishAt && willPublish(p)) {
      payload.status = 'published'
      payload.active = true
      payload.published_at = p.publishAt
    }
    if (Object.keys(payload).length === 0) continue

    const { error } = await db.from('quizzes').update(payload).eq('id', p.row.id)
    if (error) {
      console.error(`✗ ${p.row.slug}: ${error.message}`)
      process.exitCode = 1
      continue
    }
    written += 1
  }
  console.log(`\n✓ 写完 ${written} 篇`)

  /* 收尾校验：分类只剩 6 个词、topic_id 全部有值 */
  const { data: after } = await db.from('quizzes').select('slug, categories, topic_id')
  const names = new Set(QUIZ_TOPICS.map((t) => t.name))
  const bad = (after || []).filter((row: any) => {
    const list = categoryList(row.categories)
    return list.length !== 1 || !names.has(list[0]) || !row.topic_id
  })
  if (bad.length) {
    console.error(`\n⚠️ 还有 ${bad.length} 篇分类不合规：`)
    for (const row of bad as any[]) {
      console.error(`  ${row.slug}: ${JSON.stringify(row.categories)} topic=${row.topic_id ? 'y' : 'n'}`)
    }
    process.exitCode = 1
  } else {
    console.log('✓ 校验通过：全部分类都在 6 个词表内，topic_id 均已挂上')
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
