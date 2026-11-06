"use client";

/**
 * 屏 3 的主体，同时被屏 2 的右栏复用 —— 一份代码两个密度。
 * variant="rail"：编辑器右侧 320px；variant="page"：整页，多一列扣分与检查 id。
 */

import React from "react";
import { AlertTriangle, Check, ChevronRight, Rocket, X } from "lucide-react";
import type { Check as CheckItem } from "./data";
import { Label, cn, healthTone } from "./ui";

function StateIcon({ state }: { state: CheckItem["state"] }) {
  if (state === "ok")
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
        <Check size={12} strokeWidth={3} />
      </span>
    );
  if (state === "warn")
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-500">
        <AlertTriangle size={12} strokeWidth={3} />
      </span>
    );
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-600">
      <X size={12} strokeWidth={3} />
    </span>
  );
}

export function ChecksPanel({
  checks,
  score,
  variant = "rail",
}: {
  checks: CheckItem[];
  score: number;
  variant?: "rail" | "page";
}) {
  const fails = checks.filter((c) => c.state === "fail").length;
  const warns = checks.filter((c) => c.state === "warn").length;
  const passed = checks.length - fails - warns;
  const tone = healthTone(score);
  const blocked = fails > 0;

  return (
    <div className={cn("flex flex-col", variant === "page" && "gap-8")}>
      <div className="flex items-start justify-between gap-6">
        <div>
          <Label>Pre-flight</Label>
          <p className="mt-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">
            {checks.length} 项 · 全自动 · 平均 240ms
          </p>
        </div>
        <div className="text-right">
          <p className={cn("text-4xl font-black tabular-nums leading-none tracking-tighter", tone.text)}>
            {score}
          </p>
          <p className="mt-1 text-[9px] font-black uppercase tracking-widest text-slate-300">health</p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
          <div className={cn("h-full rounded-full transition-all", tone.bar)} style={{ width: `${score}%` }} />
        </div>
        <span className="text-[10px] font-black tabular-nums text-slate-400">
          {passed}/{checks.length}
        </span>
      </div>

      <div className={cn("divide-y divide-slate-50", variant === "page" && "rounded-[32px] border border-slate-100")}>
        {checks.map((c) => (
          <div
            key={c.id}
            className={cn(
              "flex items-start gap-3",
              variant === "page" ? "px-6 py-4" : "py-2.5"
            )}
          >
            <StateIcon state={c.state} />
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "text-[11px] font-bold leading-snug",
                  c.state === "ok" ? "text-slate-500" : "text-slate-900"
                )}
              >
                {c.label}
              </p>
              {c.detail && (
                <p className="mt-1 text-[10px] font-medium leading-relaxed text-slate-400">{c.detail}</p>
              )}
            </div>
            {variant === "page" && (
              <div className="flex shrink-0 items-center gap-4">
                <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-slate-300">
                  {c.id}
                </span>
                <span
                  className={cn(
                    "w-10 text-right text-[10px] font-black tabular-nums",
                    c.state === "ok" ? "text-slate-200" : "text-rose-400"
                  )}
                >
                  {c.state === "ok" ? "—" : `−${c.penalty}`}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className={cn("space-y-3", variant === "page" && "px-6")}>
        <button
          disabled={blocked}
          className={cn(
            "flex w-full items-center justify-center gap-2 rounded-2xl px-5 py-3.5 text-[10px] font-black uppercase tracking-widest transition",
            blocked
              ? "cursor-not-allowed bg-slate-100 text-slate-300"
              : "bg-slate-900 text-white shadow-sm hover:bg-slate-800"
          )}
        >
          <Rocket size={13} />
          {blocked ? `${fails} 个 blocker 未解决` : "通过并发布"}
        </button>
        <div className="flex items-center justify-between">
          <p className="text-[9px] font-bold uppercase tracking-widest text-slate-300">
            {warns} warnings · 不阻塞发布
          </p>
          <button className="flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-slate-400 transition hover:text-slate-900">
            查看 diff <ChevronRight size={11} />
          </button>
        </div>
      </div>
    </div>
  );
}
