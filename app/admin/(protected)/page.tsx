"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { Zap, BrainCircuit, ShieldCheck, Plus, Eye, Edit3, Trash2 } from "lucide-react";
import { createBrowserClient } from "@supabase/ssr";

const MODULES = {
  trends: { title: "Trends 资讯", table: "articles", category: "trends", icon: <Zap size={16} /> },
  quizzes: { title: "Quizzes 测试", table: "quizzes", category: null, icon: <BrainCircuit size={16} /> },
  stories: { title: "Stories 故事", table: "stories", category: null, icon: <ShieldCheck size={16} /> },
};

export default function AdminTablePage() {
  const [tab, setTab] = useState<keyof typeof MODULES>("trends");
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // 🛡️ 关键：使用 Browser Client 确保 Cookie 同步
  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const loadData = async () => {
    setLoading(true);
    const active = MODULES[tab];
    let query = supabase.from(active.table).select("*").order("created_at", { ascending: false });
    if (active.category) query = query.eq("category", active.category);
    const { data } = await query.limit(100);
    setRows(data || []);
    setLoading(false);
  };

  useEffect(() => { loadData(); }, [tab]);

  const handleDelete = async (id: string) => {
    if (!confirm("确认删除节点？此操作不可逆。")) return;
    const { error } = await supabase.from(MODULES[tab].table).delete().eq("id", id);
    if (!error) loadData();
  };

  return (
    <div className="flex min-h-screen bg-white font-sans text-slate-900">
      {/* 侧边栏 */}
      <aside className="w-64 border-r border-slate-100 bg-slate-50/50 flex flex-col h-screen sticky top-0">
        <div className="p-8 border-b border-slate-100 bg-white font-black italic tracking-tighter text-2xl text-cyan-600">
          AURA ADMIN
        </div>
        <nav className="p-6 space-y-3">
          {(Object.keys(MODULES) as Array<keyof typeof MODULES>).map((m) => (
            <button
              key={m}
              onClick={() => setTab(m)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-[11px] font-black uppercase tracking-widest transition-all ${
                tab === m ? "bg-slate-900 text-white shadow-xl scale-105" : "text-slate-400 hover:bg-slate-200"
              }`}
            >
              {MODULES[m].icon} {MODULES[m].title}
            </button>
          ))}
        </nav>
      </aside>

      {/* 主内容 */}
      <main className="flex-1">
        <header className="h-20 border-b border-slate-100 px-10 flex items-center justify-between sticky top-0 bg-white/80 backdrop-blur-xl z-10">
          <h2 className="font-black italic text-xl tracking-tighter uppercase">{MODULES[tab].title}</h2>
          <Link href={`/admin/${tab}/edit`} className="bg-cyan-500 hover:bg-cyan-400 text-slate-950 px-6 py-2.5 rounded-2xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 shadow-lg shadow-cyan-500/20 transition-all active:scale-95">
            <Plus size={14} /> Sync New Node
          </Link>
        </header>

        <div className="p-10">
          <div className="border border-slate-100 rounded-[32px] overflow-hidden bg-white shadow-sm">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-slate-50/50 border-b border-slate-100 text-[9px] font-black uppercase tracking-[0.2em] text-slate-400">
                  <th className="px-8 py-5">Intel Title</th>
                  <th className="px-8 py-5">Slug Path</th>
                  <th className="px-8 py-5 text-center">Protocol</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {rows.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50/30 transition-colors group">
                    <td className="px-8 py-6 font-bold text-sm group-hover:text-cyan-600">{item.title}</td>
                    <td className="px-8 py-6 text-[10px] font-mono text-slate-300">/{item.slug}</td>
                    <td className="px-8 py-6">
                      <div className="flex justify-center gap-6 text-slate-300">
                        <a href={`/trends/${item.slug}`} target="_blank" className="hover:text-cyan-500"><Eye size={18} /></a>
                        <Link href={`/admin/${tab}/edit?id=${item.id}`} className="hover:text-emerald-500"><Edit3 size={18} /></Link>
                        <button onClick={() => handleDelete(item.id)} className="hover:text-rose-500"><Trash2 size={18} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}