"use client";

import React, { useState, useEffect } from "react";
import { 
  Megaphone, Laptop, Smartphone, Save, 
  CheckCircle2, AlertCircle, Globe, Layout, 
  Upload, Link as LinkIcon, Loader2, Trash2, XCircle
} from "lucide-react";
import { supabase } from '@/lib/supabase';
// 🚀 1. 导入压缩库
import imageCompression from 'browser-image-compression';

// 🚀 升级版全站广告坑位矩阵
const AD_MATRIX = [
  { id: "HOME_HEADER", name: "首页 - 顶部 Header", page: "Home", ratio: "4/1 (推荐 1200x300)" },
  { id: "SIDEBAR_TOP", name: "侧边栏固定位", page: "Sidebar", ratio: "1/1 (推荐 300x300)" },
  { id: "GLOBAL_BOTTOM", name: "全站 - 底部通栏", page: "Global", ratio: "6/1 (推荐 1200x200)" },
  
  // 🚀 新增：全站分类列表页共用通栏（Trends / Quizzes / Stories 列表页顶部）
  { id: "LISTING_HEADER", name: "分类列表页 - 顶部通栏", page: "Listing", ratio: "5/1 (推荐 1200x240)" },
  
  // 🚀 新增：详情页文中原生位（长文章读到一半、或者测试题下方的黄金吸金位）
  { id: "DETAIL_CONTENT_MID", name: "详情页 - 文中原生广告", page: "Detail", ratio: "16/9 或 4/3 自适应宽度" },
  
  // 🚀 新增：全站底部吸附横幅（移动端和 PC 端通杀的极品高转化位）
  { id: "GLOBAL_FOOTER_STICKY", name: "全站 - 底部吸附悬浮条", page: "Global", ratio: "推荐 728x90 或 320x50" },
];

export default function AdsAdminV3_5() {
  const [ads, setAds] = useState<any[]>([]);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ id: string; percent: number } | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error', msg: string } | null>(null);

  const showToast = (type: 'success' | 'error', msg: string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 3000);
  };

  const loadAds = async () => {
    const { data, error } = await supabase.from("ads").select("*");
    if (error) {
      console.error("加载广告失败:", error);
    } else {
      setAds(data || []);
    }
  };

  useEffect(() => { loadAds(); }, []);

  const handleUpdate = async (slotId: string, updates: any) => {
    setSaveStatus("saving");
    const existingAd = ads.find(a => a.position === slotId);
    let error;
    if (existingAd?.id) {
      const { error: err } = await supabase
        .from("ads")
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq("id", existingAd.id);
      error = err;
    } else {
      const { error: err } = await supabase
        .from("ads")
        .insert([{ 
          position: slotId, 
          title: slotId,
          active: true,
          ...updates 
        }]);
      error = err;
    }
    
    if (!error) {
      setSaveStatus("done");
      setTimeout(() => setSaveStatus(null), 2000);
      loadAds();
    } else {
      console.error(error);
      showToast('error', '数据库更新失败: ' + error.message);
    }
  };

  // 🚀 2. 核心修改：压缩并转换图片为 WebP
  const handleUpload = async (slotId: string, file: File) => {
    setUploadProgress({ id: slotId, percent: 10 });
    
    // 💾 A. 配置压缩选项
    const options = {
      maxSizeMB: 0.2,            // 🚀 强行把图片压到 200KB 以下 (极度流畅)
      maxWidthOrHeight: 1920,    // 最大宽度
      useWebWorker: true,
      fileType: 'image/webp'     // 🚀 强行转换格式为 WebP
    }

    try {
      showToast('success', '正在对图片进行 ⚡ WebP 极速转换与压缩...');
      // 💾 B. 执行压缩
      const compressedFile = await imageCompression(file, options);
      
      // 💾 C. 准备上传，文件名后缀改为 .webp
      const fileName = `${slotId}-${Date.now()}.webp`;
      const filePath = `fallbacks/${fileName}`;

      setUploadProgress({ id: slotId, percent: 30 });

      // 💾 D. 上传压缩后的 WebP 文件
      const { data, error: uploadError } = await supabase.storage
        .from('ad-images')
        .upload(filePath, compressedFile, { cacheControl: '3600', upsert: true });

      if (uploadError) {
        showToast('error', '上传失败: ' + uploadError.message);
        setUploadProgress(null);
        return;
      }

      setUploadProgress({ id: slotId, percent: 80 });
      const { data: { publicUrl } } = supabase.storage.from('ad-images').getPublicUrl(filePath);
      
      await handleUpdate(slotId, { image_url: publicUrl });
      setUploadProgress(null);
      showToast('success', 'WebP 补位图片上传成功！前端加载速度已优化。');

    } catch (error) {
      console.error("压缩失败:", error);
      showToast('error', '图片格式转换或压缩失败');
      setUploadProgress(null);
    }
  };

  return (
    <div className="min-h-screen bg-[#FAFAFA] p-8 md:p-12 text-slate-900 antialiased font-sans text-left relative">
      
      {/* 全局 Toast 提示 */}
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
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-[0.2em] mt-2">WebP 自动化压缩上传系统已激活</p>
        </div>
        {saveStatus && (
          <div className="text-xs font-bold uppercase tracking-widest text-slate-400 flex items-center gap-2">
            {saveStatus === 'saving' ? <Loader2 size={14} className="animate-spin text-blue-500" /> : <CheckCircle2 size={14} className="text-emerald-500" />}
            {saveStatus === 'saving' ? 'Syncing to DB...' : 'Saved to Supabase'}
          </div>
        )}
      </div>

      <div className="max-w-7xl mx-auto grid gap-16">
        {AD_MATRIX.map((slot) => {
          const config = ads.find(a => a.position === slot.id) || { active: false, ad_code: "", mobile_ad_code: "", image_url: "", link: "" };
          const isUploading = uploadProgress?.id === slot.id;
          
          return (
            <div key={slot.id} className="bg-white border border-slate-200 rounded-[40px] shadow-sm overflow-hidden transition-all hover:shadow-xl">
              
              {/* 开关头部 */}
              <div className="p-8 border-b border-slate-50 flex justify-between items-center bg-slate-50/20">
                <div className="flex items-start gap-4 text-left">
                  <div className="w-12 h-12 bg-white border border-slate-100 rounded-xl flex items-center justify-center text-slate-400"><Layout size={20} /></div>
                  <div>
                    <h3 className="text-lg font-black italic uppercase tracking-tighter text-left">{slot.name}</h3>
                    <span className="text-[9px] font-black text-slate-300 uppercase tracking-widest">{slot.id} Slot</span>
                  </div>
                </div>
                <button onClick={() => handleUpdate(slot.id, { active: !config.active })} className={`relative inline-flex h-6 w-12 items-center rounded-full transition-all ${config.active ? 'bg-emerald-500' : 'bg-slate-200'}`}>
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${config.active ? 'translate-x-7' : 'translate-x-1'}`} />
                </button>
              </div>

              {/* 代码编辑区 */}
              <div className="p-8 grid grid-cols-1 lg:grid-cols-2 gap-10">
                 <div className="space-y-4">
                    <label className="text-[10px] font-black uppercase tracking-widest flex items-center gap-2"><Laptop size={14} className="text-blue-500" /> Desktop Ad Code</label>
                    <textarea 
                      className="w-full h-32 bg-[#1E293B] rounded-2xl p-4 font-mono text-[10px] text-emerald-400 outline-none" 
                      defaultValue={config.ad_code || ""} 
                      onBlur={(e) => handleUpdate(slot.id, { ad_code: e.target.value })} 
                      placeholder="Paste <ins> or <script> tags here..."
                    />
                 </div>
                 <div className="space-y-4">
                    <label className="text-[10px] font-black uppercase tracking-widest flex items-center gap-2"><Smartphone size={14} className="text-pink-500" /> Mobile Ad Code</label>
                    <textarea 
                      className="w-full h-32 bg-[#1E293B] rounded-2xl p-4 font-mono text-[10px] text-pink-400 outline-none" 
                      defaultValue={config.mobile_ad_code || ""} 
                      onBlur={(e) => handleUpdate(slot.id, { mobile_ad_code: e.target.value })} 
                      placeholder="Paste mobile-specific tags here..."
                    />
                 </div>
              </div>

              {/* 兜底系统 */}
              <div className="px-8 py-6 bg-slate-50 border-t border-slate-100 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-[10px] font-black uppercase text-slate-900 tracking-[0.2em]">Visual Fallback System</span>
                    <p className="text-[9px] text-slate-400 mt-1">推荐比例: {slot.ratio}</p>
                  </div>
                  {isUploading && <span className="text-[10px] font-black text-blue-500 animate-pulse uppercase tracking-widest text-left">Auto-Converting to WebP...</span>}
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="flex items-center gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3 relative overflow-hidden">
                    <Upload size={16} className="text-slate-400" />
                    <input type="text" className="flex-1 text-[10px] font-mono outline-none text-slate-500" value={config.image_url || ""} readOnly placeholder="No Image Asset (Click SELECT)" />
                    
                    {!config.image_url ? (
                      <label className={`px-3 py-1 bg-slate-900 text-white text-[9px] font-black rounded-lg cursor-pointer transition-all ${isUploading ? 'opacity-50 pointer-events-none' : ''}`}>
                        SELECT
                        <input type="file" className="hidden" accept="image/png, image/jpeg, image/webp" onChange={(e) => e.target.files && handleUpload(slot.id, e.target.files[0])} />
                      </label>
                    ) : (
                      <button onClick={async () => { if(confirm("移除图片？前端将自动隐藏或使用广告代码。")) handleUpdate(slot.id, { image_url: "" }) }} className="p-1.5 bg-rose-50 text-rose-500 rounded-lg hover:bg-rose-500 hover:text-white transition-all">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                  
                  <div className="flex items-center gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3 shadow-sm text-left">
                    <LinkIcon size={16} className="text-slate-400" />
                    <input 
                      type="text" 
                      className="flex-1 text-[10px] font-mono outline-none" 
                      placeholder="Target Link (e.g., https://...)" 
                      defaultValue={config.link || ""} 
                      onBlur={(e) => handleUpdate(slot.id, { link: e.target.value })} 
                    />
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