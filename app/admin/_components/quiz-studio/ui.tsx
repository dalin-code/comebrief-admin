'use client'

import React from 'react'

/** Quiz Studio 共用的小零件；视觉语言沿用后台白卡 + 大圆角 + 黑色斜体标题。 */

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export function Panel({
  children,
  className,
  padded = true,
}: {
  children: React.ReactNode
  className?: string
  padded?: boolean
}) {
  return (
    <div
      className={cn(
        'rounded-[32px] border border-slate-100 bg-white shadow-sm',
        padded && 'p-6',
        className
      )}
    >
      {children}
    </div>
  )
}

export function Label({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn('text-[10px] font-black uppercase tracking-widest text-slate-400', className)}>
      {children}
    </p>
  )
}

export function StudioHead({
  title,
  sub,
  actions,
}: {
  title: React.ReactNode
  sub: string
  actions?: React.ReactNode
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-5">
      <div>
        <h1 className="text-3xl font-black italic tracking-tighter text-slate-900">{title}</h1>
        <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">{sub}</p>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
    </header>
  )
}

/** 健康分 → 配色。90+ 绿、80+ 琥珀、70+ 橙、其余红。 */
export function healthTone(score: number) {
  if (score >= 90) return { text: 'text-emerald-600', bg: 'bg-emerald-50', bar: 'bg-emerald-500' }
  if (score >= 80) return { text: 'text-amber-600', bg: 'bg-amber-50', bar: 'bg-amber-400' }
  if (score >= 70) return { text: 'text-orange-600', bg: 'bg-orange-50', bar: 'bg-orange-400' }
  return { text: 'text-rose-600', bg: 'bg-rose-50', bar: 'bg-rose-500' }
}

export function HealthBadge({ score, compact = false }: { score: number; compact?: boolean }) {
  const tone = healthTone(score)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full px-3 py-1 font-black tabular-nums',
        compact ? 'text-[11px]' : 'text-xs',
        tone.bg,
        tone.text
      )}
      title={`健康分 ${score}/100`}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', tone.bar)} />
      {score}
      {!compact ? (
        <span className="text-[9px] font-bold uppercase tracking-widest opacity-60">health</span>
      ) : null}
    </span>
  )
}

export function HealthBar({ score }: { score: number }) {
  const tone = healthTone(score)
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
      <div
        className={cn('h-full rounded-full transition-all', tone.bar)}
        style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
      />
    </div>
  )
}

export function Pill({
  children,
  active,
  onClick,
  tone = 'slate',
}: {
  children: React.ReactNode
  active?: boolean
  onClick?: () => void
  tone?: 'slate' | 'dark' | 'accent'
}) {
  const base =
    'rounded-full px-4 py-2 text-[11px] font-black uppercase tracking-widest transition-all whitespace-nowrap'
  const styles = active
    ? tone === 'dark'
      ? 'bg-slate-900 text-white shadow-sm'
      : tone === 'accent'
        ? 'bg-[#FF6B3D] text-white shadow-sm'
        : 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200'
    : 'text-slate-400 hover:text-slate-700 hover:bg-white/70'
  return (
    <button type="button" onClick={onClick} className={cn(base, styles)}>
      {children}
    </button>
  )
}

const STATUS_MAP: Record<string, { label: string; cls: string; dot: string }> = {
  published: { label: '已发布', cls: 'bg-emerald-50 text-emerald-600', dot: 'bg-emerald-500' },
  draft: { label: '草稿', cls: 'bg-slate-100 text-slate-500', dot: 'bg-slate-300' },
  scheduled: { label: '定时', cls: 'bg-indigo-50 text-indigo-500', dot: 'bg-indigo-500' },
  failed: { label: '失败', cls: 'bg-rose-50 text-rose-600', dot: 'bg-rose-500' },
}

export function StatusTag({ status }: { status: string }) {
  const item = STATUS_MAP[status] || STATUS_MAP.draft
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[9px] font-black uppercase tracking-widest',
        item.cls
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', item.dot)} />
      {item.label}
    </span>
  )
}

export type ToastKind = 'success' | 'error' | 'info'

export function Toast({
  toast,
}: {
  toast: { kind: ToastKind; message: string } | null
}) {
  if (!toast) return null
  const tone =
    toast.kind === 'success'
      ? 'bg-slate-900 text-white'
      : toast.kind === 'error'
        ? 'bg-rose-500 text-white'
        : 'bg-white text-slate-700 ring-1 ring-slate-200'
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[80] -translate-x-1/2">
      <div
        className={cn(
          'max-w-[min(560px,calc(100vw-2rem))] rounded-2xl px-5 py-3 text-xs font-bold shadow-2xl',
          tone
        )}
      >
        {toast.message}
      </div>
    </div>
  )
}
