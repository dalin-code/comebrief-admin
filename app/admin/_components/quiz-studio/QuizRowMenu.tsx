'use client'

import React, { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Edit3,
  Eye,
  ExternalLink,
  LayoutGrid,
  MoreHorizontal,
  Star,
  Trash2,
} from 'lucide-react'
import { quizModel, type QuizRow } from '@/lib/quizStudio'
import { cn } from './ui'
import type { QuizStudioActions } from './types'

export default function QuizRowMenu({
  row,
  status,
  actions,
  busy = false,
  align = 'right',
}: {
  row: QuizRow
  status: string
  actions: QuizStudioActions
  busy?: boolean
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const run = (fn: () => void) => {
    setOpen(false)
    fn()
  }

  const item =
    'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[11px] font-bold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40'

  return (
    <div ref={ref} className="relative" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={busy}
        aria-label="更多操作"
        aria-expanded={open}
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-lg text-slate-300 transition hover:bg-slate-100 hover:text-slate-900',
          open && 'bg-slate-100 text-slate-900',
          busy && 'opacity-40'
        )}
      >
        <MoreHorizontal size={16} />
      </button>

      {open ? (
        <div
          className={cn(
            'absolute top-full z-50 mt-2 w-52 overflow-hidden rounded-2xl border border-slate-100 bg-white p-1.5 shadow-xl shadow-slate-900/10',
            align === 'right' ? 'right-0' : 'left-0'
          )}
        >
          <button type="button" className={item} onClick={() => run(() => actions.onOpenDetail(row))}>
            <Eye size={13} /> 查看详情
          </button>
          <button type="button" className={item} onClick={() => run(() => actions.onEdit(row))}>
            <Edit3 size={13} /> 编辑内容
          </button>
          {quizModel(row) === 'axes' ? (
            <button
              type="button"
              className={item}
              onClick={() => run(() => actions.onOpenMatrix(row))}
            >
              <LayoutGrid size={13} /> 权重矩阵
            </button>
          ) : null}
          <button type="button" className={item} onClick={() => run(() => actions.onPreview(row))}>
            <ExternalLink size={13} /> 打开前台
          </button>
          <button
            type="button"
            className={item}
            onClick={() => run(() => actions.onToggleFeatured(row))}
          >
            <Star size={13} /> {row.is_featured ? '取消主推' : '设为主推'}
          </button>
          <button type="button" className={item} onClick={() => run(() => actions.onDuplicate(row))}>
            <Copy size={13} /> 复制一份
          </button>

          <div className="my-1 h-px bg-slate-100" />

          <button
            type="button"
            className={cn(item, status === 'published' ? 'text-amber-600' : 'text-emerald-600')}
            onClick={() => run(() => actions.onTogglePublish(row))}
          >
            {status === 'published' ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}
            {status === 'published' ? '下线（转草稿）' : '发布上线'}
          </button>
          <button
            type="button"
            className={cn(item, 'text-rose-500 hover:bg-rose-50 hover:text-rose-600')}
            onClick={() => run(() => actions.onDelete(row))}
          >
            <Trash2 size={13} /> 删除
          </button>
        </div>
      ) : null}
    </div>
  )
}
