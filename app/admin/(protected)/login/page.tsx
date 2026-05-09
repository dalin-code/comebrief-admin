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

  const formatAuthError = (e: any) => {
    const message = String(e?.message || e?.msg || '')
    if (message.toLowerCase().includes('invalid login credentials')) return '账号或密码错误'
    if (message.toLowerCase().includes('email not confirmed')) return '邮箱未验证：请先完成邮箱验证'
    return message || '登录失败'
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password.trim()) return
    setLoading(true)
    setMsg({ type: 'info', text: '登录中…' })
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error) {
      setMsg({ type: 'error', text: formatAuthError(error) })
      setLoading(false)
      return
    }
    setMsg({ type: 'success', text: '登录成功，正在跳转…' })
    const redirectUrl = searchParams.get('redirect')
    router.push(redirectUrl || '/admin/dashboard')
  }

  const tone =
    msg?.type === 'success'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
      : msg?.type === 'error'
        ? 'border-rose-500/30 bg-rose-500/10 text-rose-200'
        : 'border-sky-500/30 bg-sky-500/10 text-sky-200'

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-6">
          <div className="text-sm text-slate-500">管理员后台</div>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">登录</h1>
        </div>
        {msg ? <div className={`mb-4 rounded-xl border px-4 py-3 text-sm ${tone}`}>{msg.text}</div> : null}
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="mb-2 block text-sm text-slate-700">邮箱</label>
            <input
              type="email"
              className="h-12 w-full rounded-xl border border-slate-200 bg-white px-4 text-slate-900 outline-none placeholder:text-slate-400 focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-2 block text-sm text-slate-700">密码</label>
            <input
              type="password"
              className="h-12 w-full rounded-xl border border-slate-200 bg-white px-4 text-slate-900 outline-none placeholder:text-slate-400 focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-emerald-500 px-6 font-medium text-emerald-950 shadow-sm transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
          >
            登录
          </button>
        </form>
      </div>
    </div>
  )
}

export default function AdminLoginPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-slate-50">加载中...</div>}>
      <AdminLoginContent />
    </Suspense>
  )
}
