'use client'

import React, { useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  ArrowUpDown,
  Image as ImageIcon,
  Inbox,
  Loader2,
  Plus,
  RefreshCcw,
  Search,
  Sparkles,
} from 'lucide-react'
import { effectiveStatus } from '@/lib/scheduled'
import {
  quizCategories,
  quizHealth,
  quizModelLabel,
  quizQuestionCount,
  quizResultCount,
  quizTopicList,
  type QuizRow,
} from '@/lib/quizStudio'
import { cn, HealthBadge, HealthBar, Label, Panel, Pill, StatusTag, StudioHead } from './ui'
import QuizRowMenu from './QuizRowMenu'
import type { QuizStudioActions } from './types'

const GRID = 'lg:grid-cols-[minmax(0,1fr)_108px_92px_112px_64px_92px_36px]'

const STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'published', label: '已发布' },
  { value: 'draft', label: '草稿' },
  { value: 'scheduled', label: '定时' },
]

function statusOf(row: QuizRow): string {
  return effectiveStatus(row)
}

export default function QuizStudioList({
  rows,
  loading,
  error,
  initialTopic = 'all',
  busyId = null,
  actions,
  onCreate,
  onRetry,
}: {
  rows: QuizRow[]
  loading: boolean
  error: string | null
  initialTopic?: string
  busyId?: string | null
  actions: QuizStudioActions
  onCreate: () => void
  onRetry: () => void
}) {
  // 由父级在「从分类屏跳到列表」时换 key 重挂载，避免在 effect 里同步 setState。
  const [topic, setTopic] = useState(initialTopic || 'all')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [sortByHealth, setSortByHealth] = useState(false)

  const topics = useMemo(() => quizTopicList(rows), [rows])
  const healthMap = useMemo(() => {
    const map = new Map<string, ReturnType<typeof quizHealth>>()
    for (let i = 0; i < rows.length; i += 1) map.set(rows[i].id, quizHealth(rows[i]))
    return map
  }, [rows])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    let list = rows.filter((row) => {
      const categories = quizCategories({
        categories: row.categories ?? (row.raw_data as any)?.categories,
      })
      const topicMatch =
        topic === 'all' || categories.some((category) => category.toLowerCase() === topic.toLowerCase())
      const statusMatch = status === 'all' || statusOf(row) === status
      const text = `${row.title || ''} ${row.slug || ''} ${categories.join(' ')}`.toLowerCase()
      return topicMatch && statusMatch && (!needle || text.includes(needle))
    })

    if (sortByHealth) {
      list = [...list].sort(
        (a, b) => (healthMap.get(a.id)?.score ?? 0) - (healthMap.get(b.id)?.score ?? 0)
      )
    }
    return list
  }, [rows, topic, status, query, sortByHealth, healthMap])

  const published = rows.filter((row) => statusOf(row) === 'published').length
  const drafts = rows.filter((row) => statusOf(row) === 'draft').length
  const blockers = Array.from(healthMap.values()).reduce(
    (sum, health) => sum + health.blockers.length,
    0
  )

  return (
    <div className="space-y-6">
      <StudioHead
        title={
          <>
            Quizzes<span className="text-[#FF6B3D]">.</span>
          </>
        }
        sub={`${rows.length} 条测验 · ${topics.length} 个主题 · ${published} 已发布 / ${drafts} 草稿 · ${blockers} 个 blocker`}
        actions={
          <>
            <button
              type="button"
              onClick={onRetry}
              className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500 transition hover:text-slate-900"
            >
              <RefreshCcw size={13} /> 刷新
            </button>
            <Link
              href="/admin/trends"
              className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500 transition hover:text-slate-900"
            >
              <Sparkles size={13} /> 去 BRIEFS 找选题
            </Link>
            <button
              type="button"
              onClick={onCreate}
              className="flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-[10px] font-black uppercase tracking-widest text-white shadow-sm transition hover:bg-slate-800"
            >
              <Plus size={13} /> 新建测验
            </button>
          </>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1">
          <Pill active={topic === 'all'} onClick={() => setTopic('all')}>
            全部
            <span className="ml-2 tabular-nums opacity-40">{rows.length}</span>
          </Pill>
          {topics.map((item) => (
            <Pill
              key={item.slug}
              active={topic.toLowerCase() === item.label.toLowerCase()}
              onClick={() => setTopic(item.label)}
            >
              {item.label}
              <span className="ml-2 tabular-nums opacity-40">{item.count}</span>
            </Pill>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2.5">
            <Search size={14} className="text-slate-300" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索标题 / slug / 分类…"
              className="w-48 bg-transparent text-xs font-semibold text-slate-700 outline-none placeholder:text-slate-300"
            />
          </div>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-500 outline-none"
            aria-label="按状态筛选"
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setSortByHealth((value) => !value)}
            className={cn(
              'flex items-center gap-2 rounded-2xl border px-3 py-2.5 text-[10px] font-black uppercase tracking-widest transition',
              sortByHealth
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-200 bg-white text-slate-400 hover:text-slate-900'
            )}
            title="按健康分从低到高排序"
          >
            <ArrowUpDown size={13} /> 健康分
          </button>
        </div>
      </div>

      <Panel padded={false} className="overflow-visible">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-24">
            <Loader2 size={28} className="animate-spin text-slate-200" />
            <p className="mt-4 text-[10px] font-black uppercase tracking-widest text-slate-300">
              正在读取 quizzes 表…
            </p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <AlertTriangle size={34} className="text-rose-300" />
            <p className="mt-4 max-w-md text-xs font-bold text-rose-500">{error}</p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-5 rounded-2xl bg-slate-900 px-5 py-3 text-[10px] font-black uppercase tracking-widest text-white"
            >
              重试
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <Inbox size={38} className="text-slate-200" />
            <p className="mt-4 text-sm font-bold text-slate-400">数据库里还没有测验</p>
            <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-300">
              新建一条，或者从 BRIEFS 的选题开始
            </p>
            <button
              type="button"
              onClick={onCreate}
              className="mt-5 flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-[10px] font-black uppercase tracking-widest text-white"
            >
              <Plus size={13} /> 新建测验
            </button>
          </div>
        ) : (
          <>
            <div
              className={cn(
                'hidden items-center gap-4 border-b border-slate-100 px-7 py-4 lg:grid',
                GRID
              )}
            >
              <Label>Quiz</Label>
              <Label>Topic</Label>
              <Label>Format</Label>
              <Label>Health</Label>
              <Label>Q / R</Label>
              <Label>Status</Label>
              <span />
            </div>

            <div className="divide-y divide-slate-50">
              {visible.map((row) => {
                const health = healthMap.get(row.id) || quizHealth(row)
                const categories = quizCategories({
                  categories: row.categories ?? (row.raw_data as any)?.categories,
                })
                const topicLabel = categories[0] || '未分类'
                const busy = busyId === row.id
                return (

                  <div
                    key={row.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => actions.onOpenDetail(row)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        actions.onOpenDetail(row)
                      }
                    }}
                    className={cn(
                      'group relative grid cursor-pointer grid-cols-1 items-center gap-4 px-5 py-4 transition hover:bg-slate-50/70 lg:px-7',
                      GRID
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-4">
                      <div className="h-12 w-12 shrink-0 overflow-hidden rounded-2xl border border-slate-100 bg-slate-100">
                        {row.cover_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={row.cover_url} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-slate-300">
                            <ImageIcon size={16} />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-bold text-slate-900">
                            {row.title || 'Untitled'}
                          </p>
                          {row.is_featured ? (
                            <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[8px] font-black uppercase tracking-widest text-amber-600">
                              主推
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-0.5 truncate text-[10px] font-medium text-slate-400">
                          /quizzes/{row.slug || row.id}
                        </p>
                        {health.note ? (
                          <p className="mt-1 flex items-start gap-1 text-[10px] font-medium leading-relaxed text-orange-500">
                            <AlertTriangle size={10} className="mt-0.5 shrink-0" />
                            <span className="line-clamp-1">{health.note}</span>
                          </p>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 lg:block">
                      <span className="rounded-lg bg-blue-50 px-2.5 py-1 text-[10px] font-bold text-blue-600">
                        {topicLabel}
                      </span>
                      <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 lg:hidden">
                        {quizModelLabel(row)} · {quizQuestionCount(row)}Q / {quizResultCount(row)}R
                      </span>
                    </div>

                    <p className="hidden text-[11px] font-semibold text-slate-400 lg:block">
                      {quizModelLabel(row)}
                    </p>

                    <div className="flex items-center gap-3">
                      <HealthBadge score={health.score} compact />
                      <div className="w-12 lg:w-16">
                        <HealthBar score={health.score} />
                      </div>
                    </div>

                    <p className="hidden text-[11px] font-bold tabular-nums text-slate-400 lg:block">
                      {quizQuestionCount(row)} / {quizResultCount(row)}
                    </p>

                    <div className="flex items-center justify-between gap-3 lg:block">
                      <StatusTag status={statusOf(row)} />
                    </div>

                    <div className="absolute right-4 top-4 lg:static">
                      <QuizRowMenu
                        row={row}
                        status={statusOf(row)}
                        actions={actions}
                        busy={busy}
                      />
                    </div>
                  </div>
                )
              })}
            </div>

            {visible.length === 0 ? (
              <div className="px-7 py-16 text-center text-xs font-semibold text-slate-300">
                没有匹配的测验，换个关键词或筛选条件
              </div>
            ) : null}
          </>
        )}
      </Panel>

      <p className="px-2 text-[9px] font-bold uppercase leading-relaxed tracking-widest text-slate-300">
        点一行打开详情；右侧三个点可以直接编辑 / 发布 / 复制 / 删除。健康分：axes 卷走全枚举检查，旧卷按结构完整度检查。
      </p>
    </div>
  )
}

