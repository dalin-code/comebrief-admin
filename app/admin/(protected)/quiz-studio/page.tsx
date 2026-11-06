'use client'

/**
 * Quiz Studio /admin/quiz-studio
 *
 * 静态稿 `/mockup/quiz-studio` 的落地版：同一套 6 屏，但每一屏都接真实 Supabase。
 *
 * 之前「点列表没反应、点三个点没反应」的原因是列表直接渲染 `data.ts` 的假数据，
 * 按钮没有 onClick。这里做了三件关键的事：
 *   1. 行点击 = 打开详情抽屉（能看到题目、结果、检查项、前台地址）；
 *   2. 三个点 = 真实菜单（编辑 / 前台 / 主推 / 复制 / 发布 / 删除）；
 *   3. 矩阵保存 / 发布 / 下线 / 复制 / 删除全部写回 `quizzes` 表，并刷新列表。
 *
 * 旧 `/admin/quizzes` 列表仍然保留，作为 fallback 入口；侧边栏默认指向这里。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ArrowUpRight, BrainCircuit, Loader2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { effectiveStatus, markPublishedLocally, publishDueRows } from '@/lib/scheduled'
import { auditAxeQuiz, type AxeQuiz } from '@/lib/quizAxes'
import {
  buildAxesRawData,
  duplicateQuizRow,
  publicQuizUrl,
  quizHealth,
  quizModel,
  quizTopicList,
  type QuizRow,
} from '@/lib/quizStudio'
import {
  deleteQuizRow,
  insertQuizRow,
  updateQuizRow,
} from '@/lib/quizStudioDb'
import { cn, Toast, type ToastKind } from '@/app/admin/_components/quiz-studio/ui'
import type { QuizStudioActions, StudioScreen } from '@/app/admin/_components/quiz-studio/types'
import QuizStudioList from '@/app/admin/_components/quiz-studio/QuizStudioList'
import QuizStudioMatrix from '@/app/admin/_components/quiz-studio/QuizStudioMatrix'
import QuizStudioChecks from '@/app/admin/_components/quiz-studio/QuizStudioChecks'
import QuizStudioTaxonomy from '@/app/admin/_components/quiz-studio/QuizStudioTaxonomy'
import QuizStudioReview from '@/app/admin/_components/quiz-studio/QuizStudioReview'
import QuizStudioFront from '@/app/admin/_components/quiz-studio/QuizStudioFront'
import QuizDetailDrawer from '@/app/admin/_components/quiz-studio/QuizDetailDrawer'
import IndexNowButton from '@/app/admin/_components/IndexNowButton'

const TABS: Array<{ id: StudioScreen; label: string; sub: string }> = [
  { id: 'list', label: '列表', sub: 'quizzes' },
  { id: 'matrix', label: '矩阵', sub: 'logic' },
  { id: 'checks', label: '检查', sub: 'pre-flight' },
  { id: 'taxonomy', label: '分类', sub: 'topics' },
  { id: 'review', label: '待放行', sub: 'review' },
  { id: 'front', label: '前台', sub: 'preview' },
]

export default function QuizStudioPage() {
  const router = useRouter()
  const [rows, setRows] = useState<QuizRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [screen, setScreen] = useState<StudioScreen>('list')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [listTopic, setListTopic] = useState('all')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [toast, setToast] = useState<{ kind: ToastKind; message: string } | null>(null)
  const toastTimer = useRef<number | null>(null)
  const isFetching = useRef(false)

  const notify = useCallback((kind: ToastKind, message: string) => {
    setToast({ kind, message })
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 5000)
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    }
  }, [])

  const fetchQuizzes = useCallback(
    async (silent = false) => {
      if (isFetching.current) return
      isFetching.current = true
      if (!silent) setLoading(true)
      setError(null)
      try {
        const { data, error: fetchError } = await supabase
          .from('quizzes')
          .select('*')
          .order('created_at', { ascending: false })

        if (fetchError) throw fetchError

        // 到点的定时内容先真正翻成 published —— 与旧列表同一个自愈逻辑。
        const { flipped } = await publishDueRows(supabase, 'quizzes', data || [])
        setRows(markPublishedLocally(data || [], flipped) as QuizRow[])
      } catch (err: any) {
        console.error('Quiz Studio fetch failed:', err)
        setError(err?.message || '读取 quizzes 失败，请检查登录状态与网络')
      } finally {
        setLoading(false)
        isFetching.current = false
      }
    },
    []
  )

  useEffect(() => {
    fetchQuizzes()
  }, [fetchQuizzes])

  const detailRow = useMemo(
    () => (detailId ? rows.find((row) => row.id === detailId) || null : null),
    [detailId, rows]
  )

  const healths = useMemo(() => {
    const map = new Map<string, ReturnType<typeof quizHealth>>()
    for (let i = 0; i < rows.length; i += 1) map.set(rows[i].id, quizHealth(rows[i]))
    return map
  }, [rows])

  const blockerCount = Array.from(healths.values()).reduce(
    (sum, health) => sum + health.blockers.length,
    0
  )
  const draftCount = rows.filter((row) => effectiveStatus(row) === 'draft').length
  const axesCount = rows.filter((row) => quizModel(row) === 'axes').length
  const topicCount = quizTopicList(rows).length
  const detailStatus = detailRow ? effectiveStatus(detailRow) : 'draft'

  const tabBadge = (id: StudioScreen): string | null => {
    if (id === 'list') return String(rows.length)
    if (id === 'matrix') return String(axesCount)
    if (id === 'checks') return blockerCount ? String(blockerCount) : null
    if (id === 'taxonomy') return String(topicCount)
    if (id === 'review') return String(draftCount)
    return null
  }

  const withBusy = async (id: string, task: () => Promise<void>) => {
    if (busyId) return
    setBusyId(id)
    try {
      await task()
    } finally {
      setBusyId(null)
    }
  }

  const handleTogglePublish = (row: QuizRow) =>
    withBusy(row.id, async () => {
      const status = effectiveStatus(row)

      if (status === 'published') {
        if (!window.confirm(`确定下线「${row.title || 'Untitled'}」？前台会回到草稿状态。`)) return
        const { error: updateError } = await updateQuizRow(row.id, {
          status: 'draft',
          active: false,
          published_at: null,
        })
        if (updateError) {
          notify('error', `下线失败：${updateError}`)
          return
        }
        await fetchQuizzes(true)
        notify('success', '已下线，前台不再展示')
        return
      }

      const health = quizHealth(row)
      if (health.blockers.length) {
        notify(
          'error',
          `还有 ${health.blockers.length} 个 blocker：${health.blockers[0]?.detail || health.blockers[0]?.label || '先修完再发布'}`
        )
        return
      }

      const { error: updateError } = await updateQuizRow(row.id, {
        status: 'published',
        active: true,
        published_at: new Date().toISOString(),
        scheduled_at: null,
      })
      if (updateError) {
        notify('error', `发布失败：${updateError}`)
        return
      }
      await fetchQuizzes(true)
      notify('success', '已发布上线')
    })

  const handleToggleFeatured = async (row: QuizRow) => {
    const next = !row.is_featured
    const minOrder = rows.reduce(
      (min, item) => (item.is_featured ? Math.min(min, Number(item.featured_order) || 0) : min),
      0
    )
    const payload = next
      ? { is_featured: true, featured_order: minOrder - 1 }
      : { is_featured: false, featured_order: 0 }

    setRows((prev) => prev.map((item) => (item.id === row.id ? { ...item, ...payload } : item)))
    const { error: updateError } = await updateQuizRow(row.id, payload)
    if (updateError) {
      notify('error', `主推切换失败：${updateError}`)
      await fetchQuizzes(true)
      return
    }
    notify('success', next ? '已设为主推' : '已取消主推')
  }

  const handleDuplicate = (row: QuizRow) =>
    withBusy(row.id, async () => {
      const payload = duplicateQuizRow(row)
      const { row: created, error: insertError } = await insertQuizRow(payload)
      if (insertError) {
        notify('error', `复制失败：${insertError}`)
        return
      }
      await fetchQuizzes(true)
      if (created?.id) setDetailId(created.id)
      notify('success', '已复制为草稿')
      setScreen('list')
    })

  const handleDelete = (row: QuizRow) =>
    withBusy(row.id, async () => {
      if (!window.confirm(`确定删除「${row.title || 'Untitled'}」？这个动作不可恢复。`)) return
      const { error: deleteError } = await deleteQuizRow(row.id)
      if (deleteError) {
        notify('error', `删除失败：${deleteError}`)
        return
      }
      if (detailId === row.id) setDetailId(null)
      await fetchQuizzes(true)
      notify('success', '已删除')
    })

  const handleSaveMatrix = async (row: QuizRow, quiz: AxeQuiz, publish: boolean) => {
    const audit = auditAxeQuiz({ ...quiz, model: 'axes' })
    if (publish && (!audit || audit.blockers.length)) {
      notify(
        'error',
        audit?.blockers.length
          ? `还有 ${audit.blockers.length} 个 blocker，先修完再发布`
          : 'axes 卷结构不完整，无法发布'
      )
      return false
    }

    const raw = buildAxesRawData(row, quiz)
    const payload: Record<string, any> = {
      raw_data: raw,
      title: quiz.title?.trim() || row.title,
      categories: raw.categories,
      tags: raw.tags,
      cover_url: raw.cover_url,
      scoring_mode: 'axes',
    }
    if (publish) {
      payload.status = 'published'
      payload.active = true
      payload.published_at = new Date().toISOString()
      payload.scheduled_at = null
    }

    setBusyId(row.id)
    try {
      const { error: updateError } = await updateQuizRow(row.id, payload)
      if (updateError) {
        notify('error', `保存失败：${updateError}`)
        return false
      }
      await fetchQuizzes(true)
      notify('success', publish ? '已保存并发布' : '矩阵已保存')
      return true
    } finally {
      setBusyId(null)
    }
  }

  const actions: QuizStudioActions = {
    onEdit: (row) => router.push(`/admin/quizzes/create?id=${row.id}`),
    onPreview: (row) => {
      const url = publicQuizUrl(row)
      if (!url) {
        notify('error', '这条测验没有 slug / id，拼不出前台地址')
        return
      }
      if (effectiveStatus(row) === 'draft') {
        notify('info', '这是草稿：前台可能 404，发布后再确认')
      }
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    onTogglePublish: (row) => {
      void handleTogglePublish(row)
    },
    onToggleFeatured: (row) => {
      void handleToggleFeatured(row)
    },
    onDuplicate: (row) => {
      void handleDuplicate(row)
    },
    onDelete: (row) => {
      void handleDelete(row)
    },
    onOpenMatrix: (row) => {
      if (quizModel(row) !== 'axes') {
        router.push(`/admin/quizzes/create?id=${row.id}`)
        return
      }
      setSelectedId(row.id)
      setScreen('matrix')
    },
    onOpenDetail: (row) => setDetailId(row.id),
  }

  const openChecks = (row: QuizRow) => {
    setSelectedId(row.id)
    setScreen('checks')
  }

  const openTopic = (topic: string) => {
    setListTopic(topic)
    setScreen('list')
  }

  return (

    <div className="min-h-screen bg-[#F8F9FB] px-4 py-6 lg:px-8 lg:py-8">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4 rounded-[28px] border border-slate-100 bg-white px-5 py-4 shadow-sm">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-900 text-white">
              <BrainCircuit size={18} />
            </span>
            <div>
              <p className="text-sm font-black italic tracking-tight text-slate-900">
                Quiz Studio<span className="text-[#FF6B3D]">.</span>
              </p>
              <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400">
                真实数据 · 真实动作 · /admin/quiz-studio
              </p>
            </div>
            {blockerCount ? (
              <span className="flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-1 text-[9px] font-black uppercase tracking-widest text-rose-600">
                <AlertTriangle size={10} /> {blockerCount} blocker
              </span>
            ) : (
              <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[9px] font-black uppercase tracking-widest text-emerald-600">
                LIVE
              </span>
            )}
          </div>

          <nav className="flex max-w-full flex-wrap items-center gap-1 overflow-x-auto rounded-2xl bg-slate-50 p-1">
            {TABS.map((tab) => {
              const active = screen === tab.id
              const badge = tabBadge(tab.id)
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setScreen(tab.id)}
                  className={cn(
                    'flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-[10px] font-black uppercase tracking-widest transition',
                    active ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-400 hover:text-slate-900'
                  )}
                >
                  {tab.label}
                  {badge ? (
                    <span
                      className={cn(
                        'rounded-full px-1.5 py-0.5 text-[8px] tabular-nums',
                        active
                          ? 'bg-white/15 text-white'
                          : tab.id === 'checks'
                            ? 'bg-rose-50 text-rose-500'
                            : 'bg-white text-slate-400'
                      )}
                    >
                      {badge}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </nav>

          <div className="flex flex-wrap items-center gap-2">
            <IndexNowButton className="px-4 py-3 rounded-2xl text-[10px]" iconSize={13} />
            <Link
              href="/admin/quizzes"
              className="flex items-center gap-1.5 rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-[9px] font-black uppercase tracking-widest text-slate-500 transition hover:text-slate-900"
              title="新工作台还没覆盖到的旧操作，可以从旧列表进"
            >
              旧版列表 <ArrowUpRight size={11} />
            </Link>
            <button
              type="button"
              onClick={() => router.push('/admin/quizzes/create')}
              className="rounded-2xl bg-slate-900 px-4 py-3 text-[10px] font-black uppercase tracking-widest text-white transition hover:bg-slate-800"
            >
              新建
            </button>
          </div>
        </header>

        {loading && screen !== 'list' ? (
          <div className="flex flex-col items-center justify-center rounded-[32px] border border-slate-100 bg-white py-32">
            <Loader2 size={28} className="animate-spin text-slate-200" />
            <p className="mt-4 text-[10px] font-black uppercase tracking-widest text-slate-300">
              正在读取 quizzes 表…
            </p>
          </div>
        ) : screen === 'list' ? (
          <QuizStudioList
            key={listTopic}
            rows={rows}
            loading={loading}
            error={error}
            initialTopic={listTopic}
            busyId={busyId}
            actions={actions}
            onCreate={() => router.push('/admin/quizzes/create')}
            onRetry={() => fetchQuizzes()}
          />
        ) : screen === 'matrix' ? (
          <QuizStudioMatrix
            key={selectedId || 'auto'}
            rows={rows}
            selectedId={selectedId}
            busy={Boolean(busyId)}
            onSelect={setSelectedId}
            onSave={handleSaveMatrix}
            onCreate={() => router.push('/admin/quizzes/create')}
            onEdit={(row) => router.push(`/admin/quizzes/create?id=${row.id}`)}
          />
        ) : screen === 'checks' ? (
          <QuizStudioChecks
            rows={rows}
            selectedId={selectedId}
            actions={actions}
            onSelect={setSelectedId}
            onRefresh={() => fetchQuizzes(true)}
          />
        ) : screen === 'taxonomy' ? (
          <QuizStudioTaxonomy rows={rows} onOpenTopic={openTopic} />
        ) : screen === 'review' ? (
          <QuizStudioReview
            rows={rows}
            actions={actions}
            onOpenChecks={openChecks}
            onRefresh={() => fetchQuizzes(true)}
          />
        ) : (
          <QuizStudioFront rows={rows} />
        )}

        <QuizDetailDrawer
          row={detailRow}
          status={detailStatus}
          actions={actions}
          busy={Boolean(detailRow && busyId === detailRow.id)}
          onClose={() => setDetailId(null)}
        />

        <Toast toast={toast} />
      </div>
    </div>
  )
}

