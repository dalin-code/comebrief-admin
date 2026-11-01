import type { NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/aiGemini'
import { SITE_URL, fetchSitemapUrls, pushUrls } from '@/lib/indexPush'

/**
 * IndexNow 回填：把**当前 sitemap 里的全部 URL** 一次性报给 Bing 系搜索引擎。
 *
 * 什么时候用：站点刚上线 / 刚做完一次大改（改 slug、补 canonical）时，让引擎
 * 立刻重抓一遍，而不是等下一条内容发布才顺带被通知。
 *
 * 为什么不从数据库拼 URL：sitemap 已经是 canonical 的唯一镜像（改过 slug、
 * 排掉过假页面），从它取就不会出现「推了 sitemap 里没有的地址」这种自相矛盾。
 *
 * 两条鉴权通道（2026-11-01 起）：
 *   ① 后台按钮：Authorization: Bearer <Supabase access token>，走 requireAdmin —— 站长手上有票
 *   ② cron / curl：Authorization: Bearer <CRON_SECRET> 或 ?secret=<CRON_SECRET>
 * 没配 CRON_SECRET 时，生产环境只认 ①；开发环境照旧放行（方便本地点）。
 * 之所以要加 ①：站长手上没有那个密钥，按钮点下去就是 401，功能等于不存在。
 *
 * 用法：
 *   curl -X POST 'https://<admin-host>/api/admin/index-push?dry=1' -H 'Authorization: Bearer $CRON_SECRET'
 *   curl -X POST 'https://<admin-host>/api/admin/index-push'       -H 'Authorization: Bearer $CRON_SECRET'
 */

export const runtime = 'nodejs'
export const maxDuration = 60
/** 绝不缓存：这是「现在推一次」的动作，缓存住就等于点了没反应 */
export const dynamic = 'force-dynamic'

const getBearer = (req: NextRequest) => {
  const header = req.headers.get('authorization') || ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

/** 所有响应都不许被缓存（GET 也能触发推送，被 CDN 缓存住就是灾难） */
function jsonNoStore(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  })
}

/**
 * 通过返回 null；不通过返回要直接吐给前端的响应。
 * 顺序：先 secret（零网络成本），再 admin（要打一次 Supabase getUser）。
 */
async function authorize(req: NextRequest): Promise<Response | null> {
  const secret = (process.env.CRON_SECRET || '').trim()
  const headerToken = getBearer(req)
  const querySecret = (new URL(req.url).searchParams.get('secret') || '').trim()

  // ① cron / curl 路径
  if (secret && (headerToken === secret || querySecret === secret)) return null

  // ② 后台按钮路径：带了 Bearer 但不是 CRON_SECRET，就当成登录票去验。
  //    只认 Authorization 头 —— ?secret= 是给 curl 的，不该被当成 token。
  if (headerToken) {
    const auth = await requireAdmin(req)
    if (auth.ok !== false) return null
    // 401 带「登录已过期」、503 表示连不上 Supabase Auth —— 原样透传，前端据此决定是否让人重登
    return auth.response
  }

  if (secret) return jsonNoStore({ ok: false, error: 'unauthorized' }, 401)

  if (process.env.NODE_ENV === 'production') {
    return jsonNoStore(
      {
        ok: false,
        error:
          'CRON_SECRET is not configured, and no admin token was provided. Log in to the admin panel and use the IndexNow button, or set CRON_SECRET in the Vercel project env.',
      },
      503
    )
  }

  return null
}

async function handle(req: NextRequest) {
  // authorize 现在是 async：admin 通道要打一次 Supabase getUser
  const denied = await authorize(req)
  if (denied) return denied

  const dry = new URL(req.url).searchParams.get('dry') === '1'

  try {
    const urls = await fetchSitemapUrls()

    if (dry) {
      return jsonNoStore({
        ok: true,
        dry: true,
        site: SITE_URL,
        count: urls.length,
        sample: urls.slice(0, 10),
      })
    }

    const result = await pushUrls(urls)
    return jsonNoStore({ ok: result.ok, dry: false, site: SITE_URL, urls: urls.length, indexnow: result })
  } catch (e: any) {
    return jsonNoStore({ ok: false, error: e?.message || 'index-push failed' }, 500)
  }
}

export async function POST(req: NextRequest) {
  return handle(req)
}

// GET 也放开（后台按钮用 GET）：方便直接在浏览器/curl 里点一下。
export async function GET(req: NextRequest) {
  return handle(req)
}
