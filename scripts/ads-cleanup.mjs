/**
 * 阶段一 · 线上广告数据止损（先备份，再合并重复行、收敛到 4 个主力坑位）
 *
 *   node scripts/ads-cleanup.mjs            # 演练：只打印「将要做什么」，不写库
 *   node scripts/ads-cleanup.mjs --apply    # 真写：先备份到 scripts/backups/，再改
 *
 * 做四件事：
 *   ① 把老坑位改名成新 id（HOME_HEADER→HOME_MID、SIDEBAR_TOP→SIDEBAR_PROMO、
 *      DETAIL_CONTENT_MID→DETAIL_BOTTOM、QUIZ_INLINE→QUIZ_FOOTER）；
 *   ② 同一坑位多行 → 合并成一行（有素材的当 keeper，其余行里 keeper 缺的字段补过去）；
 *   ③ 空行 / 没有可用素材的非主力坑位 → 删除（备份里都留着）；
 *   ④ 收尾校验：每个 position 只剩 1 行、空素材行 active=false。
 *
 * 为什么是脚本而不是纯 SQL：线上没有直连 Postgres 的凭据（只有 service role），
 * DDL 走不了，但 PostgREST 能做这些小表的数据整理。唯一索引部分见
 * ComeBrief/supabase/51_ads_slots.sql。
 */
import fs from 'fs'
import path from 'path'
import { createClient } from '@supabase/supabase-js'

const APPLY = process.argv.includes('--apply')

const LEGACY_MAP = {
  HOME_HEADER: 'HOME_MID',
  DETAIL_CONTENT_MID: 'DETAIL_BOTTOM',
  QUIZ_INLINE: 'QUIZ_FOOTER',
  SIDEBAR_TOP: 'SIDEBAR_PROMO',
}
const CANONICAL = ['HOME_MID', 'DETAIL_BOTTOM', 'QUIZ_FOOTER', 'SIDEBAR_PROMO']
const TEXT_FIELDS = ['ad_code', 'mobile_ad_code', 'image_url', 'mobile_image_url', 'dark_image_url', 'link']

function loadEnv() {
  const file = path.join(process.cwd(), '.env.local')
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const env = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    env[m[1]] = v
  }
  return env
}

const env = loadEnv()
const url = env.NEXT_PUBLIC_SUPABASE_URL
const key = env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}
const role = JSON.parse(Buffer.from(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).role
if (role !== 'service_role') {
  console.error(`SUPABASE_SERVICE_ROLE_KEY role is ${role}, expected service_role`)
  process.exit(1)
}

const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

const nonEmpty = (v) => {
  const s = String(v ?? '').trim()
  return Boolean(s) && s !== 'null' && s !== 'undefined'
}
const hasCreative = (row) => {
  if (!row) return false
  if (nonEmpty(row.ad_code) || nonEmpty(row.mobile_ad_code)) return true
  const img = nonEmpty(row.image_url) || nonEmpty(row.mobile_image_url) || nonEmpty(row.dark_image_url)
  return img && nonEmpty(row.link)
}
const declaredWidth = (code) => {
  const m = String(code || '').match(/width\s*=\s*["']?(\d{2,4})/i)
  return m ? Number(m[1]) : null
}
const score = (row) =>
  (nonEmpty(row.ad_code) ? 4 : 0) +
  (nonEmpty(row.mobile_ad_code) ? 2 : 0) +
  (nonEmpty(row.image_url) ? 2 : 0) +
  (nonEmpty(row.link) ? 1 : 0) +
  (row.active ? 1 : 0)

async function fetchAll() {
  const { data, error } = await supabase.from('ads').select('*').order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return data || []
}

function mergeGroup(target, rows) {
  const sorted = rows.slice().sort((a, b) => score(b) - score(a))
  const keeper = sorted[0]
  const others = sorted.slice(1)
  const patch = {}

  for (const field of TEXT_FIELDS) {
    if (nonEmpty(keeper[field])) continue
    const donor = others.find((r) => nonEmpty(r[field]))
    if (donor) patch[field] = donor[field]
  }

  // 移动端代码尺寸收敛：600×480 会撑破 320 的视口，遇到 <=400 的版本就换掉
  const mobileCandidates = [keeper, ...others].filter((r) => nonEmpty(r.mobile_ad_code))
  const narrow = mobileCandidates.find((r) => {
    const w = declaredWidth(r.mobile_ad_code)
    return w !== null && w <= 400
  })
  const keeperMobileWidth = declaredWidth(keeper.mobile_ad_code)
  if (narrow && (keeperMobileWidth === null || keeperMobileWidth > 400)) {
    patch.mobile_ad_code = narrow.mobile_ad_code
  }

  const creative = { ...keeper, ...patch }
  const active = rows.some((r) => r.active) && hasCreative(creative)
  return { keeper, extras: others, patch, active, target }
}

function fmtRow(r) {
  const code = nonEmpty(r.ad_code) ? 'Y' : '-'
  const mob = nonEmpty(r.mobile_ad_code) ? 'M' : '-'
  const img = nonEmpty(r.image_url) ? 'Y' : '-'
  const link = nonEmpty(r.link) ? 'Y' : '-'
  return `[${r.id.slice(0, 8)}] ${String(r.position).padEnd(20)} active=${String(r.active).padEnd(5)} code=${code}${mob} img=${img} link=${link}`
}


async function main() {
  const before = await fetchAll()
  console.log(`\n=== ads 共 ${before.length} 行 ===`)
  before.forEach((r) => console.log('  ' + fmtRow(r)))

  const groups = new Map()
  const orphans = []
  for (const row of before) {
    const target = LEGACY_MAP[row.position] || (CANONICAL.includes(row.position) ? row.position : null)
    if (!target) {
      orphans.push(row)
      continue
    }
    if (!groups.has(target)) groups.set(target, [])
    groups.get(target).push(row)
  }

  const actions = []
  for (const target of CANONICAL) {
    const rows = groups.get(target)
    if (!rows || !rows.length) {
      actions.push({ kind: 'missing', target })
      continue
    }
    actions.push({ kind: 'merge', ...mergeGroup(target, rows) })
  }

  for (const row of orphans) {
    actions.push({ kind: hasCreative(row) ? 'orphan-keep' : 'orphan-delete', target: row.position, row })
  }

  console.log('\n=== 计划 ===')
  for (const a of actions) {
    if (a.kind === 'missing') {
      console.log(`  · ${a.target}: 数据库没有这一行（后台保存时会自动创建）`)
    } else if (a.kind === 'merge') {
      const rename = a.keeper.position !== a.target ? ` (${a.keeper.position} → ${a.target})` : ''
      console.log(`  · ${a.target}: keeper ${a.keeper.id.slice(0, 8)}${rename}, 删除 ${a.extras.length} 行`)
      for (const k of Object.keys(a.patch)) console.log(`      + ${k} 取自其它行`)
      console.log(`      active → ${a.active}`)
    } else if (a.kind === 'orphan-delete') {
      console.log(`  · 删除非主力坑位空行 ${a.target} [${a.row.id.slice(0, 8)}]`)
    } else {
      console.log(`  · 保留非主力坑位 ${a.target} [${a.row.id.slice(0, 8)}] 并置 active=false（有素材，不删数据）`)
    }
  }

  if (!APPLY) {
    console.log('\n[dry-run] 没有写库。加 --apply 执行。\n')
    return
  }

  const backupDir = path.join(process.cwd(), 'scripts', 'backups')
  fs.mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupFile = path.join(backupDir, `ads-${stamp}.json`)
  fs.writeFileSync(backupFile, JSON.stringify(before, null, 2))
  console.log(`\n已备份 ${before.length} 行 → ${path.relative(process.cwd(), backupFile)}`)

  const now = new Date().toISOString()
  let failed = 0

  for (const a of actions) {
    if (a.kind === 'missing') continue

    if (a.kind === 'merge') {
      const patch = { ...a.patch, position: a.target, active: a.active, updated_at: now }
      const upd = await supabase.from('ads').update(patch).eq('id', a.keeper.id)
      if (upd.error) {
        console.error(`  ✗ ${a.target} 更新失败: ${upd.error.message}`)
        failed++
        continue
      }
      if (a.extras.length) {
        const del = await supabase.from('ads').delete().in('id', a.extras.map((r) => r.id))
        if (del.error) {
          console.error(`  ✗ ${a.target} 删除重复行失败: ${del.error.message}`)
          failed++
          continue
        }
      }
      console.log(`  ✓ ${a.target} 已合并（删除 ${a.extras.length} 行）`)
      continue
    }

    if (a.kind === 'orphan-delete') {
      const del = await supabase.from('ads').delete().eq('id', a.row.id)
      if (del.error) {
        console.error(`  ✗ 删除 ${a.target} 失败: ${del.error.message}`)
        failed++
      } else console.log(`  ✓ 已删除空行 ${a.target}`)
      continue
    }

    if (a.kind === 'orphan-keep') {
      const upd = await supabase.from('ads').update({ active: false, updated_at: now }).eq('id', a.row.id)
      if (upd.error) {
        console.error(`  ✗ ${a.target} 置为关闭失败: ${upd.error.message}`)
        failed++
      } else console.log(`  ✓ ${a.target} 已置为 active=false`)
    }
  }

  const after = await fetchAll()
  console.log('\n=== 结果 ===')
  after.forEach((r) => console.log('  ' + fmtRow(r)))

  const counts = new Map()
  for (const r of after) counts.set(r.position, (counts.get(r.position) || 0) + 1)
  const dup = [...counts.entries()].filter(([, n]) => n > 1)
  const emptyActive = after.filter((r) => r.active && !hasCreative(r))
  if (dup.length) console.log(`\n⚠ 仍有重复坑位：${dup.map(([p, n]) => `${p}×${n}`).join(', ')}`)
  if (emptyActive.length) console.log(`⚠ 仍有 ${emptyActive.length} 条 active=true 但无素材的行`)
  if (!dup.length && !emptyActive.length) console.log('\n✓ 每个坑位唯一，且没有「开启但无素材」的行')
  if (failed) console.log(`⚠ ${failed} 项操作失败（备份可回滚）`)
  console.log('')
}

main().catch((e) => {
  console.error('cleanup failed:', e)
  process.exit(1)
})
