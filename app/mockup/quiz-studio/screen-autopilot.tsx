"use client";

/**
 * 屏 5 · /admin/autopilot
 *
 * 这条流水线真正省的是「选题 + 初稿」，不是「判断」。
 * S1 采集 → S2 打分聚类 → S3 生成 → S4 三重校验 → S5 发布 / 进复核队列。
 * 硬性：任何一项校验没过就**不许自动发**；政治 / 悲剧 / 医疗 / 点名个人 / 未成年
 * 五个雷区在 S2 就直接丢弃，不进生成，省 token 也省事故。
 */

import React, { useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Check,
  MessageCircle,
  Play,
  RefreshCw,
  TrendingUp,
  Youtube,
  X,
} from "lucide-react";
import { CANDIDATES, GEN_QUEUE, type Candidate, type GenItem } from "./data";
import { HealthBadge, Label, Panel, ScreenHead, cn } from "./ui";

const SOURCE = {
  reddit: { icon: MessageCircle, tint: "text-orange-500 bg-orange-50", label: "Reddit" },
  youtube: { icon: Youtube, tint: "text-rose-500 bg-rose-50", label: "YouTube" },
  wikipedia: { icon: BookOpen, tint: "text-slate-500 bg-slate-100", label: "Wikipedia" },
  gtrends: { icon: TrendingUp, tint: "text-emerald-600 bg-emerald-50", label: "Trends" },
} as const;

const STEPS = [
  { id: "s1", label: "Collect", note: "4 源 · 128 条", state: "done" },
  { id: "s2", label: "Score + cluster", note: "12 条通过雷区过滤", state: "done" },
  { id: "s3", label: "Generate", note: "3 份草稿 · $0.14", state: "done" },
  { id: "s4", label: "Validate", note: "2 份 ≥90 分", state: "active" },
  { id: "s5", label: "Publish", note: "1 份待人工放行", state: "pending" },
] as const;

export default function ScreenAutopilot() {
  const [cands, setCands] = useState<Candidate[]>(CANDIDATES);
  const [queue, setQueue] = useState<GenItem[]>(GEN_QUEUE);
  const [step, setStep] = useState("s4");

  const setCand = (id: string, state: Candidate["state"]) =>
    setCands((prev) => prev.map((c) => (c.id === id ? { ...c, state } : c)));

  const setGen = (id: string, state: GenItem["state"]) =>
    setQueue((prev) => prev.map((g) => (g.id === id ? { ...g, state } : g)));

  return (
    <div className="space-y-8">
      <ScreenHead
        title={
          <>
            Autopilot<span className="text-[#FF6B3D]">.</span>
          </>
        }
        sub="06:00 / 18:00 UTC · 采集 → 打分 → 生成 → 校验 → 放行 · 每个环节都可单独关掉"
        actions={
          <>
            <button className="flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500 transition hover:text-slate-900">
              <RefreshCw size={13} /> 手动跑一轮
            </button>
            <span className="flex items-center gap-2 rounded-2xl bg-emerald-50 px-4 py-3 text-[10px] font-black uppercase tracking-widest text-emerald-600">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> 运行中 · 下次 18:00
            </span>
          </>
        }
      />

      <Panel padded={false} className="overflow-hidden">
        <div className="grid grid-cols-1 divide-y divide-slate-100 md:grid-cols-5 md:divide-x md:divide-y-0">
          {STEPS.map((s, i) => (
            <button
              key={s.id}
              onClick={() => setStep(s.id)}
              className={cn(
                "group px-6 py-5 text-left transition",
                step === s.id ? "bg-slate-50/80" : "hover:bg-slate-50/40"
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-black",
                    s.state === "done"
                      ? "bg-emerald-500 text-white"
                      : s.state === "active"
                        ? "bg-slate-900 text-white"
                        : "bg-slate-100 text-slate-400"
                  )}
                >
                  {s.state === "done" ? <Check size={10} strokeWidth={4} /> : i + 1}
                </span>
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-900">
                  {s.label}
                </p>
              </div>
              <p className="mt-2 text-[10px] font-medium text-slate-400">{s.note}</p>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/40 px-6 py-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
            今日：3 条草稿 · 2 条 ≥90 分 · 1 条已自动上线（首 30 天模式：全部需人工）
          </p>
          <p className="text-[10px] font-black tabular-nums text-slate-400">
            Gemini Flash · 约 $0.14 / 轮 · 预算上限 $5 / 月
          </p>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_400px]">
        <Panel padded={false} className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-8 py-5">
            <div>
              <Label>候选池 · 已过雷区</Label>
              <p className="mt-1 text-[10px] font-medium text-slate-400">
                跨源 ×30 · 增速 z-score ×40 · 可出题性 ×30
              </p>
            </div>
            <span className="rounded-full bg-slate-50 px-3 py-1 text-[10px] font-black tabular-nums text-slate-400">
              {cands.filter((c) => c.state === "open").length} open
            </span>
          </div>

          <div className="divide-y divide-slate-50">
            {cands.map((c) => {
              const src = SOURCE[c.source];
              return (
                <div
                  key={c.id}
                  className={cn(
                    "flex items-start gap-4 px-8 py-5 transition",
                    c.state === "ignored" ? "opacity-40" : "hover:bg-slate-50/40"
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl",
                      src.tint
                    )}
                  >
                    <src.icon size={15} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[11px] font-black uppercase tracking-widest text-slate-900">
                        {src.label}
                      </p>
                      <span className="text-[10px] font-bold text-slate-400">{c.where}</span>
                      <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[9px] font-black text-emerald-600">
                        {c.delta}
                      </span>
                      <span className="rounded-md bg-slate-50 px-1.5 py-0.5 text-[9px] font-bold text-slate-400">
                        跨 {c.cross} 源
                      </span>
                      <span className="text-[9px] font-bold tabular-nums text-slate-300">{c.volume}</span>
                    </div>
                    <p className="mt-1.5 truncate text-[11px] font-medium italic text-slate-500">
                      “{c.quote}”
                    </p>
                    {c.state === "queued" && (
                      <p className="mt-1.5 flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-[#FF6B3D]">
                        <Check size={10} strokeWidth={3} /> 已加入生成队列
                      </p>
                    )}
                    {c.state === "ignored" && (
                      <p className="mt-1.5 flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-slate-400">
                        <X size={10} strokeWidth={3} /> 已忽略 · 24h 内不再出现
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      onClick={() => setCand(c.id, c.state === "queued" ? "open" : "queued")}
                      className={cn(
                        "flex items-center gap-1.5 rounded-xl px-3 py-2 text-[9px] font-black uppercase tracking-widest transition",
                        c.state === "queued"
                          ? "bg-slate-100 text-slate-400"
                          : "bg-slate-900 text-white hover:bg-slate-800"
                      )}
                    >
                      <Play size={10} />
                      {c.state === "queued" ? "已排" : "出题"}
                    </button>
                    <button
                      onClick={() => setCand(c.id, "ignored")}
                      className="rounded-xl border border-slate-200 p-2 text-slate-300 transition hover:text-slate-900"
                      aria-label="忽略"
                    >
                      <X size={11} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>

        <div className="space-y-6">
          <Panel padded={false} className="overflow-hidden">
            <div className="border-b border-slate-100 px-6 py-5">
              <Label>生成队列 · 待放行</Label>
              <p className="mt-1 text-[10px] font-medium text-slate-400">
                Health ≥ 90 且 0 blocker 才允许「自动」；首 30 天一律人工
              </p>
            </div>
            <div className="divide-y divide-slate-50">
              {queue.map((g) => (
                <div key={g.id} className="px-6 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[12px] font-bold text-slate-900">{g.title}</p>
                      <p className="mt-0.5 text-[10px] font-medium text-slate-400">
                        {g.recipe} · {g.spec}
                      </p>
                    </div>
                    <HealthBadge score={g.health} compact />
                  </div>

                  {g.issue && (
                    <p className="mt-2 rounded-xl bg-orange-50 px-2.5 py-1.5 text-[9px] font-bold leading-relaxed text-orange-600">
                      {g.issue}
                    </p>
                  )}

                  {g.state === "published" ? (
                    <p className="mt-3 flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest text-emerald-600">
                      <Check size={11} strokeWidth={3} /> 已上线 · 09:14 UTC
                    </p>
                  ) : g.state === "dropped" ? (
                    <p className="mt-3 flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest text-slate-300">
                      <X size={11} strokeWidth={3} /> 已丢弃
                    </p>
                  ) : (
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        onClick={() => setGen(g.id, "published")}
                        className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-slate-900 px-3 py-2 text-[9px] font-black uppercase tracking-widest text-white transition hover:bg-slate-800"
                      >
                        放行 <ArrowRight size={10} />
                      </button>
                      <button
                        onClick={() => setGen(g.id, "dropped")}
                        className="rounded-xl border border-slate-200 px-3 py-2 text-[9px] font-black uppercase tracking-widest text-slate-400 transition hover:text-slate-900"
                      >
                        丢弃
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Panel>

          <Panel className="!rounded-[32px] !border-slate-900 !bg-slate-900">
            <Label className="!text-slate-500">为什么不是「全自动上线」</Label>
            <p className="mt-2 text-[11px] font-medium leading-relaxed text-slate-300">
              最贵的事故不是慢，是静默坏掉：权重不平衡的卷照样发出去，抽到同一个结果的人多到
              被人在评论区点出来。校验挡得住结构问题，挡不住「这个梗已经过气」，所以前 30 天
              每天留一次 30 秒的人工确认。
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}