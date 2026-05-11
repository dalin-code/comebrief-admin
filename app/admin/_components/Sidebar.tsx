"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { 
  Zap, BrainCircuit, ShieldCheck, 
  LayoutDashboard, Settings, LogOut, Megaphone 
} from "lucide-react";

const MENU_ITEMS = [
  { title: "数据概览", path: "/admin", icon: <LayoutDashboard size={18} /> },
  { title: "TRENDS 资讯", path: "/admin/trends", icon: <Zap size={18} /> },
  { title: "QUIZZES 测试", path: "/admin/quizzes", icon: <BrainCircuit size={18} /> },
  { title: "STORIES 故事", path: "/admin/stories", icon: <ShieldCheck size={18} /> },
  { title: "ADS 广告管理", path: "/admin/ads", icon: <Megaphone size={18} /> }, // 👈 补上了广告管理
  { title: "系统设置", path: "/admin/settings", icon: <Settings size={18} /> },
];

export function Sidebar() {
  const pathname = usePathname();

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

      <div className="p-8 border-t border-slate-50">
        <button className="flex items-center gap-2 text-rose-400 text-[10px] font-black uppercase tracking-widest hover:text-rose-600 transition-all">
          <LogOut size={14} /> 退出系统
        </button>
      </div>
    </aside>
  );
}