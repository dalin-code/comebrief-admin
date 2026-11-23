/**
 * 只读巡检：把线上 `ads` 表整表打印出来（ad_code 截断），
 * 供「阶段一 · 止损」在动手前确认每一行的真实状态。
 *
 *   node scripts/ads-audit.mjs
 *
 * 不会写库。要清理/合并请用 scripts/ads-cleanup.mjs（带 --apply）。
 */
import fs from 'fs'
import path from 'path'
import { createClient } from '@supabase/supabase-js'

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
const clip = (v, n = 160) => {
  const s = String(v ?? '')
  if (!s) return ''
  return s.length > n ? `${s.slice(0, n)}…(${s.length})` : s
}

const { data, error } = await supabase.from('ads').select('*').order('position', { ascending: true })
if (error) {
  console.error('select ads failed:', error.message, error.code || '')
  process.exit(1)
}

console.log(`ads rows: ${data.length}\n`)
for (const row of data) {
  console.log(
    JSON.stringify(
      {
        id: row.id,
        position: row.position,
        active: row.active,
        title: row.title,
        image_url: clip(row.image_url, 80),
        mobile_image_url: clip(row.mobile_image_url, 80),
        link: clip(row.link, 80),
        ad_code: clip(row.ad_code),
        mobile_ad_code: clip(row.mobile_ad_code),
        weight: row.weight,
        start_at: row.start_at,
        end_at: row.end_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
        other: Object.keys(row).filter(
          (k) =>
            ![
              'id',
              'position',
              'active',
              'title',
              'image_url',
              'mobile_image_url',
              'dark_image_url',
              'link',
              'ad_code',
              'mobile_ad_code',
              'weight',
              'start_at',
              'end_at',
              'created_at',
              'updated_at',
            ].includes(k)
        ),
      },
      null,
      0
    )
  )
}

const { count: clickCount, error: clickErr } = await supabase
  .from('ad_click_events')
  .select('*', { count: 'exact', head: true })
console.log(`\nad_click_events rows: ${clickErr ? `(${clickErr.message})` : clickCount}`)
