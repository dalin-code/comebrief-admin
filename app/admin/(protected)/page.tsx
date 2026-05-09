"use client";

import React from "react";

export default function AdminDashboardPage() {
  return (
    <div className="p-10 space-y-10">
      <header className="space-y-2">
        <h1 className="text-5xl font-black italic tracking-tighter text-slate-950 dark:text-white uppercase">
          数据概览 <span className="text-slate-200">/</span> <span className="text-emerald-500">OVERVIEW</span>
        </h1>
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em] italic">
          Neural Network & Content Performance Monitoring
        </p>
      </header>

      {/* 示例：数据指标卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        <div className="bg-white dark:bg-[#0D1117] p-8 rounded-[40px] border border-slate-100 dark:border-white/5 shadow-sm">
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4">Total Trends</p>
          <p className="text-4xl font-black dark:text-white tracking-tighter">1,248</p>
        </div>
        {/* 其他卡片内容... */}
      </div>
    </div>
  );
}