"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { 
  LayoutDashboard, 
  Zap, 
  BrainCircuit, 
  ShieldCheck, 
  Megaphone, 
  Settings 
} from "lucide-react";

const NAV_ITEMS = [
  { name: "数据概览", href: "/admin/dashboard", icon: <LayoutDashboard size={18} /> },
  { name: "Trends 资讯", href: "/admin/trends", icon: <Zap size={18} /> },
  { name: "Quizzes 测试", href: "/admin/quizzes", icon: <BrainCircuit size={18} /> },
  { name: "Stories 故事", href: "/admin/stories", icon: <ShieldCheck size={18} /> },
  { name: "广告填充", href: "/admin/ads", icon: <Megaphone size={18} /> },
  { name: "系统设置", href: "/admin/settings", icon: <Settings size={18} /> },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 border-r border-slate-200 bg-white flex flex-col h-screen sticky top-0 antialiased">
      {/* Logo 区域 */}
      <div className="p-8 border-b border-slate-50">
        <h1 className="text-xl font-black italic uppercase tracking-tighter text-slate-900">Aura Admin</h1>
        <div className="flex items-center gap-1.5 mt-1">
          <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
          <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Node v2.0 Active</span>
        </div>
      </div>

      {/* 导航区域 */}
      <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${
                isActive 
                ? "bg-slate-900 text-white shadow-lg shadow-slate-200" 
                : "text-slate-500 hover:bg-slate-50 hover:text-slate-900"
              }`}
            >
              <span className={isActive ? "text-white" : "text-slate-400"}>
                {item.icon}
              </span>
              {item.name}
            </Link>
          );
        })}
      </nav>

      {/* 底部版权 */}
      <div className="p-6 border-t border-slate-50">
        <div className="bg-slate-50 rounded-xl p-3">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter text-center">
            Designed by Dalin Lu
          </p>
        </div>
      </div>
    </aside>
  );
}