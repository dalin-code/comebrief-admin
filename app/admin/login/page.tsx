'use client'

import { useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'

function AdminLoginContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<{ type: 'error' | 'info' | 'success'; text: string } | null>(null)

  const canSubmit = email.trim() && password.trim() && !loading

  // 更加友好的错误提示
  const formatAuthError = (e: any) => {
    const message = String(e?.message || e?.msg || '')
    if (message.toLowerCase().includes('invalid login credentials')) return '账号或密码错误'
    if (message.toLowerCase().includes('email not confirmed')) return '邮箱未验证：请先完成邮箱验证'
    return message || '登录失败'
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return

    setLoading(true)
    setMsg({ type: 'info', text: '正在验证身份...' })

    const { data, error } = await supabase.auth.signInWithPassword({ 
      email: email.trim(), 
      password 
    })

    if (error || !data?.session) {
      setMsg({ type: 'error', text: formatAuthError(error || { message: '登录失败，请稍后重试' }) })
      setLoading(false)
      return
    }

    setMsg({ type: 'success', text: '验证通过，进入总控室...' })

    const redirectUrl = searchParams.get('redirect')
    await router.push(redirectUrl || '/admin/dashboard')
    setLoading(false)
  }

  const tone =
    msg?.type === 'success'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600'
      : msg?.type === 'error'
        ? 'border-rose-500/30 bg-rose-500/10 text-rose-600'
        : 'border-sky-500/30 bg-sky-500/10 text-sky-600'

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6 font-sans">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-8">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400">Admin Control Panel</div>
          <h1 className="mt-2 text-3xl font-semibold text-slate-900">登录</h1>
        </div>

        {msg && (
          <div className={`mb-6 rounded-xl border px-4 py-3 text-sm transition-all ${tone}`}>
            {msg.text}
          </div>
        )}

        <form onSubmit={onSubmit} className="space-y-5">
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">管理邮箱</label>
            <input
              type="email"
              className="h-12 w-full rounded-xl border border-slate-200 bg-white px-4 text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10 placeholder:text-slate-300"
              placeholder="admin@comebrief.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">安全密码</label>
            <input
              type="password"
              className="h-12 w-full rounded-xl border border-slate-200 bg-white px-4 text-slate-900 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10 placeholder:text-slate-300"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          
          <button
            type="submit"
            disabled={!canSubmit}
            className="relative flex h-12 w-full items-center justify-center rounded-xl bg-slate-900 px-6 font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <svg className="h-4 w-4 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                正在验证
              </span>
            ) : '进入后台'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default function AdminLoginPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-400 text-sm animate-pulse">
        初始化安全环境...
      </div>
    }>
      <AdminLoginContent />
    </Suspense>
  )
}