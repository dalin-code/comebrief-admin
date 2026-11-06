'use client'

import React, { useMemo, useState } from 'react'
import { LayoutGrid, Loader2, RotateCcw, Save } from 'lucide-react'
import QuizAxesEditor, { blankAxeQuiz } from '@/app/admin/_components/QuizAxesEditor'
import { normalizeAxeQuiz, type AxeQuiz } from '@/lib/quizAxes'
import { quizModel, quizModelLabel, type QuizRow } from '@/lib/quizStudio'
import { cn, Label, Panel, StatusTag, StudioHead } from './ui'

export default function QuizStudioMatrix({
  rows,
  selectedId,
  busy = false,
  onSelect,
  onSave,
  onCreate,
  onEdit,
}: {
  rows: QuizRow[]
  selectedId: string | null
  busy?: boolean
  onSelect: (id: string) => void
  onSave: (row: QuizRow, quiz: AxeQuiz, publish: boolean) => Promise<boolean>
  onCreate: () => void
  onEdit: (row: QuizRow) => void
}) {
  const axesRows = useMemo(() => rows.filter((row) => quizModel(row) === 'axes'), [rows])
  const row =
    axesRows.find((item) => item.id === selectedId) ||
    (selectedId ? rows.find((item) => item.id === selectedId && quizModel(item) === 'axes') : null) ||
    axesRows[0] ||
    null

  const baseQuiz = useMemo(() => {
    if (!row) return null
    return normalizeAxeQuiz(row.raw_data)?.quiz ?? null
  }, [row])

  // 父级用 `key={selectedId}` 在切换测验时重挂载本组件，draft 直接以当前行初始化；
  // 保存后 row 变新、key 不变，draft 仍是我们刚提交的那份，不会把用户改回旧值。
  const [draft, setDraft] = useState<AxeQuiz | null>(baseQuiz)
  const [dirty, setDirty] = useState(false)
  const [view, setView] = useState<'matrix' | 'archetypes'>('matrix')

  // 故意不在父级再跑一次 auditAxeQuiz：QuizAxesEditor 右栏已经用 140ms 防抖算过，
  // 这里每敲一个字再全枚举一遍会让输入卡顿。发布前的 blocker 检查放在 onSave 里。
  const change = (next: AxeQuiz) => {
    setDraft(next)
    setDirty(true)
  }

  const reset = () => {
    setDraft(baseQuiz)
    setDirty(false)
  }

  const save = async (publish: boolean) => {
    if (!row || !draft) return
    const ok = await onSave(row, draft, publish)
    if (ok) setDirty(false)
  }

  if (!axesRows.length) {
    return (
      <div className="space-y-6">
        <StudioHead
          title={
            <>
              Logic<span className="text-[#FF6B3D]">.</span>
            </>
          }
          sub="0 条原型卷 · 旧的 Score / Personality 卷请用列表里的「编辑内容」"
          actions={
            <button
              type="button"
              onClick={onCreate}
              className="flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-[10px] font-black uppercase tracking-widest text-white"
            >
              <LayoutGrid size={13} /> 新建原型卷
            </button>
          }
        />
        <Panel className="py-16 text-center">
          <LayoutGrid size={38} className="mx-auto text-slate-200" />
          <p className="mt-4 text-sm font-bold text-slate-400">还没有 axes 原型卷</p>
          <p className="mx-auto mt-2 max-w-lg text-[11px] font-medium leading-relaxed text-slate-400">
            新建测验时把评分模型选成 <strong>Archetype Matrix</strong>，保存后这里就会出现可编辑的
            0–3 权重表。旧卷没有权重矩阵，不能在 Logic 屏里编辑，但可以在列表里查看详情并打开旧编辑器。
          </p>
          <button
            type="button"
            onClick={onCreate}
            className="mt-5 rounded-2xl bg-slate-900 px-5 py-3 text-[10px] font-black uppercase tracking-widest text-white"
          >
            去新建
          </button>
        </Panel>
      </div>
    )
  }

  if (!row) {
    return (
      <Panel className="py-16 text-center">
        <Loader2 size={28} className="mx-auto animate-spin text-slate-200" />
        <p className="mt-4 text-[10px] font-black uppercase tracking-widest text-slate-300">
          正在读取 axes 数据…
        </p>
      </Panel>
    )
  }

  if (!baseQuiz) {
    return (
      <Panel className="py-16 text-center">
        <LayoutGrid size={34} className="mx-auto text-rose-200" />
        <p className="mt-4 text-sm font-bold text-slate-500">这条卷标了 model=axes，但读不出 axes 结构</p>
        <p className="mx-auto mt-2 max-w-lg text-[10px] font-medium leading-relaxed text-slate-400">
          raw_data 里可能缺 archetypes / questions，或者还是旧的 score 结构。矩阵不能安全地编辑它，
          请先用旧编辑器打开检查；修好后这里会自动出现。
        </p>
        <button
          type="button"
          onClick={() => onEdit(row)}
          className="mt-5 rounded-2xl bg-slate-900 px-5 py-3 text-[10px] font-black uppercase tracking-widest text-white"
        >
          打开旧编辑器
        </button>
      </Panel>
    )
  }

  return (
    <div className="space-y-6">
      <StudioHead
        title={
          <>
            Logic<span className="text-[#FF6B3D]">.</span>
          </>
        }
        sub={`${axesRows.length} 条原型卷 · 点格子循环 0→1→2→3 · 右栏实时重算`}
        actions={
          <>
            <span
              className={cn(
                'flex items-center gap-2 rounded-2xl px-4 py-3 text-[10px] font-black uppercase tracking-widest',
                dirty ? 'bg-amber-50 text-amber-600' : 'bg-slate-50 text-slate-300'
              )}
            >
              <span
                className={cn('h-1.5 w-1.5 rounded-full', dirty ? 'bg-amber-500' : 'bg-slate-300')}
              />
              {dirty ? '未保存' : '已同步'}
            </span>
            <button
              type="button"
              onClick={reset}
              disabled={!dirty || busy}
              className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500 transition hover:text-slate-900 disabled:opacity-40"
            >
              <RotateCcw size={13} /> 重置
            </button>
            <button
              type="button"
              onClick={() => save(false)}
              disabled={!dirty || busy}
              className="flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-[10px] font-black uppercase tracking-widest text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-40"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} 保存
            </button>
            <button
              type="button"
              onClick={() => save(true)}
              disabled={busy}
              title="保存并发布（发布前会跑一遍 12 项检查，有 blocker 会被拦住）"
              className="flex items-center gap-2 rounded-2xl bg-emerald-500 px-5 py-3 text-[10px] font-black uppercase tracking-widest text-white shadow-sm transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              保存并发布
            </button>
          </>
        }
      />

      <div className="flex flex-wrap items-end justify-between gap-4 rounded-[32px] border border-slate-100 bg-white px-6 py-5 shadow-sm">
        <div className="min-w-0 flex-1">
          <Label>正在编辑</Label>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <select
              value={row.id}
              onChange={(event) => onSelect(event.target.value)}
              className="max-w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-800 outline-none"
            >
              {axesRows.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title || 'Untitled'}
                </option>
              ))}
            </select>
            <StatusTag
              status={(row.status as string) || (row.active === false ? 'draft' : 'published')}
            />
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[9px] font-black uppercase tracking-widest text-slate-500">
              {quizModelLabel(row)}
            </span>
            <span className="text-[9px] font-bold uppercase tracking-widest text-slate-400">
              右栏实时显示 blocker
            </span>
          </div>
        </div>
        <p className="max-w-lg text-[10px] font-medium leading-relaxed text-slate-400">
          这里保存的是 <code className="font-mono">quizzes.raw_data</code> 里的 archetypes + questions；
          标题、分类、封面等外层字段保持不变。发布前会先跑一遍与 CI 同源的 12 项检查。
        </p>
      </div>

      <div className="h-[76vh] min-h-[680px] overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-sm">
        <QuizAxesEditor
          quiz={draft || blankAxeQuiz()}
          onChange={change}
          view={view}
          onViewChange={setView}
        />
      </div>
    </div>
  )
}

