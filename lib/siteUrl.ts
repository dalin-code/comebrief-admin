/**
 * 站点 origin 的唯一入口 —— 以及对「脏环境变量」的兜底。
 *
 * 2026-11-25 线上事故：后台 Vercel 的 `NEXT_PUBLIC_SITE_URL` 被粘成了
 * `[https://www.comebrief.com] (https://www.comebrief.com)`（从聊天/文档里
 * 复制链接时把 Markdown 包装一起带上了）。后果不止一个：
 *
 *   · IndexNow 按钮拼 `${SITE_URL}/sitemap.xml` 直接抛
 *     `TypeError: Failed to parse URL from …`，功能整个不可用；
 *   · 「保存后刷新前台」在 resolveTarget 里被 `/^https?:\/\//` 判成「没配」，
 *     静默跳过，站长以为已经即时刷新了；
 *   · 广告点击的兜底跳转与 Quiz Studio 的「前台」地址同样会拼坏。
 *
 * 环境变量是人手填的，就一定会有人填脏。这里只做两件事：
 *   ① 从任意文本里取出**第一个** http(s) 地址（丢掉引号、`<>`、`[]`、`()` 等包装）；
 *   ② 收敛成 origin（协议 + 主机），去掉路径、查询串与结尾斜杠。
 *
 * 为什么拿不到合法地址时返回 `''` 而不是抛错：所有调用点都在请求路径上
 * （路由 / 列表渲染），读到一个坏变量不该让整页 500 —— 由调用方决定退回哪个默认值。
 */

/** 线上规范主域（Vercel Domains 的主域必须是它，见前台 lib/site.ts 的说明）。 */
export const DEFAULT_SITE_URL = 'https://comebrief.com'

/** URL 末尾常被粘上的标点（句号、逗号、括号、引号…），都不属于地址本身。 */
const TRAILING_PUNCT = /[)\]}>"'`.,;:!?]+$/

/**
 * 从可能被 Markdown / 引号 / 括号包住的字符串里归一出一个 origin。
 *
 *   normalizeSiteUrl('[https://www.comebrief.com] (https://www.comebrief.com)')
 *     -> 'https://www.comebrief.com'
 *   normalizeSiteUrl(' "https://comebrief.com/" ') -> 'https://comebrief.com'
 *   normalizeSiteUrl('https://comebrief.com/sitemap.xml') -> 'https://comebrief.com'
 *   normalizeSiteUrl('comebrief.com') -> ''   // 没有协议，不猜
 */
export function normalizeSiteUrl(raw?: string | null): string {
  const text = String(raw ?? '').trim()
  if (!text) return ''

  // 只认带协议的第一个地址：没有协议时猜 http/https 都可能猜错，不如交给调用方兜底。
  const match = text.match(/https?:\/\/[^\s<>"'`]+/i)
  if (!match) return ''

  const candidate = match[0].replace(TRAILING_PUNCT, '')
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    // 只要 origin：SITE_URL 的语义一直是「规范 origin，不含结尾斜杠」。
    return `${url.protocol}//${url.host}`
  } catch {
    return ''
  }
}

const rawSiteUrl = process.env.NEXT_PUBLIC_SITE_URL
const normalizedSiteUrl = normalizeSiteUrl(rawSiteUrl)
const trimmedSiteUrl = String(rawSiteUrl ?? '').trim()

// 只在服务端留一行日志：脏值被悄悄「修正」时，运维要能看见，否则下次还会粘错。
// （客户端 bundle 里 NEXT_PUBLIC_* 会被内联，没必要把这条警告带进浏览器控制台。）
if (typeof window === 'undefined' && trimmedSiteUrl && normalizedSiteUrl !== trimmedSiteUrl) {
  console.warn(
    '[site-url] NEXT_PUBLIC_SITE_URL 含多余字符，已归一化：',
    JSON.stringify(trimmedSiteUrl),
    '->',
    normalizedSiteUrl || '(无法解析，退回默认值)'
  )
}

/** 规范站点 origin。环境变量脏/缺省时退回线上主域，永不返回空串。 */
export const SITE_URL = normalizedSiteUrl || DEFAULT_SITE_URL
