"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { 
  Zap, BrainCircuit, ShieldCheck, 
  LayoutDashboard, Settings, LogOut, Megaphone, Tags, PenTool, Loader2 
} from "lucide-react";
import { signOutAndRedirect } from "@/lib/clientAuth";

const MENU_ITEMS = [
  { title: "数据概览", path: "/admin", icon: <LayoutDashboard size={18} /> },
  { title: "BRIEFS 简报", path: "/admin/trends", icon: <Zap size={18} /> },
  { title: "QUIZZES 测试", path: "/admin/quizzes", icon: <BrainCircuit size={18} /> },
  { title: "STORIES 故事", path: "/admin/stories", icon: <ShieldCheck size={18} /> },
  { title: "创作标签", path: "/admin/story-tags", icon: <Tags size={18} /> },
  { title: "写作风格", path: "/admin/story-skills", icon: <PenTool size={18} /> },
  { title: "ADS 广告管理", path: "/admin/ads", icon: <Megaphone size={18} /> }, // 👈 补上了广告管理
  { title: "系统设置", path: "/admin/settings", icon: <Settings size={18} /> },
];

export function Sidebar() {
  const pathname = usePathname();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  /**
   * 退出登录。
   *
   * 这个按钮以前是「纯装饰」—— 只有图标和文字、没有 onClick，点了什么都不发生，
   * 站长自然以为它坏了。现在接上 lib/clientAuth 的 signOutAndRedirect：
   * 先正常登出 → 失败就只清本地票 → 最后**硬跳转**回 /admin/login。
   *
   * 为什么要二次确认：它就贴在侧边栏底部，平时扫菜单很容易手滑点到，
   * 而退出的代价是「这次没保存的稿子白写」。
   */
  const doSignOut = async () => {
    setBusy(true);
    setError("");
    const reason = await signOutAndRedirect();
    // 正常情况这里已经跳走了。能走到这行说明没跳成 —— 把原因留在屏幕上，
    // 别让站长对着一个「点了没反应」的按钮发呆。
    if (reason) setError(`已清掉本地登录态，但没能通知服务器（${reason}）。若页面没跳转，手动刷新一次即可。`);
    setBusy(false);
  };

  return (
    <aside className="w-64 border-r border-slate-100 bg-white flex flex-col h-screen sticky top-0 z-20">
      <div className="p-8 border-b border-slate-50 font-black italic tracking-tighter text-2xl text-slate-900">
        AURA ADMIN
      </div>
      
      <nav className="p-6 space-y-2 flex-1">
        {MENU_ITEMS.map((item) => {
          const isActive = pathname === item.path;
          return (
            <Link
              key={item.path}
              href={item.path}
              className={`w-full flex items-center gap-3 px-5 py-4 rounded-2xl text-[11px] font-black uppercase tracking-widest transition-all ${
                isActive 
                  ? "bg-slate-950 text-white shadow-xl shadow-cyan-500/10 scale-[1.02]" 
                  : "text-slate-400 hover:bg-slate-50 hover:text-slate-600"
              }`}
            >
              <span className={isActive ? "text-cyan-400" : ""}>{item.icon}</span>
              {item.title}
              {isActive && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />}
            </Link>
          );
        })}
      </nav>

      <div className="p-8 border-t border-slate-50 space-y-3">
        {confirming ? (
          <div className="space-y-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
              确定退出登录？
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={doSignOut}
                disabled={busy}
                className="flex-1 h-9 rounded-xl bg-rose-500 text-white text-[10px] font-black uppercase tracking-widest hover:bg-rose-600 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <LogOut size={12} />} 退出
              </button>
              <button
                type="button"
                onClick={() => { setConfirming(false); setError(""); }}
                disabled={busy}
                className="flex-1 h-9 rounded-xl border border-slate-200 text-slate-500 text-[10px] font-black uppercase tracking-widest hover:bg-slate-50 disabled:opacity-50 transition-all"
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="flex items-center gap-2 text-rose-400 text-[10px] font-black uppercase tracking-widest hover:text-rose-600 transition-all"
          >
            <LogOut size={14} /> 退出系统
          </button>
        )}
        {error ? <p className="text-[9px] font-bold text-rose-400 leading-relaxed">{error}</p> : null}
      </div>
    </aside>
  );
}