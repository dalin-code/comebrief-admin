"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { 
  LayoutDashboard, Zap, BrainCircuit, BookOpen, Settings, LogOut, ChevronRight
} from "lucide-react";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  const menuItems = [
    { name: "数据概览", href: "/admin", icon: LayoutDashboard },
    { name: "Trends 资讯", href: "/admin/trends", icon: Zap },
    { name: "Quizzes 测试", href: "/admin/quizzes", icon: BrainCircuit },
    { name: "Stories 故事", href: "/admin/stories", icon: BookOpen },
    { name: "Ads 广告管理", href: "/admin/ads", icon: Zap }, 
    { name: "系统设置", href: "/admin/settings", icon: Settings },
  ];

  return (
    <div className="flex h-screen bg-[#F8FAFC] dark:bg-[#050914] overflow-hidden transition-colors duration-500">
      
      {/* 🚀 侧边栏：全站唯一，锁定在左侧 */}
      <aside className="w-[280px] bg-white dark:bg-[#0D1117] border-r border-slate-100 dark:border-white/5 flex flex-col shrink-0 z-50">
        <div className="h-32 flex items-center px-10 font-black text-2xl italic text-slate-950 dark:text-white tracking-tighter uppercase">
          Aura Admin
        </div>
        
        <nav className="flex-1 px-6 space-y-2 overflow-y-auto">
          {menuItems.map((item) => {
            const isActive = pathname === item.href || (item.href !== '/admin' && pathname?.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`group flex items-center justify-between px-6 py-4 rounded-[24px] text-[12px] font-black uppercase tracking-widest transition-all duration-300 ${
                  isActive 
                    ? "bg-[#0A101D] text-white shadow-[0_10px_40px_rgba(0,0,0,0.2)]" 
                    : "text-slate-400 hover:bg-slate-50 dark:hover:bg-white/5 hover:text-slate-700 dark:hover:text-slate-200"
                }`}
              >
                <div className="flex items-center gap-4">
                  <item.icon size={20} className={isActive ? "text-cyan-400" : "text-slate-400"} />
                  <span>{item.name}</span>
                </div>
                {isActive && <ChevronRight size={16} className="text-slate-500" />}
              </Link>
            );
          })}
        </nav>

        <div className="p-8 mb-4 border-t border-slate-50 dark:border-white/5">
          <button className="flex items-center gap-4 px-6 py-4 text-[13px] font-black uppercase tracking-widest text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 rounded-[24px] transition-all w-full text-left">
            <LogOut size={20} />
            退出系统
          </button>
        </div>
      </aside>

      {/* 🚀 核心：children 会把 page.tsx 的内容渲染在这里 */}
      <main className="flex-1 relative overflow-auto custom-scrollbar">
        {children}
      </main>
    </div>
  );
}
// 导出 metadata 对象
export const metadata = {
  robots: {
    index: false,      // 不允许索引
    follow: false,     // 不允许爬虫跟随页面上的链接
    nocache: true,     // 不允许缓存
  },
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <section>
      {children}
    </section>
  )
}