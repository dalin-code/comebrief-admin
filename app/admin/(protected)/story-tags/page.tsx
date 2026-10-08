"use client";

/**
 * 创作标签管理（/admin/story-tags）
 *
 * 「AI 创作」面板里那 7 排标签，就是从 story_tags 这张表读出来的：
 *   名称 / 注解 / 例句 / 适用场景 —— 改完立刻生效（面板每次打开都重新读库）。
 *
 * 这里只做「后台 CRUD」，不生成任何内容：生成在简报编辑页右上角点「AI 创作」。
 * 写库走的是浏览器直连 Supabase（和「系统设置」页一样），不经过任何 API 路由。
 *
 * ⚠️ 例句是最重要的一栏：AI 是照着例句学「手感」的，只留一句干巴巴的定义，
 *    生成出来的东西会明显更油。所以例句尽量写成「真句子」，别写形容词。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Tags, Loader2, Save, Trash2, Plus, CheckCircle2, AlertTriangle,
  Eye, EyeOff, RotateCcw, Bookmark,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { DIMENSIONS, type DimensionKey, type StoryTag } from "@/lib/storyPrompt";

type Preset = { id: string; name: string; combo: any };
type Notice = { msg: string; type: "ok" | "err" } | null;

/** 一排标签的标题栏文案（维度定义只有一份，面板与提示词共用） */
const dimMeta = (key: DimensionKey) =>
  DIMENSIONS.find((d) => d.key === key) || { key, label: key, cn: "·", hint: "", max: 1 };

/* ============================================================
   单个标签的编辑器：改完点「保存」，只更新这一行
   ============================================================ */
function TagEditor({
  tag,
  notify,
  onSaved,
  onDeleted,
}: {
  tag: StoryTag;
  notify: (msg: string, type: "ok" | "err") => void;
  onSaved: (tag: StoryTag) => void;
  onDeleted: (id: string) => void;
}) {
  const [draft, setDraft] = useState({
    name: tag.name || "",
    summary: tag.summary || "",
    example: tag.example || "",
    usage_note: tag.usage_note || "",
    sort_order: String(tag.sort_order ?? 0),
  });
  const [busy, setBusy] = useState<"" | "save" | "delete" | "toggle">("");

  const dirty =
    draft.name !== (tag.name || "") ||
    draft.summary !== (tag.summary || "") ||
    draft.example !== (tag.example || "") ||
    draft.usage_note !== (tag.usage_note || "") ||
    (Number(draft.sort_order) || 0) !== (tag.sort_order ?? 0);

  const save = async () => {
    if (!draft.name.trim()) {
      notify("标签名不能是空的", "err");
      return;
    }
    setBusy("save");
    const patch = {
      name: draft.name.trim(),
      summary: draft.summary.trim(),
      example: draft.example.trim(),
      usage_note: draft.usage_note.trim(),
      sort_order: Number(draft.sort_order) || 0,
    };
    const { error } = await supabase.from("story_tags").update(patch).eq("id", tag.id);
    setBusy("");
    if (error) {
      notify(
        error.code === "23505" ? "这一排里已经有同名标签了，换个名字" : `保存失败：${error.message}`,
        "err"
      );
      return;
    }
    onSaved({ ...tag, ...patch });
    notify(`已保存「${patch.name}」`, "ok");
  };

  const toggleActive = async () => {
    setBusy("toggle");
    const next = !tag.is_active;
    const { error } = await supabase.from("story_tags").update({ is_active: next }).eq("id", tag.id);
    setBusy("");
    if (error) {
      notify(`操作失败：${error.message}`, "err");
      return;
    }
    onSaved({ ...tag, is_active: next });
    notify(next ? `「${tag.name}」已启用` : `「${tag.name}」已停用（面板上不再出现）`, "ok");
  };

  const remove = async () => {
    if (!window.confirm(`确定删掉标签「${tag.name}」？\n删掉后「AI 创作」面板里就没有它了（建议先「停用」而不是删）。`)) return;
    setBusy("delete");
    const { error } = await supabase.from("story_tags").delete().eq("id", tag.id);
    setBusy("");
    if (error) {
      notify(`删除失败：${error.message}`, "err");
      return;
    }
    onDeleted(tag.id);
    notify(`已删除「${tag.name}」`, "ok");
  };

  return (
    <div
      className={`rounded-3xl border p-5 transition-all ${
        tag.is_active ? "bg-white border-slate-200" : "bg-slate-50/70 border-slate-100 opacity-70"
      }`}
    >
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          className="flex-1 min-w-[140px] px-4 py-2.5 bg-slate-50 rounded-xl text-sm font-black text-slate-900 outline-none border border-transparent focus:border-indigo-300 focus:bg-white transition-all"
        />
        <div className="flex items-center gap-1.5 text-slate-400">
          <span className="text-[9px] font-black uppercase tracking-widest">排序</span>
          <input
            value={draft.sort_order}
            onChange={(e) => setDraft({ ...draft, sort_order: e.target.value })}
            inputMode="numeric"
            className="w-16 px-3 py-2.5 bg-slate-50 rounded-xl text-xs font-black text-slate-600 text-center outline-none border border-transparent focus:border-indigo-300 focus:bg-white transition-all"
          />
        </div>
        <button
          type="button"
          onClick={toggleActive}
          disabled={busy === "toggle"}
          title={tag.is_active ? "停用：面板上不再出现，但文案保留" : "启用：重新出现在面板上"}
          className={`h-10 px-4 rounded-xl text-[9px] font-black uppercase tracking-widest flex items-center gap-1.5 transition-all ${
            tag.is_active
              ? "bg-emerald-50 text-emerald-600 hover:bg-emerald-100"
              : "bg-slate-200 text-slate-500 hover:bg-slate-300"
          }`}
        >
          {busy === "toggle" ? (
            <Loader2 size={12} className="animate-spin" />
          ) : tag.is_active ? (
            <Eye size={12} />
          ) : (
            <EyeOff size={12} />
          )}
          {tag.is_active ? "启用中" : "已停用"}
        </button>
      </div>

      <div className="space-y-2">
        <Field
          label="注解 · 这是什么"
          value={draft.summary}
          onChange={(v) => setDraft({ ...draft, summary: v })}
          placeholder="一句话说清：这个标签是什么意思"
        />
        <Field
          label="例句 · AI 照着学手感（最重要）"
          value={draft.example}
          onChange={(v) => setDraft({ ...draft, example: v })}
          placeholder="写成真句子，别写形容词。例如：他把伞往她那边偏了两寸，自己肩膀湿透了，谁都没说话。"
          rows={2}
          accent
        />
        <Field
          label="适用场景 · 什么时候用它"
          value={draft.usage_note}
          onChange={(v) => setDraft({ ...draft, usage_note: v })}
          placeholder="例如：写心动、遗憾、久别重逢这类情绪的故事。"
        />
      </div>

      <div className="flex items-center justify-end gap-2 mt-4">
        {dirty && (
          <span className="mr-auto text-[9px] font-black uppercase tracking-widest text-amber-500">
            有未保存的改动
          </span>
        )}
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

/** 一行小输入框（注解 / 例句 / 场景共用） */
function Field({
  label,
  value,
  onChange,
  placeholder,
  rows = 1,
  accent = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  accent?: boolean;
}) {
  return (
    <label className="block">
      <span
        className={`block mb-1.5 ml-1 text-[9px] font-black uppercase tracking-widest ${
          accent ? "text-indigo-500" : "text-slate-400"
        }`}
      >
        {label}
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
   页面主体
   ============================================================ */
const EMPTY_ADD = { name: "", summary: "", example: "", usage_note: "", sort_order: "10" };

export default function StoryTagsAdmin() {
  const [tags, setTags] = useState<StoryTag[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [addingDim, setAddingDim] = useState<DimensionKey | "">("");
  const [addDraft, setAddDraft] = useState({ ...EMPTY_ADD });
  const [savingAdd, setSavingAdd] = useState(false);

  const notify = useCallback((msg: string, type: "ok" | "err") => {
    setNotice({ msg, type });
    window.setTimeout(() => setNotice(null), 3200);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const { data, error } = await supabase.from("story_tags").select("*");
    if (error) {
      setLoadError(error.message);
      setLoading(false);
      return;
    }
    const rows = ((data || []) as StoryTag[]).slice().sort((a, b) => {
      const ai = DIMENSIONS.findIndex((d) => d.key === a.dimension);
      const bi = DIMENSIONS.findIndex((d) => d.key === b.dimension);
      if (ai !== bi) return ai - bi;
      if ((a.sort_order ?? 0) !== (b.sort_order ?? 0)) return (a.sort_order ?? 0) - (b.sort_order ?? 0);
      return String(a.name).localeCompare(String(b.name));
    });
    setTags(rows);
    setLoading(false);
  }, []);

  const loadPresets = useCallback(async () => {
    const { data } = await supabase
      .from("story_presets")
      .select("id,name,combo")
      .order("updated_at", { ascending: false })
      .limit(50);
    setPresets(((data || []) as any[]).map((p) => ({ id: p.id, name: p.name, combo: p.combo || {} })));
  }, []);

  useEffect(() => {
    load();
    loadPresets();
  }, [load, loadPresets]);

  const grouped = useMemo(() => {
    const map: Record<string, StoryTag[]> = {};
    for (const d of DIMENSIONS) map[d.key] = [];
    for (const t of tags) {
      if (!map[t.dimension]) map[t.dimension] = [];
      map[t.dimension].push(t);
    }
    return map;
  }, [tags]);

  /** 在某排下面新增一个标签 */
  const handleAdd = async (dim: DimensionKey) => {
    if (!addDraft.name.trim()) {
      notify("标签名不能是空的", "err");
      return;
    }
    setSavingAdd(true);
    const row = {
      dimension: dim,
      name: addDraft.name.trim(),
      summary: addDraft.summary.trim(),
      example: addDraft.example.trim(),
      usage_note: addDraft.usage_note.trim(),
      sort_order: Number(addDraft.sort_order) || 0,
    };
    const { data, error } = await supabase.from("story_tags").insert([row]).select("*").single();
    setSavingAdd(false);
    if (error) {
      notify(error.code === "23505" ? "这一排里已经有同名标签了" : `新增失败：${error.message}`, "err");
      return;
    }
    if (data) setTags((prev) => [...prev, data as StoryTag]);
    setAddDraft({ ...EMPTY_ADD, sort_order: String(row.sort_order + 10) });
    setAddingDim("");
    notify(`已新增「${row.name}」`, "ok");
  };

  const deletePreset = async (p: Preset) => {
    if (!window.confirm(`删除预设「${p.name}」？`)) return;
    const { error } = await supabase.from("story_presets").delete().eq("id", p.id);
    if (error) {
      notify(`删除失败：${error.message}`, "err");
      return;
    }
    setPresets((prev) => prev.filter((x) => x.id !== p.id));
    notify("预设已删除", "ok");
  };

  /** 把存下来的配方翻译成人看得懂的一行话 */
  const comboSummary = (combo: any) => {
    const parts = DIMENSIONS.filter((d) => Array.isArray(combo?.[d.key]) && combo[d.key].length).map(
      (d) => `${d.label} ${combo[d.key].join("＋")}`
    );
    if (combo?.length) parts.push(`约 ${combo.length} 字`);
    return parts.length ? parts.join(" · ") : "（空组合）";
  };

  if (loading)
    return (
      <div className="p-20 text-center animate-pulse font-black text-slate-300 uppercase italic tracking-widest">
        Loading Story Tags...
      </div>
    );

  return (
    <div className="min-h-screen bg-[#FAFAFA] p-8 md:p-12 text-slate-900 antialiased text-left pb-32">
      {/* 顶部固定栏 */}
      <div className="max-w-5xl mx-auto mb-12 flex flex-wrap justify-between items-center gap-4 sticky top-0 bg-[#FAFAFA]/85 backdrop-blur-md z-10 py-4 border-b border-slate-200">
        <div>
          <h2 className="text-2xl font-black italic uppercase tracking-tighter flex items-center gap-2">
            <Tags className="text-slate-900" size={24} /> Story Tags
          </h2>
          <p className="text-[10px] font-bold text-slate-400 mt-1">
            共 {tags.length} 个标签 · 停用的不会出现在「AI 创作」面板上
          </p>
        </div>
        <div className="flex items-center gap-3">
          {notice && (
            <span
              className={`text-[10px] font-black uppercase tracking-widest flex items-center gap-1.5 ${
                notice.type === "ok" ? "text-emerald-500" : "text-rose-500"
              }`}
            >
              {notice.type === "ok" ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />} {notice.msg}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              load();
              loadPresets();
            }}
            className="flex items-center gap-2 px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-[0.2em] bg-slate-900 text-white hover:bg-black active:scale-95 shadow-xl shadow-slate-200 transition-all"
          >
            <RotateCcw size={14} /> 重新读取
          </button>
        </div>
      </div>

      <div className="max-w-5xl mx-auto space-y-10">
        {/* 使用说明 */}
        <section className="bg-white border border-slate-200 rounded-[32px] p-8">
          <p className="text-[11px] font-bold text-slate-500 leading-relaxed">
            这一页就是「AI 创作」面板里那 7 排标签的文案库。改完
            <strong className="text-slate-900">立刻生效</strong>
            ，不用重新部署 —— 下次打开面板（或刷新页面）读到的就是新文案。
            <br />
            例句是 AI 学「手感」的唯一来源：想让它写出来别那么油，改例句比改什么都有用。
            <br />
            暂时不想用的标签点「停用」（文案保留）；确定不要了再「删除」。
          </p>
        </section>

        {loadError && (
          <div className="bg-rose-50 border border-rose-100 rounded-[32px] p-8 text-[11px] font-bold text-rose-500 leading-relaxed">
            读不到标签表：{loadError}
            <br />
            多半是还没在 Supabase 里跑过 <code>42_story_tags.sql</code> 这份迁移。
          </div>
        )}

        {/* 7 排标签 */}
        {DIMENSIONS.map((d) => {
          const meta = dimMeta(d.key);
          const rows = grouped[d.key] || [];
          const activeCount = rows.filter((t) => t.is_active).length;
          const open = addingDim === d.key;
          return (
            <section key={d.key} className="bg-white border border-slate-200 rounded-[40px] shadow-sm overflow-hidden">
              <div className="px-10 py-6 bg-slate-50/60 border-b border-slate-100 flex flex-wrap items-center gap-3">
                <span className="text-[11px] font-black uppercase tracking-widest text-slate-900">
                  {d.cn} {d.label}
                </span>
                <span className="text-[9px] font-bold text-slate-400">{d.hint}</span>
                <span className="text-[9px] font-black text-slate-400 bg-white px-3 py-1 rounded-full border border-slate-100">
                  {activeCount} / {rows.length} 个启用
                </span>
                <span className="text-[9px] font-bold text-slate-300">面板上最多选 {meta.max} 个</span>
                <button
                  type="button"
                  onClick={() => {
                    setAddingDim(open ? "" : d.key);
                    setAddDraft({ ...EMPTY_ADD });
                  }}
                  className="ml-auto h-9 px-4 rounded-xl bg-slate-900 text-white text-[9px] font-black uppercase tracking-widest flex items-center gap-1.5 hover:bg-black active:scale-95 transition-all"
                >
                  <Plus size={12} /> 新增标签
                </button>
              </div>

              <div className="p-6 space-y-4">
                {open && (
                  <AddTagCard
                    draft={addDraft}
                    setDraft={setAddDraft}
                    saving={savingAdd}
                    onCancel={() => {
                      setAddingDim("");
                      setAddDraft({ ...EMPTY_ADD });
                    }}
                    onSubmit={() => handleAdd(d.key)}
                  />
                )}

                {rows.length === 0 && !open && (
                  <p className="text-[11px] font-bold text-slate-300 text-center py-6">
                    这一排还没有标签 —— 点右上角「新增标签」加一个。
                  </p>
                )}

                {rows.map((t) => (
                  <TagEditor
                    key={t.id}
                    tag={t}
                    notify={notify}
                    onSaved={(next) => setTags((prev) => prev.map((x) => (x.id === next.id ? next : x)))}
                    onDeleted={(id) => setTags((prev) => prev.filter((x) => x.id !== id))}
                  />
                ))}
              </div>
            </section>
          );
        })}

        {/* 常用配方：在「AI 创作」面板里点「保存预设」存下来的组合 */}
        <PresetsSection presets={presets} onDelete={deletePreset} comboSummary={comboSummary} />
      </div>
    </div>
  );
}

/* ============================================================
   某一排末尾展开的「新增标签」小表单
   ============================================================ */
type AddDraft = { name: string; summary: string; example: string; usage_note: string; sort_order: string };

function AddTagCard({
  draft,
  setDraft,
  saving,
  onCancel,
  onSubmit,
}: {
  draft: AddDraft;
  setDraft: (d: AddDraft) => void;
  saving: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="rounded-3xl border-2 border-dashed border-indigo-200 bg-indigo-50/30 p-5 space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="新标签名（例如：都市怪谈）"
          className="flex-1 min-w-[160px] px-4 py-2.5 bg-white rounded-xl text-sm font-black text-slate-900 outline-none border border-indigo-100 focus:border-indigo-300 transition-all"
        />
        <div className="flex items-center gap-1.5 text-slate-400">
          <span className="text-[9px] font-black uppercase tracking-widest">排序</span>
          <input
            value={draft.sort_order}
            onChange={(e) => setDraft({ ...draft, sort_order: e.target.value })}
            inputMode="numeric"
            className="w-16 px-3 py-2.5 bg-white rounded-xl text-xs font-black text-slate-600 text-center outline-none border border-indigo-100"
          />
        </div>
      </div>
      <Field
        label="注解 · 这是什么"
        value={draft.summary}
        onChange={(v) => setDraft({ ...draft, summary: v })}
        placeholder="一句话说清：这个标签是什么意思"
      />
      <Field
        label="例句 · AI 照着学手感（最重要）"
        value={draft.example}
        onChange={(v) => setDraft({ ...draft, example: v })}
        placeholder="写成真句子，别写形容词"
        rows={2}
        accent
      />
      <Field
        label="适用场景 · 什么时候用它"
        value={draft.usage_note}
        onChange={(v) => setDraft({ ...draft, usage_note: v })}
        placeholder="例如：想写压抑、说不出口的那种关系。"
      />
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="h-10 px-4 rounded-xl text-[9px] font-black uppercase tracking-widest text-slate-400 hover:bg-white transition-all"
        >
          取消
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={saving}
          className="h-10 px-5 rounded-xl bg-emerald-500 text-white text-[9px] font-black uppercase tracking-widest flex items-center gap-1.5 hover:bg-emerald-600 active:scale-95 transition-all"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} 加进这一排
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   常用配方：在「AI 创作」面板里点「保存预设」存下来的组合
   ============================================================ */
function PresetsSection({
  presets,
  onDelete,
  comboSummary,
}: {
  presets: Preset[];
  onDelete: (p: Preset) => void;
  comboSummary: (combo: any) => string;
}) {
  return (
    <section className="bg-white border border-slate-200 rounded-[40px] shadow-sm overflow-hidden">
      <div className="px-10 py-6 bg-slate-50/60 border-b border-slate-100 flex flex-wrap items-center gap-3">
        <span className="text-[11px] font-black uppercase tracking-widest text-slate-900 flex items-center gap-2">
          <Bookmark size={14} className="text-indigo-500" /> 常用配方 (Presets)
        </span>
        <span className="text-[9px] font-bold text-slate-400">
          在「AI 创作」面板里点「保存预设」存下来的组合
        </span>
      </div>
      <div className="p-6 space-y-3">
        {presets.length === 0 && (
          <p className="text-[11px] font-bold text-slate-300 text-center py-6">
            还没有预设 —— 去简报编辑页点「AI 创作」，选好标签后点「保存预设」。
          </p>
        )}
        {presets.map((p) => (
          <div key={p.id} className="flex items-center gap-4 rounded-3xl border border-slate-200 bg-white px-5 py-4">
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-black text-slate-900 truncate">{p.name}</p>
              <p className="text-[9px] font-bold text-slate-400 mt-1 truncate">{comboSummary(p.combo)}</p>
              {p.combo?.idea && (
                <p className="text-[9px] font-bold text-slate-300 mt-1 truncate">构思：{p.combo.idea}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDelete(p)}
              className="h-10 px-4 rounded-xl text-[9px] font-black uppercase tracking-widest text-rose-500 hover:bg-rose-50 transition-all flex items-center gap-1.5 shrink-0"
            >
              <Trash2 size={12} /> 删除
            </button>
          </div>
        ))}
        <p className="text-[9px] font-bold text-slate-300 leading-relaxed pt-2">
          这里只负责删。想改预设的内容：回「AI 创作」面板把标签调好，再用一个新名字存一份（同名会被挡住，因为名字不能重复）。
        </p>
      </div>
    </section>
  );
}


