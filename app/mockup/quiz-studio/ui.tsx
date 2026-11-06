"use client";

/**
 * 静态稿共用的小零件。
 *
 * 视觉语言刻意照抄现有 admin（app/admin/(protected)/page.tsx）：
 * 白卡 + border-slate-100 + rounded-[40px] + shadow-sm、
 * 标题 text-3xl font-black italic tracking-tighter、
 * 表头 text-[10px] font-black tracking-widest uppercase text-slate-400。
 * 这样评审时能直接对照旁边真页面，不用在脑子里做平移。
 */

import React from "react";

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function Panel({
  children,
  className,
  padded = true,
}: {
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-[40px] border border-slate-100 bg-white shadow-sm",
        padded && "p-8",
        className
      )}
    >
      {children}
    </div>
  );
}

export function Label({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("text-[10px] font-black uppercase tracking-widest text-slate-400", className)}>
      {children}
    </p>
  );
}

export function ScreenHead({
  title,
  sub,
  actions,
}: {
  title: React.ReactNode;
  sub: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-6">
      <div>
        <h1 className="text-3xl font-black italic tracking-tighter text-slate-900">{title}</h1>
        <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">{sub}</p>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
    </header>
  );
}

/** 健康分 → 配色。90+ 绿、80+ 琥珀、70+ 橙、其余红。 */
export function healthTone(score: number) {
  if (score >= 90) return { text: "text-emerald-600", bg: "bg-emerald-50", bar: "bg-emerald-500" };
  if (score >= 80) return { text: "text-amber-600", bg: "bg-amber-50", bar: "bg-amber-400" };
  if (score >= 70) return { text: "text-orange-600", bg: "bg-orange-50", bar: "bg-orange-400" };
  return { text: "text-rose-600", bg: "bg-rose-50", bar: "bg-rose-500" };
}

export function HealthBadge({ score, compact = false }: { score: number; compact?: boolean }) {
  const tone = healthTone(score);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-3 py-1 font-black tabular-nums",
        compact ? "text-[11px]" : "text-xs",
        tone.bg,
        tone.text
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", tone.bar)} />
      {score}
      {!compact && <span className="text-[9px] font-bold uppercase tracking-widest opacity-60">health</span>}
    </span>
  );
}

export function HealthBar({ score }: { score: number }) {
  const tone = healthTone(score);
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
      <div className={cn("h-full rounded-full transition-all", tone.bar)} style={{ width: `${score}%` }} />
    </div>
  );
}

export function Pill({
  children,
  active,
  onClick,
  tone = "slate",
}: {
  children: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
  tone?: "slate" | "dark" | "accent";
}) {
  const base =
    "rounded-full px-4 py-2 text-[11px] font-black uppercase tracking-widest transition-all whitespace-nowrap";
  const styles = active
    ? tone === "dark"
      ? "bg-slate-900 text-white shadow-sm"
      : tone === "accent"
        ? "bg-[#FF6B3D] text-white shadow-sm"
        : "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200"
    : "text-slate-400 hover:text-slate-700 hover:bg-white/70";
  return (
    <button type="button" onClick={onClick} className={cn(base, styles)}>
      {children}
    </button>
  );
}

export function StatusTag({ status }: { status: "published" | "draft" | "scheduled" }) {
  const map = {
    published: { label: "已发布", cls: "bg-emerald-50 text-emerald-600" },
    draft: { label: "草稿", cls: "bg-slate-100 text-slate-500" },
    scheduled: { label: "定时", cls: "bg-indigo-50 text-indigo-500" },
  } as const;
  const item = map[status];
  return (
    <span
      className={cn(
        "rounded-full px-2.5 py-1 text-[9px] font-black uppercase tracking-widest",
        item.cls
      )}
    >
      {item.label}
    </span>
  );
}

export function MiniStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      <p className="mt-1 text-lg font-black tabular-nums tracking-tight text-slate-900">{value}</p>
    </div>
  );
}
