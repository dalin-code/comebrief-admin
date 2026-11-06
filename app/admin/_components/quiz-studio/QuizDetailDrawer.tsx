'use client'

import React, { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Edit3,
  ExternalLink,
  Image as ImageIcon,
  LayoutGrid,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import { normalizeAxeQuiz } from '@/lib/quizAxes'
import {
  formatStudioDate,
  publicQuizUrl,
  quizCategories,
  quizHealth,
  quizModel,
  quizModelLabel,
  quizQuestionCount,
  quizResultCount,
  type QuizRow,
} from '@/lib/quizStudio'
import { cn, HealthBadge, HealthBar, Label, StatusTag } from './ui'
import type { QuizStudioActions } from './types'

function CheckRow({ check }: { check: ReturnType<typeof quizHealth>['checks'][number] }) {
  return (
    <li className="flex items-start gap-2 rounded-xl border border-slate-100 px-3 py-2">
      <span
        className={cn(
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
          check.level === 'ok'
            ? 'bg-emerald-50 text-emerald-600'
            : check.level === 'warning'
              ? 'bg-amber-50 text-amber-500'
              : 'bg-rose-50 text-rose-600'
        )}
      >
        {check.level === 'ok' ? (
          <Check size={11} strokeWidth={3} />
        ) : check.level === 'warning' ? (
          <AlertTriangle size={11} strokeWidth={3} />
        ) : (
          <X size={11} strokeWidth={3} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'text-[10px] font-black leading-snug',
            check.level === 'ok' ? 'text-slate-400' : 'text-slate-700'
          )}
        >
          {check.label}
        </p>
        {check.detail ? (
          <p className="mt-0.5 text-[9px] font-medium leading-relaxed text-slate-400">
            {check.detail}
          </p>
        ) : null}
      </div>
      {check.level !== 'ok' ? (
        <span className="shrink-0 text-[9px] font-black text-slate-300">−{check.penalty}</span>
      ) : null}
    </li>
  )
}

export default function QuizDetailDrawer({
  row,
  status,
  actions,
  busy = false,
  onClose,
}: {
  row: QuizRow | null
  status: string
  actions: QuizStudioActions
  busy?: boolean
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  const health = useMemo(() => quizHealth(row), [row])
  const model = quizModel(row)
  const axes = useMemo(
    () => (model === 'axes' && row ? normalizeAxeQuiz(row.raw_data)?.quiz ?? null : null),
    [model, row]
  )
  const raw = row && row.raw_data && typeof row.raw_data === 'object' ? (row.raw_data as any) : {}
  const questions = Array.isArray(raw.questions) ? raw.questions : []
  const results = Array.isArray(raw.results) ? raw.results : []
  const categories = quizCategories({ categories: row?.categories ?? raw.categories })
  const url = row ? publicQuizUrl(row) : ''

  useEffect(() => {
    if (!row) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [row, onClose])

  if (!row) return null

  const copyUrl = async () => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

  const enabled = !busy
  const primary =
    'flex items-center justify-center gap-2 rounded-2xl px-4 py-3 text-[10px] font-black uppercase tracking-widest transition disabled:cursor-not-allowed disabled:opacity-40'

  return (
    <div className="fixed inset-0 z-[70] flex justify-end">
      <button
        type="button"
        aria-label="关闭详情"
        onClick={onClose}
        className="absolute inset-0 bg-slate-950/30 backdrop-blur-[2px]"
      />
      <aside className="relative flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl">
        <header className="flex items-start gap-4 border-b border-slate-100 px-6 py-5">
          <div className="h-16 w-16 shrink-0 overflow-hidden rounded-2xl border border-slate-200 bg-slate-100">
            {row.cover_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={row.cover_url} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-slate-300">
                <ImageIcon size={20} />
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusTag status={status} />
              {row.is_featured ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-[9px] font-black uppercase tracking-widest text-amber-600">
                  <Star size={10} fill="currentColor" /> 主推
                </span>
              ) : null}
            </div>
            <h2 className="mt-2 text-xl font-black tracking-tight text-slate-900">
              {row.title || 'Untitled'}
            </h2>
            <p className="mt-1 break-all text-[10px] font-bold uppercase tracking-widest text-slate-400">
              /quizzes/{row.slug || row.id}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-2 text-slate-300 transition hover:bg-slate-100 hover:text-slate-900"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Format', value: quizModelLabel(row) },
              { label: 'Questions', value: quizQuestionCount(row) },
              { label: 'Results', value: quizResultCount(row) },
              { label: 'Updated', value: formatStudioDate(row.updated_at) },
            ].map((item) => (
              <div key={item.label} className="rounded-2xl bg-slate-50 px-3 py-3">
                <Label>{item.label}</Label>
                <p className="mt-1 truncate text-[12px] font-black text-slate-800" title={String(item.value)}>
                  {item.value}
                </p>
              </div>
            ))}
          </div>

          <div className="rounded-2xl border border-slate-100 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label>Health</Label>
                <div className="mt-1 flex items-center gap-3">
                  <HealthBadge score={health.score} />
                  <span className="text-[10px] font-bold text-slate-400">
                    {health.blockers.length} blocker / {health.warnings.length} warning
                  </span>
                </div>
              </div>
              <span className="text-3xl font-black tabular-nums tracking-tighter text-slate-900">
                {health.score}
              </span>
            </div>
            <div className="mt-3">
              <HealthBar score={health.score} />
            </div>
            <ul className="mt-4 max-h-64 space-y-1.5 overflow-y-auto pr-1">
              {health.checks.map((check) => (
                <CheckRow key={check.id} check={check} />
              ))}
            </ul>
          </div>

          <div>
            <Label>Topics</Label>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {categories.length ? (
                categories.map((category) => (
                  <span
                    key={category}
                    className="rounded-lg bg-blue-50 px-2.5 py-1 text-[10px] font-bold text-blue-600"
                  >
                    {category}
                  </span>
                ))
              ) : (
                <span className="text-[10px] font-bold text-slate-300">未分类</span>
              )}
            </div>
          </div>

          <div className="rounded-2xl bg-slate-50 p-4">
            <Label>前台地址</Label>
            <p className="mt-2 break-all font-mono text-[10px] font-bold text-slate-500">{url || '—'}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={copyUrl}
                disabled={!url}
                className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[9px] font-black uppercase tracking-widest text-slate-500 transition hover:text-slate-900 disabled:opacity-40"
              >
                {copied ? <Check size={11} /> : <Copy size={11} />}
                {copied ? '已复制' : '复制链接'}
              </button>
              <button
                type="button"
                onClick={() => actions.onPreview(row)}
                disabled={!enabled || !url}
                className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[9px] font-black uppercase tracking-widest text-slate-500 transition hover:text-slate-900 disabled:opacity-40"
              >
                <ExternalLink size={11} /> 打开前台
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <Label>内容预览</Label>
            {axes ? (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {axes.archetypes.map((archetype) => (
                    <span
                      key={archetype.id}
                      className="rounded-full bg-slate-900 px-3 py-1.5 text-[10px] font-black text-white"
                      title={archetype.headline || archetype.name}
                    >
                      {archetype.short || archetype.name}
                    </span>
                  ))}
                </div>
                <ol className="space-y-2">
                  {axes.questions.map((question, index) => (
                    <li key={question.id || index} className="rounded-2xl border border-slate-100 p-3">
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                        Q{index + 1}
                        {question.scene ? ` · ${question.scene}` : ''}
                      </p>
                      <p className="mt-1 text-[12px] font-bold text-slate-800">
                        {question.title || '（无题干）'}
                      </p>
                      <p className="mt-1 text-[10px] font-medium leading-relaxed text-slate-400">
                        {question.options.map((option) => option.text || '（空选项）').join(' · ')}
                      </p>
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <>
                <ol className="space-y-2">
                  {questions.map((question: any, index: number) => (
                    <li key={question.id || index} className="rounded-2xl border border-slate-100 p-3">
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                        Q{index + 1}
                      </p>
                      <p className="mt-1 text-[12px] font-bold text-slate-800">
                        {question.title || '（无题干）'}
                      </p>
                      <p className="mt-1 text-[10px] font-medium leading-relaxed text-slate-400">
                        {(Array.isArray(question.options) ? question.options : [])
                          .map((option: any) => option.text || '（空选项）')
                          .join(' · ')}
                      </p>
                    </li>
                  ))}
                  {questions.length === 0 ? (
                    <li className="rounded-2xl border border-dashed border-slate-200 py-6 text-center text-[11px] font-bold text-slate-300">
                      没有题目
                    </li>
                  ) : null}
                </ol>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {results.map((result: any, index: number) => (
                    <div key={result.id || index} className="rounded-2xl bg-slate-50 p-3">
                      <p className="text-[11px] font-black text-slate-800">
                        {result.title || '（无结果名）'}
                      </p>
                      <p className="mt-1 line-clamp-2 text-[10px] font-medium leading-relaxed text-slate-400">
                        {result.description || '—'}
                      </p>
                      {result.min_score !== undefined || result.max_score !== undefined ? (
                        <p className="mt-1 text-[9px] font-black uppercase tracking-widest text-slate-300">
                          {result.min_score ?? '?'} – {result.max_score ?? '?'}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <footer className="border-t border-slate-100 bg-white px-6 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => actions.onEdit(row)}
              disabled={!enabled}
              className={cn(primary, 'flex-1 bg-slate-900 text-white hover:bg-slate-800')}
            >
              <Edit3 size={13} /> 编辑内容
            </button>
            {model === 'axes' ? (
              <button
                type="button"
                onClick={() => actions.onOpenMatrix(row)}
                disabled={!enabled}
                className={cn(primary, 'border border-slate-200 bg-white text-slate-600 hover:text-slate-900')}
              >
                <LayoutGrid size={13} /> 权重矩阵
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => actions.onTogglePublish(row)}
              disabled={!enabled}
              className={cn(
                primary,
                status === 'published'
                  ? 'border border-amber-200 bg-amber-50 text-amber-700'
                  : 'bg-emerald-500 text-white hover:bg-emerald-600'
              )}
            >
              {status === 'published' ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}
              {status === 'published' ? '下线' : '发布'}
            </button>
            <button
              type="button"
              onClick={() => actions.onDuplicate(row)}
              disabled={!enabled}
              className={cn(primary, 'border border-slate-200 bg-white text-slate-500 hover:text-slate-900')}
              title="复制一份草稿"
            >
              <Copy size={13} />
            </button>
            <button
              type="button"
              onClick={() => actions.onDelete(row)}
              disabled={!enabled}
              className={cn(primary, 'border border-rose-100 bg-rose-50 text-rose-500 hover:bg-rose-100')}
              title="删除"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </footer>
      </aside>
    </div>
  )
}
