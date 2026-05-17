"use client";

import React, { useState, useRef, useEffect, Suspense } from "react";
import { 
  Plus, BookOpen, Image as ImageIcon, Lock, Save, ChevronLeft, 
  Coins, Trash2, X, CheckCircle2, Menu, UploadCloud, 
  Type, LayoutPanelTop, Eye, Unlock, Loader2, AlertCircle
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from '@/lib/supabase';

function PublisherStudioContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editId = searchParams?.get('id');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const comicUploadRef = useRef<HTMLInputElement>(null);
  
  const [currentChapterIndex, setCurrentChapterIndex] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importJsonText, setImportJsonText] = useState("");
  const [toast, setToast] = useState<{ msg: string, type: 'success' | 'error' } | null>(null);

  // --- 核心数据结构 ---
  const [storyData, setStoryData] = useState<any>({
    title: "",
    type: "story", 
    cover_url: "",
    chapters: [
      {
        id: `ch_${Date.now()}`,
        title: "第一章：序幕",
        is_free: true, 
        price: 0,
        content_text: "",
        comic_pages: []
      }
    ]
  });

  const showToast = (msg: string, type: 'success' | 'error') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // 1. 数据回填
  useEffect(() => {
    if (editId) {
      const fetchWork = async () => {
        const { data, error } = await supabase.from('stories').select('*').eq('id', editId).single();
        if (data && !error && data.raw_data) {
          setStoryData(data.raw_data);
        }
      };
      fetchWork();
    }
  }, [editId]);

  // 2. 🚀 导入引擎 (修复：先验证，后更新)
  const handleTextImport = async () => {
    if (!importJsonText.trim()) return;
    setIsImporting(true);
    try {
      const batchData = JSON.parse(importJsonText);
      const dataArray = Array.isArray(batchData) ? batchData : [batchData];
      
      if (dataArray.length === 0 || !dataArray[0].chapters) {
        throw new Error("JSON 结构不匹配，缺少 chapters 数组");
      }

      const firstItem = dataArray[0];
      const insertPayload = dataArray.map(item => ({
        id: crypto.randomUUID(),
        title: item.title || "Untitled",
        cover_url: item.cover_url || "",
        active: true,
        content: item.chapters?.[0]?.content_text || "",
        raw_data: item 
      }));

      const { error } = await supabase.from('stories').insert(insertPayload);
      if (error) throw error;

      // 🚀 核心修复：更新状态时直接重置索引，确保不会越界
      setCurrentChapterIndex(0);
      setStoryData({
        title: firstItem.title || "",
        type: firstItem.type || "story",
        cover_url: firstItem.cover_url || "",
        chapters: firstItem.chapters || []
      });

      showToast(`成功导入 ${dataArray.length} 部作品！`, "success");
      setShowImportModal(false);
      setImportJsonText(""); 
    } catch (err: any) {
      showToast(`导入失败: ${err.message}`, "error");
    } finally {
      setIsImporting(false);
    }
  };

  // 3. 🚀 发布/更新
  const handleFinalSave = async () => {
    if (!storyData.title.trim()) {
      showToast("请输入作品标题", "error");
      return;
    }
    setIsSaving(true);
    try {
      const payload = {
        title: storyData.title,
        cover_url: storyData.cover_url,
        active: true,
        content: storyData.chapters[0]?.content_text || "",
        raw_data: storyData 
      };

      const { error } = editId 
        ? await supabase.from('stories').update(payload).eq('id', editId)
        : await supabase.from('stories').insert([payload]);

      if (error) throw error;
      showToast("连载已成功同步至云端", "success");
      setTimeout(() => router.push('/admin/stories'), 1000);
    } catch (err: any) {
      showToast(`保存失败: ${err.message}`, "error");
    } finally {
      setIsSaving(false);
    }
  };

  // 4. 章节操作 (完全保留你的原版逻辑)
  const addChapter = () => {
    const newCh = {
      id: `ch_${Date.now()}`,
      title: `第 ${storyData.chapters.length + 1} 章`,
      is_free: false,
      price: 99,
      content_text: "",
      comic_pages: []
    };
    setStoryData({ ...storyData, chapters: [...storyData.chapters, newCh] });
    setCurrentChapterIndex(storyData.chapters.length); 
  };

  const removeChapter = (idx: number) => {
    if (storyData.chapters.length <= 1) return;
    const n = storyData.chapters.filter((_: any, i: number) => i !== idx);
    setStoryData({ ...storyData, chapters: n });
    setCurrentChapterIndex(0);
  };

  const handleUpload = async (e: any, target: 'cover' | 'comic') => {
    const files = e.target.files; if (!files?.length) return;
    setIsUploading(true);
    try {
      const urls: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const path = `content/${Date.now()}-${Math.random().toString(36).slice(7)}`;
        const { error } = await supabase.storage.from('aura').upload(path, files[i]);
        if (error) throw error;
        urls.push(supabase.storage.from('aura').getPublicUrl(path).data.publicUrl);
      }
      const newData = { ...storyData };
      if (target === 'cover') newData.cover_url = urls[0];
      else newData.chapters[currentChapterIndex].comic_pages.push(...urls);
      setStoryData(newData);
      showToast("图片上传成功", "success");
    } catch (err: any) { showToast(err.message, "error"); }
    finally { setIsUploading(false); }
  };

  // 🚀 核心安全防护：防止读空
  const activeChapter = storyData?.chapters?.[currentChapterIndex] || storyData?.chapters?.[0] || {};

  return (
    <div className="h-screen bg-[#F8F9FB] text-slate-900 flex flex-col overflow-hidden font-sans">
      
      {toast && (
        <div className={`fixed top-8 left-1/2 -translate-x-1/2 z-[100] px-8 py-3 rounded-full shadow-2xl flex items-center gap-3 animate-in fade-in slide-in-from-top-6 ${toast.type === 'success' ? 'bg-slate-900 text-white' : 'bg-rose-500 text-white'}`}>
          {toast.type === 'success' ? <CheckCircle2 size={16} className="text-emerald-400" /> : <AlertCircle size={16} />}
          <span className="text-[11px] font-black uppercase tracking-widest text-white">{toast.msg}</span>
        </div>
      )}

      {/* Header (1:1 UI 复原) */}
      <header className="h-20 bg-white border-b border-slate-200 px-8 flex items-center justify-between shrink-0 z-30">
        <div className="flex items-center gap-6">
          <button onClick={() => router.back()} className="text-slate-400 p-2 hover:bg-slate-50 rounded-xl transition-all"><ChevronLeft size={20}/></button>
          <div className="flex bg-slate-100 p-1 rounded-2xl">
            <button onClick={() => setStoryData({...storyData, type: 'story'})} className={`px-6 py-2.5 rounded-xl text-[11px] font-black uppercase flex items-center gap-2 transition-all ${storyData.type === 'story' ? 'bg-white shadow-sm text-blue-600' : 'text-slate-400'}`}><Type size={14} /> 故事</button>
            <button onClick={() => setStoryData({...storyData, type: 'comic'})} className={`px-6 py-2.5 rounded-xl text-[11px] font-black uppercase flex items-center gap-2 transition-all ${storyData.type === 'comic' ? 'bg-white shadow-sm text-purple-600' : 'text-slate-400'}`}><LayoutPanelTop size={14} /> 漫画</button>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <input className="bg-transparent text-lg font-black italic outline-none w-64 text-right mr-4 text-slate-900 border-b-2 border-transparent focus:border-slate-200" value={storyData.title} onChange={(e) => setStoryData({...storyData, title: e.target.value})} placeholder="输入作品标题..." />
          <button onClick={() => setShowImportModal(true)} className="bg-white border border-slate-200 text-slate-600 px-6 py-3 rounded-2xl text-[10px] font-black uppercase flex items-center gap-2 shadow-sm hover:bg-slate-50 transition-all"><UploadCloud size={14} /> 导入</button>
          <button onClick={handleFinalSave} disabled={isSaving} className="bg-slate-900 text-white px-8 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-black shadow-xl flex items-center gap-2">
            {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} 发布
          </button>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        {/* 左侧：连载目录 (带删除逻辑) */}
        <aside className="w-80 bg-white border-r border-slate-200 flex flex-col shrink-0 z-10">
          <div className="p-6 border-b flex justify-between items-center bg-slate-50/50">
             <div className="flex items-center gap-2 text-slate-400 font-black uppercase text-[10px] tracking-widest"><Menu size={14}/> 连载目录</div>
             <button onClick={addChapter} className="text-blue-600 hover:scale-110 transition-transform"><Plus size={18}/></button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-2 no-scrollbar">
             {storyData.chapters?.map((ch: any, idx: number) => (
               <div key={ch.id} className="relative group">
                 <button onClick={() => setCurrentChapterIndex(idx)} className={`w-full text-left p-5 rounded-[24px] border transition-all flex flex-col gap-2 ${currentChapterIndex === idx ? 'bg-slate-900 border-slate-900 text-white shadow-lg' : 'bg-white border-slate-100 text-slate-600 hover:bg-slate-50'}`}>
                   <div className="flex justify-between items-center w-full"><span className={`text-[9px] font-black uppercase ${currentChapterIndex === idx ? 'text-slate-400' : 'text-slate-400'}`}>{idx + 1} - Chapter</span>{ch.is_free ? <Unlock size={12} className="text-emerald-400" /> : <Lock size={12} className="text-orange-400" />}</div>
                   <p className="text-xs font-bold italic line-clamp-1">{ch.title || "未命名章节"}</p>
                 </button>
                 {storyData.chapters.length > 1 && (
                    <button onClick={() => removeChapter(idx)} className="absolute -top-1 -right-1 bg-rose-500 text-white p-1.5 rounded-full opacity-0 group-hover:opacity-100 transition-opacity z-20 shadow-md hover:scale-110"><X size={10}/></button>
                 )}
               </div>
             ))}
          </div>
        </aside>

        {/* 中间：画布编辑区 (1:1 UI 复原) */}
        <section className="flex-1 overflow-y-auto p-8 lg:p-12 bg-[#FBFBFC]">
           <div className="max-w-4xl mx-auto space-y-8">
              
              <div className="bg-white rounded-[32px] p-8 border border-slate-200 shadow-sm flex flex-col space-y-4">
                 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest text-left">本章标题</label>
                 <input 
                    className="w-full bg-transparent text-3xl font-black italic outline-none text-slate-900 text-left"
                    value={activeChapter?.title || ""}
                    onChange={(e) => {
                      const n = {...storyData};
                      n.chapters[currentChapterIndex].title = e.target.value;
                      setStoryData(n);
                    }}
                 />
              </div>

              {storyData.type === 'story' ? (
                <div className="bg-white rounded-[40px] border border-slate-200 overflow-hidden shadow-sm h-[600px] flex flex-col">
                   <div className="p-4 border-b border-slate-100 bg-slate-50 flex items-center gap-4 text-slate-400">
                      <BookOpen size={16} />
                      <span className="text-[10px] font-black uppercase tracking-widest">正文内容</span>
                   </div>
                   <textarea 
                      className="flex-1 p-10 bg-transparent text-lg text-slate-800 leading-loose outline-none resize-none font-serif text-left"
                      value={activeChapter?.content_text || ""}
                      onChange={(e) => {
                        const n = {...storyData};
                        n.chapters[currentChapterIndex].content_text = e.target.value;
                        setStoryData(n);
                      }}
                   />
                </div>
              ) : (
                <div className="bg-white rounded-[40px] border border-slate-200 p-8 shadow-sm space-y-8 text-left">
                   <div className="flex items-center justify-between border-b pb-4">
                      <div className="flex items-center gap-3 text-slate-400 font-black uppercase text-[10px]">
                        <ImageIcon size={18} /> Comic Pages ({activeChapter?.comic_pages?.length || 0})
                      </div>
                      <input type="file" multiple accept="image/*" className="hidden" ref={comicUploadRef} onChange={(e) => handleUpload(e, 'comic')} />
                      <button onClick={() => comicUploadRef.current?.click()} className="bg-purple-50 text-purple-600 px-6 py-2.5 rounded-xl text-[10px] font-black uppercase hover:bg-purple-100 transition-all">+ 添加图片</button>
                   </div>
                   <div className="flex flex-col gap-6 max-w-2xl mx-auto">
                      {activeChapter?.comic_pages?.map((img: string, i: number) => (
                        <div key={i} className="relative group bg-slate-50 rounded-2xl border overflow-hidden shadow-md">
                           <img src={img} className="w-full object-contain" alt="" />
                           <button 
                             onClick={() => {
                               const n = {...storyData};
                               n.chapters[currentChapterIndex].comic_pages.splice(i, 1);
                               setStoryData(n);
                             }}
                             className="absolute top-4 right-4 bg-rose-500 text-white p-2 rounded-full opacity-0 group-hover:opacity-100 transition-all z-20 shadow-lg"
                           >
                             <Trash2 size={16} />
                           </button>
                        </div>
                      ))}
                   </div>
                </div>
              )}
           </div>
        </section>

        {/* 右侧：变现与封面设置 (1:1 UI 复原) */}
        <aside className="w-80 bg-white border-l border-slate-200 p-8 flex flex-col gap-10 overflow-y-auto shrink-0 z-10 text-left">
           <div className="space-y-6">
              <span className="text-[10px] font-black uppercase text-slate-400 tracking-widest flex items-center gap-2"><Coins size={14}/> 章节变现</span>
              <div className={`rounded-[32px] p-6 border transition-all ${activeChapter?.is_free ? 'bg-slate-50 border-slate-100' : 'bg-orange-50 border-orange-200'}`}>
                 <div className="flex items-center justify-between mb-4">
                    <span className={`text-[10px] font-black uppercase ${activeChapter?.is_free ? 'text-slate-500' : 'text-orange-600'}`}>
                      {activeChapter?.is_free ? '限免阅读' : '付费章节'}
                    </span>
                    <button 
                      onClick={() => {
                        const n = {...storyData};
                        n.chapters[currentChapterIndex].is_free = !n.chapters[currentChapterIndex].is_free;
                        setStoryData(n);
                      }}
                      className={`w-12 h-6 rounded-full relative transition-all ${activeChapter?.is_free ? 'bg-emerald-400' : 'bg-orange-500'}`}
                    >
                      <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${activeChapter?.is_free ? 'left-1' : 'left-7'}`} />
                    </button>
                 </div>
                 {!activeChapter?.is_free && (
                   <div className="space-y-3 pt-2 border-t border-orange-200/50">
                      <label className="text-[9px] font-black text-orange-600/70 uppercase">售价 (AURA)</label>
                      <div className="flex items-center gap-3 bg-white px-4 py-3 rounded-xl border border-orange-200 shadow-sm">
                          <Coins size={14} className="text-orange-500" />
                          <input className="bg-transparent font-black text-xs outline-none w-full" type="number" value={activeChapter?.price || 0} onChange={(e)=> {const n={...storyData}; n.chapters[currentChapterIndex].price = parseInt(e.target.value)||0; setStoryData(n);}} />
                      </div>
                   </div>
                 )}
              </div>
           </div>

           <div className="space-y-6">
              <span className="text-[10px] font-black uppercase text-slate-400 tracking-widest block">作品封面</span>
              <input type="file" className="hidden" ref={fileInputRef} onChange={(e) => handleUpload(e, 'cover')} accept="image/*" />
              <div onClick={() => !isUploading && fileInputRef.current?.click()} className="relative aspect-[3/4] rounded-[32px] bg-slate-50 border-2 border-dashed border-slate-200 flex items-center justify-center overflow-hidden cursor-pointer hover:bg-slate-100 transition-all">
                {isUploading ? (
                  <Loader2 size={24} className="animate-spin text-slate-400"/>
                ) : storyData.cover_url ? (
                  <img src={storyData.cover_url} className="w-full h-full object-cover" />
                ) : (
                  <div className="text-center"><UploadCloud size={32} className="mx-auto text-slate-200 mb-2" /><p className="text-[9px] font-black text-slate-500 uppercase">设置主封面</p></div>
                )}
              </div>
           </div>
        </aside>

      </main>

      {/* 🚀 批量导入弹窗 (加固版) */}
      {showImportModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
          <div className="bg-white rounded-[32px] shadow-2xl w-full max-w-2xl overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="p-6 border-b flex justify-between items-center bg-slate-50">
              <h3 className="text-xs font-black uppercase tracking-widest text-slate-900">导入多章节连载 JSON</h3>
              <button onClick={() => setShowImportModal(false)} className="text-slate-400 hover:text-slate-900"><X size={20}/></button>
            </div>
            <div className="p-6 bg-slate-100">
              <textarea 
                className="w-full h-80 bg-slate-900 text-emerald-400 p-6 rounded-2xl font-mono text-[11px] outline-none resize-none leading-relaxed" 
                value={importJsonText} 
                onChange={(e) => setImportJsonText(e.target.value)} 
                placeholder="在此粘贴 JSON 数组..." 
              />
            </div>
            <div className="p-6 border-t flex justify-end gap-3 bg-white text-right">
              <button onClick={() => setShowImportModal(false)} className="px-6 py-3 text-[10px] font-black uppercase text-slate-500 hover:bg-slate-50 rounded-xl transition-all">取消</button>
              <button 
                onClick={handleTextImport} 
                disabled={isImporting || !importJsonText.trim()} 
                className="bg-blue-600 text-white px-10 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest shadow-xl disabled:opacity-50"
              >
                {isImporting ? "正在入库..." : "确认批量导入"}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default function PublisherStudio() {
  return (
    <Suspense fallback={<div>Loading Studio...</div>}>
      <PublisherStudioContent />
    </Suspense>
  );
}