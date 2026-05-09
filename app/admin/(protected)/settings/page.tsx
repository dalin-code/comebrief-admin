"use client";

import React, { useState, useEffect } from "react";
import { 
  Settings, Globe, Share2, 
  Code2, Save, CheckCircle2, Loader2, Info
} from "lucide-react";
import { createClient } from "@supabase/supabase-js";

const CONFIG_GROUPS = [
  {
    group: "基础信息",
    icon: <Globe size={18} />,
    items: [
      { key: "site_name", label: "网站名称", placeholder: "例如: AURA AI", type: "text" },
      { key: "site_description", label: "网站描述 (SEO)", placeholder: "用于搜索结果的描述文字", type: "textarea" },
      { key: "site_keywords", label: "关键词 (Keywords)", placeholder: "AI, Web3, Trends", type: "text" },
    ]
  },
  {
    group: "社交与外链",
    icon: <Share2 size={18} />,
    items: [
      { key: "contact_email", label: "联系邮箱", placeholder: "admin@aura.com", type: "text" },
      { key: "discord_link", label: "Discord 链接", placeholder: "https://discord.gg/...", type: "text" },
      { key: "twitter_link", label: "Twitter (X)", placeholder: "https://twitter.com/...", type: "text" },
    ]
  },
  {
    group: "高级注入",
    icon: <Code2 size={18} />,
    items: [
      { key: "ga_tracking_id", label: "Google Analytics / Header Script", placeholder: "粘贴 <script> 代码...", type: "textarea" },
    ]
  }
];

export default function SystemSettings() {
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  // 加载数据
  const loadConfigs = async () => {
    setLoading(true);
    const { data } = await supabase.from("site_settings").select("*").eq("type", "system_config");
    if (data) {
      const values: Record<string, string> = {};
      data.forEach(item => { values[item.key] = item.content_pc || ""; });
      setFormValues(values);
    }
    setLoading(false);
  };

  useEffect(() => { loadConfigs(); }, []);

  // 统一保存函数
  const handleFinalSave = async () => {
    setIsSaving(true);
    
    // 将 formValues 转换为数组进行批量 Upsert
    const upsertData = Object.entries(formValues).map(([key, value]) => ({
      key,
      type: "system_config",
      content_pc: value
    }));

    const { error } = await supabase.from("site_settings").upsert(upsertData, { onConflict: 'key' });

    if (!error) {
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
      loadConfigs();
    }
    setIsSaving(false);
  };

  if (loading) return <div className="p-20 text-center animate-pulse font-black text-slate-300 uppercase italic tracking-widest">Loading AURA Data...</div>;

  return (
    <div className="min-h-screen bg-[#FAFAFA] p-8 md:p-12 text-slate-900 antialiased text-left pb-32">
      
      {/* 固定顶部的保存栏 */}
      <div className="max-w-4xl mx-auto mb-12 flex justify-between items-center sticky top-0 bg-[#FAFAFA]/80 backdrop-blur-md z-10 py-4 border-b border-slate-200">
        <div>
          <h2 className="text-2xl font-black italic uppercase tracking-tighter flex items-center gap-2">
            <Settings className="text-slate-900" size={24} /> System Settings
          </h2>
        </div>
        
        <div className="flex items-center gap-4">
          {showSuccess && (
            <span className="text-[10px] font-black text-emerald-500 uppercase tracking-widest flex items-center gap-1 animate-in fade-in slide-in-from-right-2">
              <CheckCircle2 size={14} /> Global Sync Success
            </span>
          )}
          <button 
            onClick={handleFinalSave}
            disabled={isSaving}
            className={`flex items-center gap-2 px-8 py-3 rounded-2xl text-[10px] font-black uppercase tracking-[0.2em] transition-all shadow-xl ${
              isSaving ? 'bg-slate-400 cursor-not-allowed' : 'bg-slate-900 text-white hover:bg-black active:scale-95 shadow-slate-200'
            }`}
          >
            {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      <div className="max-w-4xl mx-auto space-y-12">
        {CONFIG_GROUPS.map((group, gIdx) => (
          <div key={gIdx} className="bg-white border border-slate-200 rounded-[40px] shadow-sm overflow-hidden transition-all hover:shadow-md">
            <div className="px-10 py-6 bg-slate-50/50 border-b border-slate-50 flex items-center gap-3">
              <span className="text-slate-400">{group.icon}</span>
              <span className="text-[11px] font-black uppercase tracking-widest text-slate-900">{group.group}</span>
            </div>
            
            <div className="p-10 space-y-10">
              {group.items.map((item) => (
                <div key={item.key} className="space-y-4">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block text-left">
                    {item.label}
                  </label>
                  
                  {item.type === "textarea" ? (
                    <textarea 
                      className="w-full h-32 bg-slate-50 border border-slate-200 rounded-[24px] p-5 font-mono text-[11px] focus:bg-white focus:border-slate-900 outline-none transition-all shadow-inner"
                      placeholder={item.placeholder}
                      value={formValues[item.key] || ""}
                      onChange={(e) => setFormValues({...formValues, [item.key]: e.target.value})}
                    />
                  ) : (
                    <input 
                      type="text"
                      className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-5 py-4 text-[11px] font-bold focus:bg-white focus:border-slate-900 outline-none transition-all shadow-inner"
                      placeholder={item.placeholder}
                      value={formValues[item.key] || ""}
                      onChange={(e) => setFormValues({...formValues, [item.key]: e.target.value})}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}