'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

type Stat = { label: string; value: string; hint?: string }

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stat[]>([
    { label: 'Total Tools', value: '—', hint: '录入工具总数' },
    { label: 'Monthly Clicks', value: '—', hint: '本月点击量（近似）' },
    { label: 'Active Subscribers', value: '—', hint: '活跃订阅用户数' },
    { label: 'Content SEO Score', value: '—', hint: '已发布文章占比' },
  ])

  useEffect(() => {
    const load = async () => {
      try {
        const toolsCount = await supabase.from('tools').select('*', { head: true, count: 'exact' })

        let monthlyClicksValue: string = '—'
        if (!toolsCount.error && typeof toolsCount.count === 'number') {
          const clicksCols = await supabase.from('tools').select('clicks').limit(10000)
          if (!clicksCols.error && Array.isArray(clicksCols.data)) {
            const sum = (clicksCols.data as any[]).reduce((acc, r) => acc + (typeof r.clicks === 'number' ? r.clicks : 0), 0)
            monthlyClicksValue = String(sum)
          }
        }

        let activeSubsValue: string = '—'

        let seoScoreValue = '—'
        const articlesAll = await supabase.from('articles').select('*', { head: true, count: 'exact' })
        const articlesPublished = await supabase.from('articles').select('*', { head: true, count: 'exact' }).not('published_at', 'is', null)
        if (
          !articlesAll.error &&
          !articlesPublished.error &&
          typeof articlesAll.count === 'number' &&
          typeof articlesPublished.count === 'number'
        ) {
          if (articlesAll.count > 0) seoScoreValue = `${Math.round((articlesPublished.count / articlesAll.count) * 100)}%`
        }

        setStats([
          {
            label: 'Total Tools',
            value: typeof toolsCount.count === 'number' ? String(toolsCount.count) : '—',
            hint: '录入工具总数',
          },
          { label: 'Monthly Clicks', value: monthlyClicksValue, hint: '本月点击量（近似）' },
          { label: 'Active Subscribers', value: activeSubsValue, hint: '活跃订阅用户数' },
          { label: 'Content SEO Score', value: seoScoreValue, hint: '已发布文章占比' },
        ])
      } catch (error) {
        console.error('[dashboard] load stats failed', error)
      }
    }
    load()
  }, [])

  return (
    <div className="min-h-screen bg-slate-50 px-6 py-10">
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-8">
          <div className="text-sm text-slate-500">Dashboard</div>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">概览</h1>
        </div>
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="rounded-2xl border border-slate-200 bg-white p-6">
              <div className="text-sm text-slate-800">{s.label}</div>
              {s.hint ? <div className="mt-1 text-xs text-slate-500">{s.hint}</div> : null}
              <div className="mt-2 text-3xl font-semibold text-slate-900">{s.value}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
