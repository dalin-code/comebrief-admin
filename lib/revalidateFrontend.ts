import { fetchWithTimeout, isAbortError } from '@/lib/aiGemini'

/**
 * 敲一下前台的门，让它把那几页 ISR 缓存立刻重建。
 *
 * 背景（2026-10-16）：站长的原话是「后台改了话题，网站上面没有同步显示」。
 * 前台 `/`、`/briefs`、`/briefs/[slug]` 都是 `revalidate = 60` 的 ISR，改完
 * 最多要等一分钟；站长点完保存就去刷新页面，看到的还是旧版。这条通知把等待
 * 从「最多一分钟」缩到「一两百毫秒」。
 *
 * 配置（两个都要）：
 *   · `FRONTEND_REVALIDATE_URL` —— 前台刷新接口的完整地址，
 *     例如 `https://www.comebrief.com/api/revalidate`；
 *     没配时退而认 `NEXT_PUBLIC_SITE_URL`（后台本来就用它当前台地址）+ `/api/revalidate`。
 *   · `REVALIDATE_SECRET` —— 与前台项目同名的那个值（前台 /api/revalidate 校验它）。
 *
 * 三条硬约束：
 *   ① **永不抛错**：这是「锦上添花」的通知，不能因为它把站长的保存动作带崩
 *      （保存本身已经成功了）。所有失败都吞掉、只留日志。
 *   ② **有超时**：5 秒。前台函数冷启动再慢也不该让后台请求挂着。
 *   ③ **没配就跳过**：缺变量时返回 `skipped: true` 并点名缺哪一个 ——
 *      此时行为与以前完全一样（前台最多一分钟后自己刷新），不是报错。
 */
const TIMEOUT_MS = 5000

/** 刷新目标只认这三页（与前台 app/api/revalidate/route.ts 里的白名单一致）。 */
export const FRONTEND_PATHS = ['/', '/briefs', '/briefs/[slug]'] as const

export type RevalidateOutcome = {
  ok: boolean
  /** true = 没配置，什么都没发（不是失败） */
  skipped: boolean
  /** 实际敲的地址，便于日志里一眼看出打到哪儿去了 */
  url?: string
  status?: number
  error?: string
  /** 前台回了哪几页被刷新 */
  revalidated?: string[]
}

function resolveTarget(): { url: string; secret: string; missing: string[] } {
  const secret = (process.env.REVALIDATE_SECRET || '').trim()

  const explicit = (process.env.FRONTEND_REVALIDATE_URL || '').trim()
  const site = (process.env.NEXT_PUBLIC_SITE_URL || '').trim()
  const fromSite = /^https?:\/\//i.test(site)
    ? `${site.replace(/\/+$/, '')}/api/revalidate`
    : ''

  const url = explicit || fromSite
  const missing: string[] = []
  if (!url) missing.push('FRONTEND_REVALIDATE_URL（或 NEXT_PUBLIC_SITE_URL）')
  if (!secret) missing.push('REVALIDATE_SECRET')

  return { url, secret, missing }
}

export async function notifyFrontendRevalidate(reason: string): Promise<RevalidateOutcome> {
  const { url, secret, missing } = resolveTarget()

  if (missing.length > 0) {
    // 只在真发生改动时记一行：不配这两个变量是允许的状态（退回 ISR 一分钟）
    console.log(`[revalidate] 跳过（${reason}）：未配置 ${missing.join(' / ')} —— 前台最多一分钟后自己刷新`)
    return { ok: false, skipped: true, error: `未配置 ${missing.join(' / ')}` }
  }

  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'x-revalidate-secret': secret, accept: 'application/json' },
        cache: 'no-store',
      },
      TIMEOUT_MS
    )

    const json: any = await res.json().catch(() => null)
    if (!res.ok || json?.ok === false) {
      const message = json?.error || `HTTP ${res.status}`
      console.log(`[revalidate] 前台拒绝了这次刷新（${reason}）——`, message)
      return { ok: false, skipped: false, url, status: res.status, error: message }
    }

    console.log(`[revalidate] ok（${reason}）`, { url, revalidated: json?.revalidated })
    return { ok: true, skipped: false, url, status: res.status, revalidated: json?.revalidated }
  } catch (e: any) {
    const message = isAbortError(e) ? `超时（${TIMEOUT_MS}ms）` : e?.message || 'fetch failed'
    console.log(`[revalidate] 通知前台失败（${reason}）——`, message)
    return { ok: false, skipped: false, url, error: message }
  }
}

/** 给后台接口用的「一行摘要」，前端 toast 里直接拼这句话。 */
export function describeRevalidate(o: RevalidateOutcome): string {
  if (o.ok) return '前台已同步刷新'
  if (o.skipped) return '前台最多一分钟后自动更新（未配置即时刷新）'
  return '前台最多一分钟后自动更新（即时刷新没成功）'
}
