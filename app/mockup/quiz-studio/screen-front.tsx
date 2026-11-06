"use client";

/**
 * 屏 6 · 前台 /quizzes
 *
 * 两个决定都体现在这一屏：
 *   ① 一张卡只允许**一个** badge（优先级 Viral > Pick > Trending > New > Quick），
 *      现在是想贴几个贴几个，卡片底部一排小字，扫读时等于没有信息。
 *   ② 筛选维度换成 topic，而不是现在 QuizzesBrowser 里那段
 *      `quiz.category === 'Pop Culture' || quiz.title.includes('K-Pop')` 的字符串匹配。
 * 视觉上刻意用前台那套（纸色 + 衬线斜体 + 等宽小标），和 admin 的石灰白区分开。
 */

import React, { useState } from "react";
import { ArrowUpRight, Moon, Search } from "lucide-react";
import { FEED, FEED_FILTERS } from "./data";
import { cn } from "./ui";

export default function ScreenFront() {
  const [filter, setFilter] = useState("All");
  const cards = FEED.filter((c) => filter === "All" || c.topic === filter);

  return (
    <div className="overflow-hidden rounded-[40px] bg-[#FBF7EF] shadow-sm ring-1 ring-black/5">
      <div className="mk-sans flex items-center justify-between border-b border-[#0B0A12]/10 px-8 py-4">
        <div className="flex items-center gap-8">
          <span className="mk-display text-lg font-bold tracking-tight text-[#0B0A12]">
            ComeBrief<span className="text-[#FF6B3D]">.</span>
          </span>
          <nav className="hidden items-center gap-6 md:flex">
            {["Stories", "Quizzes", "About"].map((n, i) => (
              <span
                key={n}
                className={cn(
                  "mk-mono text-[10px] font-bold uppercase tracking-widest",
                  i === 1 ? "text-[#0B0A12]" : "text-[#0B0A12]/40"
                )}
              >
                {n}
              </span>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-[#0B0A12]/60">
          <Search size={15} />
          <Moon size={15} />
        </div>
      </div>

      <div className="px-8 pb-12 pt-10 md:px-12">
        <p className="mk-mono text-[10px] font-bold uppercase tracking-[0.3em] text-[#FF6B3D]">
          The quiz library
        </p>
        <h1 className="mk-display mt-3 max-w-2xl text-4xl font-bold italic leading-[1.05] tracking-tight text-[#0B0A12] md:text-5xl">
          Find out which one you are.
        </h1>
        <p className="mk-sans mt-3 max-w-xl text-sm leading-relaxed text-[#0B0A12]/60">
          Eight questions. Four archetypes. One result you will screenshot before you have
          finished reading it.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {FEED_FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "mk-mono rounded-full px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-widest transition",
                  filter === f
                    ? "bg-[#0B0A12] text-[#FBF7EF]"
                    : "text-[#0B0A12]/45 hover:bg-[#0B0A12]/5 hover:text-[#0B0A12]"
                )}
              >
                {f}
              </button>
            ))}
          </div>
          <span className="mk-mono text-[10px] font-bold uppercase tracking-widest text-[#0B0A12]/40">
            {cards.length} quizzes
          </span>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((c) => (
            <article key={c.id} className="group cursor-pointer">
              <div
                className={cn(
                  "relative aspect-[4/5] overflow-hidden rounded-[24px] bg-gradient-to-br ring-1 ring-black/5 transition-transform duration-300 group-hover:-translate-y-1",
                  c.cover
                )}
              >
                {c.badge && (
                  <span
                    className={cn(
                      "mk-mono absolute left-3 top-3 rounded-full px-2.5 py-1 text-[9px] font-bold uppercase tracking-widest shadow-sm",
                      c.badge.tone
                    )}
                  >
                    {c.badge.label}
                  </span>
                )}
                <div className="absolute inset-x-0 bottom-0 flex items-end justify-between bg-gradient-to-t from-black/45 to-transparent p-4">
                  <p className="mk-mono text-[9px] font-bold uppercase tracking-widest text-white/70">
                    {c.topic}
                  </p>
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/15 text-white ring-1 ring-white/30 backdrop-blur transition group-hover:bg-white group-hover:text-[#0B0A12]">
                    <ArrowUpRight size={13} />
                  </span>
                </div>
                <span className="mk-mono absolute right-4 top-3.5 text-[10px] font-bold tracking-widest text-white/50">
                  {String(FEED.findIndex((x) => x.id === c.id) + 1).padStart(2, "0")}
                </span>
                <span
                  aria-hidden
                  className="mk-display pointer-events-none absolute -bottom-6 -left-3 select-none text-[180px] font-bold italic leading-none text-white opacity-20 mix-blend-soft-light"
                >
                  {c.title.charAt(0)}
                </span>
              </div>
              <h3 className="mk-display mt-3 text-lg font-bold italic leading-snug tracking-tight text-[#0B0A12]">
                {c.title}
              </h3>
              <p className="mk-mono mt-1 text-[9px] font-bold uppercase tracking-widest text-[#0B0A12]/40">
                {c.meta}
              </p>
            </article>
          ))}
        </div>

        {cards.length === 0 && (
          <div className="mt-16 rounded-[24px] border border-dashed border-[#0B0A12]/15 py-20 text-center">
            <p className="mk-display text-xl font-bold italic text-[#0B0A12]/70">
              This shelf is still empty.
            </p>
            <p className="mk-mono mt-2 text-[10px] font-bold uppercase tracking-widest text-[#0B0A12]/35">
              &lt; 3 quizzes → noindex, follow
            </p>
          </div>
        )}

        <p className="mk-mono mt-10 text-[9px] font-bold uppercase leading-relaxed tracking-widest text-[#0B0A12]/30">
          一张卡只允许一个 badge · 优先级 Viral &gt; Pick &gt; Trending &gt; New &gt; Quick
        </p>
      </div>
    </div>
  );
}
