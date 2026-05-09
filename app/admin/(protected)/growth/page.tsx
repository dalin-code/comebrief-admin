'use client'

import { useEffect, useMemo, useState } from 'react'
import { Download, Save } from 'lucide-react'
import { supabase } from '@/lib/supabase'

type Notice = { type: 'success' | 'error' | 'info'; message: string } | null
type ToolLite = { id: string | number; name: string }

export default function GrowthPage() {
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState(false)

  const [tools, setTools] = useState<ToolLite[]>([])
  const [plan, setPlan] = useState<'free' | 'featured'>('free')
  const [toolId, setToolId] = useState<string>('')

  const [subscriberCount, setSubscriberCount] = useState<number | null>(null)

  useEffect(() => {
    const load = async () => {
      const t = await supabase.from('tools').select('id,name').order('created_at', { ascending: false }).limit(200)
      if (!t.error) setTools((t.data || []) as ToolLite[])

      const s = await supabase.from('newsletter_subscribers').select('*', { head: true, count: 'exact' })
      if (!s.error) setSubscriberCount(typeof s.count === 'number' ? s.count : null)
    }
    load()
  }, [])

  const toolOptions = useMemo(() => tools, [tools])

  const exportSubscribers = async () => {
    setBusy(true)
    setNotice({ type: 'info', message: '正在导出订阅者…' })
    const { data, error } = await supabase
      .from('newsletter_subscribers')
      .select('email,source,article_id,created_at')
      .order('created_at', { ascending: false })
      .limit(50000)
    if (error) {
      setNotice({ type: 'error', message: `导出失败：${error.message}` })
      setBusy(false)
      return
    }
    const rows = (data || []) as Array<{ email?: string; source?: string; article_id?: string | null; created_at?: string }>
    const csv = [
      'email,source,article_id,created_at',
      ...rows.map((r) => `${csvEscape(r.email || '')},${csvEscape(r.source || '')},${csvEscape(String(r.article_id || ''))},${csvEscape(r.created_at || '')}`),
    ].join('\n')
    downloadText(`subscribers-${new Date().toISOString().slice(0, 10)}.csv`, csv)
    setNotice({ type: 'success', message: `已导出 ${rows.length} 条订阅者` })
    setBusy(false)
  }

  const submitTool = async () => {
    if (!toolId) {
      setNotice({ type: 'error', message: '请选择一个工具' })
      return
    }
    setBusy(true)
    setNotice({ type: 'info', message: '正在提交…' })
    const { data: u } = await supabase.auth.getUser()
    const userId = u.user?.id || ''
    if (!userId) {
      setNotice({ type: 'error', message: '提交失败：未登录' })
      setBusy(false)
      return
    }
    const toolName = tools.find((t) => String(t.id) === String(toolId))?.name || ''
    const now = new Date().toISOString()
    const payload: any = {
      id: crypto.randomUUID(),
      user_id: userId,
      plan,
      status: 'submitted',
      created_at: now,
      tool_name: toolName || null,
      tool_id: toolId,
    }
    let error: any
    let current: any = payload
    for (let i = 0; i < 10; i += 1) {
      ;({ error } = await supabase.from('tool_submissions').insert(current))
      if (!error) break
      const msg = String(error?.message || '')
      const m1 = msg.match(/Could not find the '([^']+)' column/i)
      const m2 = msg.match(/column\s+tool_submissions\.([a-zA-Z0-9_]+)\s+does\s+not\s+exist/i)
      const missing = (m1?.[1] || m2?.[1] || '').trim()
      if (missing && Object.prototype.hasOwnProperty.call(current, missing)) {
        const next: any = { ...current }
        delete next[missing]
        current = next
        continue
      }
      break
    }
    if (error) {
      setNotice({ type: 'error', message: `保存失败：${error.message}` })
      setBusy(false)
      return
    }
    setNotice({ type: 'success', message: '已提交' })
    setBusy(false)
  }

  const tone =
    notice?.type === 'success'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
      : notice?.type === 'error'
        ? 'border-rose-200 bg-rose-50 text-rose-700'
        : 'border-sky-200 bg-sky-50 text-sky-800'

  return (
    <div className="min-h-screen bg-slate-50 px-6 py-10">
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-8">
          <div className="text-sm text-slate-500">Growth</div>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">增长引擎</h1>
          <div className="mt-1 text-sm text-slate-500">广告位 + 订阅者资产</div>
        </div>

        {notice ? <div className={`mb-6 rounded-xl border px-4 py-3 text-sm ${tone}`}>{notice.message}</div> : null}

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-2xl border border-slate-200 bg-white p-6">
            <div className="mb-5">
              <div className="text-sm font-medium text-slate-900">工具提交（Tool Submissions）</div>
              <div className="mt-1 text-sm text-slate-500">提交工具 / 赞助位意向</div>
            </div>
            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-sm text-slate-700">Plan</label>
                <select
                  value={plan}
                  onChange={(e) => setPlan(e.target.value as any)}
                  className="h-11 w-full rounded-xl border border-slate-200 bg-white px-4 text-sm text-slate-900 outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20"
                >
                  <option value="free">free</option>
                  <option value="featured">featured</option>
                </select>
              </div>
              <div>
                <label className="mb-2 block text-sm text-slate-700">工具</label>
                <select
                  value={toolId}
                  onChange={(e) => setToolId(e.target.value)}
                  className="h-11 w-full rounded-xl border border-slate-200 bg-white px-4 text-sm text-slate-900 outline-none focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20"
                >
                  <option value="">请选择…</option>
                  {toolOptions.map((t) => (
                    <option key={String(t.id)} value={String(t.id)}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={submitTool}
                className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
              >
                <Save className="h-4 w-4" />
                提交
              </button>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-6">
            <div className="mb-5">
              <div className="text-sm font-medium text-slate-900">订阅名单（Newsletter Subscribers）</div>
              <div className="mt-1 text-sm text-slate-500">导出到邮件群发工具</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-xs text-slate-500">总订阅者</div>
              <div className="mt-1 text-3xl font-semibold text-slate-900">{subscriberCount ?? '—'}</div>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={exportSubscribers}
              className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 text-sm font-medium text-emerald-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
            >
              <Download className="h-4 w-4" />
              导出 CSV
            </button>
            <div className="mt-3 text-xs text-slate-500">默认导出字段：email、source、article_id、created_at（最多 50000 条）</div>
          </section>
        </div>
      </div>
    </div>
  )
}

function csvEscape(v: string) {
  const s = String(v ?? '')
  if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`
  return s
}

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
