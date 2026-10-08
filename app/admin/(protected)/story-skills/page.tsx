"use client";

/**
 * 写法管理（/admin/story-skills）
 *
 * 「AI 创作」面板上那一排 A–F 写法，就是从 story_skills 这张表读出来的。
 * 标签决定「写什么」，写法决定「怎么写」—— 后者才是那股 AI 味的来源：
 * 模型默认的叙述姿态（句长均匀、每段收口、该说的都说尽、结尾必给交代）
 * 本身就是那个味道，换题材是换不掉的。
 *
 * 每个写法带四样东西（改完立刻生效，面板每次打开都重新读库）：
 *   posture  姿态板 —— 9 条，明确指定这次偏在哪几条上
 *   exemplar 范文   —— 200–400 字，模型靠它学「句子怎么结束」，比讲道理有效得多
 *   rules    专属规矩、avoid 易踩的坑
 *
 * ⚠️ 范文是这里最重要的东西。只想改一句就改一句，别把它删空 ——
 *    没有范文的写法，模型会直接滑回它自己的默认腔调。
 *
 * 写库走浏览器直连 Supabase（和「创作标签」页一样），不经过任何 API 路由。
 */

import { useCallback, useEffect, useState } from "react";
import {
  PenTool, Loader2, Save, Trash2, Plus, CheckCircle2, AlertTriangle,
  Eye, EyeOff, Star,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { StorySkill } from "@/lib/storyPrompt";

type Notice = { msg: string; type: "ok" | "err" } | null;

/* ============================================================
   成色检查：这几栏填得够不够，直接决定生成出来的东西像人还是像 AI
   ============================================================ */
function quality(skill: StorySkill) {
  const exChars = (skill.exemplar || "").replace(/\s/g, "").length;
  const postureLines = (skill.posture || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean).length;
  const problems: string[] = [];
  if (exChars === 0) problems.push("范文是空的 —— 模型会滑回默认腔调");
  else if (exChars < 200) problems.push(`范文只有 ${exChars} 字（建议 200–400 字）`);
  else if (exChars > 600) problems.push(`范文 ${exChars} 字，太长了会挤掉正文的额度`);
  if (postureLines < 3) problems.push(`姿态板只有 ${postureLines} 条（少于 3 条基本不起作用）`);
  if (!(skill.avoid || "").trim()) problems.push("没写「别写成什么样」—— 这一栏拦得住一半的 AI 味");
  return { exChars, postureLines, problems };
}

/** 一个小输入框（各栏共用） */
function Field({
  label,
  value,
  onChange,
  placeholder,
  rows = 1,
  accent = false,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  accent?: boolean;
  hint?: string;
}) {
  return (
    <label className="block">
      <span
        className={`block mb-1.5 ml-1 text-[9px] font-black uppercase tracking-widest ${
          accent ? "text-indigo-500" : "text-slate-400"
        }`}
      >
        {label}
        {hint && <span className="ml-2 normal-case tracking-normal font-bold text-slate-300">{hint}</span>}
      </span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className={`w-full px-4 py-3 rounded-2xl text-xs font-medium leading-relaxed outline-none border transition-all resize-y ${
          accent
            ? "bg-indigo-50/40 border-indigo-100 text-slate-700 focus:border-indigo-300"
            : "bg-slate-50 border-transparent text-slate-600 focus:border-indigo-200 focus:bg-white"
        }`}
      />
    </label>
  );
}

/* ============================================================
   单个写法的编辑器：改完点「保存」，只更新这一行
   ============================================================ */
function SkillEditor({
  skill,
  notify,
  onSaved,
  onDeleted,
  onSetDefault,
}: {
  skill: StorySkill;
  notify: (msg: string, type: "ok" | "err") => void;
  onSaved: (skill: StorySkill) => void;
  onDeleted: (id: string) => void;
  onSetDefault: (skill: StorySkill) => void;
}) {
  const [draft, setDraft] = useState({
    code: skill.code || "",
    name: skill.name || "",
    tagline: skill.tagline || "",
    summary: skill.summary || "",
    posture: skill.posture || "",
    exemplar: skill.exemplar || "",
    rules: skill.rules || "",
    avoid: skill.avoid || "",
    best_for: skill.best_for || "",
    sort_order: String(skill.sort_order ?? 0),
  });
  const [busy, setBusy] = useState<"" | "save" | "delete" | "toggle">("");

  const dirty =
    draft.code !== (skill.code || "") ||
    draft.name !== (skill.name || "") ||
    draft.tagline !== (skill.tagline || "") ||
    draft.summary !== (skill.summary || "") ||
    draft.posture !== (skill.posture || "") ||
    draft.exemplar !== (skill.exemplar || "") ||
    draft.rules !== (skill.rules || "") ||
    draft.avoid !== (skill.avoid || "") ||
    draft.best_for !== (skill.best_for || "") ||
    (Number(draft.sort_order) || 0) !== (skill.sort_order ?? 0);

  const q = quality({
    ...skill,
    posture: draft.posture,
    exemplar: draft.exemplar,
    avoid: draft.avoid,
  });

  const save = async () => {
    if (!draft.code.trim() || !draft.name.trim()) {
      notify("写法代号和名字都不能是空的", "err");
      return;
    }
    setBusy("save");
    const patch = {
      code: draft.code.trim(),
      name: draft.name.trim(),
      tagline: draft.tagline.trim(),
      summary: draft.summary.trim(),
      posture: draft.posture.trim(),
      exemplar: draft.exemplar.trim(),
      rules: draft.rules.trim(),
      avoid: draft.avoid.trim(),
      best_for: draft.best_for.trim(),
      sort_order: Number(draft.sort_order) || 0,
    };
    const { error } = await supabase.from("story_skills").update(patch).eq("id", skill.id);
    setBusy("");
    if (error) {
      notify(
        error.code === "23505" ? "代号或名字和别的写法重了，换一个" : `保存失败：${error.message}`,
        "err"
      );
      return;
    }
    onSaved({ ...skill, ...patch });
    notify(`已保存「${patch.name}」（下次点生成就生效）`, "ok");
  };

  const toggleActive = async () => {
    setBusy("toggle");
    const next = !skill.is_active;
    const { error } = await supabase.from("story_skills").update({ is_active: next }).eq("id", skill.id);
    setBusy("");
    if (error) {
      notify(`操作失败：${error.message}`, "err");
      return;
    }
    onSaved({ ...skill, is_active: next });
    notify(
      next
        ? `「${skill.name}」已启用`
        : skill.is_default
          ? `「${skill.name}」已停用 —— 它同时是默认写法，不选写法时就没写法可用了，记得再设一个默认`
          : `「${skill.name}」已停用（面板上不再出现）`,
      "ok"
    );
  };

  const remove = async () => {
    if (
      !window.confirm(
        `确定删掉写法「${skill.name}」？\n删掉后「AI 创作」面板里就没有它了（建议先「停用」而不是删）。`
      )
    )
      return;
    setBusy("delete");
    const { error } = await supabase.from("story_skills").delete().eq("id", skill.id);
    setBusy("");
    if (error) {
      notify(`删除失败：${error.message}`, "err");
      return;
    }
    if (skill.id) onDeleted(skill.id);
    notify(`已删除「${skill.name}」`, "ok");
  };

  return (
    <div
      className={`bg-white rounded-[32px] border shadow-sm p-6 space-y-4 ${
        skill.is_default ? "border-amber-300 ring-1 ring-amber-200" : "border-slate-200"
      } ${skill.is_active ? "" : "opacity-60"}`}
    >
      {/* 抬头：代号 + 名字 + 几个状态徽章 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-9 h-9 rounded-2xl bg-slate-900 text-white flex items-center justify-center font-black text-sm shrink-0">
          {(draft.code || "?").slice(0, 2)}
        </span>
        <input
          value={draft.code}
          onChange={(e) => setDraft({ ...draft, code: e.target.value })}
          placeholder="代号"
          className="w-16 px-3 py-2 rounded-xl bg-slate-50 border border-transparent text-xs font-black text-slate-700 outline-none focus:border-indigo-200 focus:bg-white transition-all"
        />
        <input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="写法名，例如：冷刃白描"
          className="flex-1 min-w-[200px] px-3 py-2 rounded-xl bg-slate-50 border border-transparent text-sm font-black text-slate-900 outline-none focus:border-indigo-200 focus:bg-white transition-all"
        />
        {skill.is_default && (
          <span className="h-7 px-3 rounded-full bg-amber-100 text-amber-700 text-[9px] font-black uppercase tracking-widest flex items-center gap-1.5">
            <Star size={11} /> 默认
          </span>
        )}
        {!skill.is_active && (
          <span className="h-7 px-3 rounded-full bg-slate-100 text-slate-400 text-[9px] font-black uppercase tracking-widest">
            已停用
          </span>
        )}
        <span className="h-7 px-3 rounded-full bg-slate-50 text-slate-400 text-[9px] font-black uppercase tracking-widest">
          范文 {q.exChars} 字 · 姿态 {q.postureLines} 条
        </span>
      </div>

      {/* 成色不足就当场指出来 —— 这栏填得够不够，直接决定生成质量 */}
      {q.problems.length > 0 && (
        <div className="rounded-2xl bg-amber-50 border border-amber-100 px-4 py-3 space-y-1">
          {q.problems.map((p, i) => (
            <p key={i} className="text-[10px] font-bold text-amber-700 flex items-start gap-1.5">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {p}
            </p>
          ))}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        <Field
          label="一句话卖点 · 选择器上的一行小字"
          value={draft.tagline}
          onChange={(v) => setDraft({ ...draft, tagline: v })}
          placeholder="例如：把情绪从句子里抽走，只留动作"
        />
        <Field
          label="这个写法在干什么"
          value={draft.summary}
          onChange={(v) => setDraft({ ...draft, summary: v })}
          placeholder="例如：短句、砍断、只写外部，让读者自己往里填温度。"
        />
      </div>

      <Field
        label="姿态板 · 9 条，每行一条"
        hint="先写偏哪一边（长/短、说/省），再写具体到什么程度"
        value={draft.posture}
        onChange={(v) => setDraft({ ...draft, posture: v })}
        placeholder={"1 句长：短。平均 12 字以内，超过 25 字就砍成两句。\n2 段落：断裂。一段一到三句。\n3 信息：省略。因果动机能不说就不说。"}
        rows={6}
      />
      <Field
        label="范文 · 200–400 字（最重要的一栏）"
        hint="模型学的是「句子怎么结束」，不是内容"
        value={draft.exemplar}
        onChange={(v) => setDraft({ ...draft, exemplar: v })}
        placeholder="贴一段你自己写的、或者你喜欢的作者的段落。句子怎么结束、在哪里停顿，就是它要学的东西。"
        rows={5}
        accent
      />

      <div className="grid md:grid-cols-2 gap-4">
        <Field
          label="专属规矩 · 每行一条"
          value={draft.rules}
          onChange={(v) => setDraft({ ...draft, rules: v })}
          placeholder={"- 正文里不许出现两个以上的形容词堆叠。\n- 不写「他想起」，直接切进去。"}
          rows={3}
        />
        <Field
          label="别写成什么样 · 每行一条"
          value={draft.avoid}
          onChange={(v) => setDraft({ ...draft, avoid: v })}
          placeholder={"- 情绪大词（孤独、宿命、破防）\n- 大段内心独白\n- 结尾一定给个交代"}
          rows={3}
        />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Field
          label="适合什么题材 · 只在后台展示"
          value={draft.best_for}
          onChange={(v) => setDraft({ ...draft, best_for: v })}
          placeholder="例如：悬疑 / 推理 / 惊悚恐怖"
        />
        <label className="block">
          <span className="block mb-1.5 ml-1 text-[9px] font-black uppercase tracking-widest text-slate-400">
            排序 · 数字越小越靠前
          </span>
          <input
            value={draft.sort_order}
            onChange={(e) => setDraft({ ...draft, sort_order: e.target.value })}
            inputMode="numeric"
            className="w-full px-4 py-3 rounded-2xl bg-slate-50 border border-transparent text-xs font-bold text-slate-600 outline-none focus:border-indigo-200 focus:bg-white transition-all"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        {dirty && (
          <span className="mr-auto text-[9px] font-black uppercase tracking-widest text-amber-500">
            有未保存的改动
          </span>
        )}
        {!skill.is_default && (
          <button
            type="button"
            onClick={() => onSetDefault(skill)}
            className="h-10 px-4 rounded-xl text-[9px] font-black uppercase tracking-widest text-amber-600 hover:bg-amber-50 transition-all flex items-center gap-1.5"
          >
            <Star size={12} /> 设为默认
          </button>
        )}
        <button
          type="button"
          onClick={toggleActive}
          disabled={busy === "toggle"}
          className="h-10 px-4 rounded-xl text-[9px] font-black uppercase tracking-widest text-slate-500 hover:bg-slate-50 transition-all flex items-center gap-1.5"
        >
          {busy === "toggle" ? (
            <Loader2 size={12} className="animate-spin" />
          ) : skill.is_active ? (
            <EyeOff size={12} />
          ) : (
            <Eye size={12} />
          )}
          {skill.is_active ? "停用" : "启用"}
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={busy === "delete"}
          className="h-10 px-4 rounded-xl text-[9px] font-black uppercase tracking-widest text-rose-500 hover:bg-rose-50 transition-all flex items-center gap-1.5"
        >
          {busy === "delete" ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} 删除
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy === "save" || !dirty}
          className={`h-10 px-5 rounded-xl text-[9px] font-black uppercase tracking-widest flex items-center gap-1.5 transition-all ${
            dirty ? "bg-slate-900 text-white hover:bg-black" : "bg-slate-100 text-slate-300 cursor-not-allowed"
          }`}
        >
          {busy === "save" ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} 保存
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   页面主体
   ============================================================ */
const EMPTY_ADD = {
  code: "",
  name: "",
  tagline: "",
  summary: "",
  posture: "",
  exemplar: "",
  rules: "",
  avoid: "",
  best_for: "",
  sort_order: "70",
};

export default function StorySkillsAdmin() {
  const [skills, setSkills] = useState<StorySkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addDraft, setAddDraft] = useState({ ...EMPTY_ADD });
  const [savingAdd, setSavingAdd] = useState(false);

  const notify = useCallback((msg: string, type: "ok" | "err") => {
    setNotice({ msg, type });
    window.setTimeout(() => setNotice(null), 4000);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("story_skills")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("code", { ascending: true });
    setLoading(false);
    if (error) {
      setLoadError(
        /does not exist|schema cache|relation/i.test(error.message || "")
          ? "写法库还没建好：请先在 Supabase 里执行 supabase/43_story_skills.sql"
          : `读取失败：${error.message}`
      );
      return;
    }
    setLoadError("");
    setSkills((data || []) as StorySkill[]);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const patchLocal = (next: StorySkill) =>
    setSkills((prev) => prev.map((s) => (s.id === next.id ? next : s)));

  /** 设成默认写法：先摘掉原来那个，再戴上这个（表上有个「只许一个默认」的唯一索引） */
  const setDefault = async (skill: StorySkill) => {
    if (!skill.id) return;
    const prev = skills.find((s) => s.is_default);
    if (prev?.id) {
      const { error } = await supabase
        .from("story_skills")
        .update({ is_default: false })
        .eq("id", prev.id);
      if (error) {
        notify(`操作失败：${error.message}`, "err");
        return;
      }
    }
    const { error } = await supabase
      .from("story_skills")
      .update({ is_default: true })
      .eq("id", skill.id);
    if (error) {
      notify(`操作失败：${error.message}`, "err");
      return;
    }
    setSkills((list) =>
      list.map((s) => ({ ...s, is_default: s.id === skill.id }))
    );
    notify(`「${skill.name}」现在是默认写法（面板里不选也会用它）`, "ok");
  };

  const handleAdd = async () => {
    if (!addDraft.code.trim() || !addDraft.name.trim()) {
      notify("写法代号和名字都不能是空的", "err");
      return;
    }
    setSavingAdd(true);
    const row = {
      code: addDraft.code.trim(),
      name: addDraft.name.trim(),
      tagline: addDraft.tagline.trim(),
      summary: addDraft.summary.trim(),
      posture: addDraft.posture.trim(),
      exemplar: addDraft.exemplar.trim(),
      rules: addDraft.rules.trim(),
      avoid: addDraft.avoid.trim(),
      best_for: addDraft.best_for.trim(),
      sort_order: Number(addDraft.sort_order) || 0,
    };
    const { data, error } = await supabase.from("story_skills").insert([row]).select("*").single();
    setSavingAdd(false);
    if (error) {
      notify(error.code === "23505" ? "代号或名字重了，换一个" : `新增失败：${error.message}`, "err");
      return;
    }
    if (data) setSkills((prev) => [...prev, data as StorySkill]);
    setAddDraft({ ...EMPTY_ADD, sort_order: String(row.sort_order + 10) });
    setShowAdd(false);
    notify(`已新增「${row.name}」—— 记得把范文补上`, "ok");
  };

  if (loading)
    return (
      <div className="p-20 text-center animate-pulse font-black text-slate-300 uppercase italic tracking-widest">
        Loading Story Skills...
      </div>
    );

  return (
    <div className="min-h-screen bg-[#FAFAFA] p-8 md:p-12 text-slate-900 antialiased text-left pb-32">
      {/* 顶部固定栏 */}
      <div className="max-w-5xl mx-auto mb-12 flex flex-wrap justify-between items-center gap-4 sticky top-0 bg-[#FAFAFA]/85 backdrop-blur-md z-10 py-4 border-b border-slate-200">
        <div>
          <h2 className="text-2xl font-black italic uppercase tracking-tighter flex items-center gap-2">
            <PenTool className="text-slate-900" size={24} /> Story Skills
          </h2>
          <p className="text-[10px] font-bold text-slate-400 mt-1">
            共 {skills.length} 种写法 · 标签决定「写什么」，这里决定「怎么写」
          </p>
        </div>
        <div className="flex items-center gap-3">
          {notice && (
            <span
              className={`text-[10px] font-black uppercase tracking-widest flex items-center gap-1.5 ${
                notice.type === "ok" ? "text-emerald-500" : "text-rose-500"
              }`}
            >
              {notice.type === "ok" ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
              {notice.msg}
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowAdd((v) => !v)}
            className="h-11 px-5 rounded-2xl bg-slate-900 text-white text-[10px] font-black uppercase tracking-widest flex items-center gap-2 hover:bg-black transition-all"
          >
            <Plus size={14} /> 新增写法
          </button>
        </div>
      </div>

      {loadError && (
        <div className="max-w-5xl mx-auto mb-8 rounded-3xl bg-rose-50 border border-rose-100 px-6 py-5 text-[11px] font-bold text-rose-600 leading-relaxed flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {loadError}
        </div>
      )}

      {showAdd && (
        <div className="max-w-5xl mx-auto mb-8 bg-white rounded-[32px] border-2 border-dashed border-slate-200 p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-black uppercase tracking-widest text-slate-900 flex items-center gap-2">
              <Plus size={14} className="text-emerald-500" /> 新增一套写法
            </span>
            <span className="text-[9px] font-bold text-slate-400">
              先填个代号和名字存下来也行，范文以后补（留空会自动提示成色不足）
            </span>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <Field
              label="代号 · 面板按钮上的那个字符"
              value={addDraft.code}
              onChange={(v) => setAddDraft({ ...addDraft, code: v })}
              placeholder="例如：G"
            />
            <Field
              label="写法名"
              value={addDraft.name}
              onChange={(v) => setAddDraft({ ...addDraft, name: v })}
              placeholder="例如：方言口语"
            />
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <Field
              label="一句话卖点"
              value={addDraft.tagline}
              onChange={(v) => setAddDraft({ ...addDraft, tagline: v })}
              placeholder="例如：让所有人物说人话，说废话"
            />
            <Field
              label="排序 · 数字越小越靠前"
              value={addDraft.sort_order}
              onChange={(v) => setAddDraft({ ...addDraft, sort_order: v })}
              placeholder="70"
            />
          </div>

          <Field
            label="这个写法在干什么"
            value={addDraft.summary}
            onChange={(v) => setAddDraft({ ...addDraft, summary: v })}
            placeholder="一句话说清它和别的写法的区别。"
          />
          <Field
            label="姿态板 · 9 条，每行一条"
            value={addDraft.posture}
            onChange={(v) => setAddDraft({ ...addDraft, posture: v })}
            placeholder={"1 句长：\n2 段落：\n3 信息：\n4 情绪：\n5 比喻：\n6 对话：\n7 时间：\n8 视角距离：\n9 收尾："}
            rows={5}
          />
          <Field
            label="范文 · 200–400 字（最重要的一栏）"
            hint="模型学的是「句子怎么结束」，不是内容"
            value={addDraft.exemplar}
            onChange={(v) => setAddDraft({ ...addDraft, exemplar: v })}
            placeholder="贴一段你自己写的、或者你喜欢的作者的段落。"
            rows={5}
            accent
          />
          <div className="grid md:grid-cols-2 gap-4">
            <Field
              label="专属规矩 · 每行一条"
              value={addDraft.rules}
              onChange={(v) => setAddDraft({ ...addDraft, rules: v })}
              placeholder={"- "}
              rows={3}
            />
            <Field
              label="别写成什么样 · 每行一条"
              value={addDraft.avoid}
              onChange={(v) => setAddDraft({ ...addDraft, avoid: v })}
              placeholder={"- "}
              rows={3}
            />
          </div>
          <Field
            label="适合什么题材 · 只在后台展示"
            value={addDraft.best_for}
            onChange={(v) => setAddDraft({ ...addDraft, best_for: v })}
            placeholder="例如：家庭现实 / 都市"
          />

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowAdd(false)}
              className="h-10 px-4 rounded-xl text-[9px] font-black uppercase tracking-widest text-slate-400 hover:bg-slate-50 transition-all"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleAdd}
              disabled={savingAdd}
              className="h-10 px-5 rounded-xl bg-emerald-500 text-white text-[9px] font-black uppercase tracking-widest flex items-center gap-1.5 hover:bg-emerald-600 active:scale-95 transition-all"
            >
              {savingAdd ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} 加进去
            </button>
          </div>
        </div>
      )}

      <div className="max-w-5xl mx-auto space-y-6">
        {skills.length === 0 && !loadError && (
          <p className="text-[11px] font-bold text-slate-300 text-center py-16">
            还没有写法 —— 点右上角「新增写法」，或者先跑一遍 supabase/43_story_skills.sql。
          </p>
        )}
        {skills.map((s) => (
          <SkillEditor
            key={s.id}
            skill={s}
            notify={notify}
            onSaved={patchLocal}
            onDeleted={(id) => setSkills((prev) => prev.filter((x) => x.id !== id))}
            onSetDefault={setDefault}
          />
        ))}
      </div>

      <div className="max-w-5xl mx-auto mt-10 space-y-2">
        <p className="text-[10px] font-bold text-slate-400 leading-relaxed">
          改完点「保存」就生效 —— 「AI 创作」面板每次打开都会重新读这张表，不用重新部署。
        </p>
        <p className="text-[10px] font-bold text-slate-400 leading-relaxed">
          写法不进别的提示词：「姿态板 + 范文 + 专属规矩」是整段拼进 system 里的，改短一点，生成会快一点、便宜一点。
        </p>
        <p className="text-[10px] font-bold text-slate-300 leading-relaxed">
          F「自定义文风」是留给你自己的空位：照 A–E 的格式填上你的姿态板和范文，它就是一套你的文风。
        </p>
      </div>
    </div>
  );
}

