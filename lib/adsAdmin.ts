import type { AdSlotId } from './adsSlots'

/**
 * 后台广告写入的公共逻辑（只在服务端用，别在客户端 import）。
 *
 * 三件事：
 *   ① 入参白名单化 —— 只收 ads 表真实存在的字段，`javascript:` / 内联事件先挡掉；
 *   ② 一个坑位只留一行 —— 没有唯一索引时也能自愈（选了多行就合并、删多余）；
 *   ③ 「没素材不许开启」—— 空行 active=true 正是首页头部变空白的元凶。
 */

export interface AdPatch {
  title?: string | null
  ad_code?: string | null
  mobile_ad_code?: string | null
  image_url?: string | null
  mobile_image_url?: string | null
  dark_image_url?: string | null
  link?: string | null
  active?: boolean
  weight?: number
  start_at?: string | null
  end_at?: string | null
  categories?: string[] | null
}

export const AD_NULLABLE_TEXT_FIELDS = [
  'ad_code',
  'mobile_ad_code',
  'image_url',
  'mobile_image_url',
  'dark_image_url',
  'link',
] as const

const MAX_CODE_LENGTH = 20000

function cleanText(value: unknown, max = MAX_CODE_LENGTH): string | null {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  if (!s || s === 'null' || s === 'undefined') return null
  return s.slice(0, max)
}

/** `javascript:` / `data:text/html` 这类能直接执行脚本的协议，一律不接受。 */
function isDangerousUrl(value: string): boolean {
  const compact = value.replace(/[\s\u0000-\u001f]/g, '').toLowerCase()
  return /^(javascript|vbscript|data:text\/html)/.test(compact)
}

export interface SanitizeResult {
  patch: AdPatch
  warnings: string[]
}

/**
 * 把前端传来的对象收窄成可写字段。
 *
 * 注意：这里**不删除** `<script>`（AdSense / Ad Manager 的代码本来就要 script），
 * 真正的执行面控制在渲染侧 `ComeBrief/lib/adSanitize.ts`：默认剥掉 script，
 * 想放行得显式配 `NEXT_PUBLIC_ADS_ALLOW_SCRIPTS=1`。写接口只挡「明显不该进库」的东西。
 */
export function sanitizeAdPatch(input: unknown): SanitizeResult {
  const warnings: string[] = []
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, any>
  const patch: AdPatch = {}

  for (const field of AD_NULLABLE_TEXT_FIELDS) {
    if (!(field in src)) continue
    let value = cleanText(src[field], field === 'link' ? 2000 : MAX_CODE_LENGTH)

    if (value && field === 'link') {
      if (isDangerousUrl(value)) {
        warnings.push('链接使用了 javascript:/data: 协议，已忽略')
        value = null
      } else if (!/^(https?:\/\/|\/)/i.test(value)) {
        warnings.push('链接必须是 http(s):// 或站内 / 开头，已忽略')
        value = null
      }
    }

    if (value && (field === 'ad_code' || field === 'mobile_ad_code')) {
      // 内联事件处理器在 <a onmouseover=...> 这类素材里没有正当用途，直接剥掉；
      // 剩下的结构留给渲染侧 sanitizer 再过一遍。
      if (/\son[a-z]+\s*=/i.test(value)) {
        warnings.push('广告代码里的内联事件（on*）已被移除')
        value = value.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      }
      if (/<script[^>]+src\s*=\s*["']?\s*javascript:/i.test(value)) {
        warnings.push('广告代码里出现 javascript: 形式的 script src，已清空该字段')
        value = null
      }
    }

    ;(patch as any)[field] = value
  }

  if ('title' in src) patch.title = cleanText(src.title, 200)
  if ('active' in src) patch.active = Boolean(src.active)

  if ('weight' in src) {
    const n = Number(src.weight)
    patch.weight = Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : 1
  }

  for (const field of ['start_at', 'end_at'] as const) {
    if (!(field in src)) continue
    const raw = cleanText(src[field], 64)
    if (!raw) {
      patch[field] = null
      continue
    }
    const t = Date.parse(raw)
    if (Number.isNaN(t)) {
      warnings.push(`${field} 不是合法时间，已忽略`)
      continue
    }
    patch[field] = new Date(t).toISOString()
  }

  if ('categories' in src) {
    const raw = src.categories
    const list = Array.isArray(raw)
      ? raw
      : String(raw ?? '')
          .split(',')
          .map((s) => s.trim())
    const cleaned = Array.from(
      new Set(
        list
          .map((s) => String(s || '').trim())
          .filter(Boolean)
          .map((s) => s.slice(0, 60))
      )
    )
    patch.categories = cleaned.length ? cleaned : null
  }

  return { patch, warnings }
}

/** 这个坑位此刻有没有可展示的素材（与前台 `hasCreative` 的判定保持一致）。 */
export function hasCreative(row: Partial<Record<string, any>> | null | undefined): boolean {
  if (!row) return false
  const nonEmpty = (v: unknown) => {
    const s = String(v ?? '').trim()
    return Boolean(s) && s !== 'null' && s !== 'undefined'
  }
  if (nonEmpty(row.ad_code) || nonEmpty(row.mobile_ad_code)) return true
  const hasImage =
    nonEmpty(row.image_url) || nonEmpty(row.mobile_image_url) || nonEmpty(row.dark_image_url)
  return hasImage && nonEmpty(row.link)
}


export interface UpsertResult {
  ok: boolean
  row?: any
  error?: string
  /** 顺手清掉的重复行数 */
  removed?: number
  warnings: string[]
}

/**
 * 按坑位写入（等价于 upsert position）。
 *
 * 为什么不用 `.upsert({ position }, { onConflict: 'position' })`：
 * 线上 `ads` 表可能还没跑 `51_ads_slots.sql`（唯一索引不存在），
 * PostgREST 会直接报 `there is no unique or exclusion constraint matching the ON CONFLICT specification`。
 * 所以这里走「查 → 更新 keeper → 删多余 → 没有就插入」的确定性路径，
 * 不管有没有唯一索引都能把「一个坑位一行」落实。
 */
export async function upsertAdSlot(
  client: any,
  slot: AdSlotId,
  patch: AdPatch,
  opts?: { note?: (msg: string) => void }
): Promise<UpsertResult> {
  const warnings: string[] = []
  const note = opts?.note || (() => {})

  const { data: rows, error } = await client
    .from('ads')
    .select('*')
    .eq('position', slot)
    .order('created_at', { ascending: true })

  if (error) return { ok: false, error: error.message, warnings }

  const list = (rows || []) as any[]
  // keeper：有素材优先；其次 active；再其次最早创建（历史最久、后台一直在维护的那行）
  const keeper =
    list.slice().sort((a, b) => {
      const score = (r: any) =>
        (hasCreative(r) ? 4 : 0) + (r.active ? 2 : 0) + (String(r.ad_code || '').trim() ? 1 : 0)
      const diff = score(b) - score(a)
      if (diff !== 0) return diff
      return String(a.created_at || '').localeCompare(String(b.created_at || ''))
    })[0] || null

  // 「开启」但最终没有任何素材 → 强制关闭，并把原因带回后台
  const willBeActive = patch.active === undefined ? Boolean(keeper?.active) : patch.active
  if (willBeActive) {
    const merged = { ...(keeper || {}), ...patch }
    if (!hasCreative(merged)) {
      patch = { ...patch, active: false }
      warnings.push('该坑位没有任何素材（代码或图片+链接），已自动保持关闭')
    }
  }

  const payload: any = { ...patch, position: slot, updated_at: new Date().toISOString() }
  let saved: any = null

  if (keeper?.id) {
    const res = await client.from('ads').update(payload).eq('id', keeper.id).select('*').maybeSingle()
    if (res.error) return { ok: false, error: res.error.message, warnings }
    saved = res.data
  } else {
    const res = await client
      .from('ads')
      .insert([{ title: slot, active: false, ...payload }])
      .select('*')
      .maybeSingle()
    if (res.error) return { ok: false, error: res.error.message, warnings }
    saved = res.data
  }

  // 清掉同一坑位的其它历史行（先合并它们独有的素材，避免「删了就等于丢」）
  const extras = list.filter((r) => r.id !== keeper?.id)
  if (extras.length) {
    const merged: any = {}
    for (const field of AD_NULLABLE_TEXT_FIELDS) {
      if (String(saved?.[field] ?? '').trim()) continue
      const donor = extras.find((r) => String(r[field] ?? '').trim())
      if (donor) merged[field] = donor[field]
    }
    if (Object.keys(merged).length) {
      const res = await client.from('ads').update(merged).eq('id', saved.id).select('*').maybeSingle()
      if (!res.error && res.data) saved = res.data
      else warnings.push('合并重复行时部分字段写入失败：' + (res.error?.message || 'unknown'))
    }

    const del = await client
      .from('ads')
      .delete()
      .in(
        'id',
        extras.map((r) => r.id)
      )
      .select('id')
    if (del.error) warnings.push('重复行清理失败（不影响保存）：' + del.error.message)
    else note(`已清理 ${del.data?.length || 0} 条重复记录`)
  }

  return { ok: true, row: saved, removed: extras.length, warnings }
}
