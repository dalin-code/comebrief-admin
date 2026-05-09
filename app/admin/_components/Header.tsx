'use client'

import { useMemo } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { ChevronRight, LogOut } from 'lucide-react'
import { supabase } from '@/lib/supabase'

const labelMap: Record<string, string> = {
  admin: '后台',
  dashboard: '概览',
  trends: 'Trends 资讯',
  quizzes: 'Quizzes 测试',
  stories: 'Stories 故事',
  ads: '广告填充',
  settings: '系统设置',
  // 兼容旧路径
  news: 'Trends 资讯',
  tools: 'Quizzes 测试',
  growth: 'Stories 故事',
}

export default function Header() {
  const pathname = usePathname() || ''
  const router = useRouter()

  const crumbs = useMemo(() => {
    const parts = pathname.split('/').filter(Boolean)
    if (!parts.length) return []
    const acc: Array<{ label: string; href: string }> = []
    for (let i = 0; i < parts.length; i += 1) {
      const raw = parts[i]
      const label = labelMap[raw] || (raw.length > 18 ? `${raw.slice(0, 18)}…` : raw)
      const href = '/' + parts.slice(0, i + 1).join('/')
      acc.push({ label, href })
    }
    return acc
  }, [pathname])

  const onLogout = async () => {
    await supabase.auth.signOut()
    router.push('/')
  }

  const title = crumbs.length ? crumbs[crumbs.length - 1].label : '后台'

  return (
    <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/80 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-slate-600">
            {crumbs.slice(0, -1).map((c) => (
              <button
                key={c.href}
                type="button"
                onClick={() => router.push(c.href)}
                className="truncate transition hover:text-slate-900"
              >
                {c.label}
              </button>
            ))}
            {crumbs.length > 1 ? <ChevronRight className="h-4 w-4 text-slate-400" /> : null}
            <div className="truncate text-slate-900">{title}</div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onLogout}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 transition hover:bg-slate-50"
          >
            <LogOut className="h-4 w-4" />
            退出
          </button>
          <div className="grid h-9 w-9 place-items-center rounded-full border border-slate-200 bg-slate-50 text-xs font-semibold text-slate-800">
            A
          </div>
        </div>
      </div>
    </header>
  )
}
