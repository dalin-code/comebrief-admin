#!/usr/bin/env node
/**
 * P15 · 把 articles 里 `draft-xxxx` 的 slug 换成关键词 slug
 *
 * 背景：11 篇故事入库时 slug 是 `draft-0520` 这种占位值（当时还没有英文标题）。
 * 它们**已经进了 sitemap**（sitemap 用的就是 articles.slug），等于在告诉 Google
 * 「这篇讲的是 draft-0520」。URL 是搜索结果里唯一的「可读关键词位」，白白浪费。
 *
 * 为什么必须配 301：旧地址可能已经被抓过/被分享过。直接改库 = 旧地址立刻 404，
 * 权重和已有排名一起丢。所以顺序是「改库 → next.config.js 补 301」，不能反。
 *
 * 用法：
 *   node --import ./scripts/_ts-resolve.mts scripts/p15-draft-slug-fix.mts            # 只看计划
 *   node --import ./scripts/_ts-resolve.mts scripts/p15-draft-slug-fix.mts --apply    # 真写库
 *
 * 幂等：已经是好 slug 的行不会被碰；重跑只处理仍然 `draft-` 开头的行。
 */
import { readFileSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { slugify } from '../lib/storyPrompt.ts'

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
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!URL || !KEY) {
  console.error('缺少 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const db = createClient(URL, KEY, { auth: { persistSession: false } })

async function main() {
  const { data, error } = await db.from('articles').select('id, slug, title, status')
  if (error) throw new Error(error.message)

  const rows = data || []
  const taken = new Set(rows.map((r) => String(r.slug || '')))
  const targets = rows.filter((r) => String(r.slug || '').startsWith('draft-'))

  if (targets.length === 0) {
    console.log('没有 draft-* slug，无需处理（幂等）。')
    return
  }

  console.log(`模式：${APPLY ? 'APPLY（会写库）' : 'DRY-RUN（只打印）'}`)
  console.log(`发现 ${targets.length} 条 draft-* slug\n`)

  const plan: { id: string; from: string; to: string; title: string; conflict?: string }[] = []

  for (const row of targets) {
    const from = String(row.slug || '')
    const title = String(row.title || '')
    const to = slugify(title)

    let conflict: string | undefined
    if (!to) conflict = '标题无法生成 slug（空了）'
    else if (to === from) conflict = '生成结果与原值相同'
    else if (taken.has(to) && to !== from) conflict = '新 slug 已被别的文章占用'

    // 同一批里两条标题撞车，也得拦下来
    if (!conflict && plan.some((p) => p.to === to)) conflict = '与本次计划中的另一条重复'

    if (to) taken.add(to)
    plan.push({ id: row.id, from, to, title, conflict })
  }

  const bad = plan.filter((p) => p.conflict)
  for (const p of plan) {
    const mark = p.conflict ? '❌' : '✅'
    console.log(`${mark} ${p.from.padEnd(14)} → ${(p.to || '(空)').padEnd(46)} ${p.title.slice(0, 42)}`)
    if (p.conflict) console.log(`      ⚠️  ${p.conflict}`)
  }

  console.log('\n— 需要在 next.config.js 里补的 301（旧地址 → 新地址）—')
  for (const p of plan) {
    if (p.conflict) continue
    console.log(`      { source: "/briefs/${p.from}", destination: "/briefs/${p.to}", permanent: true },`)
  }

  if (bad.length > 0) {
    console.error(`\n有 ${bad.length} 条需要人工处理，全部未写入。`)
    process.exitCode = 1
    return
  }

  if (!APPLY) {
    console.log('\nDRY-RUN 结束，未写库。确认无误后加 --apply。')
    return
  }

  let done = 0
  for (const p of plan) {
    const { error: updateError } = await db.from('articles').update({ slug: p.to }).eq('id', p.id)
    if (updateError) {
      console.error(`❌ 写入失败 ${p.from}: ${updateError.message}`)
      process.exitCode = 1
      continue
    }
    done += 1
    console.log(`✅ 已更新 ${p.from} → ${p.to}`)
  }

  console.log(`\n完成 ${done}/${plan.length} 条。`)
  console.log('⚠️ 下一步别忘：把上面那 11 条 301 写进 next.config.js 并重新部署，')
  console.log('   否则旧地址（可能已被收录）会直接 404。')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
