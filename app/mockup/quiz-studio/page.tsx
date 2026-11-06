"use client";

/**
 * 静态稿入口：/mockup/quiz-studio
 *
 * 六屏共用一份假数据，所以屏 2 改的权重会立刻影响屏 2 右栏，
 * 但不会跨屏串（各屏自己 hold state，刷新即回到初始值 —— 评审时反而省事）。
 * 全部假数据，没有一次 fetch；`npx tsc --noEmit` 通过即可，不需要数据库。
 */

import React, { useState } from "react";
import Link from "next/link";
import { ArrowUpRight, MousePointerClick, MousePointerSquareDashed } from "lucide-react";
import { SCREENS, type ScreenId } from "./data";
import ScreenList from "./screen-list";
import ScreenMatrix from "./screen-matrix";
import ScreenChecks from "./screen-checks";
import ScreenTaxonomy from "./screen-taxonomy";
import ScreenAutopilot from "./screen-autopilot";
import ScreenFront from "./screen-front";
import { cn } from "./ui";

const RENDER: Record<ScreenId, () => React.JSX.Element> = {
  list: ScreenList,
  matrix: ScreenMatrix,
  checks: ScreenChecks,
  taxonomy: ScreenTaxonomy,
  autopilot: ScreenAutopilot,
  front: ScreenFront,
};

const NOTES = [
  "屏 2 点格子 → 右栏检查项与健康分实时重算（真的跑了 65,536 种组合）",
  "屏 2「自动配平」会把最轻的一列补到极差 ≤ 3，看平局率怎么掉下来",
  "屏 6 的 Trivia 筛选项是空的 —— 主题下 < 3 条时该页应 noindex",
];

export default function QuizStudioMockupPage() {
  const [active, setActive] = useState<ScreenId>("list");
  const Screen = RENDER[active];

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-20 border-b border-slate-200/70 bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-900 text-[11px] font-black text-white">
              CB
            </span>
            <div>
              <p className="text-[11px] font-black uppercase tracking-widest text-slate-900">
                Quiz Studio · 静态稿 v1
              </p>
              <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400">
                taxonomy · scoring · validation · autopilot
              </p>
            </div>
            <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[8px] font-black uppercase tracking-widest text-amber-600">
              static · 假数据
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-1.5 rounded-full bg-slate-50 px-3 py-1.5 text-[9px] font-bold uppercase tracking-widest text-slate-400 md:flex">
              <MousePointerClick size={11} /> 可点
            </span>
            <Link
              href="/admin/quizzes"
              className="flex items-center gap-1.5 rounded-full border border-slate-200 px-3 py-1.5 text-[9px] font-black uppercase tracking-widest text-slate-500 transition hover:border-slate-300 hover:text-slate-900"
            >
              真实后台 <ArrowUpRight size={11} />
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1500px] gap-8 px-6 py-8">
        <aside className="hidden w-[228px] shrink-0 lg:block">
          <div className="sticky top-[92px] space-y-2">
            {SCREENS.map((s) => (
              <button
                key={s.id}
                onClick={() => setActive(s.id)}
                className={cn(
                  "group w-full rounded-2xl px-4 py-3 text-left transition",
                  active === s.id
                    ? "bg-white shadow-sm ring-1 ring-slate-200"
                    : "hover:bg-white/70"
                )}
              >
                <p
                  className={cn(
                    "text-[11px] font-black uppercase tracking-widest",
                    active === s.id ? "text-slate-900" : "text-slate-400"
                  )}
                >
                  {s.label}
                </p>
                <p className="mt-1 font-mono text-[9px] font-bold uppercase tracking-widest text-slate-300">
                  {s.sub}
                </p>
              </button>
            ))}

            <div className="mt-6 rounded-2xl border border-dashed border-slate-200 p-4">
              <p className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest text-slate-400">
                <MousePointerSquareDashed size={11} /> 评审时先点这三处
              </p>
              <ul className="mt-2 space-y-2">
                {NOTES.map((n) => (
                  <li key={n} className="text-[10px] font-medium leading-relaxed text-slate-400">
                    · {n}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <div className="-mx-1 mb-6 flex gap-2 overflow-x-auto pb-2 lg:hidden">
            {SCREENS.map((s) => (
              <button
                key={s.id}
                onClick={() => setActive(s.id)}
                className={cn(
                  "shrink-0 rounded-full px-4 py-2 text-[10px] font-black uppercase tracking-widest transition",
                  active === s.id
                    ? "bg-slate-900 text-white"
                    : "bg-white text-slate-400 ring-1 ring-slate-200"
                )}
              >
                {s.label}
              </button>
            ))}
          </div>

          <Screen />
        </main>
      </div>
    </div>
  );
}
