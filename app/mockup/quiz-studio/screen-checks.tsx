"use client";

/**
 * 屏 3 · 发布前检查（整页形态）
 *
 * 和屏 2 右栏同一份 ChecksPanel，只是多出：扣分明细、发布设置、
 * 「点发布之后会发生什么」的清单。之所以要这一屏，是因为
 * 之前的发布动作是**一次 blind upsert**：题库里权重坏了、结果名太长、
 * 海报导不出来，前台照样上线，只能靠人刷页面发现问题。
 */

import React, { useMemo, useState } from "react";
import { CheckCircle2, CircuitBoard, Globe2, Rss, ShieldCheck } from "lucide-react";
import { ARCHETYPES, QUESTIONS, enumerate, healthChecks, healthScore } from "./data";
import { ChecksPanel } from "./checks-panel";
import { Label, Panel, ScreenHead, cn } from "./ui";

const TOGGLES = [
  {
    id: "gate",
    label: "自动发布闸门",
    desc: "健康分 ≥ 90 且 0 blocker 时直接上线，其余进复核队列",
    on: true,
  },
  {
    id: "conservative",
    label: "首 30 天保守模式",
    desc: "任何 AI 生成内容都必须人工点一次，不自动上线",
    on: true,
  },
  {
    id: "index",
    label: "发布即提交索引",
    desc: "写入 sitemap、ping IndexNow、生成 OG 图",
    on: true,
  },
];

const SIDE_EFFECTS = [
  { icon: Globe2, label: "/quizzes 列表", note: "排到第 2 位（按 7d views）" },
  { icon: Globe2, label: "/quizzes/topic/love", note: "该主题从 3 条变 4 条，摘掉 noindex" },
  { icon: Rss, label: "RSS + sitemap.xml", note: "新增 1 个 URL + 4 个结果页" },
  { icon: CircuitBoard, label: "首页「新测验」槽位", note: "替换 14 天前的那条" },
];

export default function ScreenChecks() {
  const [toggles, setToggles] = useState(TOGGLES);

  const result = useMemo(() => enumerate(QUESTIONS), []);
  const checks = useMemo(() => healthChecks(QUESTIONS, ARCHETYPES, result), [result]);
  const score = healthScore(checks);

  const blockers = checks.filter((c) => c.state === "fail").length;
  const warnings = checks.filter((c) => c.state === "warn").length;

  return (
    <div className="space-y-8">
      <ScreenHead
        title={
          <>
            Pre-flight<span className="text-[#FF6B3D]">.</span>
          </>
        }
        sub={`${checks.length} 项检查 · 全自动 · 改权重后 240ms 内刷新`}
        actions={
          <span className="flex items-center gap-2 rounded-2xl bg-slate-50 px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-400">
            <ShieldCheck size={14} /> 只读预览 · 编辑去 Logic
          </span>
        }
      />

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-8">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[
              { label: "Health", value: score, suffix: "/100", tone: "text-slate-900" },
              { label: "Blockers", value: blockers, suffix: "项", tone: "text-rose-500" },
              { label: "Warnings", value: warnings, suffix: "项", tone: "text-amber-500" },
            ].map((s) => (
              <Panel key={s.label} className="!rounded-[32px] !p-6">
                <Label>{s.label}</Label>
                <p className={cn("mt-2 text-3xl font-black tabular-nums tracking-tighter", s.tone)}>
                  {s.value}
                  <span className="ml-1 text-xs font-bold text-slate-300">{s.suffix}</span>
                </p>
              </Panel>
            ))}
          </div>

          <Panel>
            <ChecksPanel checks={checks} score={score} variant="page" />
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel className="!rounded-[32px]">
            <Label>发布设置</Label>
            <div className="mt-4 space-y-4">
              {toggles.map((t, i) => (
                <div key={t.id} className="flex items-start gap-3">
                  <button
                    onClick={() =>
                      setToggles((prev) => prev.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))
                    }
                    className={cn(
                      "mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition",
                      t.on ? "bg-slate-900" : "bg-slate-200"
                    )}
                    aria-label={t.label}
                  >
                    <span
                      className={cn(
                        "h-4 w-4 rounded-full bg-white shadow-sm transition",
                        t.on && "translate-x-4"
                      )}
                    />
                  </button>
                  <div>
                    <p className="text-[11px] font-bold text-slate-900">{t.label}</p>
                    <p className="mt-0.5 text-[10px] font-medium leading-relaxed text-slate-400">
                      {t.desc}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          <Panel className="!rounded-[32px]">
            <Label>点发布之后会发生什么</Label>
            <div className="mt-4 space-y-3">
              {SIDE_EFFECTS.map((s) => (
                <div key={s.label} className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-slate-50 text-slate-400">
                    <s.icon size={13} />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[11px] font-bold text-slate-700">{s.label}</p>
                    <p className="text-[10px] font-medium text-slate-400">{s.note}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-5 flex items-center gap-2 rounded-2xl bg-emerald-50 px-3 py-2 text-[10px] font-bold text-emerald-600">
              <CheckCircle2 size={13} /> 一步可回滚（保留上一版 raw_data 快照）
            </div>
          </Panel>

          <Panel className="!rounded-[32px]">
            <Label>本次改动 · 未保存</Label>
            <div className="mt-4 space-y-2.5">
              {[
                { sign: "+", text: "Q6 选项 B · overload +1", tone: "text-emerald-600" },
                { sign: "→", text: "废选项 1 → 0，DEADOPT 转为通过", tone: "text-slate-500" },
                { sign: "↗", text: "健康分 81 → 86", tone: "text-slate-900" },
                { sign: "·", text: "「自动配平」预计再改 7 格（未执行）", tone: "text-slate-400" },
              ].map((d) => (
                <div key={d.text} className="flex items-start gap-2">
                  <span className={cn("w-3 shrink-0 font-mono text-[10px] font-bold", d.tone)}>
                    {d.sign}
                  </span>
                  <p className={cn("text-[10px] font-medium leading-relaxed", d.tone)}>{d.text}</p>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
