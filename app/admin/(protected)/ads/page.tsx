"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  Laptop, Smartphone, CheckCircle2, XCircle, Info, Upload,
  Link as LinkIcon, Loader2, Trash2, RefreshCw,
  MousePointerClick, Eye, Clock, ShieldCheck, Image as ImageIcon,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { getFreshAccessToken } from "@/lib/clientAuth";
import { AD_SLOTS, type AdSlotId } from "@/lib/adsSlots";
// 🚀 图片压缩库（沿用 v3.5 的 WebP 自动转换）
import imageCompression from "browser-image-compression";

/**
 * 广告矩阵 v4
 *
 * 与 v3.5 的区别（每条都是线上真踩过的）：
 *   ① 坑位从「后台写死的 6 个」收敛到 4 个主力坑位，并且和前台/接口共用
 *      `lib/adsSlots.ts` —— 不会再出现「后台能配、前台没挂」；
 *   ② 保存不再直接写 `ads` 表（anon key 谁都能拿），而是带登录票打
 *      `/api/admin/ads`，服务端按坑位 upsert + 清重复行；
 *   ③ 卡片上直接给运营信息：来源、最后更新时间、7 天点击/曝光/CTR；
 *   ④ 每个坑位一个「清空素材」按钮，过期推广一键下线。
 */

type Stats = { clicks7d: number; impressions7d: number; clicksTotal: number; ctr: number | null };

type AdsPayload = {
  ads: any[];
  stats: Record<string, Stats>;
  notes: string[];
  unknownPositions: string[];
  via: string | null;
};

const EMPTY: AdsPayload = { ads: [], stats: {}, notes: [], unknownPositions: [], via: null };
const EMPTY_STATS: Stats = { clicks7d: 0, impressions7d: 0, clicksTotal: 0, ctr: null };

function nonEmpty(v: unknown) {
  const s = String(v ?? "").trim();
  return Boolean(s) && s !== "null" && s !== "undefined";
}

/** 与前台 `/api/ads`、后台 `lib/adsAdmin.ts` 同一口径：代码 或 图片+链接。 */
function hasCreative(row: any) {
  if (!row) return false;
  if (nonEmpty(row.ad_code) || nonEmpty(row.mobile_ad_code)) return true;
  const img = nonEmpty(row.image_url) || nonEmpty(row.mobile_image_url) || nonEmpty(row.dark_image_url);
  return img && nonEmpty(row.link);
}

function sourceLabel(row: any) {
  const code = `${row?.ad_code || ""} ${row?.mobile_ad_code || ""}`;
  if (!hasCreative(row)) return "无素材";
  if (/click-\d|anrdoezrs|tkqlhce|jdoqocy|kqzyfj|dpbolvw|awltovhc|lduhtrp|tqlkg|ftjcfx/i.test(code)) {
    return "Affiliate (CJ)";
  }
  if (/adsbygoogle|googlesyndication|doubleclick/i.test(code)) return "AdSense / AdX";
  if (nonEmpty(code)) return "HTML / JS";
  return "Image + Link";
}

function fmtTime(iso?: string | null) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleString("zh-CN", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

/** ISO → `<input type="datetime-local">` 需要的本地时间字符串。 */
function toLocalInput(iso?: string | null) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtPct(v: number | null) {
  if (v === null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}


export default function AdsAdminV4() {
  const [data, setData] = useState<AdsPayload>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [savingSlot, setSavingSlot] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ id: string; percent: number } | null>(null);
  const [toast, setToast] = useState<{ type: "success" | "error" | "info"; msg: string } | null>(null);
  /** 未落库的编辑内容：按坑位合并，避免 onBlur 保存后 textarea 还显示旧值 */
  const [drafts, setDrafts] = useState<Record<string, Record<string, any>>>({});

  const say = (type: "success" | "error" | "info", msg: string) => {
    setToast({ type, msg });
    window.setTimeout(() => setToast(null), type === "error" ? 8000 : 4000);
  };

  const apiCall = useCallback(async (init?: RequestInit) => {
    const token = await getFreshAccessToken();
    if (!token) throw new Error("登录已过期，请刷新页面重新登录");
    const resp = await fetch("/api/admin/ads", {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers || {}),
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || json?.ok === false) {
      throw new Error(json?.error || `请求失败（${resp.status}）`);
    }
    return json;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const json = await apiCall();
      setData({
        ads: json.ads || [],
        stats: json.stats || {},
        notes: json.notes || [],
        unknownPositions: json.unknownPositions || [],
        via: json.via || null,
      });
      setDrafts({});
    } catch (e: any) {
      say("error", e?.message || "加载广告失败");
    } finally {
      setLoading(false);
    }
  }, [apiCall]);

  useEffect(() => {
    load();
  }, [load]);

  const configOf = (slot: string) =>
    data.ads.find((a) => a.position === slot) || {
      id: null, position: slot, active: false, ad_code: "", mobile_ad_code: "",
      image_url: "", mobile_image_url: "", dark_image_url: "", link: "",
      weight: 1, start_at: null, end_at: null, categories: null, updated_at: null,
    };

  const draftOf = (slot: string, field: string, fallback: any) => {
    const d = drafts[slot];
    return d && field in d ? d[field] : fallback ?? "";
  };

  const setDraft = (slot: string, field: string, value: any) => {
    setDrafts((prev) => ({ ...prev, [slot]: { ...(prev[slot] || {}), [field]: value } }));
  };

  /** 把服务端返回的单行合进列表（同坑位的旧行先剔掉） */
  const mergeRow = (prev: AdsPayload, row: any): AdsPayload => {
    if (!row) return prev;
    const rest = prev.ads.filter((a) => a.position !== row.position && a.id !== row.id);
    return { ...prev, ads: [...rest, row] };
  };

  const save = async (slot: AdSlotId, patch: Record<string, any>, note?: string) => {
    if (!Object.keys(patch).length) return;
    setSavingSlot(slot);
    try {
      const json = await apiCall({
        method: "POST",
        body: JSON.stringify({ position: slot, action: "save", patch }),
      });
      setData((prev) => mergeRow(prev, json.row));
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[slot];
        return next;
      });
      const warnings: string[] = json.warnings || [];
      if (warnings.length) say("info", warnings[0]);
      else say("success", note || "已保存，线上接口最多 60 秒内生效");
      if (json.removed) say("success", `已顺带清理 ${json.removed} 条重复记录`);
    } catch (e: any) {
      say("error", e?.message || "保存失败");
      load();
    } finally {
      setSavingSlot(null);
    }
  };

  const clearSlot = async (slot: AdSlotId) => {
    if (!confirm("清空该坑位的代码/图片/链接，并关闭开关？（前台会立刻不再渲染）")) return;
    setSavingSlot(slot);
    try {
      const json = await apiCall({
        method: "POST",
        body: JSON.stringify({ position: slot, action: "clear" }),
      });
      setData((prev) => mergeRow(prev, json.row));
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[slot];
        return next;
      });
      say("success", "已清空并关闭该坑位");
    } catch (e: any) {
      say("error", e?.message || "清空失败");
    } finally {
      setSavingSlot(null);
    }
  };

  /** 上传：压缩 → WebP → Storage → 写回 image_url（沿用 v3.5 的链路） */
  const handleUpload = async (slot: AdSlotId, file: File) => {
    setUploadProgress({ id: slot, percent: 10 });
    try {
      const compressed = await imageCompression(file, {
        maxSizeMB: 0.2,
        maxWidthOrHeight: 1920,
        useWebWorker: true,
        fileType: "image/webp",
      });
      setUploadProgress({ id: slot, percent: 40 });
      const filePath = `fallbacks/${slot}-${Date.now()}.webp`;
      const { error } = await supabase.storage
        .from("ad-images")
        .upload(filePath, compressed, { cacheControl: "3600", upsert: true });
      if (error) throw error;

      const { data: pub } = supabase.storage.from("ad-images").getPublicUrl(filePath);
      setUploadProgress({ id: slot, percent: 80 });
      await save(slot, { image_url: pub?.publicUrl || "" }, "WebP 兜底图已上传并保存");
    } catch (e: any) {
      say("error", e?.message || "图片压缩/上传失败");
    } finally {
      setUploadProgress(null);
    }
  };


  const statsOf = (id?: string | null): Stats => (id ? data.stats[id] || EMPTY_STATS : EMPTY_STATS);

  return (
    <div className="min-h-screen bg-[#FAFAFA] p-8 md:p-12 text-slate-900 antialiased font-sans text-left relative">
      {toast && (
        <div
          className={`fixed top-10 left-1/2 -translate-x-1/2 z-50 max-w-lg px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3 animate-in fade-in slide-in-from-top-4 duration-300 ${
            toast.type === "success"
              ? "bg-emerald-600 text-white"
              : toast.type === "info"
              ? "bg-slate-900 text-white"
              : "bg-rose-600 text-white"
          }`}
        >
          {toast.type === "success" ? (
            <CheckCircle2 size={18} className="shrink-0" />
          ) : toast.type === "info" ? (
            <Info size={18} className="shrink-0" />
          ) : (
            <XCircle size={18} className="shrink-0" />
          )}
          <span className="text-xs font-black tracking-wide leading-relaxed">{toast.msg}</span>
        </div>
      )}

      <div className="max-w-7xl mx-auto mb-10 flex flex-col md:flex-row md:items-end justify-between border-b border-slate-200 pb-8 gap-6">
        <div>
          <h2 className="text-3xl font-black italic tracking-tighter">Pro Ad Matrix v4</h2>
          <p className="text-[10px] text-slate-400 font-bold tracking-[0.2em] mt-2">
            4 个主力坑位 · 无素材不渲染 · 点击 / 曝光第一方统计
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[9px] font-black tracking-widest text-slate-400">
            写入通道 {data.via === "service_role" ? "SERVICE ROLE" : data.via === "user_token" ? "登录票" : "—"}
          </span>
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-2 bg-white border border-slate-200 text-slate-700 text-[10px] font-black tracking-widest px-4 py-2.5 rounded-xl hover:border-slate-300 disabled:opacity-50"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            刷新
          </button>
        </div>
      </div>

      {data.unknownPositions.length > 0 && (
        <div className="max-w-7xl mx-auto mb-8 bg-amber-50 border border-amber-200 text-amber-800 rounded-2xl px-6 py-4 text-[11px] font-bold leading-relaxed">
          数据库里还有不在 4 个主力清单内的坑位：{data.unknownPositions.join(" / ")}。它们不会被前台渲染；
          跑一遍 <code className="font-mono">ComeBrief/supabase/51_ads_slots.sql</code> 或{" "}
          <code className="font-mono">scripts/ads-cleanup.mjs --apply</code> 完成迁移/清理。
        </div>
      )}

      {data.notes.length > 0 && (
        <div className="max-w-7xl mx-auto mb-8 bg-slate-900 text-slate-200 rounded-2xl px-6 py-4 space-y-1.5">
          {data.notes.map((n, i) => (
            <p key={i} className="text-[10px] font-bold tracking-wide leading-relaxed">
              · {n}
            </p>
          ))}
        </div>
      )}

      {loading ? (
        <div className="max-w-7xl mx-auto py-32 flex flex-col items-center gap-4">
          <Loader2 className="animate-spin text-slate-300" size={32} />
          <p className="text-[10px] font-black tracking-[0.3em] text-slate-400">LOADING AD MATRIX...</p>
        </div>
      ) : (
        <div className="max-w-7xl mx-auto grid gap-12">
          {AD_SLOTS.map((slot) => {
            const config = configOf(slot.id);
            const stats = statsOf(config.id);
            const isSaving = savingSlot === slot.id;
            const isUploading = uploadProgress?.id === slot.id;
            const ready = hasCreative(config);

            return (
              <div
                key={slot.id}
                className="bg-white border border-slate-200 rounded-[40px] shadow-sm overflow-hidden transition-all hover:shadow-xl"
              >
                <div className="p-8 border-b border-slate-50 flex flex-col lg:flex-row lg:items-center justify-between gap-6 bg-slate-50/20">
                  <div className="flex items-start gap-4 text-left">
                    <div className="w-12 h-12 bg-white border border-slate-100 rounded-xl flex items-center justify-center text-slate-400 shrink-0">
                      <ImageIcon size={20} />
                    </div>
                    <div>
                      <h3 className="text-lg font-black italic tracking-tighter text-left">{slot.name}</h3>
                      <p className="text-[9px] font-black text-slate-300 tracking-widest mt-1">
                        {slot.id} · {slot.page}
                      </p>
                      <p className="text-[10px] text-slate-500 mt-2 leading-relaxed max-w-xl">{slot.where}</p>
                      <p className="text-[9px] text-slate-400 mt-1">
                        PC {slot.desktop} · Mobile {slot.mobile}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    {isSaving && (
                      <span className="text-[9px] font-black tracking-widest text-slate-400 flex items-center gap-1.5">
                        <Loader2 size={12} className="animate-spin" /> 保存中
                      </span>
                    )}
                    <span
                      className={`text-[9px] font-black tracking-widest px-3 py-1.5 rounded-full ${
                        ready ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-400"
                      }`}
                    >
                      {sourceLabel(config)}
                    </span>
                    <button
                      onClick={() => save(slot.id, { active: !config.active })}
                      disabled={isSaving}
                      title={config.active ? "关闭该坑位" : "开启该坑位（没有素材会被自动保持关闭）"}
                      className={`relative inline-flex h-6 w-12 items-center rounded-full transition-all disabled:opacity-50 ${
                        config.active ? "bg-emerald-500" : "bg-slate-200"
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          config.active ? "translate-x-7" : "translate-x-1"
                        }`}
                      />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-5 divide-x divide-slate-100 border-b border-slate-50">
                  <div className="px-6 py-4">
                    <p className="text-[9px] font-black tracking-widest text-slate-400 flex items-center gap-1.5">
                      <ShieldCheck size={11} /> 状态
                    </p>
                    <p className={`mt-1.5 text-sm font-black ${config.active ? "text-emerald-600" : "text-slate-400"}`}>
                      {config.active ? "投放中" : "已关闭"}
                    </p>
                  </div>
                  <div className="px-6 py-4">
                    <p className="text-[9px] font-black tracking-widest text-slate-400 flex items-center gap-1.5">
                      <Clock size={11} /> 最后更新
                    </p>
                    <p className="mt-1.5 text-sm font-black text-slate-700">{fmtTime(config.updated_at)}</p>
                  </div>
                  <div className="px-6 py-4">
                    <p className="text-[9px] font-black tracking-widest text-slate-400 flex items-center gap-1.5">
                      <MousePointerClick size={11} /> 点击 7d
                    </p>
                    <p className="mt-1.5 text-sm font-black text-slate-700">
                      {stats.clicks7d}
                      <span className="ml-1.5 text-[9px] text-slate-400 font-bold">累计 {stats.clicksTotal}</span>
                    </p>
                  </div>
                  <div className="px-6 py-4">
                    <p className="text-[9px] font-black tracking-widest text-slate-400 flex items-center gap-1.5">
                      <Eye size={11} /> 曝光 7d
                    </p>
                    <p className="mt-1.5 text-sm font-black text-slate-700">{stats.impressions7d}</p>
                  </div>
                  <div className="px-6 py-4">
                    <p className="text-[9px] font-black tracking-widest text-slate-400 flex items-center gap-1.5">
                      <CheckCircle2 size={11} /> CTR 7d
                    </p>
                    <p className="mt-1.5 text-sm font-black text-slate-700">{fmtPct(stats.ctr)}</p>
                  </div>
                </div>

                <div className="p-8 grid grid-cols-1 lg:grid-cols-2 gap-8 border-b border-slate-50">
                  <div className="space-y-3">
                    <label className="text-[10px] font-black tracking-widest flex items-center gap-2">
                      <Laptop size={14} className="text-blue-500" /> Desktop Ad Code
                    </label>
                    <textarea
                      className="w-full h-32 bg-[#1E293B] rounded-2xl p-4 font-mono text-[10px] text-emerald-400 outline-none"
                      value={draftOf(slot.id, "ad_code", config.ad_code)}
                      onChange={(e) => setDraft(slot.id, "ad_code", e.target.value)}
                      onBlur={(e) => {
                        if (e.target.value.trim() !== String(config.ad_code || "").trim()) {
                          save(slot.id, { ad_code: e.target.value });
                        }
                      }}
                      placeholder='<a href="..."><img src="..." width="728" height="90" alt=""></a>'
                    />
                  </div>
                  <div className="space-y-3">
                    <label className="text-[10px] font-black tracking-widest flex items-center gap-2">
                      <Smartphone size={14} className="text-pink-500" /> Mobile Ad Code
                    </label>
                    <textarea
                      className="w-full h-32 bg-[#1E293B] rounded-2xl p-4 font-mono text-[10px] text-pink-400 outline-none"
                      value={draftOf(slot.id, "mobile_ad_code", config.mobile_ad_code)}
                      onChange={(e) => setDraft(slot.id, "mobile_ad_code", e.target.value)}
                      onBlur={(e) => {
                        if (e.target.value.trim() !== String(config.mobile_ad_code || "").trim()) {
                          save(slot.id, { mobile_ad_code: e.target.value });
                        }
                      }}
                      placeholder='<a href="..."><img src="..." width="300" height="250" alt=""></a>'
                    />
                  </div>
                </div>


                <div className="px-8 py-6 bg-slate-50 border-b border-slate-100 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-[10px] font-black text-slate-900 tracking-[0.2em]">
                        Visual Fallback · 优先级：Ad Code &gt; 图片+链接 &gt; 不渲染
                      </span>
                      <p className="text-[9px] text-slate-400 mt-1">
                        必填「图片 + 目标链接」才会生效；建议 PC {slot.desktop} / Mobile {slot.mobile}
                      </p>
                    </div>
                    {isUploading && (
                      <span className="text-[10px] font-black text-blue-500 animate-pulse tracking-widest">
                        WebP 转换中 {uploadProgress?.percent}%
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="flex items-center gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3">
                      <Upload size={16} className="text-slate-400 shrink-0" />
                      <input
                        type="text"
                        className="flex-1 text-[10px] font-mono outline-none text-slate-500 min-w-0"
                        value={draftOf(slot.id, "image_url", config.image_url)}
                        onChange={(e) => setDraft(slot.id, "image_url", e.target.value)}
                        onBlur={(e) => {
                          if (e.target.value.trim() !== String(config.image_url || "").trim()) {
                            save(slot.id, { image_url: e.target.value });
                          }
                        }}
                        placeholder="No Image Asset (Click SELECT)"
                      />
                      {!config.image_url ? (
                        <label
                          className={`px-3 py-1 bg-slate-900 text-white text-[9px] font-black rounded-lg cursor-pointer shrink-0 ${
                            isUploading ? "opacity-50 pointer-events-none" : ""
                          }`}
                        >
                          SELECT
                          <input
                            type="file"
                            className="hidden"
                            accept="image/png, image/jpeg, image/webp"
                            onChange={(e) => e.target.files?.[0] && handleUpload(slot.id, e.target.files[0])}
                          />
                        </label>
                      ) : (
                        <button
                          onClick={() => save(slot.id, { image_url: "" }, "已移除兜底图")}
                          className="p-1.5 bg-rose-50 text-rose-500 rounded-lg hover:bg-rose-500 hover:text-white transition-all shrink-0"
                          title="移除图片"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>

                    <div className="flex items-center gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3">
                      <LinkIcon size={16} className="text-slate-400 shrink-0" />
                      <input
                        type="text"
                        className="flex-1 text-[10px] font-mono outline-none min-w-0"
                        value={draftOf(slot.id, "link", config.link)}
                        onChange={(e) => setDraft(slot.id, "link", e.target.value)}
                        onBlur={(e) => {
                          if (e.target.value.trim() !== String(config.link || "").trim()) {
                            save(slot.id, { link: e.target.value });
                          }
                        }}
                        placeholder="Target Link (https://... 或 /trends/...)"
                      />
                    </div>
                  </div>
                </div>


                <div className="px-8 py-6 grid grid-cols-1 md:grid-cols-4 gap-4 border-b border-slate-50">
                  <div>
                    <label className="text-[9px] font-black tracking-widest text-slate-400">权重（1–100，同坑位多条时轮播）</label>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      className="mt-2 w-full text-[11px] font-mono border border-slate-200 rounded-xl px-3 py-2 outline-none focus:border-slate-400"
                      value={draftOf(slot.id, "weight", config.weight ?? 1)}
                      onChange={(e) => setDraft(slot.id, "weight", e.target.value)}
                      onBlur={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isFinite(n) && n !== Number(config.weight ?? 1)) save(slot.id, { weight: n });
                      }}
                    />
                  </div>
                  <div>
                    <label className="text-[9px] font-black tracking-widest text-slate-400">开始时间（空 = 立即）</label>
                    <input
                      type="datetime-local"
                      className="mt-2 w-full text-[11px] font-mono border border-slate-200 rounded-xl px-3 py-2 outline-none focus:border-slate-400"
                      value={draftOf(slot.id, "start_at", toLocalInput(config.start_at))}
                      onChange={(e) => setDraft(slot.id, "start_at", e.target.value)}
                      onBlur={(e) => save(slot.id, { start_at: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="text-[9px] font-black tracking-widest text-slate-400">结束时间（空 = 长期）</label>
                    <input
                      type="datetime-local"
                      className="mt-2 w-full text-[11px] font-mono border border-slate-200 rounded-xl px-3 py-2 outline-none focus:border-slate-400"
                      value={draftOf(slot.id, "end_at", toLocalInput(config.end_at))}
                      onChange={(e) => setDraft(slot.id, "end_at", e.target.value)}
                      onBlur={(e) => save(slot.id, { end_at: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="text-[9px] font-black tracking-widest text-slate-400">分类定向（逗号分隔，空 = 全站）</label>
                    <input
                      type="text"
                      className="mt-2 w-full text-[11px] font-mono border border-slate-200 rounded-xl px-3 py-2 outline-none focus:border-slate-400"
                      value={draftOf(
                        slot.id,
                        "categories",
                        Array.isArray(config.categories) ? config.categories.join(", ") : ""
                      )}
                      onChange={(e) => setDraft(slot.id, "categories", e.target.value)}
                      onBlur={(e) => save(slot.id, { categories: e.target.value })}
                      placeholder="TRENDS, QUIZ"
                    />
                  </div>
                </div>

                <div className="px-8 py-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <p className="text-[9px] text-slate-400 font-bold tracking-wide leading-relaxed">
                    {ready
                      ? "该坑位已具备素材；关闭开关或清空素材后，前台会立刻 return null（不留空白块）。"
                      : "没有素材：即使开关打开，后台也会自动保持关闭，前台不渲染任何 DOM。"}
                  </p>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => clearSlot(slot.id)}
                      disabled={isSaving}
                      className="flex items-center gap-2 text-[10px] font-black tracking-widest px-4 py-2.5 rounded-xl border border-rose-200 text-rose-600 bg-rose-50 hover:bg-rose-100 disabled:opacity-50"
                    >
                      <Trash2 size={13} /> 清空素材
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
