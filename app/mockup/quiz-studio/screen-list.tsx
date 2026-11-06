"use client";

/**
 * 屏 1 · /admin/quizzes
 *
 * 核心改动只有一件事：把「健康分」提到列表里，且**可排序**。
 * 现在 22 条里 3 条 questions_count=0、2 套互不兼容的打分方式同时存在，
 * 但列表页一个信号都不给 —— 人只能点进去、翻到最后一屏、靠眼睛判断。
 */

import React, { useMemo, useState } from "react";
import {
  ArrowUpDown,
  Filter,
  MoreHorizontal,
  Plus,
  Search,
  Sparkles,
  AlertTriangle,
} from "lucide-react";
import { QUIZ_ROWS } from "./data";
import { HealthBadge, Label, Panel, Pill, ScreenHead, StatusTag, cn } from "./ui";

const TOPIC_TABS = ["All", "Personality", "Pop Culture", "Social", "Career", "Lifestyle", "Sports"];

const GRID =
  "lg:grid-cols-[minmax(0,1fr)_104px_96px_112px_56px_64px_56px_72px_32px]";

export default function ScreenList() {
  const [topic, setTopic] = useState("All");
  const [q, setQ] = useState("");
  const [sortByHealth, setSortByHealth] = useState(false);

  const rows = useMemo(() => {
    let list = QUIZ_ROWS.filter((r) => topic === "All" || r.topic === topic).filter((r) =>
      r.title.toLowerCase().includes(q.trim().toLowerCase())
    );
    if (sortByHealth) list = [...list].sort((a, b) => a.health - b.health);
    return list;
  }, [topic, q, sortByHealth]);

  return (
    <div className="space-y-8">
      <ScreenHead
        title={
          <>
            Quizzes<span className="text-[#FF6B3D]">.</span>
          </>
        }
        sub={`${QUIZ_ROWS.length} rows · 6 topics · 健康分才是这一页真正的主键`}
        actions={
          <>
            <button className="flex items-center gap-2 rounded-2xl border border-slate-200 px-5 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500 transition hover:border-slate-300 hover:text-slate-900">
              <Sparkles size={14} /> 从趋势生成
            </button>
            <button className="flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-[10px] font-black uppercase tracking-widest text-white shadow-sm transition hover:bg-slate-800">
              <Plus size={14} /> 新建测验
            </button>
          </>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1">
          {TOPIC_TABS.map((t) => (
            <Pill key={t} active={topic === t} onClick={() => setTopic(t)}>
              {t}
              {t !== "All" && (
                <span className="ml-2 tabular-nums opacity-40">
                  {QUIZ_ROWS.filter((r) => r.topic === t).length}
                </span>
              )}
            </Pill>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2.5">
            <Search size={14} className="text-slate-300" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search title…"
              className="w-44 bg-transparent text-xs font-semibold text-slate-700 outline-none placeholder:text-slate-300"
            />
          </div>
          <button className="flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-slate-400 transition hover:text-slate-900">
            <Filter size={13} /> 筛选
          </button>
        </div>
      </div>

      <Panel padded={false} className="overflow-hidden">
        <div
          className={cn(
            "hidden items-center gap-4 border-b border-slate-100 px-8 py-5 lg:grid",
            GRID
          )}
        >
          <Label>Quiz</Label>
          <Label>Topic</Label>
          <Label>Format</Label>
          <button
            onClick={() => setSortByHealth((v) => !v)}
            className={cn(
              "flex items-center gap-1 text-[10px] font-black uppercase tracking-widest transition",
              sortByHealth ? "text-slate-900" : "text-slate-400 hover:text-slate-600"
            )}
          >
            Health <ArrowUpDown size={11} />
          </button>
          <Label>Q / R</Label>
          <Label>7d views</Label>
          <Label>Share</Label>
          <Label>Status</Label>
          <span />
        </div>

        <div className="hidden divide-y divide-slate-50 lg:block">
          {rows.map((r) => (
            <div
              key={r.id}
              className={cn(
                "group grid cursor-pointer grid-cols-1 items-center gap-4 px-8 py-5 transition hover:bg-slate-50/60",
                GRID
              )}
            >
              <div className="flex min-w-0 items-center gap-4">
                <div
                  className={cn(
                    "h-11 w-11 shrink-0 rounded-2xl bg-gradient-to-br ring-1 ring-black/5",
                    r.cover
                  )}
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-bold text-slate-900">{r.title}</p>
                    {r.source === "autopilot" && (
                      <span className="shrink-0 rounded-full bg-indigo-50 px-2 py-0.5 text-[8px] font-black uppercase tracking-widest text-indigo-500">
                        auto
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[10px] font-medium text-slate-400">
                    /quizzes/{r.id.replace("q-", "")}
                  </p>
                  {r.note && (
                    <p className="mt-1 flex items-start gap-1 text-[10px] font-medium leading-relaxed text-orange-500">
                      <AlertTriangle size={10} className="mt-0.5 shrink-0" /> {r.note}
                    </p>
                  )}
                </div>
              </div>

              <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">
                {r.topic}
              </p>
              <p className="text-[11px] font-semibold text-slate-400">{r.format}</p>
              <div className="justify-self-start">
                <HealthBadge score={r.health} compact />
              </div>
              <p className="text-[11px] font-bold tabular-nums text-slate-400">
                {r.q} / {r.r}
              </p>
              <p className="text-[11px] font-bold tabular-nums text-slate-500">{r.views}</p>
              <p className="text-[11px] font-bold tabular-nums text-slate-500">{r.share}</p>
              <StatusTag status={r.status} />
              <button className="text-slate-300 transition group-hover:text-slate-900">
                <MoreHorizontal size={16} />
              </button>
            </div>
          ))}

          {rows.length === 0 && (
            <div className="px-8 py-16 text-center text-xs font-semibold text-slate-300">
              没有匹配的行
            </div>
          )}
        </div>

        {/* 窄屏：表格列太多，改成卡片；同一个数据集，不做第二套数据。 */}
        <div className="divide-y divide-slate-50 lg:hidden">
          {rows.map((r) => (
            <div key={r.id} className="flex items-start gap-4 px-5 py-4">
              <div
                className={cn(
                  "h-12 w-12 shrink-0 rounded-2xl bg-gradient-to-br ring-1 ring-black/5",
                  r.cover
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold leading-snug text-slate-900">{r.title}</p>
                <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                  {r.topic} · {r.format} · {r.q}Q / {r.r}R
                </p>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <HealthBadge score={r.health} compact />
                  <span className="text-[10px] font-bold tabular-nums text-slate-400">
                    {r.views} views
                  </span>
                  <StatusTag status={r.status} />
                </div>
                {r.note && (
                  <p className="mt-2 flex items-start gap-1 text-[10px] font-medium leading-relaxed text-orange-500">
                    <AlertTriangle size={10} className="mt-0.5 shrink-0" /> {r.note}
                  </p>
                )}
              </div>
            </div>
          ))}
          {rows.length === 0 && (
            <div className="px-8 py-16 text-center text-xs font-semibold text-slate-300">
              没有匹配的行
            </div>
          )}
        </div>
      </Panel>

      <div className="space-y-3 px-2">
        <Label>健康分 = 100 − 30×blocker − 8×warning − 5×额外（未配平 / 平局率高 / 长名溢出）</Label>
        <div className="flex flex-wrap items-center gap-6 text-[10px] font-bold uppercase tracking-widest text-slate-400">
          <span className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> 90–100 可自动发布
          </span>
          <span className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> 80–89 建议人工过一眼
          </span>
          <span className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-rose-500" /> &lt;70 进复核队列
          </span>
        </div>
      </div>
    </div>
  );
}