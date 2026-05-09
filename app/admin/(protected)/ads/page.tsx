"use client";

import React, { useState, useEffect } from "react";
import { 
  Megaphone, Laptop, Smartphone, Save, 
  CheckCircle2, AlertCircle, Globe, Layout, 
  Upload, Link as LinkIcon, Loader2, Trash2, XCircle
} from "lucide-react";
import { createClient } from "@supabase/supabase-js";

const AD_MATRIX = [
  { id: "home_top", name: "首页 - 顶部 Header", page: "Home", defaultHeight: 90 },
  { id: "content_mid", name: "详情页 - 文中原生", page: "Detail", defaultHeight: 280 },
  { id: "anchor_footer", name: "全站 - 底部吸附", page: "Global", defaultHeight: 60 },
  { id: "vignette_popup", name: "全屏插页弹窗", page: "Global", defaultHeight: 0 },
  { id: "sidebar_sticky", name: "侧边栏固定位", page: "Sidebar", defaultHeight: 600 },
];

export default function AdsAdminV3_5() {
  const [ads, setAds] = useState<any[]>([]);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ id: string; percent: number } | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error', msg: string } | null>(null);
  
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const showToast = (type: 'success' | 'error', msg: string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 3000);
  };

  const loadAds = async () => {
    const { data } = await supabase.from("site_settings").select("*").eq("type", "ad_config");
    setAds(data || []);
  };

  useEffect(() => { loadAds(); }, []);

  const handleUpdate = async (slotId: string, updates: any) => {
    setSaveStatus("saving");
    const { error } = await supabase.from("site_settings").upsert({ 
      key: slotId, type: "ad_config", ...updates 
    }, { onConflict: 'key' });
    
    if (!error) {
      setSaveStatus("done");
      setTimeout(() => setSaveStatus(null), 2000);
      loadAds();
    } else {
      showToast('error', '数据库更新失败');
    }
  };

  const handleUpload = async (slotId: string, file: File) => {
    const fileExt = file.name.split('.').pop();
    const fileName = `${slotId}-${Date.now()}.${fileExt}`;
    const filePath = `fallbacks/${fileName}`;

    setUploadProgress({ id: slotId, percent: 10 }); // 初始进度

    // 使用 XMLHttpRequest 或 Supabase 自带上传监控
    const { data, error: uploadError } = await supabase.storage
      .from('ad-images')
      .upload(filePath, file, {
      
      });

    if (uploadError) {
      showToast('error', '上传失败: ' + uploadError.message);
      setUploadProgress(null);
      return;
    }

    const { data: { publicUrl } } = supabase.storage.from('ad-images').getPublicUrl(filePath);
    await handleUpdate(slotId, { fallback_img: publicUrl });
    setUploadProgress(null);
    showToast('success', '补位图片上传成功！');
  };

  return (
    <div className="min-h-screen bg-[#FAFAFA] p-8 md:p-12 text-slate-900 antialiased font-sans text-left relative">
      
      {/* --- 全局 Toast 提示 --- */}
      {toast && (
        <div className={`fixed top-10 left-1/2 -translate-x-1/2 z-50 px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3 animate-in fade-in slide-in-from-top-4 duration-300 ${
          toast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'
        }`}>
          {toast.type === 'success' ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
          <span className="text-xs font-black uppercase tracking-widest">{toast.msg}</span>
        </div>
      )}

      {/* Header */}
      <div className="max-w-7xl mx-auto mb-10 flex flex-col md:flex-row md:items-end justify-between border-b border-slate-200 pb-8 gap-6">
        <div>
          <h2 className="text-3xl font-black italic uppercase tracking-tighter">Pro Ad Matrix v3.5</h2>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-[0.2em] mt-2">智能反馈与流式上传系统</p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto grid gap-16">
        {AD_MATRIX.map((slot) => {
          const config = ads.find(a => a.key === slot.id) || { active: false, content_pc: "", content_mob: "", fallback_img: "" };
          const isUploading = uploadProgress?.id === slot.id;
          
          return (
            <div key={slot.id} className="bg-white border border-slate-200 rounded-[40px] shadow-sm overflow-hidden transition-all hover:shadow-xl">
              {/* 开关部分保持 v3.4 逻辑... */}
              <div className="p-8 border-b border-slate-50 flex justify-between items-center bg-slate-50/20">
                <div className="flex items-start gap-4 text-left">
                  <div className="w-12 h-12 bg-white border border-slate-100 rounded-xl flex items-center justify-center text-slate-400"><Layout size={20} /></div>
                  <div>
                    <h3 className="text-lg font-black italic uppercase tracking-tighter text-left">{slot.name}</h3>
                    <span className="text-[9px] font-black text-slate-300 uppercase tracking-widest">{slot.page} Slot</span>
                  </div>
                </div>
                <button onClick={() => handleUpdate(slot.id, { active: !config.active })} className={`relative inline-flex h-6 w-12 items-center rounded-full transition-all ${config.active ? 'bg-emerald-500' : 'bg-slate-200'}`}>
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${config.active ? 'translate-x-7' : 'translate-x-1'}`} />
                </button>
              </div>

              {/* 代码编辑区保持 v3.4 样式... */}
              <div className="p-8 grid grid-cols-1 lg:grid-cols-2 gap-10">
                 {/* ... 省略重复的 textarea 代码以保持聚焦 ... */}
                 <div className="space-y-4">
                    <label className="text-[10px] font-black uppercase tracking-widest flex items-center gap-2"><Laptop size={14} className="text-blue-500" /> Desktop</label>
                    <textarea className="w-full h-32 bg-[#1E293B] rounded-2xl p-4 font-mono text-[10px] text-emerald-400 outline-none" defaultValue={config.content_pc} onBlur={(e) => handleUpdate(slot.id, { content_pc: e.target.value })} />
                 </div>
                 <div className="space-y-4">
                    <label className="text-[10px] font-black uppercase tracking-widest flex items-center gap-2"><Smartphone size={14} className="text-pink-500" /> Mobile</label>
                    <textarea className="w-full h-32 bg-[#1E293B] rounded-2xl p-4 font-mono text-[10px] text-pink-400 outline-none" defaultValue={config.content_mob} onBlur={(e) => handleUpdate(slot.id, { content_mob: e.target.value })} />
                 </div>
              </div>

              {/* --- 升级版补位系统 --- */}
              <div className="px-8 py-6 bg-slate-50 border-t border-slate-100 space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-black uppercase text-slate-900 tracking-[0.2em]">Visual Fallback System</span>
                  {isUploading && <span className="text-[10px] font-black text-blue-500 animate-pulse uppercase tracking-widest text-left">Uploading {Math.round(uploadProgress.percent)}%</span>}
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="flex items-center gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3 relative overflow-hidden">
                    {/* 上传进度条背景 */}
                    {isUploading && (
                      <div 
                        className="absolute bottom-0 left-0 h-1 bg-blue-500 transition-all duration-300" 
                        style={{ width: `${uploadProgress.percent}%` }}
                      />
                    )}

                    {isUploading ? <Loader2 size={16} className="animate-spin text-blue-500" /> : <Upload size={16} className="text-slate-400" />}
                    <input type="text" className="flex-1 text-[10px] font-mono outline-none" value={config.fallback_img} readOnly placeholder="No Image Asset" />
                    
                    {!config.fallback_img ? (
                      <label className={`px-3 py-1 bg-slate-900 text-white text-[9px] font-black rounded-lg cursor-pointer transition-all ${isUploading ? 'opacity-50 pointer-events-none' : ''}`}>
                        SELECT
                        <input type="file" className="hidden" accept="image/*" onChange={(e) => e.target.files && handleUpload(slot.id, e.target.files[0])} />
                      </label>
                    ) : (
                      <button onClick={async () => { if(confirm("移除图片？")) handleUpdate(slot.id, { fallback_img: "" }) }} className="p-1.5 bg-rose-50 text-rose-500 rounded-lg hover:bg-rose-500 hover:text-white transition-all">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                  
                  <div className="flex items-center gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3 shadow-sm text-left">
                    <LinkIcon size={16} className="text-slate-400" />
                    <input type="text" className="flex-1 text-[10px] font-mono outline-none" placeholder="Target Link..." defaultValue={config.fallback_url} onBlur={(e) => handleUpdate(slot.id, { fallback_url: e.target.value })} />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}