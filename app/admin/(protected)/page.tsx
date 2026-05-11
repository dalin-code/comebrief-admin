"use client";

import React from "react";
import { Zap, BrainCircuit, ShieldCheck, Target, ArrowUpRight, Megaphone } from "lucide-react";

export default function DashboardPage() {
  const stats = [
    { title: "Trends Pulse", value: "128", growth: "+12%", icon: <Zap className="text-cyan-500" />, color: "bg-cyan-50" },
    { title: "Active Quiz", value: "42", growth: "+5%", icon: <BrainCircuit className="text-purple-500" />, color: "bg-purple-50" },
    { title: "Ad Impressions", value: "12.5k", growth: "+24%", icon: <Megaphone className="text-amber-500" />, color: "bg-amber-50" },
    { title: "2026 Target", value: "¥52.4k", growth: "10.5%", icon: <Target className="text-rose-500" />, color: "bg-rose-50" },
  ];

  return (
    <div className="p-10 space-y-10 animate-in fade-in duration-700">
      <header>
        <h1 className="text-3xl font-black italic tracking-tighter text-slate-900 uppercase">
          Command Center <span className="text-cyan-500">.</span>
        </h1>
        <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">Operational Intelligence Overview</p>
      </header>

      {/* 数据卡片网格 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {stats.map((stat, i) => (
          <div key={i} className="p-8 rounded-[40px] bg-white border border-slate-100 shadow-sm hover:shadow-xl transition-all group">
            <div className="flex justify-between items-start mb-6">
              <div className={`p-4 rounded-2xl ${stat.color} transition-transform group-hover:rotate-12`}>
                {stat.icon}
              </div>
              <span className="text-[9px] font-black text-emerald-500 bg-emerald-50 px-2 py-1 rounded-full flex items-center">
                {stat.growth} <ArrowUpRight size={10} className="ml-0.5" />
              </span>
            </div>
            <div className="space-y-1">
              <p className="text-[10px] font-black text-slate-300 uppercase tracking-widest">{stat.title}</p>
              <h3 className="text-3xl font-black text-slate-900 tracking-tighter">{stat.value}</h3>
            </div>
          </div>
        ))}
      </div>

      {/* 营收监控大板 */}
      <div className="p-10 rounded-[48px] bg-slate-950 border border-white/5 relative overflow-hidden min-h-[350px] flex flex-col justify-end text-white">
        <div className="absolute top-0 right-0 w-64 h-64 bg-cyan-500/10 blur-[100px] rounded-full" />
        <h4 className="text-2xl font-black italic tracking-tighter mb-2">Revenue Node Analysis</h4>
        <p className="text-slate-500 text-sm max-w-sm">当前 2026 营收目标已同步，ADS 模块已就绪，正在监控全站变现效率。</p>
      </div>
    </div>
  );
}