'use client'

import React, { useMemo } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ExternalLink,
  LayoutGrid,
  Pencil,
  ShieldCheck,
  X,
} from 'lucide-react'
import { effectiveStatus } from '@/lib/scheduled'
import {
  formatStudioDate,
  publicQuizUrl,
  publicTopicUrl,
  quizCategories,
  quizHealth,
  quizModel,
  type QuizRow,
} from '@/lib/quizStudio'
import { cn, HealthBar, Label, Panel, StatusTag, StudioHead } from './ui'
import type { QuizStudioActions } from './types'

function CheckLine({ check }: { check: ReturnType<typeof quizHealth>['checks'][number] }) {
  return (
    <li className="flex items-start gap-3 rounded-2xl border border-slate-100 p-3">
      <span
        className={cn(
          'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
          check.level === 'ok'
            ? 'bg-emerald-50 text-emerald-600'
            : check.level === 'warning'
              ? 'bg-amber-50 text-amber-500'
              : 'bg-rose-50 text-rose-600'
        )}
      >
        {check.level === 'ok' ? (
          <Check size={12} strokeWidth={3} />
        ) : check.level === 'warning' ? (
          <AlertTriangle size={12} strokeWidth={3} />
        ) : (
          <X size={12} strokeWidth={3} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn('text-[11px] font-black', check.level === 'ok' ? 'text-slate-400' : 'text-slate-700')}>
          {check.label}
        </p>
        {check.detail ? (
          <p className="mt-1 text-[10px] font-medium leading-relaxed text-slate-400">{check.detail}</p>
        ) : null}
      </div>
      {check.level !== 'ok' ? (
        <span className="shrink-0 text-[10px] font-black text-slate-300">−{check.penalty}</span>
      ) : null}
    </li>
  )
}

export default function QuizStudioChecks({
  rows,
  selectedId,
  actions,
  onSelect,
  onRefresh,
}: {
  rows: QuizRow[]
  selectedId: string | null
  actions: QuizStudioActions
  onSelect: (id: string) => void
  onRefresh: () => void
}) {
  const row = rows.find((item) => item.id === selectedId) || rows[0] || null
  const health = useMemo(() => quizHealth(row), [row])
  const status = row ? effectiveStatus(row) : 'draft'
  const model = quizModel(row)
  const categories = quizCategories({
    categories: row?.categories ?? (row?.raw_data as any)?.categories,
  })
  const topic = categories[0] || ''
  const quizUrl = row ? publicQuizUrl(row) : ''
  const topicUrl = topic ? publicTopicUrl(topic) : ''

  if (!row) {
    return (
      <Panel className="py-16 text-center">
        <ShieldCheck size={36} className="mx-auto text-slate-200" />
        <p className="mt-4 text-sm font-bold text-slate-400">还没有可检查的测验</p>
      </Panel>
    )
  }

  return (
    <div className="space-y-6">
      <StudioHead
        title={
          <>
            Pre-flight<span className="text-[#FF6B3D]">.</span>
          </>
        }
        sub={`${health.checks.length} 项检查 · ${health.blockers.length} blocker / ${health.warnings.length} warning · 与 CI 的 check:quiz 同源`}
        actions={
          <>
            <select
              value={row.id}
              onChange={(event) => onSelect(event.target.value)}
              className="max-w-[280px] rounded-2xl border border-slate-200 bg-white px-4 py-3 text-[11px] font-bold text-slate-700 outline-none"
            >
              {rows.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title || 'Untitled'}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={onRefresh}
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500 transition hover:text-slate-900"
            >
              重新读取
            </button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[
              { label: 'Health', value: health.score, suffix: '/100', tone: 'text-slate-900' },
              { label: 'Blockers', value: health.blockers.length, suffix: '项', tone: 'text-rose-500' },
              { label: 'Warnings', value: health.warnings.length, suffix: '项', tone: 'text-amber-500' },
            ].map((item) => (
              <Panel key={item.label}>
                <Label>{item.label}</Label>
                <p className={cn('mt-2 text-3xl font-black tabular-nums tracking-tighter', item.tone)}>
                  {item.value}
                  <span className="ml-1 text-xs font-bold text-slate-300">{item.suffix}</span>
                </p>
              </Panel>
            ))}
          </div>

          <Panel className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <Label>{row.title || 'Untitled'}</Label>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <StatusTag status={status} />
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[9px] font-black uppercase tracking-widest text-slate-500">
                    {model}
                  </span>
                  {categories.map((category) => (
                    <span
                      key={category}
                      className="rounded-full bg-blue-50 px-2.5 py-1 text-[9px] font-bold text-blue-600"
                    >
                      {category}
                    </span>
                  ))}
                </div>
              </div>
              <div className="w-40">
                <HealthBar score={health.score} />
              </div>
            </div>

            <ul className="space-y-2">
              {health.checks.map((check) => (
                <CheckLine key={check.id} check={check} />
              ))}
            </ul>
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel className="space-y-4">
            <Label>上线状态</Label>
            <div className="space-y-2 text-[11px]">
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-400">当前</span>
                <StatusTag status={status} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-400">active</span>
                <span className="font-mono font-bold text-slate-600">{String(row.active ?? '—')}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-400">发布</span>
                <span className="font-bold text-slate-600">{formatStudioDate(row.published_at)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-400">定时</span>
                <span className="font-bold text-slate-600">{formatStudioDate(row.scheduled_at)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-400">更新</span>
                <span className="font-bold text-slate-600">{formatStudioDate(row.updated_at)}</span>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => actions.onTogglePublish(row)}
                disabled={status !== 'published' && health.blockers.length > 0}
                title={
                  status !== 'published' && health.blockers.length > 0
                    ? '还有 blocker，修完再发布'
                    : undefined
                }
                className={cn(
                  'flex items-center justify-center gap-2 rounded-2xl px-4 py-3 text-[10px] font-black uppercase tracking-widest transition disabled:cursor-not-allowed disabled:opacity-40',
                  status === 'published'
                    ? 'border border-amber-200 bg-amber-50 text-amber-700'
                    : 'bg-emerald-500 text-white hover:bg-emerald-600'
                )}
              >
                {status === 'published' ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}
                {status === 'published' ? '下线（转草稿）' : '发布上线'}
              </button>
              <button
                type="button"
                onClick={() => (model === 'axes' ? actions.onOpenMatrix(row) : actions.onEdit(row))}
                className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-600 transition hover:text-slate-900"
              >
                {model === 'axes' ? <LayoutGrid size={13} /> : <Pencil size={13} />}
                {model === 'axes' ? '去权重矩阵' : '打开编辑器'}
              </button>
            </div>
          </Panel>


          <Panel className="space-y-3">
            <Label>公开地址</Label>
            <div className="space-y-2 text-[10px]">
              <a
                href={quizUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2 font-mono font-bold text-slate-500 transition hover:text-slate-900"
              >
                <span className="truncate">{quizUrl || '—'}</span>
                <ExternalLink size={11} className="shrink-0" />
              </a>
              {topicUrl ? (
                <a
                  href={topicUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2 font-mono font-bold text-slate-500 transition hover:text-slate-900"
                >
                  <span className="truncate">{topicUrl}</span>
                  <ExternalLink size={11} className="shrink-0" />
                </a>
              ) : null}
            </div>
            <p className="text-[10px] font-medium leading-relaxed text-slate-400">
              只有已发布（或到点的定时）测验才会出现在前台。主题页至少要有 1 条可见测验；
              0 条时该地址是 404，不会被 sitemap 收录。
            </p>
          </Panel>

          <Panel className="!border-slate-900 !bg-slate-900">
            <Label className="!text-slate-500">发布规则</Label>
            <p className="mt-2 text-[10px] font-medium leading-relaxed text-slate-300">
              草稿随时可以保存；发布动作会被 blocker 拦住。axes 卷的检查跑的是完整枚举，
              和 CI 的 <code className="font-mono">check:quiz</code> 同一份判据，后台看到可发布
              就意味着 CI 也会过。
            </p>
            <Link
              href="/admin/quizzes/create"
              className="mt-3 inline-flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest text-cyan-300 hover:text-white"
            >
              新建测验 <ExternalLink size={10} />
            </Link>
          </Panel>
        </div>
      </div>
    </div>
  )
}

