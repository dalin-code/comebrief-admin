import { createClient } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

/**
 * 浏览器端的登录态小工具（只给客户端组件用）。
 *
 * 为什么单独抽一个文件：这两个函数原本各写一份 —— StoryComposer 里一份
 * （AI 接口用），trends/edit 里完全没有（于是封面上传撞上了下面这个坑）。
 * 「票快过期就先换一张」这件事只要漏掉一处，站长在那一处就会看到一句
 * 莫名其妙的 403，所以只能有一份实现。
 */

/**
 * 取一张尽量新鲜的 access_token；拿不到（没登录）就返回空串。
 *
 * 为什么不直接 `getSession().session.access_token`：
 *   ① supabase-js 给 PostgREST 和 Storage 配的是同一个 `fetchWithAuth`，它拿的
 *      就是 `auth.getSession()` 里那张**缓存票** —— 只读缓存，不看 `exp`。
 *      后台标签页挂久了（笔记本合盖 / 切走很久），自动续期的定时器被浏览器
 *      掐掉，缓存里躺着的就是一张过期票。这时候上传封面，Storage 回的是
 *      `{"statusCode":"403","message":"\"exp\" claim timestamp check failed"}` ——
 *      站长看到的「封面上传失败」其实就是这一句话，跟图片、跟桶都没关系。
 *   ② 一次生成 / 续写要跑 30–60 秒，出门时还有效的票，跑到后台可能已经过期了
 *      —— 留 60 秒余量，快过期就先换一张。
 *   ③ token 刷新失败（网络抖动）时 `getSession()` 仍会返回那张旧票，发出去必然被
 *      后台判 401。
 *
 * 本函数自己吞掉刷新失败（退回旧票并打一条日志），调用方不必再包 try/catch。
 */
export async function getFreshAccessToken(forceRefresh = false): Promise<string> {
  const { data } = await supabase.auth.getSession()
  const session = data?.session
  if (session && !forceRefresh) {
    const expiresAt = session.expires_at ? session.expires_at * 1000 : Number.POSITIVE_INFINITY
    if (expiresAt - Date.now() > 60_000) return session.access_token
  }
  if (forceRefresh || session) {
    try {
      const { data: refreshed, error } = await supabase.auth.refreshSession()
      if (refreshed?.session?.access_token) return refreshed.session.access_token
      if (error) console.warn('[auth] 换票失败，先用旧票试试：', error.message)
    } catch (e: any) {
      console.warn('[auth] 换票抛错，先用旧票试试：', e?.message || e)
    }
  }
  return session?.access_token || ''
}

/**
 * 这句话是不是「这张票不认」。
 *
 * 用来决定「要不要换票重试」，而不是把 Supabase 的英文原文直接丢给站长。
 * 认得出的几种：Storage 的 `"exp" claim timestamp check failed` /
 * `signature verification failed`、各服务的 expired / invalid JWT / unauthorized。
 * 图片本身太大、桶不存在之类的错不在此列 —— 那些换票一百次也没用。
 */
export function isAuthTokenError(message?: string | null): boolean {
  const m = String(message || '')
  return /"exp"\s*claim|claim timestamp|expired|jwt|invalid.\btoken|signature verification|unauthorized/i.test(m)
}

/**
 * 只带 publishable / anon key、**不带登录态**的 Storage 客户端。
 *
 * 兜底用途：登录态这张票被 Storage 判死、连硬刷新换票都救不回来时，
 * 仍然要把图片传上去（`images` 桶对匿名写入是开放的 —— 前台访客走的就是这条路，
 * 权限上不比登录态更高，所以这不是「降权后门」，只是换个入口）。
 *
 * `persistSession: false` 是硬要求：这个实例绝不碰 localStorage 里那份
 * `sb-<ref>-auth-token`，否则两个 GoTrue 实例抢同一个 key，会把站长的登录态搅乱。
 */
export const anonStorageClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'public-anon-key',
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
)
