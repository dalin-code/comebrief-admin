'use client'

import React, { useMemo } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Inbox,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { effectiveStatus } from '@/lib/scheduled'
import { formatStudioDate, quizHealth, quizModelLabel, type QuizRow } from '@/lib/quizStudio'
import { cn, HealthBadge, Label, Panel, StatusTag, StudioHead } from './ui'
import type { QuizStudioActions } from './types'

export default function QuizStudioReview({
  rows,
  actions,
  onOpenChecks,
  onRefresh,
}: {
  rows: QuizRow[]
  actions: QuizStudioActions
  onOpenChecks: (row: QuizRow) => void
  onRefresh: () => void
}) {
  // 每条只算一次健康分：axes 卷的检查是全枚举，放在 sort 比较器里会重复算很多遍。
  const queue = useMemo(() => {
    const items = rows
      .filter((row) => {
        const status = effectiveStatus(row)
        return status === 'draft' || status === 'scheduled'
      })
      .map((row) => ({ row, health: quizHealth(row) }))
    items.sort((a, b) => a.health.score - b.health.score)
    return items
  }, [rows])

  const published = rows.filter((row) => effectiveStatus(row) === 'published')
  const scheduled = rows.filter((row) => effectiveStatus(row) === 'scheduled')
  const blockers = queue.reduce((sum, item) => sum + item.health.blockers.length, 0)

  return (
    <div className="space-y-6">
      <StudioHead
        title={
          <>
            Review<span className="text-[#FF6B3D]">.</span>
          </>
        }
        sub={`${queue.length} 条待放行 · ${scheduled.length} 条定时 · ${blockers} 个 blocker · 这里只处理真实队列`}
        actions={
          <>
            <span className="flex items-center gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-[10px] font-black uppercase tracking-widest text-amber-600">
              <Sparkles size={13} /> 自动生成未接入
            </span>
            <button
              type="button"
              onClick={onRefresh}
              className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500 transition hover:text-slate-900"
            >
              <RefreshCcw size={13} /> 刷新
            </button>
          </>
        }
      />

      <Panel className="!bg-slate-50/70">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {[
            {
              label: '采集 / 生成',
              value: '未接入',
              note: '没有假装在跑：选题仍从 BRIEFS 人工决定',
              tone: 'text-slate-400',
              icon: Sparkles,
            },
            {
              label: '校验',
              value: queue.length,
              note: `${blockers} 个 blocker 需要在发布前修掉`,
              tone: blockers ? 'text-rose-500' : 'text-emerald-600',
              icon: ShieldCheck,
            },
            {
              label: '已上线',
              value: published.length,
              note: '真实已发布测验数',
              tone: 'text-emerald-600',
              icon: CheckCircle2,
            },
          ].map((item) => (
            <div key={item.label} className="flex items-start gap-3 rounded-2xl bg-white p-4">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
                <item.icon size={14} />
              </span>
              <div>
                <Label>{item.label}</Label>
                <p className={cn('mt-1 text-lg font-black tabular-nums', item.tone)}>{item.value}</p>
                <p className="mt-1 text-[10px] font-medium leading-relaxed text-slate-400">
                  {item.note}
                </p>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-4 text-[10px] font-medium leading-relaxed text-slate-500">
          静态稿里的 Autopilot 是完整流水线（采集 → 打分 → 生成 → 校验 → 发布）。当前后台没有接
          AI 生成任务，所以这里改成真实可用的<strong>待放行队列</strong>：列出所有草稿 / 定时卷，
          按健康分从低到高排，点「检查」看 blocker，修完再发布。等生成流水线真的接上，再把它放回这一屏。
        </p>
      </Panel>

      <Panel padded={false} className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-6 py-4">
          <div>
            <Label>待放行队列</Label>
            <p className="mt-1 text-[10px] font-medium text-slate-400">
              Health ≥ 90 且 0 blocker 才建议发布；这里不做「一键全发」，避免把坏卷批量放出去。
            </p>
          </div>
          <Link
            href="/admin/trends"
            className="flex items-center gap-1.5 rounded-xl bg-slate-900 px-3 py-2 text-[9px] font-black uppercase tracking-widest text-white"
          >
            去 BRIEFS 选题 <ArrowRight size={11} />
          </Link>
        </div>

        <div className="divide-y divide-slate-50">
          {queue.map(({ row, health }) => {
            const status = effectiveStatus(row)
            const blocked = health.blockers.length > 0
            return (
              <div key={row.id} className="flex flex-wrap items-start gap-4 px-6 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => actions.onOpenDetail(row)}
                      className="truncate text-left text-[12px] font-bold text-slate-900 hover:underline"
                    >
                      {row.title || 'Untitled'}
                    </button>
                    <StatusTag status={status} />
                    <span className="text-[9px] font-bold uppercase tracking-widest text-slate-400">
                      {quizModelLabel(row)}
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] font-medium text-slate-400">
                    更新 {formatStudioDate(row.updated_at)}
                    {health.note ? ` · ${health.note}` : ' · 没有发现 blocker'}
                  </p>
                  {blocked ? (
                    <p className="mt-1 flex items-start gap-1 text-[10px] font-medium leading-relaxed text-rose-500">
                      <AlertTriangle size={10} className="mt-0.5 shrink-0" />
                      {health.blockers.length} 个 blocker，发布按钮已锁
                    </p>
                  ) : null}
                </div>

                <div className="flex items-center gap-2">
                  <HealthBadge score={health.score} compact />
                  <button
                    type="button"
                    onClick={() => onOpenChecks(row)}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-[9px] font-black uppercase tracking-widest text-slate-500 transition hover:text-slate-900"
                  >
                    检查
                  </button>
                  <button
                    type="button"
                    onClick={() => actions.onTogglePublish(row)}
                    disabled={blocked}
                    title={blocked ? '还有 blocker，先去检查页修掉' : '发布上线'}
                    className={cn(
                      'flex items-center gap-1.5 rounded-xl px-3 py-2 text-[9px] font-black uppercase tracking-widest transition disabled:cursor-not-allowed disabled:opacity-40',
                      status === 'published'
                        ? 'bg-amber-50 text-amber-700'
                        : 'bg-emerald-500 text-white hover:bg-emerald-600'
                    )}
                  >
                    {status === 'published' ? <AlertTriangle size={10} /> : <Check size={10} />}
                    {status === 'published' ? '下线' : '放行'}
                  </button>
                  <button
                    type="button"
                    onClick={() => actions.onDelete(row)}
                    className="rounded-xl border border-rose-100 bg-rose-50 p-2 text-rose-500 transition hover:bg-rose-100"
                    title="删除"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>
            )
          })}

          {queue.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Inbox size={34} className="text-slate-200" />
              <p className="mt-3 text-sm font-bold text-slate-400">队列是空的</p>
              <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-300">
                没有草稿 / 定时测验需要放行
              </p>
            </div>
          ) : null}
        </div>
      </Panel>
    </div>
  )
}

