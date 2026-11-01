'use client'

import { useState } from 'react'
import { AlertCircle, CheckCircle2, Info, Loader2, Send } from 'lucide-react'
import { getFreshAccessToken } from '@/lib/clientAuth'

/**
 * IndexNow 一键推送按钮（后台列表页的快捷操作）。
 *
 * 为什么需要它：`/api/admin/index-push` 早就有了，但只认 `CRON_SECRET`
 * （给 curl / cron 用的）。站长手上没有那个密钥，想「大改之后让 Bing 立刻重抓一遍」
 * 就只能干等。这个按钮用自己那张登录票（Supabase access token）敲同一个路由，
 * 由服务端换密钥去打 IndexNow —— 密钥永远不进浏览器。
 *
 * 推的是**整站 sitemap**，不是当前列表：index-push 的设计前提是
 * 「sitemap 已经是 canonical 的唯一镜像」，按列表推反而会漏页面。
 *
 * 自带 toast，不依赖各列表页本来没有的提示状态 —— 三个页面都只是插一个按钮。
 */

type ToastKind = 'success' | 'warn' | 'error'

type PushPayload = {
  ok?: boolean
  error?: string
  site?: string
  /** sitemap 里取到的 URL 总数 */
  urls?: number
  indexnow?: {
    ok: boolean
    /** 真正被搜索引擎接受的条数 */
    submitted: number
    batches: number
    status?: number
    error?: string
  }
}

const TOAST_STYLE: Record<ToastKind, string> = {
  success: 'bg-slate-900 text-white',
  warn: 'bg-amber-500 text-white',
  error: 'bg-rose-500 text-white',
}

export default function IndexNowButton({
  className = '',
  iconSize = 14,
}: {
  /** 每个页面按钮的尺寸/圆角不一样，由调用方补 padding 与 rounded */
  className?: string
  iconSize?: number
}) {
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ kind: ToastKind; msg: string } | null>(null)

  const say = (kind: ToastKind, msg: string) => {
    setToast({ kind, msg })
    // 错误信息带原始响应体，给足阅读时间；成功 5 秒足够
    window.setTimeout(() => setToast(null), kind === 'error' ? 9000 : 5000)
  }

  const push = async () => {
    if (busy) return
    setBusy(true)
    setToast(null)
    try {
      const token = await getFreshAccessToken()
      if (!token) throw new Error('登录已过期，请刷新页面重新登录')

      const resp = await fetch('/api/admin/index-push', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      const json = (await resp.json().catch(() => null)) as PushPayload | null

      if (!resp.ok) {
        const msg = json?.error || `推送失败（${resp.status}）`
        // 401 = 票过期（去重登）；503 = 服务端连不上 Supabase Auth（重试就好，别赶人去重登）
        say('error', resp.status === 503 ? `${msg}。这是服务端连不上鉴权服务，稍后重试即可` : msg)
        return
      }

      const total = Number(json?.urls ?? 0)
      const result = json?.indexnow

      if (!total) {
        say('warn', 'sitemap 里没有取到任何 URL，先去前台确认 sitemap.xml 是否正常')
        return
      }

      const submitted = Number(result?.submitted ?? 0)
      if (result?.ok) {
        say('success', `成功推送 ${submitted} 条页面链接至 Bing/Yandex`)
        return
      }

      // 部分批次被拒：把 IndexNow 的原始原因带上（403 = key 文件取不到，422 = URL 不属于该 host）
      const reason = result?.error || (result?.status ? `HTTP ${result.status}` : '未知原因')
      say('warn', `已推送 ${submitted} / ${total} 条，其余被拒：${reason}`)
    } catch (e: any) {
      say('error', e?.message || '推送失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={push}
        disabled={busy}
        title="把 sitemap 里的全部页面地址一次性报给 Bing / Yandex（IndexNow 协议）"
        className={`bg-white border border-slate-200 text-slate-700 font-black uppercase tracking-widest hover:bg-slate-50 hover:border-slate-300 transition-all shadow-sm flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed ${className}`}
      >
        {busy ? <Loader2 size={iconSize} className="animate-spin" /> : <Send size={iconSize} />}
        <span>{busy ? '推送中...' : 'IndexNow'}</span>
      </button>

      {toast && (
        <div
          className={`fixed bottom-8 right-8 z-[300] max-w-md px-6 py-4 rounded-2xl shadow-2xl flex items-start gap-3 animate-in fade-in slide-in-from-bottom-4 ${TOAST_STYLE[toast.kind]}`}
        >
          {toast.kind === 'success' ? (
            <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-400" />
          ) : toast.kind === 'warn' ? (
            <Info size={16} className="mt-0.5 shrink-0" />
          ) : (
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
          )}
          <p className="text-[11px] font-black leading-relaxed">{toast.msg}</p>
        </div>
      )}
    </>
  )
}
