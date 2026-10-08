"use client";

import React, { useState, useRef, useEffect, Suspense } from "react";
import { 
  Plus, Trash2, Save, ChevronLeft, Layers, 
  BarChart3, Image as ImageIcon, Trophy, Type, 
  Calculator, Target, PieChart, Info, Hash, Loader2, 
  CheckCircle2, AlertCircle, X, UploadCloud, Sparkles, Tag, Flame, Star, Zap, Clock, ShieldCheck,
  Folder, Timer, Edit3, Check
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
// --- 🚀 AURA 核心：WebP 转码转码引擎 ---
const compressAndConvertToWebP = (file: File): Promise<File> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result as string;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error("Canvas failed"));
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((blob) => {
          if (!blob) return reject(new Error("Blob failed"));
          const webpFile = new File([blob], file.name.replace(/\.[^/.]+$/, "") + ".webp", { type: "image/webp" });
          resolve(webpFile);
        }, "image/webp", 0.8);
      };
    };
    reader.onerror = (err) => reject(err);
  });
};

function QuizEditorContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editId = searchParams.get('id'); 
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState("content"); 
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  
  // 状态系统
  const [isUploading, setIsUploading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  // 🚀 发布策略（与 BRIEFS 后台的发布面板对齐）
  // 默认 draft：保持原有「保存下来先不上线」的行为不变。
  const [postStatus, setPostStatus] = useState<'draft' | 'published' | 'scheduled'>('draft');
  const [scheduledAt, setScheduledAt] = useState("");
  const [isFeatured, setIsFeatured] = useState(false);
  const [featuredOrder, setFeaturedOrder] = useState(0);
  const [isImporting, setIsImporting] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false); 
  const [importJsonText, setImportJsonText] = useState(""); 
  const [toast, setToast] = useState<{ msg: string, type: 'success' | 'error' } | null>(null);

  // 分类管理状态 (之前丢失的部分)
  const [categoriesList, setCategoriesList] = useState(["Persona", "Subconscious", "Social", "Future"]);
  const [isEditingCategories, setIsEditingCategories] = useState(false);
  const [newCategory, setNewCategory] = useState("");

  const AVAILABLE_TAGS = [
    { id: 'hot', label: 'HOT', icon: <Flame size={12}/>, color: 'text-orange-500 bg-orange-50 border-orange-100' },
    { id: 'featured', label: 'FEATURED', icon: <Star size={12}/>, color: 'text-blue-500 bg-blue-50 border-blue-100' },
    { id: 'hardcore', label: 'HARDCORE', icon: <Zap size={12}/>, color: 'text-purple-500 bg-purple-50 border-purple-100' },
  ];

  const SCORING_MODELS = [
    { id: 'score', name: 'Total Score', desc: 'Sum of all points.', icon: <Calculator size={18}/> },
    { id: 'personality', name: 'Personality', desc: 'Based on tag frequency.', icon: <Target size={18}/> },
  ];

  // 核心业务数据
  const [quizData, setQuizData] = useState({
    title: "",
    model: "score",
    categories: ["Persona"], 
    cover_url: "",
    is_limited: false,
    tags: [] as string[],
    questions: [
      { id: `q${Date.now()}`, title: "", weight: 1.0, options: [{ id: `o${Date.now()}`, text: "", score: 0, tag: "A" }] }
    ],
    results: [{ id: `r${Date.now()}`, min_score: 0, max_score: 10, title: "", description: "" }]
  });


  const showToast = (msg: string, type: 'success' | 'error') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // 🚀 核心：依赖项只留 [editId]，绝对不要放 supabase 或 quizData
useEffect(() => {
  if (editId) {
    const fetchQuiz = async () => {
      try {
        const { data, error } = await supabase
          .from('quizzes')
          .select('*')
          .eq('id', editId)
          .single();
        
        if (error) throw error;
        
        if (data?.raw_data) {
          setQuizData(data.raw_data);
        }
        // 回填发布策略：状态 / 定时时间 / 主推位
        if (data?.status) setPostStatus(data.status);
        if (data?.scheduled_at) {
          const d = new Date(data.scheduled_at);
          const offset = d.getTimezoneOffset() * 60000;
          setScheduledAt(new Date(d.getTime() - offset).toISOString().slice(0, 16));
        }
        setIsFeatured(Boolean(data?.is_featured));
        if (data?.featured_order != null) setFeaturedOrder(Number(data.featured_order) || 0);
      } catch (err) {
        console.error("Fetch quiz error:", err);
        showToast("Failed to load quiz data. Please check your connection.", "error");
      }
    };
    fetchQuiz();
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [editId]);

  // --- 功能逻辑 ---
  // 🚀 纠错版上传逻辑：回归 covers 路径 + 强制缓存刷新
const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
  const file = e.target.files?.[0];
  if (!file) return;

  setIsUploading(true);
  try {
    // 1. WebP 转码
    const webpFile = await compressAndConvertToWebP(file);
    
    // 2. 这里的路径必须改回你最初成功的 "covers/"
    const cleanName = `quiz-${Date.now()}.webp`;
    const storagePath = `covers/${cleanName}`; 

    const { error: uploadError } = await supabase.storage
      .from('aura')
      .upload(storagePath, webpFile, {
        contentType: 'image/webp',
        upsert: true // 开启覆盖模式，更保险
      });

    if (uploadError) throw uploadError;

    // 3. 获取公开链接
    const { data } = supabase.storage
      .from('aura')
      .getPublicUrl(storagePath);

    if (!data?.publicUrl) throw new Error("Could not get public URL");

    // 4. 🚀 关键：在 URL 后面加个时间戳，强制浏览器重新加载新图，防止由于旧缓存导致的“白屏”
    const finalUrl = `${data.publicUrl}?t=${Date.now()}`;

    setQuizData(prev => ({ 
      ...prev, 
      cover_url: finalUrl 
    }));

    showToast("WebP Cover Updated", "success");
  } catch (err: any) {
    console.error("Upload Error Details:", err);
    showToast(`Upload Failed: ${err.message || 'Unknown error'}`, "error");
  } finally {
    setIsUploading(false);
  }
};

  const handlePublish = async () => {
    if (!quizData.title.trim()) return showToast("Title required", "error");

    // 定时发布必须给一个未来的时间点
    if (postStatus === 'scheduled') {
      if (!scheduledAt) return showToast("请选择定时上线时间", "error");
      if (new Date(scheduledAt).getTime() <= Date.now()) {
        return showToast("定时上线时间必须晚于当前时间", "error");
      }
    }

    setIsSaving(true);
    try {
      // active 与 status 必须同步维护：
      //   前台按 active 过滤，后台按 status 展示。
      //   只改其中一个，就会出现「后台说已发布、前台看不到」的矛盾。
      //   定时内容先保持不可见，等 cron 到点后一并翻正。
      const isLive = postStatus === 'published';

      const payload: any = {
        title: quizData.title,
        cover_url: quizData.cover_url,
        categories: quizData.categories,
        tags: quizData.tags,
        active: isLive,
        status: postStatus,
        scheduled_at: postStatus === 'scheduled' ? new Date(scheduledAt).toISOString() : null,
        is_featured: isFeatured,
        featured_order: isFeatured ? Number(featuredOrder) || 0 : 0,
        raw_data: quizData
      };
      if (isLive) payload.published_at = new Date().toISOString();

      // 阶段 0 的 SQL 还没跑时，status / scheduled_at / is_featured 这些列并不存在。
      // 沿用后台已有的「缺列就剔除该字段重试」策略，避免整套保存流程直接失败。
      let current: any = { ...payload };
      let saved = false;
      let lastError: any = null;
      for (let i = 0; i < 6; i++) {
        const res = editId
          ? await supabase.from('quizzes').update(current).eq('id', editId)
          : await supabase.from('quizzes').insert([current]);

        if (!res.error) { saved = true; break; }

        lastError = res.error;
        const msg = String(res.error.message || '');
        const m1 = msg.match(/Could not find the '([^']+)' column/i);
        const m2 = msg.match(/column\s+quizzes\.([a-zA-Z0-9_]+)\s+does\s+not\s+exist/i);
        const missing = (m1?.[1] || m2?.[1] || '').trim();
        if (missing && Object.prototype.hasOwnProperty.call(current, missing)) {
          const next: any = { ...current };
          delete next[missing];
          current = next;
          continue;
        }
        break;
      }
      if (!saved) throw lastError || new Error('save failed');

      showToast(
        postStatus === 'published' ? "已发布上线" : postStatus === 'scheduled' ? "已排入定时队列" : "草稿已保存",
        "success"
      );
      setTimeout(() => router.push('/admin/quizzes'), 1000);
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setIsSaving(false);
    }
  };

  const handleTextImport = async () => {
    if (!importJsonText.trim()) return;
    setIsImporting(true);
    try {
      const data = JSON.parse(importJsonText);
      const items = Array.isArray(data) ? data : [data];
      const insertPayload = items.map(q => ({
        title: q.title,
        raw_data: q,
        active: false,
        categories: q.categories || ["Persona"]
      }));
      const { error } = await supabase.from('quizzes').insert(insertPayload);
      if (error) throw error;
      showToast(`Imported ${items.length} Quizzes`, "success");
      setShowImportModal(false);
      setImportJsonText("");
      setTimeout(() => router.push('/admin/quizzes'), 1000);
    } catch {
      showToast("Invalid JSON Format", "error");
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="h-screen bg-[#F8F9FB] flex flex-col overflow-hidden text-left relative font-sans">
      {/* Toast通知 */}
      {toast && (
        <div className={`fixed top-8 left-1/2 -translate-x-1/2 z-[100] px-8 py-4 rounded-[28px] shadow-2xl flex items-center gap-4 animate-in fade-in slide-in-from-top-6 ${
          toast.type === 'success' ? 'bg-slate-900 text-white' : 'bg-rose-500 text-white'
        }`}>
          {toast.type === 'success' ? <CheckCircle2 size={18} className="text-emerald-400" /> : <AlertCircle size={18} />}
          <span className="text-[11px] font-black uppercase tracking-widest">{toast.msg}</span>
        </div>
      )}

      {/* Header */}
      <header className="h-20 bg-white border-b border-slate-200 px-8 flex items-center justify-between shrink-0 z-10">
        <div className="flex items-center gap-4">
          <button onClick={() => router.back()} className="p-2 hover:bg-slate-50 rounded-xl transition-all"><ChevronLeft size={20} /></button>
          <div className="flex items-center gap-3">
            <div className="bg-orange-500 p-2 rounded-lg text-white"><Trophy size={18} /></div>
            <input className="bg-transparent text-lg font-black outline-none w-64 text-left border-b-2 border-transparent focus:border-orange-500" value={quizData.title} onChange={(e)=>setQuizData({...quizData, title:e.target.value})} placeholder="Enter Quiz Title..." />
          </div>
        </div>
        <nav className="flex bg-slate-100 p-1 rounded-2xl">
          {[{id:'content',label:'Content'},{id:'results',label:'Results'},{id:'logic',label:'Logic'}].map(t => (
            <button key={t.id} onClick={()=>setActiveTab(t.id)} className={`px-6 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === t.id ? 'bg-white shadow-sm text-slate-900' : 'text-slate-400'}`}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-3">
           <button onClick={() => setShowImportModal(true)} className="bg-white border border-slate-200 text-slate-600 px-6 py-3 rounded-2xl text-[10px] font-black uppercase flex items-center gap-2 shadow-sm hover:bg-slate-50 transition-all">
             <UploadCloud size={14} /> Batch Import
           </button>
           <button onClick={handlePublish} disabled={isSaving} className="bg-slate-900 text-white px-10 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 hover:bg-black transition-all shadow-xl">
             {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}{' '}
             {postStatus === 'published' ? 'Publish Live' : postStatus === 'scheduled' ? 'Schedule' : 'Save Draft'}
           </button>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        {/* 左侧题目大纲 */}
        <aside className="w-72 bg-white border-r border-slate-200 flex flex-col shrink-0">
          <div className="p-6 border-b border-slate-50 text-[10px] font-black uppercase text-slate-400 tracking-widest">Outline</div>
          <div className="flex-1 overflow-y-auto p-4 space-y-2 no-scrollbar">
            {quizData.questions.map((q, i) => (
              <button key={q.id} onClick={() => { setActiveTab('content'); setCurrentQuestionIndex(i); }} className={`w-full text-left p-4 rounded-2xl transition-all ${currentQuestionIndex === i && activeTab === 'content' ? 'bg-slate-900 text-white shadow-lg' : 'hover:bg-slate-50 text-slate-500'}`}>
                <div className="text-[9px] font-black opacity-30 mb-1 uppercase">Q{i+1}</div>
                <div className="text-xs font-bold line-clamp-1 italic">{q.title || "Untitled Question"}</div>
              </button>
            ))}
            <button onClick={() => setQuizData({...quizData, questions: [...quizData.questions, { id: `q${Date.now()}`, title: "", weight: 1.0, options: [] }]})} className="w-full py-4 border-2 border-dashed border-slate-100 rounded-2xl text-[10px] font-black text-slate-300 uppercase hover:text-slate-900 transition-all">+ New Question</button>
          </div>
        </aside>

        {/* 中间编辑主区 */}
        <section className="flex-1 overflow-y-auto p-12 bg-[#FBFBFC]">
          <div className="max-w-3xl mx-auto">
            {activeTab === 'content' && (
              <div className="bg-white rounded-[40px] border border-slate-200 p-10 shadow-sm space-y-10 animate-in fade-in">
                <textarea className="w-full text-3xl font-black italic outline-none placeholder:text-slate-100 leading-tight text-left" value={quizData.questions[currentQuestionIndex]?.title} onChange={(e) => {
                  const n = [...quizData.questions]; n[currentQuestionIndex].title = e.target.value; setQuizData({...quizData, questions: n});
                }} placeholder="What's the question?" />
                <div className="space-y-4">
                  <p className="text-[10px] font-black text-slate-300 uppercase tracking-widest">Options & Scores</p>
                  {quizData.questions[currentQuestionIndex]?.options.map((opt, oIdx) => (
                    <div key={opt.id} className="flex gap-3 group">
                      <input className="flex-1 bg-slate-50 border rounded-2xl px-6 py-4 text-sm font-bold outline-none focus:bg-white transition-all" value={opt.text} onChange={(e)=>{
                        const n = [...quizData.questions]; n[currentQuestionIndex].options[oIdx].text = e.target.value; setQuizData({...quizData, questions: n});
                      }} placeholder="Option label" />
                      <div className="w-24 bg-slate-100 rounded-2xl flex items-center px-4">
                        <input type="number" className="bg-transparent w-full text-center font-black text-xs outline-none" value={opt.score} onChange={(e)=>{
                           const n = [...quizData.questions]; n[currentQuestionIndex].options[oIdx].score = parseInt(e.target.value) || 0; setQuizData({...quizData, questions: n});
                        }} />
                      </div>
                      <button onClick={() => { const n = [...quizData.questions]; n[currentQuestionIndex].options.splice(oIdx, 1); setQuizData({...quizData, questions: n}); }} className="p-2 text-rose-500 opacity-0 group-hover:opacity-100 transition-opacity"><Trash2 size={18}/></button>
                    </div>
                  ))}
                  <button onClick={() => { const n = [...quizData.questions]; n[currentQuestionIndex].options.push({ id: `o${Date.now()}`, text: "", score: 0, tag: "" }); setQuizData({...quizData, questions: n}); }} className="w-full py-4 border-2 border-dashed border-slate-100 rounded-2xl text-[10px] font-black text-slate-300 uppercase hover:text-slate-900 transition-all">+ Add Option</button>
                </div>
              </div>
            )}

            {activeTab === 'results' && (
              <div className="space-y-8 animate-in fade-in">
                <div className="flex justify-between items-center pb-6 border-b border-slate-100">
                  <h3 className="text-2xl font-black italic uppercase tracking-tighter flex items-center gap-2"><Sparkles className="text-orange-500"/> Result Mapping</h3>
                  <button onClick={() => setQuizData({...quizData, results: [...quizData.results, { id: `r${Date.now()}`, min_score: 0, max_score: 10, title: "", description: "" }]})} className="bg-slate-900 text-white px-8 py-3 rounded-2xl text-[10px] font-black uppercase shadow-lg">+ New Result</button>
                </div>
                {quizData.results.map((res, rIdx) => (
                  <div key={res.id} className="bg-white rounded-[40px] border border-slate-200 p-8 flex gap-8 relative shadow-sm aura-hover-lift">
                    <div className="w-40 space-y-3 shrink-0">
                       <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Range</label>
                       <div className="flex items-center gap-2 bg-slate-50 p-3 rounded-2xl shadow-inner border border-slate-100">
                          <input type="number" className="bg-transparent w-full text-center font-bold text-xs outline-none" value={res.min_score} onChange={(e)=>{
                             const n = [...quizData.results]; n[rIdx].min_score = parseInt(e.target.value) || 0; setQuizData({...quizData, results: n});
                          }} />
                          <span className="text-slate-200">/</span>
                          <input type="number" className="bg-transparent w-full text-center font-bold text-xs outline-none" value={res.max_score} onChange={(e)=>{
                             const n = [...quizData.results]; n[rIdx].max_score = parseInt(e.target.value) || 0; setQuizData({...quizData, results: n});
                          }} />
                       </div>
                    </div>
                    <div className="flex-1 space-y-4">
                       <input className="w-full text-xl font-black italic outline-none border-b-2 border-slate-50 focus:border-slate-900 transition-all bg-transparent text-left" placeholder="Result Title" value={res.title} onChange={(e)=>{
                          const n = [...quizData.results]; n[rIdx].title = e.target.value; setQuizData({...quizData, results: n});
                       }} />
                       <textarea className="w-full h-24 bg-slate-50 rounded-2xl p-5 text-xs font-medium outline-none shadow-inner leading-relaxed text-left" placeholder="Provide deep analysis..." value={res.description} onChange={(e)=>{
                          const n = [...quizData.results]; n[rIdx].description = e.target.value; setQuizData({...quizData, results: n});
                       }} />
                    </div>
                    <button onClick={() => { const n = [...quizData.results]; n.splice(rIdx, 1); setQuizData({...quizData, results: n}); }} className="absolute top-8 right-8 text-slate-300 hover:text-rose-500"><Trash2 size={16}/></button>
                  </div>
                ))}
              </div>
            )}
            
            {activeTab === 'logic' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 animate-in fade-in">
                {SCORING_MODELS.map(m => (
                  <button key={m.id} onClick={() => setQuizData({...quizData, model: m.id})} className={`p-12 rounded-[48px] border-2 transition-all text-left space-y-6 ${quizData.model === m.id ? 'bg-white border-slate-900 shadow-2xl scale-105' : 'bg-white border-transparent opacity-50'}`}>
                    <div className={`p-5 rounded-2xl w-fit ${quizData.model === m.id ? 'bg-slate-900 text-white shadow-xl' : 'bg-slate-100 text-slate-400'}`}>{m.icon}</div>
                    <div><p className="text-xl font-black italic uppercase mb-2 text-slate-900">{m.name}</p><p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">{m.desc}</p></div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* 右侧配置栏 (恢复分类管理) */}
        <aside className="w-80 bg-white border-l border-slate-200 p-8 flex flex-col gap-10 shrink-0 overflow-y-auto no-scrollbar">
          {/* 🚀 发布策略（与 BRIEFS 后台同一套交互） */}
          <div className="p-6 rounded-[32px] bg-slate-50 border border-slate-100 space-y-4">
            <span className="text-[10px] font-black uppercase text-slate-900 tracking-widest flex items-center gap-2">
              <Clock size={14} className="text-blue-500"/> 发布策略
            </span>

            <div className="grid grid-cols-3 gap-1.5 p-1.5 bg-white rounded-2xl border border-slate-100">
              {(['draft', 'published', 'scheduled'] as const).map(st => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setPostStatus(st)}
                  className={`py-2.5 rounded-xl text-[9px] font-black uppercase transition-all ${postStatus === st ? 'bg-slate-900 text-white shadow-md' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  {st === 'draft' ? '草稿' : st === 'published' ? '发布' : '定时'}
                </button>
              ))}
            </div>

            {postStatus === 'scheduled' && (
              <div className="space-y-2 p-4 bg-indigo-50/50 rounded-2xl border border-indigo-50">
                <label className="text-[9px] font-black uppercase tracking-widest text-indigo-500 block">上线时间</label>
                <input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  className="w-full px-3 py-2.5 bg-white border border-slate-100 text-[11px] font-bold rounded-xl text-slate-700 outline-none focus:border-indigo-500"
                />
                <p className="text-[8px] text-slate-400 font-bold italic leading-relaxed">
                  到点后由 /api/cron/publish 自动翻成已发布。
                </p>
              </div>
            )}

            <div className="flex items-center justify-between p-4 rounded-2xl bg-white border border-slate-100">
              <span className="text-[10px] font-black uppercase text-slate-900 tracking-widest flex items-center gap-2">
                <Star size={14} className={isFeatured ? 'text-amber-500' : 'text-slate-300'} fill={isFeatured ? 'currentColor' : 'none'} /> 主推 / Banner
              </span>
              <button
                type="button"
                onClick={() => setIsFeatured(v => !v)}
                className={`w-10 h-5 rounded-full transition-all relative ${isFeatured ? 'bg-amber-500' : 'bg-slate-300'}`}
              >
                <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${isFeatured ? 'left-6' : 'left-1'}`} />
              </button>
            </div>

            {isFeatured && (
              <div className="flex items-center gap-3 p-4 rounded-2xl bg-white border border-slate-100">
                <span className="text-[9px] font-black uppercase text-slate-400 tracking-widest shrink-0">排序</span>
                <input
                  type="number"
                  value={featuredOrder}
                  onChange={(e) => setFeaturedOrder(parseInt(e.target.value) || 0)}
                  className="w-full bg-slate-50 rounded-xl px-3 py-2 text-[11px] font-bold outline-none border border-slate-100"
                />
                <span className="text-[8px] text-slate-400 font-bold shrink-0">越小越前</span>
              </div>
            )}
          </div>

          {/* 限时模式 */}
          <div className="p-6 rounded-[32px] bg-slate-50 border border-slate-100 space-y-4">
             <div className="flex items-center justify-between">
                <span className="text-[10px] font-black uppercase text-slate-900 tracking-widest flex items-center gap-2"><Timer size={14} className="text-rose-500"/> Limited Mode</span>
                <button onClick={() => setQuizData(prev => ({...prev, is_limited: !prev.is_limited}))} className={`w-10 h-5 rounded-full transition-all relative ${quizData.is_limited ? 'bg-rose-500' : 'bg-slate-300'}`}>
                  <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${quizData.is_limited ? 'left-6' : 'left-1'}`} />
                </button>
             </div>
             <p className="text-[9px] text-slate-400 font-bold leading-relaxed italic">Enable breathing "LIMITED" badge on cover.</p>
          </div>

          {/* 分类管理 (恢复) */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-black uppercase text-slate-400 tracking-widest flex items-center gap-2"><Folder size={14}/> Categories</span>
              <button onClick={() => setIsEditingCategories(!isEditingCategories)} className="p-2 text-slate-400 hover:text-slate-900 transition-all">{isEditingCategories ? <Check size={14}/> : <Edit3 size={14}/>}</button>
            </div>
            <div className="flex flex-wrap gap-2">
              {categoriesList.map(cat => (
                <div key={cat} className="group relative">
                  <button onClick={() => setQuizData(prev => ({...prev, categories: prev.categories.includes(cat) ? prev.categories.filter(c => c !== cat) : [...prev.categories, cat]}))} className={`px-4 py-2 rounded-xl text-[10px] font-bold border transition-all ${quizData.categories.includes(cat) ? 'bg-blue-50 border-blue-200 text-blue-600 shadow-sm scale-105' : 'bg-white border-slate-100 text-slate-500 hover:border-slate-300'}`}>{cat}</button>
                  {isEditingCategories && (
                    <button onClick={() => setCategoriesList(prev => prev.filter(c => c !== cat))} className="absolute -top-1 -right-1 w-4 h-4 bg-rose-500 text-white rounded-full flex items-center justify-center shadow-md"><X size={8}/></button>
                  )}
                </div>
              ))}
            </div>
            {isEditingCategories && (
              <div className="flex gap-2 mt-4">
                <input className="flex-1 bg-slate-50 border border-slate-100 rounded-xl px-4 py-2 text-[10px] font-bold outline-none" value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder="New tag..." onKeyDown={(e) => {
                  if(e.key === 'Enter' && newCategory.trim()) { setCategoriesList([...categoriesList, newCategory.trim()]); setNewCategory(""); }
                }} />
                <button onClick={() => { if(newCategory.trim()) { setCategoriesList([...categoriesList, newCategory.trim()]); setNewCategory(""); }}} className="p-2 bg-slate-900 text-white rounded-xl"><Plus size={14}/></button>
              </div>
            )}
          </div>

          {/* 标签管理 */}
          <div className="space-y-4">
            <span className="text-[10px] font-black uppercase text-slate-400 tracking-widest block">Operational Tags</span>
            <div className="flex flex-wrap gap-2">
              {AVAILABLE_TAGS.map(tag => (
                <button key={tag.id} onClick={() => setQuizData(prev => ({...prev, tags: prev.tags.includes(tag.id) ? prev.tags.filter(t => t !== tag.id) : [...prev.tags, tag.id]}))} className={`px-4 py-2 rounded-xl text-[10px] font-bold border transition-all ${quizData.tags.includes(tag.id) ? `${tag.color} scale-105 shadow-sm` : 'bg-white border-slate-100 text-slate-500 hover:border-slate-300'}`}>{tag.icon} {tag.label}</button>
              ))}
            </div>
          </div>

          {/* 封面上传 (WebP 实时反馈) */}
          <div className="space-y-4">
            <span className="text-[10px] font-black uppercase text-slate-400 tracking-widest block">Cover Vision</span>
            <input type="file" accept="image/*" className="hidden" ref={fileInputRef} onChange={handleFileUpload} />
            <div onClick={() => !isUploading && fileInputRef.current?.click()} className={`relative aspect-video rounded-[36px] border-2 border-dashed flex items-center justify-center overflow-hidden cursor-pointer group transition-all ${quizData.cover_url ? 'border-transparent shadow-2xl' : 'bg-slate-50 border-slate-100 hover:border-slate-900'}`}>
              {isUploading ? (
                <div className="flex flex-col items-center gap-2">
                  <Loader2 className="animate-spin text-slate-400" />
                  <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest">Optimizing WebP...</span>
                </div>
              ) : quizData.cover_url ? (
                <>
                  <img src={quizData.cover_url} className="w-full h-full object-cover" />
                  {quizData.is_limited && <div className="absolute top-4 right-4 bg-rose-500 text-white px-3 py-1 rounded-full text-[8px] font-black uppercase tracking-tighter animate-pulse shadow-lg flex items-center gap-1"><Zap size={10} fill="currentColor"/> Limited</div>}
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-all flex items-center justify-center">
                    <span className="text-white text-[9px] font-black uppercase tracking-[0.3em]">Update Media</span>
                  </div>
                </>
              ) : <UploadCloud className="text-slate-300" />}
            </div>
          </div>
        </aside>
      </main>

      {/* 批量导入弹窗 (恢复) */}
      {showImportModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
          <div className="bg-white rounded-[32px] shadow-2xl w-full max-w-3xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50">
              <h3 className="text-sm font-black uppercase tracking-widest text-slate-900">Batch JSON Import</h3>
              <button onClick={() => setShowImportModal(false)} className="text-slate-400 hover:text-slate-900 bg-white p-2 rounded-xl"><X size={20}/></button>
            </div>
            <div className="p-6 bg-slate-100">
              <textarea className="w-full h-96 bg-slate-900 text-emerald-400 p-6 rounded-2xl font-mono text-[11px] outline-none resize-none leading-relaxed" value={importJsonText} onChange={(e) => setImportJsonText(e.target.value)} placeholder="Paste AI-generated JSON pack..." />
            </div>
            <div className="p-6 border-t flex justify-end gap-3 bg-white">
              <button onClick={() => setShowImportModal(false)} className="px-6 py-3 text-[10px] font-black uppercase text-slate-500 rounded-xl">Cancel</button>
              <button onClick={handleTextImport} disabled={isImporting || !importJsonText.trim()} className="bg-blue-600 text-white px-8 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest shadow-xl active:scale-95 transition-all">
                {isImporting ? "Processing..." : "Confirm Batch Import"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function QuizStudioWrapper() {
  return (
    <Suspense fallback={<div className="h-screen flex items-center justify-center bg-[#F8F9FB] font-black italic text-slate-300 animate-pulse uppercase tracking-widest">Aura Loading...</div>}>
      <QuizEditorContent />
    </Suspense>
  );
}