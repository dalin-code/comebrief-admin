import type { NextRequest } from 'next/server'
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
 * 鉴权与 /api/cron/publish 完全一致：
 *   配了 CRON_SECRET → 必须带 Authorization: Bearer <CRON_SECRET> 或 ?secret=
 *   没配 → 生产环境拒绝（503），开发环境放行
 *
 * 用法：
 *   curl -X POST 'https://<admin-host>/api/admin/index-push?dry=1' -H 'Authorization: Bearer $CRON_SECRET'
 *   curl -X POST 'https://<admin-host>/api/admin/index-push'       -H 'Authorization: Bearer $CRON_SECRET'
 */

export const runtime = 'nodejs'
export const maxDuration = 60

const getBearer = (req: NextRequest) => {
  const header = req.headers.get('authorization') || ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

function authorize(req: NextRequest): Response | null {
  const secret = (process.env.CRON_SECRET || '').trim()
  const provided =
    (new URL(req.url).searchParams.get('secret') || '').trim() || getBearer(req)

  if (secret) {
    if (provided === secret) return null
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  if (process.env.NODE_ENV === 'production') {
    return Response.json(
      {
        ok: false,
        error:
          'CRON_SECRET is not configured. Set it in the Vercel project env, then call this route with Authorization: Bearer <CRON_SECRET>.',
      },
      { status: 503 }
    )
  }

  return null
}

async function handle(req: NextRequest) {
  const denied = authorize(req)
  if (denied) return denied

  const dry = new URL(req.url).searchParams.get('dry') === '1'

  try {
    const urls = await fetchSitemapUrls()

    if (dry) {
      return Response.json({
        ok: true,
        dry: true,
        site: SITE_URL,
        count: urls.length,
        sample: urls.slice(0, 10),
      })
    }

    const result = await pushUrls(urls)
    return Response.json({ ok: result.ok, dry: false, site: SITE_URL, urls: urls.length, indexnow: result })
  } catch (e: any) {
    return Response.json(
      { ok: false, error: e?.message || 'index-push failed' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  return handle(req)
}

// GET 也放开（带 secret 时）：方便直接在浏览器/curl 里点一下。
export async function GET(req: NextRequest) {
  return handle(req)
}
