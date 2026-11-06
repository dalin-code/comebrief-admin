"use client";

/**
 * 屏 4 · /admin/taxonomy
 *
 * 存在的唯一理由：现在有三套互不相认的分类。
 *   前台 lib/result-theme.ts → Pop Culture / Career / Sports / Social / Subconscious / Persona
 *   后台 lib/quizPack.ts     → Persona / Subconscious / Social / Future
 *   趋势 MASTER_CATEGORIES   → 10 个，和上面两套都对不上
 * 结果是：Sports / Career 在前台有主题配色，在后台根本选不出来；
 * Future 能选但前台没有主题，只能靠 result-theme 的关键词兜底猜。
 * 这一页把 6 个 topic 定为唯一真源，另外两套降级为「标签」。
 */

import React, { useState } from "react";
import { ArrowRight, GitMerge, Layers, Tag } from "lucide-react";
import { AESTHETICS, FORMATS, SIGNALS, TOPICS } from "./data";
import { Label, Panel, ScreenHead, cn } from "./ui";

const OLD_TAXONOMIES = [
  {
    label: "前台 result-theme.ts",
    tone: "bg-orange-50 text-orange-600",
    items: ["Pop Culture", "Career", "Sports", "Social", "Subconscious", "Persona"],
  },
  {
    label: "后台 quizPack.ts",
    tone: "bg-indigo-50 text-indigo-600",
    items: ["Persona", "Subconscious", "Social", "Future"],
  },
  {
    label: "趋势 MASTER_CATEGORIES",
    tone: "bg-slate-100 text-slate-500",
    items: ["Music", "Film & TV", "Tech", "Fashion", "Internet", "Anime", "+4"],
  },
];

export default function ScreenTaxonomy() {
  const [active, setActive] = useState(TOPICS[0].id);
  const topic = TOPICS.find((t) => t.id === active) || TOPICS[0];

  return (
    <div className="space-y-8">
      <ScreenHead
        title={
          <>
            Taxonomy<span className="text-[#FF6B3D]">.</span>
          </>
        }
        sub="一条测验 = 1 个 topic + 最多 4 个 tag · topic 决定主题色 / hub / OG 模板"
        actions={
          <button className="flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-[10px] font-black uppercase tracking-widest text-white shadow-sm transition hover:bg-slate-800">
            <GitMerge size={13} /> 跑一次归并脚本
          </button>
        }
      />

      <Panel className="!rounded-[32px] !bg-slate-50/60">
        <div className="flex flex-wrap items-center gap-3">
          <Label className="!text-slate-500">现状 · 三套分类互不相认</Label>
          <span className="rounded-full bg-white px-3 py-1 text-[9px] font-black uppercase tracking-widest text-slate-400 ring-1 ring-slate-200">
            Sports / Career 后台选不出来
          </span>
          <span className="rounded-full bg-white px-3 py-1 text-[9px] font-black uppercase tracking-widest text-slate-400 ring-1 ring-slate-200">
            Future 前台没有主题
          </span>
        </div>
        <div className="mt-5 grid grid-cols-1 gap-6 md:grid-cols-3">
          {OLD_TAXONOMIES.map((t) => (
            <div key={t.label}>
              <span
                className={cn(
                  "inline-block rounded-full px-2.5 py-1 text-[9px] font-black uppercase tracking-widest",
                  t.tone
                )}
              >
                {t.label}
              </span>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {t.items.map((i) => (
                  <span
                    key={i}
                    className="rounded-lg bg-white px-2 py-1 text-[10px] font-semibold text-slate-500 ring-1 ring-slate-100"
                  >
                    {i}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-6 flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">
          全部归并到下面的 6 个 topic <ArrowRight size={12} /> 旧值降级为 tag
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel padded={false} className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-8 py-5">
            <Label>Topics · 6 个，写死在代码里，不允许再长</Label>
            <Label>Count</Label>
          </div>
          <div className="divide-y divide-slate-50">
            {TOPICS.map((t) => (
              <button
                key={t.id}
                onClick={() => setActive(t.id)}
                className={cn(
                  "flex w-full items-center gap-4 px-8 py-4 text-left transition",
                  active === t.id ? "bg-slate-50/80" : "hover:bg-slate-50/40"
                )}
              >
                <span
                  className="h-8 w-8 shrink-0 rounded-xl ring-1 ring-black/5"
                  style={{ backgroundColor: t.color }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-slate-900">
                    {t.label} <span className="ml-1 text-[10px] text-slate-300">{t.zh}</span>
                  </p>
                  <p className="mt-0.5 truncate text-[10px] font-medium text-slate-400">{t.slug}</p>
                </div>
                {t.count < 3 && (
                  <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[8px] font-black uppercase tracking-widest text-slate-400">
                    noindex
                  </span>
                )}
                <span className="w-8 shrink-0 text-right text-sm font-black tabular-nums text-slate-300">
                  {t.count}
                </span>
              </button>
            ))}
          </div>
        </Panel>

        <div className="space-y-6">
          <Panel className="!rounded-[32px]">
            <div className="flex items-center gap-3">
              <span
                className="h-9 w-9 rounded-xl ring-1 ring-black/5"
                style={{ backgroundColor: topic.color }}
              />
              <div>
                <p className="text-sm font-black tracking-tight text-slate-900">{topic.label}</p>
                <p className="text-[10px] font-medium text-slate-400">{topic.slug}</p>
              </div>
            </div>
            <div className="mt-5 space-y-4">
              <div>
                <Label>Hub intro · 前台显示</Label>
                <p className="mt-1.5 text-[11px] font-medium leading-relaxed text-slate-600">
                  {topic.blurb}
                </p>
              </div>
              <div>
                <Label>SEO title</Label>
                <p className="mt-1.5 text-[11px] font-semibold text-slate-600">
                  {topic.label} Quizzes — ComeBrief
                </p>
              </div>
              <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2">
                <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                  索引策略
                </span>
                <span
                  className={cn(
                    "rounded-full px-2 py-1 text-[8px] font-black uppercase tracking-widest",
                    topic.count < 3 ? "bg-slate-200 text-slate-500" : "bg-emerald-50 text-emerald-600"
                  )}
                >
                  {topic.count < 3 ? "noindex, follow" : "index"}
                </span>
              </div>
            </div>
          </Panel>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <Panel className="!rounded-[32px]">
          <div className="flex items-center gap-2">
            <Tag size={13} className="text-slate-300" />
            <Label>Signals · 可多选 ≤ 4</Label>
          </div>
          <div className="mt-4 flex flex-wrap gap-1.5">
            {SIGNALS.map((s) => (
              <span
                key={s.id}
                className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-[10px] font-bold text-slate-500"
              >
                {s.label}
                <span className="ml-1.5 tabular-nums text-slate-300">{s.count}</span>
              </span>
            ))}
          </div>
        </Panel>

        <Panel className="!rounded-[32px]">
          <div className="flex items-center gap-2">
            <Layers size={13} className="text-slate-300" />
            <Label>Formats · 单选</Label>
          </div>
          <div className="mt-4 space-y-2">
            {FORMATS.map((f) => (
              <div key={f.id} className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-bold text-slate-600">{f.label}</span>
                <span className="text-[10px] font-medium text-slate-300">{f.note}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel className="!rounded-[32px]">
          <div className="flex items-center gap-2">
            <Tag size={13} className="text-slate-300" />
            <Label>Aesthetics · 可多选</Label>
          </div>
          <div className="mt-4 flex flex-wrap gap-1.5">
            {AESTHETICS.map((a) => (
              <span
                key={a.id}
                className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-[10px] font-bold text-slate-500"
              >
                {a.label}
                <span className="ml-1.5 tabular-nums text-slate-300">{a.count}</span>
              </span>
            ))}
          </div>
          <p className="mt-4 text-[10px] font-medium leading-relaxed text-slate-400">
            Y2K / Cyberpunk 这类不做 topic —— 它们不影响主题色和结果卡，只影响筛选与推荐。
          </p>
        </Panel>
      </div>
    </div>
  );
}