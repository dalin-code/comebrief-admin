"use client";

/**
 * 屏 2 · 编辑器里的 Logic 页（权重矩阵）
 *
 * 这一屏是整套东西的核心：现在 22 条测验的权重是「散文里写死的数字」，
 * 没人能一眼看出某个原型是不是根本抽不到。矩阵把它变成可编辑的表格，
 * 并且每一格都**当场重算 65,536 种组合**：
 *   · 列合计 = 该原型在整卷里能拿到的最大分
 *   · 命中占比 = 全枚举下该原型胜出的组合比例
 *   · 右栏检查项 = 由上面两个数字推出来的 blocker / warning
 * 点格子循环 0→1→2→3，改一格，右栏立刻变。
 */

import React, { useMemo, useState } from "react";
import { ClipboardPaste, RotateCcw, Save, Scale } from "lucide-react";
import {
  ARCHETYPES,
  QUESTIONS,
  enumerate,
  healthChecks,
  healthScore,
  type ArchId,
  type QuizQuestion,
} from "./data";
import { ChecksPanel } from "./checks-panel";
import { Label, Panel, ScreenHead, cn } from "./ui";

const CELL_STYLE = (w: number, tint: string) => {
  if (w <= 0) return { style: {}, cls: "bg-slate-50 text-slate-200 hover:bg-slate-100" };
  // 只把透明度加在背景上，字色保持可读 —— 否则 1 分格的数字淡到看不见，
  // 矩阵也就失去「一眼读出权重」的意义了。
  const rgb = tint
    .replace("#", "")
    .match(/.{2}/g)!
    .map((h) => parseInt(h, 16))
    .join(",");
  return {
    style: {
      backgroundColor: `rgba(${rgb},${w === 1 ? 0.16 : w === 2 ? 0.42 : 1})`,
      color: w === 3 ? "#ffffff" : "#0f172a",
    },
    cls: "font-black",
  };
};

export default function ScreenMatrix() {
  const [questions, setQuestions] = useState<QuizQuestion[]>(() =>
    QUESTIONS.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o, w: { ...o.w } })) }))
  );
  const [dirty, setDirty] = useState(false);

  const setWeight = (qi: number, oi: number, arch: ArchId, value: number) => {
    setQuestions((prev) =>
      prev.map((q, i) =>
        i !== qi
          ? q
          : {
              ...q,
              options: q.options.map((o, j) =>
                j !== oi ? o : { ...o, w: { ...o.w, [arch]: Math.max(0, Math.min(3, value)) } }
              ),
            }
      )
    );
    setDirty(true);
  };

  const cycle = (qi: number, oi: number, arch: ArchId) => {
    const current = questions[qi].options[oi].w[arch] || 0;
    setWeight(qi, oi, arch, (current + 1) % 4);
  };

  const result = useMemo(() => enumerate(questions), [questions]);
  const checks = useMemo(() => healthChecks(questions, ARCHETYPES, result), [questions, result]);
  const score = healthScore(checks);

  /** 自动配平：反复给「最轻的那一列」加 1 分，直到极差 ≤ 3 或加满 40 次。 */
  const autoBalance = () => {
    const next = questions.map((q) => ({
      ...q,
      options: q.options.map((o) => ({ ...o, w: { ...o.w } })),
    }));
    for (let step = 0; step < 40; step += 1) {
      const totals = ARCHETYPES.map((a) =>
        next.reduce((sum, q) => sum + q.options.reduce((s, o) => s + (o.w[a.id] || 0), 0), 0)
      );
      if (Math.max(...totals) - Math.min(...totals) <= 3) break;
      const arch = ARCHETYPES[totals.indexOf(Math.min(...totals))].id;

      // 找「行合计最小、且该列还没到 3」的选项加一分 —— 改动量最小。
      let best: { qi: number; oi: number; sum: number } | null = null;
      next.forEach((q, qi) => {
        q.options.forEach((o, oi) => {
          if ((o.w[arch] || 0) >= 3) return;
          const sum = ARCHETYPES.reduce((s, a) => s + (o.w[a.id] || 0), 0);
          if (!best || sum < best.sum) best = { qi, oi, sum };
        });
      });
      if (!best) break;
      const target = best as { qi: number; oi: number };
      next[target.qi].options[target.oi].w[arch] += 1;
    }
    setQuestions(next);
    setDirty(true);
  };

  const reset = () => {
    setQuestions(
      QUESTIONS.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o, w: { ...o.w } })) }))
    );
    setDirty(false);
  };

  return (
    <div className="space-y-8">
      <ScreenHead
        title={
          <>
            Logic<span className="text-[#FF6B3D]">.</span>
          </>
        }
        sub="Weight matrix · 点格子循环 0→1→2→3 · 右栏实时重算"
        actions={
          <>
            <span
              className={cn(
                "flex items-center gap-2 rounded-2xl px-4 py-3 text-[10px] font-black uppercase tracking-widest",
                dirty ? "bg-amber-50 text-amber-600" : "bg-slate-50 text-slate-300"
              )}
            >
              <span
                className={cn("h-1.5 w-1.5 rounded-full", dirty ? "bg-amber-500" : "bg-slate-300")}
              />
              {dirty ? "未保存" : "已同步"}
            </span>
            <button
              onClick={reset}
              className="flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500 transition hover:text-slate-900"
            >
              <RotateCcw size={13} /> 重置
            </button>
            <button className="flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-[10px] font-black uppercase tracking-widest text-white shadow-sm transition hover:bg-slate-800">
              <Save size={13} /> 保存草稿
            </button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_336px]">
        <Panel padded={false} className="overflow-hidden">
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-100 px-8 py-6">
            <div>
              <Label>Quiz · draft</Label>
              <h2 className="mt-2 text-lg font-black tracking-tight text-slate-900">
                Which 2026 Social Archetype Are You?
              </h2>
              <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                8 questions · 4 archetypes · 65,536 combos · scoring_mode = axes
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={autoBalance}
                className="flex items-center gap-2 rounded-xl bg-orange-50 px-3.5 py-2 text-[10px] font-black uppercase tracking-widest text-[#FF6B3D] transition hover:bg-orange-100"
              >
                <Scale size={13} /> 自动配平
              </button>
              <button className="flex items-center gap-2 rounded-xl border border-slate-200 px-3.5 py-2 text-[10px] font-black uppercase tracking-widest text-slate-400 transition hover:text-slate-900">
                <ClipboardPaste size={13} /> 粘贴表格
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <div className="min-w-[660px]">
              <div className="flex items-center gap-3 border-b border-slate-100 px-8 py-3">
                <span className="flex-1 text-[9px] font-black uppercase tracking-widest text-slate-300">
                  Option
                </span>
                {ARCHETYPES.map((a) => (
                  <div key={a.id} className="w-16 shrink-0 text-center" title={a.name}>
                    <p className="text-[9px] font-black uppercase tracking-widest text-slate-400">
                      {a.short}
                    </p>
                    <div
                      className="mx-auto mt-1.5 h-0.5 w-6 rounded-full"
                      style={{ backgroundColor: a.tint }}
                    />
                  </div>
                ))}
                <span className="w-10 shrink-0 text-right text-[9px] font-black uppercase tracking-widest text-slate-300">
                  Σ
                </span>
              </div>

              <div>
                {questions.map((q, qi) => (
              <div key={q.id}>
                <div className="flex items-center gap-3 bg-slate-50/70 px-8 py-2.5">
                  <span className="rounded-md bg-white px-1.5 py-0.5 text-[9px] font-black tabular-nums text-slate-400 ring-1 ring-slate-200">
                    Q{qi + 1}
                  </span>
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                    {q.scene}
                  </p>
                  <p className="truncate text-[10px] font-medium text-slate-400">{q.title}</p>
                </div>

                {q.options.map((o, oi) => {
                  const rowSum = ARCHETYPES.reduce((s, a) => s + (o.w[a.id] || 0), 0);
                  return (
                    <div
                      key={o.id}
                      className="flex items-center gap-3 border-b border-slate-50 px-8 py-2 last:border-0 hover:bg-slate-50/40"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <span className="w-4 shrink-0 text-[9px] font-black uppercase text-slate-300">
                          {String.fromCharCode(65 + oi)}
                        </span>
                        <p className="truncate text-[11px] font-medium text-slate-600" title={o.text}>
                          {o.text}
                        </p>
                      </div>
                      {ARCHETYPES.map((a) => {
                        const w = o.w[a.id] || 0;
                        const tone = CELL_STYLE(w, a.tint);
                        return (
                          <button
                            key={a.id}
                            onClick={() => cycle(qi, oi, a.id)}
                            title={`${a.name} · 权重 ${w}`}
                            style={tone.style}
                            className={cn(
                              "h-8 w-16 shrink-0 rounded-lg text-[11px] tabular-nums transition-all",
                              tone.cls
                            )}
                          >
                            {w === 0 ? "·" : w}
                          </button>
                        );
                      })}
                      <span
                        className={cn(
                          "w-10 shrink-0 text-right text-[11px] font-black tabular-nums",
                          rowSum === 0 ? "text-rose-400" : "text-slate-400"
                        )}
                      >
                        {rowSum}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="space-y-3 border-t border-slate-100 bg-slate-50/40 px-8 py-5">
            <div className="flex items-center gap-3">
              <span className="flex-1 text-[9px] font-black uppercase tracking-widest text-slate-400">
                列合计
              </span>
              {ARCHETYPES.map((a) => (
                <span
                  key={a.id}
                  className="w-16 shrink-0 text-center text-[11px] font-black tabular-nums text-slate-600"
                >
                  {result.columnTotals[a.id]}
                </span>
              ))}
              <span className="w-10 shrink-0 text-right text-[11px] font-black tabular-nums text-slate-300">
                {Object.values(result.columnTotals).reduce((a, b) => a + b, 0)}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="flex-1 text-[9px] font-black uppercase tracking-widest text-slate-400">
                命中占比 · 全枚举
              </span>
              {ARCHETYPES.map((a) => (
                <span
                  key={a.id}
                  className={cn(
                    "w-16 shrink-0 text-center text-[11px] font-black tabular-nums",
                    result.hitPct[a.id] < 12 ? "text-rose-500" : "text-slate-600"
                  )}
                >
                  {result.hitPct[a.id].toFixed(0)}%
                </span>
              ))}
              <span className="w-10 shrink-0" />
            </div>
            <p className="text-[9px] font-bold uppercase tracking-widest text-slate-300">
              平局仲裁：列合计 → 指定仲裁题（Q5）→ 声明顺序 · 当前平局率 {result.tiePct.toFixed(1)}%
            </p>
          </div>
            </div>
          </div>
        </Panel>

        <Panel className="h-fit">
          <ChecksPanel checks={checks} score={score} variant="rail" />
        </Panel>
      </div>
    </div>
  );
}