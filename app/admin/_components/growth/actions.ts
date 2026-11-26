'use client'

import { getFreshAccessToken } from '@/lib/clientAuth'
import { GROWTH_DEFAULTS_FALLBACK, normalizeGrowthDefaults, type GrowthDefaults } from '@/lib/growth'
import { supabase } from '@/lib/supabase'

/**
 * SEO / GEO 控制台的三个网络动作。
 *
 * 抽成一个文件而不是散在页面里，是因为两个页面（`/growth/topics` 与
 * `/growth/defaults`）都要用同一套「先取票、再敲路由、把服务端的话原样
 * 转成人话」的逻辑 —— 复制两遍必然有一遍忘了处理 503（鉴权服务抖动）。
 */

/** 后端 503 = admin 路由连不上 Supabase Auth；重试即可，不该赶人去重登。 */
function describeStatus(status: number): string {
  if (status === 401) return '登录已过期，请刷新页面重新登录'
  if (status === 503) return '服务端暂时连不上鉴权服务，稍后重试即可'
  return `请求失败（HTTP ${status}）`
}

/**
 * 读 `seo_global_defaults.social_utm`。
 *
 * 三种「读不到」都不该让页面白屏：表还没建（SQL 52 没跑）、行还没插、字段
 * 是半截 —— 一律回落到 `GROWTH_DEFAULTS_FALLBACK`，同时把 `ready: false`
 * 交给调用方去提示「先去跑 SQL」，而不是假装读到了。
 */
export async function loadGrowthDefaults(): Promise<{ defaults: GrowthDefaults; ready: boolean; error: string }> {
  const { data, error } = await supabase
    .from('seo_global_defaults')
    .select('value')
    .eq('key', 'social_utm')
    .maybeSingle()

  if (error) {
    return { defaults: GROWTH_DEFAULTS_FALLBACK, ready: false, error: error.message }
  }
  if (!data) {
    return { defaults: GROWTH_DEFAULTS_FALLBACK, ready: false, error: '' }
  }
  return { defaults: normalizeGrowthDefaults((data as any).value), ready: true, error: '' }
}

/** 保存 `social_utm`（整块覆盖；调用方传的一定是 `normalizeGrowthDefaults()` 的完整形状）。 */
export async function saveGrowthDefaults(defaults: GrowthDefaults): Promise<{ ok: boolean; error: string }> {
  const { error } = await supabase
    .from('seo_global_defaults')
    .upsert({ key: 'social_utm', value: defaults }, { onConflict: 'key' })
  return { ok: !error, error: error?.message || '' }
}

/**
 * 让前台立刻重建缓存。
 *
 * 返回 200 不代表「一定刷新了」：`skipped: true` 表示前台的
 * `REVALIDATE_SECRET` / `FRONTEND_URL` 没配齐，退回 ≤60s 的 ISR。
 * 保存本身已经成功，所以这里永远不 throw —— 只把话说清楚。
 */
export async function notifyRevalidate(): Promise<{ ok: boolean; message: string }> {
  try {
    const token = await getFreshAccessToken()
    if (!token) return { ok: false, message: '登录已过期，缓存没能刷新（保存已生效，最迟 60 秒后可见）' }
    const res = await fetch('/api/admin/revalidate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, message: data?.error || describeStatus(res.status) }
    return { ok: data?.ok === true, message: String(data?.message || '') }
  } catch (e: any) {
    return { ok: false, message: String(e?.message || e) }
  }
}

/**
 * 只推这一页（IndexNow）。
 *
 * 走 `?url=` 单条模式：服务端会先做同域校验，`dry=1` 只回显要推的地址。
 * 返回 `ok:false` 时 `message` 是给站长看的原话（403 = key 文件取不到、
 * 422 = 地址不属于这个 host），不要自己改写成「推送失败」。
 */
export async function pushSinglePage(
  path: string,
  options: { dry?: boolean } = {}
): Promise<{ ok: boolean; message: string }> {
  try {
    const token = await getFreshAccessToken()
    if (!token) return { ok: false, message: '登录已过期，请刷新页面重新登录' }
    const params = new URLSearchParams({ url: path })
    if (options.dry) params.set('dry', '1')
    const res = await fetch(`/api/admin/index-push?${params.toString()}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, message: data?.error || describeStatus(res.status) }

    if (data?.dry === true) {
      const sample = Array.isArray(data?.sample) ? data.sample[0] : ''
      return { ok: true, message: `演练：将推送 ${sample || path}` }
    }
    const submitted = Number(data?.indexnow?.submitted ?? 0)
    if (data?.ok === true && data?.indexnow?.ok === true) {
      return { ok: true, message: `已把这一页报给 Bing / Yandex（${submitted} 条）` }
    }
    const reason = data?.indexnow?.error || data?.error || (data?.indexnow?.status ? `HTTP ${data.indexnow.status}` : '未知原因')
    return { ok: false, message: `推送被拒：${reason}` }
  } catch (e: any) {
    return { ok: false, message: String(e?.message || e) }
  }
}

/**
 * PostgREST 的「这一列不存在」→ 列名。
 *
 * 为什么后台每个保存路径都要自己处理一遍：代码先部署、SQL 52 后执行时，
 * 带着 `intro_summary` 去 upsert 会整条失败。剔掉那一列重试，至少能把
 * 其它字段存下去，而不是让站长对着「保存失败」发呆。
 */
export function missingColumnFromError(message: unknown): string {
  const text = String(message ?? '')
  if (!/PGRST204|schema cache|could not find the .* column|column .* does not exist/i.test(text)) return ''
  const patterns = [
    /Could not find the '([^']+)' column/i,
    /column\s+(?:public\.)?\w+\.?([a-zA-Z0-9_]+)\s+does\s+not\s+exist/i,
    /'([a-zA-Z0-9_]+)'\s+column/i,
  ]
  for (const re of patterns) {
    const match = text.match(re)
    const name = String(match?.[1] || '').trim()
    if (name) return name
  }
  return ''
}
