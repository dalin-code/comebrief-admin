"use client";

/**
 * axes 卷的权重矩阵编辑器（静态稿 `/mockup/quiz-studio` 屏 02 的落地版）。
 *
 * 为什么要有它：`model: "axes"` 的卷，胜负完全由「选项 × 原型」的 0–3 权重表
 * 决定，而这张表在旧编辑器里**根本没有地方放** —— 旧界面只有 `options[].score`
 * （单分数）和 `results[].min_score ~ max_score`（区间落点）。所以 axes 卷只能
 * 手写 JSON 直插 `raw_data`，这也正是 P4 之前「前台全绿但一卷都建不出来」的原因。
 *
 * 这一屏的三件事，缺一不可：
 *   1. **能编辑**：点格子循环 0→1→2→3，改题干 / 场景 / 选项 / 原型全在原地；
 *   2. **能看见后果**：每改一格，用 `enumerateAxe()` 把全部作答组合重跑一遍，
 *      列合计 / 命中占比 / 平局率 / 12 项检查立刻跟着变 —— 「某个原型再也抽不到」
 *      这类故障在矩阵里是**红色的一列 0%**，而不是上线两周后的用户投诉；
 *   3. **能配平**：`Scale` 按钮反复给最轻的那一列加分，直到极差 ≤ 3。
 *
 * 和静态稿的差别（都是有意的）：
 *   · 静态稿的表头是硬编码的 4 个原型，这里是动态列（2–8 个都行，横向滚动）；
 *   · 静态稿点「保存」是假的，这里没有保存按钮 —— 状态归父级（`onChange`），
 *     由 `/admin/quizzes/create` 的 Publish / Save Draft 统一落库；
 *   · 平局仲裁只写「按声明顺序」，静态稿里那句「指定仲裁题（Q5）」是稿子里的
 *     叙事，真实规则没有仲裁题（改动要同步 docs/quiz-axes.md）。
 *
 * 重算为什么要延后 140ms：10 题 × 4 选项 = 1,048,576 种组合，在输入框每敲一个
 * 字都同步重算会让打字肉眼可见地卡。延后只影响「数字晚一拍」，不影响存下来的
 * 权重；改格子（离散操作）也不受影响。
 */

import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2, Plus, Scale, Trash2, X } from "lucide-react";
import {
  MAX_NAME_CHARS,
  MAX_QUESTIONS,
  MAX_WEIGHT,
  MIN_HIT_PCT,
  MIN_QUESTIONS,
  axeChecks,
  axeHealthScore,
  enumerateAxe,
  type AxeCheck,
  type AxeEnumeration,
  type AxeQuiz,
} from "@/lib/quizAxes";

export type AxeEditorView = "matrix" | "archetypes";

type Audit = { enumeration: AxeEnumeration; checks: AxeCheck[]; health: number };

function computeAudit(quiz: AxeQuiz): Audit {
  const enumeration = enumerateAxe(quiz);
  const checks = axeChecks(quiz, enumeration);
  return { enumeration, checks, health: axeHealthScore(checks) };
}

/** 原型的色调只用于矩阵表头与热力底色，不写进数据（结果页的配色由分类决定）。 */
const TINTS = ["#FF6B3D", "#3B82F6", "#8B5CF6", "#10B981", "#F59E0B", "#EC4899", "#0EA5E9", "#84CC16"];

const tintFor = (index: number) => TINTS[index % TINTS.length];

const cn = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(" ");

const healthTone = (score: number) =>
  score >= 90 ? "text-emerald-500" : score >= 70 ? "text-amber-500" : "text-rose-500";

/** 一键起一份空卷：两个原型 + 一题两个选项 —— 一张能立刻开始画的表，而不是 4×6 的空壳。 */
export function blankAxeQuiz(): AxeQuiz {
  const stamp = Date.now().toString(36);
  return {
    model: "axes",
    archetypes: [
      { id: "arch1", name: "Archetype One", short: "A1", headline: "", quote: "", summary: "", stats: [], pills: [] },
      { id: "arch2", name: "Archetype Two", short: "A2", headline: "", quote: "", summary: "", stats: [], pills: [] },
    ],
    questions: [
      {
        id: `q-${stamp}`,
        scene: "",
        title: "",
        options: [
          { id: `o-${stamp}-a`, text: "", weights: {} },
          { id: `o-${stamp}-b`, text: "", weights: {} },
        ],
      },
    ],
  };
}

/**
 * 深拷贝到「可以安全 mutate」的层：只拷会被改的两层（原型数组项、选项权重表）。
 * 其余字段（题干、文案）是不可变字符串，浅拷就够。
 */
function cloneQuiz(quiz: AxeQuiz): AxeQuiz {
  return {
    ...quiz,
    archetypes: quiz.archetypes.map((a) => ({
      ...a,
      stats: [...(a.stats ?? [])],
      pills: [...(a.pills ?? [])],
    })),
    questions: quiz.questions.map((q) => ({
      ...q,
      options: q.options.map((o) => ({ ...o, weights: { ...o.weights } })),
    })),
  };
}

/** 新 id 必须避开已占用的键，否则矩阵会出现两个同名列、React 也会撞 key。 */
function uniqueId(base: string, used: Set<string>): string {
  const clean = base.trim() || "arch";
  if (!used.has(clean)) return clean;
  for (let i = 2; i < 200; i += 1) {
    const candidate = `${clean}${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${clean}${Date.now()}`;
}

/** 格子底色：只把透明度加在背景上，字色保持可读（1 分格淡到看不见就没意义了）。 */
function cellTone(weight: number, tint: string): { className: string; style?: React.CSSProperties } {
  if (weight <= 0) return { className: "bg-slate-50 text-slate-300 hover:bg-slate-100" };
  const rgb = tint
    .replace("#", "")
    .match(/.{2}/g)!
    .map((hex) => parseInt(hex, 16))
    .join(",");
  const alpha = weight === 1 ? 0.16 : weight === 2 ? 0.42 : 1;
  return {
    className: "font-black shadow-sm",
    style: { backgroundColor: `rgba(${rgb},${alpha})`, color: weight >= MAX_WEIGHT ? "#ffffff" : "#0f172a" },
  };
}

type Props = {
  quiz: AxeQuiz;
  onChange: (next: AxeQuiz) => void;
  /** 由父级（`activeTab`）驱动，这样顶部导航与这里的视图永远同一个真相。 */
  view: AxeEditorView;
  onViewChange: (next: AxeEditorView) => void;
};

export default function QuizAxesEditor({ quiz, onChange, view, onViewChange }: Props) {
  // 「已经算完的那一版卷」：输入框永远拿到最新的 `quiz`（受控、不卡字），
  // 只有矩阵数字滞后 140ms。用两份状态而不是 `useEffect` 里 setState 算出来的
  // pending —— 后者在 React 19 里会被 `react-hooks/set-state-in-effect` 拦下，
  // 而且会导致「先渲染一次旧值、再渲染一次新值」的级联。
  const [settledQuiz, setSettledQuiz] = useState<AxeQuiz>(quiz);
  // pills 用逗号分隔的输入框：编辑中存原文，失焦时才切成数组 —— 否则用户
  // 刚敲下 "a, " 逗号就被吃掉，永远打不出第二个标签。
  const [pillDraft, setPillDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    const timer = window.setTimeout(() => setSettledQuiz(quiz), 140);
    return () => window.clearTimeout(timer);
  }, [quiz]);

  const audit = useMemo(() => computeAudit(settledQuiz), [settledQuiz]);
  const pending = settledQuiz !== quiz;


  /* ------------------------------------------------------------------ *
   * 写操作：全部走 copy-on-write，父级只收到新对象
   * ------------------------------------------------------------------ */

  const patch = (recipe: (draft: AxeQuiz) => void) => {
    const draft = cloneQuiz(quiz);
    recipe(draft);
    onChange(draft);
  };

  const setWeight = (qi: number, oi: number, archId: string, value: number) => {
    patch((draft) => {
      draft.questions[qi].options[oi].weights[archId] = Math.max(0, Math.min(MAX_WEIGHT, value));
    });
  };

  /** 点一格 0→1→2→3→0：三档循环比手打数字快，也不会打出 4。 */
  const cycleWeight = (qi: number, oi: number, archId: string) => {
    const current = quiz.questions[qi].options[oi].weights[archId] || 0;
    setWeight(qi, oi, archId, (current + 1) % (MAX_WEIGHT + 1));
  };

  const setQuestionText = (qi: number, field: "title" | "scene", value: string) => {
    patch((draft) => {
      draft.questions[qi][field] = value;
    });
  };

  const setOptionText = (qi: number, oi: number, value: string) => {
    patch((draft) => {
      draft.questions[qi].options[oi].text = value;
    });
  };

  const addQuestion = () => {
    if (quiz.questions.length >= MAX_QUESTIONS) return;
    const stamp = Date.now().toString(36);
    patch((draft) => {
      draft.questions.push({
        id: `q-${stamp}`,
        scene: "",
        title: "",
        options: [
          { id: `o-${stamp}-a`, text: "", weights: {} },
          { id: `o-${stamp}-b`, text: "", weights: {} },
        ],
      });
    });
  };

  const removeQuestion = (qi: number) => {
    patch((draft) => {
      draft.questions.splice(qi, 1);
    });
  };

  const addOption = (qi: number) => {
    const stamp = Date.now().toString(36);
    patch((draft) => {
      draft.questions[qi].options.push({ id: `o-${stamp}`, text: "", weights: {} });
    });
  };

  const removeOption = (qi: number, oi: number) => {
    patch((draft) => {
      draft.questions[qi].options.splice(oi, 1);
    });
  };

  const addArchetype = () => {
    patch((draft) => {
      const used = new Set(draft.archetypes.map((a) => a.id));
      const id = uniqueId(`arch${draft.archetypes.length + 1}`, used);
      draft.archetypes.push({ id, name: "", short: "", headline: "", quote: "", summary: "", stats: [], pills: [] });
    });
  };

  const removeArchetype = (ai: number) => {
    patch((draft) => {
      const id = draft.archetypes[ai].id;
      draft.archetypes.splice(ai, 1);
      // 删列时把权重键一起清掉：留着会在下次同名 id 出现时「复活」旧分数。
      draft.questions.forEach((q) =>
        q.options.forEach((o) => {
          delete o.weights[id];
        })
      );
    });
  };

  const setArchetypeText = (
    ai: number,
    field: "name" | "short" | "headline" | "quote" | "summary",
    value: string
  ) => {
    patch((draft) => {
      draft.archetypes[ai][field] = value;
    });
  };

  /**
   * 改原型 id —— **必须同时迁移权重表的键**。
   *
   * 权重是 `{ [archetypeId]: 0-3 }`，id 一改，旧键就指向一个不存在的原型：
   * 枚举时那一列静默变成 0（页面不报错，只是「这个原型再也抽不到」）。
   * 所以这里做三件事：洗成合法 id、保证唯一、把每一格的键一起改名。
   */
  const renameArchetype = (ai: number, raw: string) => {
    const oldId = quiz.archetypes[ai].id;
    const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!cleaned) return; // 空 id 会让整卷失去键，宁可不响应

    const others = new Set(quiz.archetypes.filter((_, i) => i !== ai).map((a) => a.id));
    // 重名直接拒绝（而不是静默改成 arch22）：作者会以为改成功了，权重却落在另一个键上。
    if (others.has(cleaned)) return;
    const nextId = cleaned;
    if (nextId === oldId) return;

    patch((draft) => {
      draft.archetypes[ai].id = nextId;
      draft.questions.forEach((q) =>
        q.options.forEach((o) => {
          if (Object.prototype.hasOwnProperty.call(o.weights, oldId)) {
            o.weights[nextId] = o.weights[oldId];
            delete o.weights[oldId];
          }
        })
      );
    });
  };

  /** stats 是「印在海报上的字」不是百分比；尾部空值会被裁掉，免得印出一个空行。 */
  const setStat = (ai: number, index: number, value: string) => {
    patch((draft) => {
      const stats = [...(draft.archetypes[ai].stats ?? [])];
      while (stats.length <= index) stats.push("");
      stats[index] = value;
      while (stats.length > 0 && !String(stats[stats.length - 1] ?? "").trim()) stats.pop();
      draft.archetypes[ai].stats = stats;
    });
  };

  const commitPills = (ai: number, raw: string) => {
    patch((draft) => {
      draft.archetypes[ai].pills = raw
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .slice(0, 4);
    });
  };

  /**
   * 自动配平：反复给「列合计最小」的原型加分，直到极差 ≤ 3 或加满 40 次。
   * 每次挑「行合计最小、且这一列还没到 3」的选项 —— 改动量最小，作者好复核。
   */
  const autoBalance = () => {
    const draft = cloneQuiz(quiz);
    const colIds = draft.archetypes.map((a) => a.id);
    if (colIds.length < 2) return;

    for (let step = 0; step < 40; step += 1) {
      const totals = colIds.map((id) =>
        draft.questions.reduce(
          (sum, q) => sum + q.options.reduce((acc, o) => acc + (o.weights[id] || 0), 0),
          0
        )
      );
      if (Math.max(...totals) - Math.min(...totals) <= 3) break;

      const targetId = colIds[totals.indexOf(Math.min(...totals))];
      let best: { qi: number; oi: number; sum: number } | null = null;
      draft.questions.forEach((q, qi) => {
        q.options.forEach((o, oi) => {
          if ((o.weights[targetId] || 0) >= MAX_WEIGHT) return;
          const sum = colIds.reduce((acc, id) => acc + (o.weights[id] || 0), 0);
          if (!best || sum < best.sum) best = { qi, oi, sum };
        });
      });
      if (!best) break;
      const pick: { qi: number; oi: number } = best;
      const option = draft.questions[pick.qi].options[pick.oi];
      option.weights[targetId] = (option.weights[targetId] || 0) + 1;
    }

    onChange(draft);
  };

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  const ids = quiz.archetypes.map((a) => a.id);
  const blockers = audit.checks.filter((c) => c.level === "blocker").length;
  const warnings = audit.checks.filter((c) => c.level === "warning").length;

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto p-8 space-y-6">
        {/* 抬头：卷面统计 + 视图切换 + 配平 */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-orange-500">
              Archetype matrix
            </p>
            <h2 className="mt-1 text-xl font-black italic tracking-tight text-slate-900">
              {quiz.questions.length} questions · {ids.length} archetypes ·{" "}
              {audit.enumeration.combos.toLocaleString()} combos
            </h2>
            <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">
              点格子循环 0→1→2→3 · 改一格右栏当场重算
              {audit.enumeration.sampled ? " · 组合数过大，已退化为固定种子抽样" : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {pending ? (
              <span className="flex items-center gap-2 rounded-2xl bg-slate-50 px-4 py-2.5 text-[9px] font-black uppercase tracking-widest text-slate-400">
                <Loader2 size={12} className="animate-spin" /> 重算中
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => onViewChange(view === "matrix" ? "archetypes" : "matrix")}
              className="rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-[9px] font-black uppercase tracking-widest text-slate-500 transition-all hover:text-slate-900"
            >
              {view === "matrix" ? "编辑原型文案" : "回到权重矩阵"}
            </button>
            <button
              type="button"
              onClick={autoBalance}
              title="给列合计最轻的原型补分，直到极差 ≤ 3"
              className="flex items-center gap-2 rounded-2xl bg-slate-900 px-4 py-2.5 text-[9px] font-black uppercase tracking-widest text-white shadow-sm transition-all hover:bg-black"
            >
              <Scale size={13} /> 配平
            </button>
          </div>
        </div>




        {view === "matrix" ? (
          <>
            <div className="overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-sm">
              <div className="overflow-x-auto">
                <div className="min-w-[760px]">
                  {/* 表头：每个原型一列（色调点 + 短名） */}
                  <div className="flex items-center gap-3 border-b border-slate-100 bg-slate-50/60 px-6 py-3">
                    <span className="flex-1 text-[9px] font-black uppercase tracking-widest text-slate-400">
                      Question · option
                    </span>
                    {quiz.archetypes.map((a, ai) => (
                      <span key={a.id} className="w-16 shrink-0 text-center" title={a.name}>
                        <span
                          className="mx-auto mb-1 block h-1.5 w-1.5 rounded-full"
                          style={{ backgroundColor: tintFor(ai) }}
                        />
                        <span className="block truncate text-[10px] font-black uppercase tracking-widest text-slate-500">
                          {a.short || a.name || "?"}
                        </span>
                      </span>
                    ))}
                    <span className="w-10 shrink-0 text-right text-[9px] font-black uppercase tracking-widest text-slate-300">
                      Σ
                    </span>
                    <span className="w-4 shrink-0" />
                  </div>

                  {quiz.questions.map((q, qi) => (
                    <div key={q.id || qi} className="border-b border-slate-100 last:border-b-0">
                      {/* 题干行：场景 + 题干 + 删题 */}
                      <div className="flex items-center gap-3 bg-slate-50/40 px-6 py-3">
                        <span className="w-5 shrink-0 text-center text-[9px] font-black text-slate-300">
                          {qi + 1}
                        </span>
                        <input
                          value={q.scene ?? ""}
                          onChange={(e) => setQuestionText(qi, "scene", e.target.value)}
                          placeholder="Scene"
                          className="w-36 shrink-0 rounded-lg bg-transparent px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-slate-400 outline-none transition-all focus:bg-white"
                        />
                        <input
                          value={q.title}
                          onChange={(e) => setQuestionText(qi, "title", e.target.value)}
                          placeholder="What's the question?"
                          className="flex-1 rounded-lg bg-transparent px-2 py-1 text-xs font-black italic text-slate-800 outline-none transition-all focus:bg-white"
                        />
                        <button
                          type="button"
                          onClick={() => removeQuestion(qi)}
                          title="删除这一题"
                          className="shrink-0 p-1 text-slate-300 transition-all hover:text-rose-500"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>

                      {q.options.map((o, oi) => {
                        const rowSum = ids.reduce((sum, id) => sum + (o.weights[id] || 0), 0);
                        return (
                          <div key={o.id || oi} className="flex items-center gap-3 px-6 py-1.5">
                            <span className="w-5 shrink-0 text-center text-[10px] font-black text-slate-300">
                              {String.fromCharCode(65 + oi)}
                            </span>
                            <input
                              value={o.text}
                              onChange={(e) => setOptionText(qi, oi, e.target.value)}
                              placeholder="Option label"
                              className="flex-1 rounded-lg bg-slate-50 px-3 py-1.5 text-[11px] font-bold text-slate-700 outline-none transition-all focus:bg-white focus:ring-1 focus:ring-slate-200"
                            />
                            {ids.map((id, colIndex) => {
                              const weight = o.weights[id] || 0;
                              const tone = cellTone(weight, tintFor(colIndex));
                              return (
                                <button
                                  key={id}
                                  type="button"
                                  onClick={() => cycleWeight(qi, oi, id)}
                                  title={`${quiz.archetypes[colIndex].name || id} · 权重 ${weight}`}
                                  style={tone.style}
                                  className={cn(
                                    "h-7 w-16 shrink-0 rounded-lg text-[11px] tabular-nums transition-all",
                                    tone.className
                                  )}
                                >
                                  {weight === 0 ? "·" : weight}
                                </button>
                              );
                            })}
                            <span
                              title="这一行给所有原型加的总分"
                              className={cn(
                                "w-10 shrink-0 text-right text-[11px] font-black tabular-nums",
                                rowSum === 0 ? "text-rose-400" : "text-slate-400"
                              )}
                            >
                              {rowSum}
                            </span>
                            <button
                              type="button"
                              onClick={() => removeOption(qi, oi)}
                              title="删除这个选项"
                              className="w-4 shrink-0 text-slate-200 transition-all hover:text-rose-500"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        );
                      })}

                      <div className="px-6 pb-3 pl-14">
                        <button
                          type="button"
                          onClick={() => addOption(qi)}
                          className="text-[9px] font-black uppercase tracking-widest text-slate-300 transition-all hover:text-slate-900"
                        >
                          + option
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 底部合计：列合计 / 命中占比 / 平局率，全部由全枚举算出 */}
              <div className="space-y-2 border-t border-slate-100 bg-slate-50/40 px-6 py-4">
                <div className="flex items-center gap-3">
                  <span className="flex-1 text-[9px] font-black uppercase tracking-widest text-slate-400">
                    列合计
                  </span>
                  {ids.map((id) => (
                    <span
                      key={id}
                      className="w-16 shrink-0 text-center text-[11px] font-black tabular-nums text-slate-600"
                    >
                      {audit.enumeration.columnTotals[id] ?? 0}
                    </span>
                  ))}
                  <span className="w-10 shrink-0 text-right text-[11px] font-black tabular-nums text-slate-300">
                    {ids.reduce((sum, id) => sum + (audit.enumeration.columnTotals[id] ?? 0), 0)}
                  </span>
                  <span className="w-4 shrink-0" />
                </div>
                <div className="flex items-center gap-3">
                  <span className="flex-1 text-[9px] font-black uppercase tracking-widest text-slate-400">
                    命中占比 · 全枚举
                  </span>
                  {ids.map((id) => (
                    <span
                      key={id}
                      className={cn(
                        "w-16 shrink-0 text-center text-[11px] font-black tabular-nums",
                        (audit.enumeration.hitPct[id] ?? 0) < MIN_HIT_PCT
                          ? "text-rose-500"
                          : "text-slate-600"
                      )}
                    >
                      {(audit.enumeration.hitPct[id] ?? 0).toFixed(0)}%
                    </span>
                  ))}
                  <span className="w-10 shrink-0" />
                  <span className="w-4 shrink-0" />
                </div>
                <p className="text-[9px] font-bold uppercase tracking-widest text-slate-300">
                  平局按声明顺序裁决 · 当前平局率 {audit.enumeration.tiePct.toFixed(1)}%
                  {audit.enumeration.deadOptions.length
                    ? ` · ${audit.enumeration.deadOptions.length} 个废选项（全 0 行）`
                    : ""}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={addQuestion}
                disabled={quiz.questions.length >= MAX_QUESTIONS}
                className="flex items-center gap-2 rounded-2xl border-2 border-dashed border-slate-200 px-6 py-3 text-[10px] font-black uppercase tracking-widest text-slate-400 transition-all hover:border-slate-900 hover:text-slate-900 disabled:opacity-40"
              >
                <Plus size={13} /> New question
              </button>
              <button
                type="button"
                onClick={() => onViewChange("archetypes")}
                className="flex items-center gap-2 rounded-2xl border-2 border-dashed border-slate-200 px-6 py-3 text-[10px] font-black uppercase tracking-widest text-slate-400 transition-all hover:border-slate-900 hover:text-slate-900"
              >
                <Plus size={13} /> Archetype copy
              </button>
              {quiz.questions.length < MIN_QUESTIONS ? (
                <span className="text-[10px] font-bold text-amber-600">
                  建议 {MIN_QUESTIONS}–{MAX_QUESTIONS} 题：现在 {quiz.questions.length} 题，
                  原型互相抢票会让分布抖得很厉害
                </span>
              ) : null}
            </div>
          </>
        ) : (

          <div className="space-y-4">
            {quiz.archetypes.map((a, ai) => {
              const pillText = pillDraft[a.id] ?? (a.pills ?? []).join(", ");
              return (
                <div
                  key={a.id}
                  className="space-y-4 rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: tintFor(ai) }}
                    />
                    <input
                      value={a.name}
                      onChange={(e) => setArchetypeText(ai, "name", e.target.value)}
                      placeholder="Archetype name（印在票根 / 海报上）"
                      className="min-w-0 flex-1 rounded-xl bg-slate-50 px-4 py-2.5 text-sm font-black italic text-slate-900 outline-none transition-all focus:bg-white"
                    />
                    <span
                      className={cn(
                        "shrink-0 text-[9px] font-black tabular-nums",
                        a.name.length > MAX_NAME_CHARS ? "text-rose-500" : "text-slate-300"
                      )}
                    >
                      {a.name.length}/{MAX_NAME_CHARS}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeArchetype(ai)}
                      disabled={quiz.archetypes.length <= 2}
                      title="至少留两个原型，否则没有可比的结果"
                      className="shrink-0 p-1 text-slate-300 transition-all hover:text-rose-500 disabled:opacity-30"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <label className="block space-y-1">
                      <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">
                        id · 权重表的键
                      </span>
                      <input
                        value={a.id}
                        onChange={(e) => renameArchetype(ai, e.target.value)}
                        title="只能是 a-z / 0-9 / _ / -；不能为空、不能与别的原型重名；改名会自动迁移权重表的键"
                        className="w-full rounded-xl bg-slate-50 px-3 py-2 font-mono text-[11px] font-bold text-slate-600 outline-none transition-all focus:bg-white"
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">
                        短名 · 只用在矩阵表头
                      </span>
                      <input
                        value={a.short ?? ""}
                        onChange={(e) => setArchetypeText(ai, "short", e.target.value)}
                        placeholder="A1"
                        className="w-full rounded-xl bg-slate-50 px-3 py-2 text-[11px] font-bold text-slate-600 outline-none transition-all focus:bg-white"
                      />
                    </label>
                  </div>

                  <input
                    value={a.headline ?? ""}
                    onChange={(e) => setArchetypeText(ai, "headline", e.target.value)}
                    placeholder="Headline · 结果页的大字那句"
                    className="w-full rounded-xl bg-slate-50 px-4 py-2.5 text-[12px] font-bold text-slate-700 outline-none transition-all focus:bg-white"
                  />
                  <textarea
                    value={a.quote ?? ""}
                    onChange={(e) => setArchetypeText(ai, "quote", e.target.value)}
                    placeholder="Quote · 印在结果页引语块里的一句话"
                    rows={2}
                    className="w-full resize-none rounded-xl bg-slate-50 px-4 py-2.5 text-[12px] font-medium leading-relaxed text-slate-600 outline-none transition-all focus:bg-white"
                  />
                  <textarea
                    value={a.summary ?? ""}
                    onChange={(e) => setArchetypeText(ai, "summary", e.target.value)}
                    placeholder="The Read · 结果页正文那一段（AI 起草会填，2–3 句）"
                    rows={3}
                    className="w-full resize-none rounded-xl bg-slate-50 px-4 py-2.5 text-[12px] font-medium leading-relaxed text-slate-600 outline-none transition-all focus:bg-white"
                  />

                  <div className="space-y-2">
                    <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">
                      三条 stats · 印在海报上的字（不是百分比）
                    </span>
                    {[0, 1, 2].map((i) => (
                      <input
                        key={i}
                        value={(a.stats ?? [])[i] ?? ""}
                        onChange={(e) => setStat(ai, i, e.target.value)}
                        placeholder="8.4k memes archived"
                        className="w-full rounded-xl bg-slate-50 px-3 py-2 text-[11px] font-bold text-slate-600 outline-none transition-all focus:bg-white"
                      />
                    ))}
                  </div>

                  <label className="block space-y-1">
                    <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">
                      pills · 逗号分隔，最多 4 个（票根上的小标签）
                    </span>
                    <input
                      value={pillText}
                      onChange={(e) =>
                        setPillDraft((prev) => ({ ...prev, [a.id]: e.target.value }))
                      }
                      onBlur={(e) => {
                        commitPills(ai, e.target.value);
                        setPillDraft((prev) => {
                          const next = { ...prev };
                          delete next[a.id];
                          return next;
                        });
                      }}
                      placeholder="Chronically online, Screenshot hoarder"
                      className="w-full rounded-xl bg-slate-50 px-3 py-2 text-[11px] font-bold text-slate-600 outline-none transition-all focus:bg-white"
                    />
                  </label>
                </div>
              );
            })}

            <button
              type="button"
              onClick={addArchetype}
              className="flex w-full items-center justify-center gap-2 rounded-[28px] border-2 border-dashed border-slate-200 py-5 text-[10px] font-black uppercase tracking-widest text-slate-400 transition-all hover:border-slate-900 hover:text-slate-900"
            >
              <Plus size={13} /> New archetype
            </button>
          </div>
        )}
      </div>

      {/* 右栏：12 项发布前检查（与 CI 的 check:quiz 同源，都是 axeChecks） */}
      <aside className="no-scrollbar w-80 shrink-0 space-y-4 overflow-y-auto border-l border-slate-200 bg-white p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
              Pre-flight
            </p>
            <p className="mt-1 text-[9px] font-bold uppercase tracking-widest text-slate-300">
              {audit.checks.length} 项 · {blockers} blocker / {warnings} warning
            </p>
          </div>
          <p
            className={cn(
              "text-4xl font-black leading-none tabular-nums tracking-tighter",
              healthTone(audit.health)
            )}
          >
            {audit.health}
          </p>
        </div>

        <ul className="space-y-2">
          {audit.checks.map((check) => (
            <li key={check.id} className="rounded-2xl border border-slate-100 p-3">
              <div className="flex items-start gap-2">
                <span
                  className={cn(
                    "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
                    check.level === "ok"
                      ? "bg-emerald-50 text-emerald-600"
                      : check.level === "warning"
                        ? "bg-amber-50 text-amber-500"
                        : "bg-rose-50 text-rose-600"
                  )}
                >
                  {check.level === "ok" ? (
                    <Check size={11} strokeWidth={3} />
                  ) : check.level === "warning" ? (
                    <AlertTriangle size={11} strokeWidth={3} />
                  ) : (
                    <X size={11} strokeWidth={3} />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "text-[10px] font-black leading-snug",
                      check.level === "ok" ? "text-slate-400" : "text-slate-700"
                    )}
                  >
                    {check.label}
                  </p>
                  {check.detail ? (
                    <p className="mt-1 text-[9px] font-medium leading-relaxed text-slate-400">
                      {check.detail}
                    </p>
                  ) : null}
                </div>
                {check.level !== "ok" ? (
                  <span className="shrink-0 text-[9px] font-black text-slate-300">
                    −{check.penalty}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>

        <p className="rounded-2xl bg-slate-50 p-4 text-[9px] font-bold leading-relaxed text-slate-400">
          满分 100。有 blocker 时不能发布（草稿可以存）：抽不到的原型、盖不满的格子算
          blocker，剩下的是「会影响体感」的 warning。这份检查与 CI 的 check:quiz 同源，
          后台看到 100 分就该过 CI。
        </p>
      </aside>
    </div>
  );
}
