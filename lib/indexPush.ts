/**
 * IndexNow 推送（Bing / Yandex / Seznam / Naver 共用协议）。
 *
 * 为什么值得做：Google 早就不看 sitemap 里的 ping 了，Bing 系仍然吃 IndexNow。
 * 新内容发布后**主动报一次**，比等爬虫按自己的节奏回访快得多 —— 尤其本站
 * 更新频率不高，爬虫回访间隔会越拉越长。
 *
 * 三条硬约束（违反任意一条，接口会静默丢弃整批 URL）：
 *
 *   1. 必须能用 `https://<host>/<key>.txt` 取到 key，且**内容就是 key 本身**。
 *      那个文件在不在这里 —— 在另一个仓库：ComeBrief/public/<key>.txt。
 *      两个仓库的 key 必须一致，改一处就要改两处。
 *   2. 一次提交的 URL 必须全部属于同一个 host。
 *   3. 单次最多 10,000 条，需要分批。
 *
 * 为什么失败不抛异常：这是「锦上添花」的旁路。搜索引擎没收到通知，内容也照样
 * 会被自然爬到；反过来，如果推送失败把定时发布任务搞挂了，就是本末倒置。
 */

import { SITE_URL, normalizeSiteUrl } from './siteUrl'

/** 与 ComeBrief/public/<key>.txt 里的内容必须逐字一致。 */
const FALLBACK_KEY = '142b2a46fe175573a7bc78efc919322b'

export const INDEXNOW_KEY = (process.env.INDEXNOW_KEY || FALLBACK_KEY).trim()

/**
 * 站点主域。canonical / sitemap 的唯一真源在 ComeBrief 的 lib/site.ts，这里只跟随。
 *
 * 读的是 `lib/siteUrl.ts` 归一化后的值：环境变量被粘成
 * `[https://www.comebrief.com] (https://www.comebrief.com)` 时，直接拼
 * `/sitemap.xml` 会抛 `Failed to parse URL`。这里同时 re-export，保持既有
 * `import { SITE_URL } from '@/lib/indexPush'` 的调用点不动。
 */
export { SITE_URL }

/** 共享端点：会自动把请求分发给所有参与该协议的搜索引擎。 */
const ENDPOINT = 'https://api.indexnow.org/indexnow'

/** 协议上限 10,000，留一点余量。 */
const MAX_PER_REQUEST = 9000

export type PushResult = {
  ok: boolean
  submitted: number
  batches: number
  /** 最后一次非 2xx 的状态码与响应体，便于排查 key 文件没部署之类的问题。 */
  status?: number
  error?: string
}

/** 表 → 前台路径前缀。少写一个，那批内容就永远推不上去。 */
const TABLE_PREFIX: Record<string, string> = {
  articles: 'briefs',
  stories: 'stories',
  quizzes: 'quizzes',
}

/**
 * 把 URL 列表推给 IndexNow。
 *
 * 注意：IndexNow 的成功码是 **200 或 202**（202 = 已接受但仍在校验 key 文件），
 * 403 通常意味着 key 文件取不到或内容不匹配，422 意味着 URL 不属于该 host。
 *
 * `origin` 默认取 SITE_URL；回填时会显式传入 sitemap 里第一条 URL 的 origin ——
 * sitemap 才是 canonical 的镜像，环境变量写的是 www 还是 apex 都不该让它 422。
 */
export async function pushUrls(urls: string[], origin: string = SITE_URL): Promise<PushResult> {
  // 去重 + 只保留同域 URL（约束 2：混入别的 host 会让整批被拒）
  const site = normalizeSiteUrl(origin) || SITE_URL
  const host = new URL(site).host
  const unique = Array.from(new Set(urls.filter(Boolean))).filter((url) => {
    try {
      return new URL(url).host === host
    } catch {
      return false
    }
  })

  if (unique.length === 0) return { ok: true, submitted: 0, batches: 0 }

  let submitted = 0
  let batches = 0
  let status: number | undefined
  let error: string | undefined

  for (let i = 0; i < unique.length; i += MAX_PER_REQUEST) {
    const urlList = unique.slice(i, i + MAX_PER_REQUEST)
    batches += 1

    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          host,
          key: INDEXNOW_KEY,
          keyLocation: `${site}/${INDEXNOW_KEY}.txt`,
          urlList,
        }),
      })

      status = response.status
      if (response.ok) {
        submitted += urlList.length
      } else {
        // 403 / 422 的响应体里一般有明确原因，原样带上，别只留一个数字。
        error = `${response.status} ${(await response.text()).slice(0, 300)}`.trim()
        console.error('[indexnow] batch rejected:', error)
      }
    } catch (e: any) {
      error = e?.message || 'network error'
      console.error('[indexnow] request failed:', error)
    }
  }

  return { ok: submitted === unique.length, submitted, batches, status, error }
}

/**
 * 把刚发布的行推上去。
 *
 * slug 缺失时退回 UUID 路径 —— ComeBrief 的详情页对两者都做了处理（UUID 会
 * 301 到 slug 版本），所以推 UUID 也不算错，只是多一次跳转。
 */
export async function pushPublishedRows(
  client: any,
  table: string,
  ids: string[]
): Promise<PushResult> {
  const prefix = TABLE_PREFIX[table]
  if (!prefix || ids.length === 0) return { ok: true, submitted: 0, batches: 0 }

  const { data, error } = await client.from(table).select('id, slug').in('id', ids)
  if (error) {
    console.error(`[indexnow] slug lookup failed for ${table}:`, error.message)
    // 查不到 slug 也要推：用 UUID，前台会 301 到 slug 版本。
    return pushUrls(ids.map((id) => `${SITE_URL}/${prefix}/${id}`))
  }

  const urls = ((data || []) as Array<{ id: string; slug?: string | null }>).map(
    (row) => `${SITE_URL}/${prefix}/${row.slug || row.id}`
  )
  return pushUrls(urls)
}

/** sitemap 快照：URL 列表 + 它们真正所属的 origin（canonical 的真源）。 */
export type SitemapSnapshot = {
  /** 第一条 URL 的 origin；取不到时退回 SITE_URL */
  origin: string
  urls: string[]
}

/**
 * 从站点 sitemap 读出全部 URL（回填用）。sitemap 本身就是 canonical 的镜像。
 *
 * 为什么连 origin 一起返回：环境变量可能写成 www（而 sitemap 发的是 apex），
 * 这时若仍按 SITE_URL 的 host 过滤，整张 sitemap 会被当成「异域 URL」全部丢光
 * —— 按钮显示「没取到任何 URL」，看起来像 sitemap 坏了，其实是 host 对不上。
 */
export async function fetchSitemapSnapshot(): Promise<SitemapSnapshot> {
  const response = await fetch(`${SITE_URL}/sitemap.xml`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`sitemap ${response.status}（${SITE_URL}/sitemap.xml）`)
  const xml = await response.text()
  const urls = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g)).map((m) => m[1].trim())

  const sitemapOrigin = urls.map((url) => normalizeSiteUrl(url)).find(Boolean) || ''
  if (sitemapOrigin && sitemapOrigin !== SITE_URL) {
    console.warn(
      `[indexnow] sitemap 的域名是 ${sitemapOrigin}，与 NEXT_PUBLIC_SITE_URL（${SITE_URL}）不一致，按 sitemap 的域名推送`
    )
  }

  return { origin: sitemapOrigin || SITE_URL, urls }
}

/** 只要 URL 列表的旧入口（等价于 `(await fetchSitemapSnapshot()).urls`）。 */
export async function fetchSitemapUrls(): Promise<string[]> {
  return (await fetchSitemapSnapshot()).urls
}
