import type { NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/aiGemini'
import { fetchSitemapSnapshot, isSameSiteUrl, pushUrls, toAbsoluteSiteUrl, SITE_URL } from '@/lib/indexPush'

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
 *
 * 单条推送（后台「保存后推送这一页」，2026-11-25 起）：
 *   curl -X POST 'https://<admin-host>/api/admin/index-push?url=/quizzes/career-test&dry=1' -H 'Authorization: Bearer $CRON_SECRET'
 *   curl -X POST 'https://<admin-host>/api/admin/index-push?url=/quizzes/career-test'       -H 'Authorization: Bearer $CRON_SECRET'
 * `url` 接受站内路径或完整 http(s) 地址；不属于站点主域的会被 400 拦下
 * （IndexNow 混入别的 host 会让整批 422，这个错很难从「推送失败」四个字里看出来）。
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

/**
 * 单条推送：后台「保存后推送这一页」用的。
 *
 * 与整站回填分开的三条理由：
 *   · 回填要先把 sitemap 拉一遍（一次外网请求 + 一次解析），推一页不需要；
 *   · 单条必须先做**同域校验**：IndexNow 混入异构 host 会让整批 422，而站长
 *     只看到「推送失败」，不会想到是自己复制了预览域名；
 *   · `?dry=1` 也要能用 —— 排查「到底推的是哪条」时，先看一眼再真推。
 */
async function pushSingle(rawUrl: string, dry: boolean): Promise<Response> {
  const absolute = toAbsoluteSiteUrl(rawUrl, SITE_URL)
  if (!absolute) {
    return jsonNoStore(
      { ok: false, error: 'url 不合法：传站内路径（/quizzes/xxx）或完整 http(s) 地址' },
      400
    )
  }
  if (!isSameSiteUrl(absolute, SITE_URL)) {
    return jsonNoStore(
      {
        ok: false,
        error: `这个地址不属于 ${SITE_URL}（IndexNow 混入别的域名会让整批 422，已拦下）`,
        url: absolute,
      },
      400
    )
  }

  if (dry) {
    return jsonNoStore({ ok: true, dry: true, site: SITE_URL, count: 1, sample: [absolute] })
  }

  const result = await pushUrls([absolute], SITE_URL)
  return jsonNoStore({ ok: result.ok, dry: false, site: SITE_URL, urls: 1, url: absolute, indexnow: result })
}

async function handle(req: NextRequest) {
  // authorize 现在是 async：admin 通道要打一次 Supabase getUser
  const denied = await authorize(req)
  if (denied) return denied

  const params = new URL(req.url).searchParams
  const dry = params.get('dry') === '1'
  const single = (params.get('url') || '').trim()

  // 给了 url 就只推这一条（后台「保存后推送」走这里），不再拉 sitemap。
  if (single) return pushSingle(single, dry)

  try {
    const { origin, urls } = await fetchSitemapSnapshot()

    if (dry) {
      return jsonNoStore({
        ok: true,
        dry: true,
        site: origin,
        count: urls.length,
        sample: urls.slice(0, 10),
      })
    }

    // 按 sitemap 自己的 origin 推（而不是环境变量里的那个）：host 与 urlList
    // 必须属于同一域，否则 IndexNow 整批 422；sitemap 才是 canonical 的真源。
    const result = await pushUrls(urls, origin)
    return jsonNoStore({ ok: result.ok, dry: false, site: origin, urls: urls.length, indexnow: result })
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
