"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { Zap, BrainCircuit, ShieldCheck, Plus, Eye, Edit3, Trash2, RefreshCw } from "lucide-react";
import { createClient } from "@supabase/supabase-js";

const MODULES = {
  trends: { title: "Trends 资讯", table: "articles", category: "trends", icon: <Zap size={16} /> },
  quizzes: { title: "Quizzes 测试", table: "quizzes", category: null, icon: <BrainCircuit size={16} /> },
  stories: { title: "Stories 故事", table: "stories", category: null, icon: <ShieldCheck size={16} /> },
};

export default function AdminTablePage() {
  const [tab, setTab] = useState<keyof typeof MODULES>("trends");
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const supabase = createClient(
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
    if (!confirm("确认删除？")) return;
    await supabase.from(MODULES[tab].table).delete().eq("id", id);
    loadData();
  };

  return (
    <div className="flex min-h-screen bg-white">
      {/* 侧边栏 */}
      <aside className="w-64 border-r border-gray-200 bg-gray-50 flex flex-col h-screen sticky top-0">
        <div className="p-6 border-b border-gray-200 bg-white font-black italic tracking-tighter text-xl">AURA ADMIN</div>
        <nav className="p-4 space-y-2">
          {(Object.keys(MODULES) as Array<keyof typeof MODULES>).map((m) => (
            <button
              key={m}
              onClick={() => setTab(m)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-bold transition ${
                tab === m ? "bg-black text-white shadow-lg" : "text-gray-500 hover:bg-gray-200"
              }`}
            >
              {MODULES[m].icon} {MODULES[m].title}
            </button>
          ))}
        </nav>
      </aside>

      {/* 主内容 */}
      <main className="flex-1 bg-white">
        <header className="h-16 border-b border-gray-100 px-8 flex items-center justify-between">
          <h2 className="font-bold text-gray-800">{MODULES[tab].title}</h2>
          <Link href={`/admin/${tab}/edit`} className="bg-emerald-600 text-white px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2">
            <Plus size={14} /> 新增内容
          </Link>
        </header>

        {/* --- 标准横向表格 --- */}
        <div className="p-8">
          <div className="border border-gray-200 rounded-xl overflow-hidden shadow-sm">
            <table className="w-full text-left border-collapse bg-white">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-[11px] font-bold uppercase text-gray-400">
                  <th className="px-6 py-4">标题</th>
                  <th className="px-6 py-4">Slug</th>
                  <th className="px-6 py-4 text-center">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 text-gray-700">
                {rows.map((item) => (
                  <tr key={item.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 font-bold text-sm">{item.title}</td>
                    <td className="px-6 py-4 text-xs font-mono text-gray-400">/{item.slug}</td>
                    <td className="px-6 py-4">
                      <div className="flex justify-center gap-4 text-gray-400">
                        {/* 这里的链接需要根据你的前端端口调整 */}
                        <a href={`http://localhost:3000/${tab}/${item.slug}`} target="_blank" className="hover:text-blue-500"><Eye size={18} /></a>
                        <Link href={`/admin/${tab}/edit?id=${item.id}`} className="hover:text-emerald-500"><Edit3 size={18} /></Link>
                        <button onClick={() => handleDelete(item.id)} className="hover:text-red-500"><Trash2 size={18} /></button>
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