import type { NextRequest } from 'next/server'
import { jsonResponse, requireAdmin } from '@/lib/aiGemini'
import { describeRevalidate, notifyFrontendRevalidate } from '@/lib/revalidateFrontend'

export const runtime = 'nodejs'

/**
 * 「后台刚改完，请前台立刻重建缓存」——给浏览器端调用的那一层。
 *
 * 为什么不让编辑器直接去敲前台：前台 `/api/revalidate` 认的是
 * `REVALIDATE_SECRET`（服务端密钥）。密钥一旦出现在浏览器里，任何访客都能
 * 拿到它去刷缓存。所以浏览器只带自己的登录票来敲这个路由，由服务端换密钥转发。
 *
 * 鉴权沿用后台那一套 `requireAdmin`（没有 Authorization 头 → 401，票不对 → 401）。
 * 返回 200 表示「这次转发的结果」，不代表前台一定刷新了：
 *   · `{ ok: true, revalidated: [...] }`  → 前台已立即重建；
 *   · `{ ok: false, skipped: true }`      → 两个配置项没配齐，退回 ≤60s 的 ISR，
 *     编辑器据此把 toast 文案说清楚（不能让站长以为「已经立刻生效了」）。
 * 无论哪种都不影响已经保存成功的内容 —— 它只影响「多久看到」。
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req)
  if (auth.ok === false) return auth.response

  const outcome = await notifyFrontendRevalidate(`admin:${auth.userId}`)

  return jsonResponse({
    ok: outcome.ok,
    skipped: outcome.skipped,
    message: describeRevalidate(outcome),
    error: outcome.error,
    revalidated: outcome.revalidated,
  })
}
