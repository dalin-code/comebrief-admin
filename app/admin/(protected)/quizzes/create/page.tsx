"use client";

import React, { useState, useRef, useEffect, Suspense } from "react";
import { 
  Plus, Trash2, Save, ChevronLeft, Layers, 
  BarChart3, Image as ImageIcon, Trophy, Type, 
  Calculator, Target, PieChart, Info, Hash, Loader2, 
  CheckCircle2, AlertCircle, X, UploadCloud, Sparkles, Tag, Flame, Star, Zap, Clock, ShieldCheck,
  Folder, Timer, Edit3, Check, LayoutGrid
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import QuizBatchImport from "@/app/admin/_components/QuizBatchImport";
import QuizAiWizard, { type QuizAiApplyPayload } from "@/app/admin/_components/QuizAiWizard";
import QuizAxesEditor, { blankAxeQuiz } from "@/app/admin/_components/QuizAxesEditor";
import { auditAxeQuiz, normalizeAxeQuiz, type AxeQuiz } from "@/lib/quizAxes";
import { contentPathFor } from "@/lib/growth";
import GrowthPanel, {
  EMPTY_GROWTH_DRAFT,
  draftFromRow,
  draftToContentFields,
  type GrowthDraft,
} from "@/app/admin/_components/growth/GrowthPanel";
import { notifyRevalidate } from "@/app/admin/_components/growth/actions";
import { DEFAULT_CATEGORY, QUIZ_CATEGORIES } from "@/lib/quizPack";
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
  const [showImportModal, setShowImportModal] = useState(false);
  const [showAiWizard, setShowAiWizard] = useState(false);
  // AI 起草带过来的溯源信息（趋势 id / 热词 / 地区 / 模型），保存时写进 raw_data.meta。
  // 单独放一份状态而不是塞进 quizData：旧卷没有这个字段，混进去会让旧路径的载荷变形。
  const [aiMeta, setAiMeta] = useState<Record<string, any> | null>(null);
  const [aiHook, setAiHook] = useState(""); 
  const [toast, setToast] = useState<{ msg: string, type: 'success' | 'error' } | null>(null);

  // 分类按钮：候选值只有一份真源（lib/quizPack → lib/quizKit 的 6 个话题）。
  // 历史数据里不在表内的值会在加载时补到列表末尾，仍然可见、可点掉。
  const [categoriesList, setCategoriesList] = useState<string[]>([...QUIZ_CATEGORIES]);
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
    // axes：0–3 权重矩阵 + 全枚举自检。选中它，中间区会换成矩阵编辑器
    // （`QuizAxesEditor`），题目/结果两个旧标签页不再适用。
    { id: 'axes', name: 'Archetype Matrix', desc: '0–3 weights per archetype, verified by full enumeration.', icon: <LayoutGrid size={18}/> },
  ];

  // 核心业务数据
  const [quizData, setQuizData] = useState({
    title: "",
    model: "score",
    categories: [DEFAULT_CATEGORY],
    cover_url: "",
    is_limited: false,
    tags: [] as string[],
    questions: [
      { id: `q${Date.now()}`, title: "", weight: 1.0, options: [{ id: `o${Date.now()}`, text: "", score: 0, tag: "A" }] }
    ],
    results: [{ id: `r${Date.now()}`, min_score: 0, max_score: 10, title: "", description: "" }]
  });

  // axes 卷的正文（原型 + 题目 + 权重表）单独放一份状态：
  // 它的形状和上面的 `score` / `personality` 载荷完全不同（没有 results、
  // 选项也没有 score/tag），硬塞进 `quizData` 只会让每个 tab 都多一层判空。
  // 保存时按 `quizData.model` 二选一写进 `raw_data`。
  const [axeQuiz, setAxeQuiz] = useState<AxeQuiz>(blankAxeQuiz);

  // SEO / GEO 物料（SQL 52 加在 quizzes 上的七列）。和正文分开一份状态：
  // 这些字段只出现在 SEO 标签页，混进 `quizData` 会让每个 tab 都多一层判空。
  // 落库仍由 handlePublish 一起写进 payload —— 少一次「保存了两半」的机会。
  const [growthDraft, setGrowthDraft] = useState<GrowthDraft>(EMPTY_GROWTH_DRAFT);
  /** 前台地址（AI 起草要它来拼社媒链接）；新建时为空，保存前不推前台。 */
  const [growthUrl, setGrowthUrl] = useState('');


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
          // axes 卷要拆成两份状态：正文（原型 / 题目 / 权重）进 `axeQuiz`，
          // 外层字段（标题 / 分类 / 封面 / 限时）留在 `quizData`。
          // 不能整块 `setQuizData(raw_data)` —— 它没有 `results`，一进 Results
          // 标签页就会 `.map` 到 undefined 上白屏。
          const axe = normalizeAxeQuiz(data.raw_data);
          if (axe) {
            setAxeQuiz(axe.quiz);
            const loadedCategories: string[] = Array.isArray(data.raw_data?.categories)
              ? data.raw_data.categories
              : Array.isArray(data?.categories)
                ? data.categories
                : [];
            // 统一词表优先；旧数据里不在表内的词补在后面（仍然可见、可点掉），
            // 否则「已选分类」会指向一个不存在的按钮，看起来像没分类。
            setCategoriesList(
              Array.from(new Set<string>([...QUIZ_CATEGORIES, ...loadedCategories]))
            );
            setQuizData((prev) => ({
              ...prev,
              title: data.raw_data?.title ?? data?.title ?? prev.title,
              model: 'axes',
              categories: loadedCategories.length ? loadedCategories : prev.categories,
              tags: Array.isArray(data.raw_data?.tags) ? data.raw_data.tags : prev.tags,
              cover_url: data.raw_data?.cover_url ?? data?.cover_url ?? prev.cover_url,
              is_limited: Boolean(data.raw_data?.is_limited),
              questions: [],
              results: [],
            }));
            // 只有「真的改了数据」才提示。缺象限这类降级走 advisories，不再冒充纠错
            // （见 lib/quizAxes 的 AxeNormalizeResult）。
            if (axe.issues.length) {
              showToast(`已自动纠正 ${axe.issues.length} 处：${axe.issues[0]}`, "success");
            }
          } else {
            setQuizData(data.raw_data);
          }
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
        // SEO / GEO 物料：缺列（SQL 52 还没跑）时读不到这些键，draftFromRow 会把它们当空 —— 面板照样能用
        setGrowthDraft(draftFromRow(data));
        setGrowthUrl(contentPathFor('quizzes', data?.slug || data?.id || ''));
      } catch (err) {
        console.error("Fetch quiz error:", err);
        showToast("Failed to load quiz data. Please check your connection.", "error");
      }
    };
    fetchQuiz();
  }
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

  /**
   * AI 起草 → 编辑器。
   *
   * 只**填**，不保存：标题 / 分类 / 标签 / 四个原型 / 8 题 × 4 选项全部进状态，
   * 打分模型切到 axes（否则矩阵编辑器整块不渲染，用户会以为“点了没反应”）。
   * meta 存起来，保存时写进 raw_data.meta —— 三个月后还能回答“这卷依据什么”。
   */
  const handleAiApply = (payload: QuizAiApplyPayload) => {
    setQuizData((prev) => ({
      ...prev,
      title: payload.title || prev.title,
      model: 'axes',
      categories: payload.categories.length ? payload.categories : prev.categories,
      tags: payload.tags,
    }));
    setAxeQuiz(payload.quiz);
    setAiMeta(payload.meta ?? null);
    setAiHook(payload.hook ?? '');
    setActiveTab('content');
    showToast(`AI 起草已填入：${payload.quiz.questions.length} 题 / ${payload.quiz.archetypes.length} 个结果`, 'success');
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
      // axes 卷发布前必须过一遍自检（草稿可以存，草稿不上线）：
      // 「抽不到的原型 / 盖不满的格子」是 blocker，和 CI 的 check:quiz 同源，
      // 后台放行就等于让 CI 变成唯一的守门人 —— 但 CI 拦不住手点发布的人。
      if (quizData.model === 'axes' && postStatus !== 'draft') {
        const audit = auditAxeQuiz({ ...axeQuiz, model: 'axes' });
        if (!audit) {
          return showToast('原型卷结构不完整：需要 archetypes + questions', 'error');
        }
        if (audit.blockers.length) {
          return showToast(`还有 ${audit.blockers.length} 项 blocker：${audit.blockers[0].label}`, 'error');
        }
      }

      // active 与 status 必须同步维护：
      //   前台按 active 过滤，后台按 status 展示。
      //   只改其中一个，就会出现「后台说已发布、前台看不到」的矛盾。
      //   定时内容先保持不可见，等 cron 到点后一并翻正。
      const isLive = postStatus === 'published';

      // axes 卷的 raw_data 只有一种形状：外层字段 + archetypes + questions。
      // 旧的 questions / results 绝不能混进去 —— ComeBrief 的 parseQuiz 见到
      // `model === "axes"` 会走原型分支（多出来的 results 被静默忽略），但下一次
      // 有人用旧编辑器打开时，那两份互相矛盾的题表会把人带偏。
      const rawData = quizData.model === 'axes'
        ? {
            title: quizData.title,
            model: 'axes',
            categories: quizData.categories,
            tags: quizData.tags,
            cover_url: quizData.cover_url,
            is_limited: quizData.is_limited,
            // AI 起草带过来的两样：列表卡片副标题 + 溯源信息（趋势 id / 热词 / 地区 / 模型）。
            // 都只在新卷上出现，旧卷保存时这两个键根本不存在，raw_data 形状不变。
            ...(aiHook ? { hook: aiHook } : {}),
            ...(aiMeta ? { meta: aiMeta } : {}),
            archetypes: axeQuiz.archetypes,
            questions: axeQuiz.questions,
            // 结果页地图的两条轴。新卷从 AI 起草 / 手写里带过来；没有就不写这个键，
            // 前台会退回雷达图 —— 但**不能**在这里凭空造一对轴名，那是编内容。
            ...(axeQuiz.axes ? { axes: axeQuiz.axes } : {}),
          }
        : quizData;

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
        // `50_quiz_taxonomy.sql` 里 scoring_mode 允许 axes；列还没跑时下面那段
        // 「缺列就剔除重试」会把它摘掉，不影响保存。
        ...(quizData.model === 'axes' ? { scoring_mode: 'axes' } : {}),
        raw_data: rawData,
        // SQL 52 的七列。列不存在时下面「缺列就剔除重试」会逐个摘掉，不会让整次保存失败。
        ...draftToContentFields(growthDraft),
      };
      if (isLive) payload.published_at = new Date().toISOString();

      // 阶段 0 的 SQL 还没跑时，status / scheduled_at / is_featured 这些列并不存在。
      // 沿用后台已有的「缺列就剔除该字段重试」策略，避免整套保存流程直接失败。
      let current: any = { ...payload };
      let saved = false;
      let lastError: any = null;
      for (let i = 0; i < 12; i++) {
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

      // 保存成功后再刷前台缓存。刷新失败不影响保存结果 —— 前台会退回 ≤60s 的 ISR，
      // 所以提示只说「最迟 60 秒可见」，不把刷新失败说成保存失败。
      const revalidate = await notifyRevalidate();
      showToast(
        `${postStatus === 'published' ? "已发布上线" : postStatus === 'scheduled' ? "已排入定时队列" : "草稿已保存"}${
          revalidate.ok ? ' · 前台缓存已刷新' : ' · 前台最迟 60 秒可见'
        }`,
        "success"
      );
      setTimeout(() => router.push('/admin/quiz-studio'), 1000);
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setIsSaving(false);
    }
  };

  // axes 卷的两个旧标签页换了语义：Content → 权重矩阵，Results → 原型文案。
  // 位置仍是三个（而不是给 axes 另开一套导航）：「题目 / 结果 / 打分逻辑」
  // 这件事三个模型都一样，只是画法不同。
  // 第四个 SEO 标签页与模型无关（两套模型都要能被搜到），所以两边都加。
  const navTabs = [
    ...(quizData.model === 'axes'
      ? [{ id: 'content', label: 'Matrix' }, { id: 'results', label: 'Archetypes' }, { id: 'logic', label: 'Logic' }]
      : [{ id: 'content', label: 'Content' }, { id: 'results', label: 'Results' }, { id: 'logic', label: 'Logic' }]),
    { id: 'seo', label: 'SEO' },
  ];

  const modelPicker = (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-8 animate-in fade-in">
      {SCORING_MODELS.map(m => (
        <button key={m.id} onClick={() => {
          // 从 axes 切走 = 丢掉权重矩阵（archetypes + questions 不在旧载荷里）。
          // 已上线的卷被手滑改回 score 就是一次静默的数据删除，所以问一次。
          if (quizData.model === 'axes' && m.id !== 'axes' && axeQuiz.questions.length > 0) {
            if (!window.confirm('切走会丢掉权重矩阵（archetypes + 题目 + 权重），确定要换打分模型？')) return;
          }
          setQuizData({ ...quizData, model: m.id });
        }} className={`p-12 rounded-[48px] border-2 transition-all text-left space-y-6 ${quizData.model === m.id ? 'bg-white border-slate-900 shadow-2xl scale-105' : 'bg-white border-transparent opacity-50'}`}>
          <div className={`p-5 rounded-2xl w-fit ${quizData.model === m.id ? 'bg-slate-900 text-white shadow-xl' : 'bg-slate-100 text-slate-400'}`}>{m.icon}</div>
          <div><p className="text-xl font-black italic mb-2 text-slate-900">{m.name}</p><p className="text-[10px] text-slate-400 font-bold tracking-widest">{m.desc}</p></div>
        </button>
      ))}
    </div>
  );

  // 🧠 喂给 SEO / GEO 起草器的「内容事实」。测验没有正文，就用题干拼一份大纲 ——
  // 没有它，AI 写出来的描述与实际题目对不上（一道职场卷被写成恋爱测试）。
  const quizOutline = quizData.questions
    .map((q: any, i: number) => {
      const title = String(q?.title || '').trim();
      return title ? `${i + 1}. ${title}` : '';
    })
    .filter(Boolean)
    .join('\n')
    .slice(0, 6000);

  return (
    <div className="h-screen bg-[#F8F9FB] flex flex-col overflow-hidden text-left relative font-sans">
      {/* Toast通知 */}
      {toast && (
        <div className={`fixed top-8 left-1/2 -translate-x-1/2 z-[100] px-8 py-4 rounded-[28px] shadow-2xl flex items-center gap-4 animate-in fade-in slide-in-from-top-6 ${
          toast.type === 'success' ? 'bg-slate-900 text-white' : 'bg-rose-500 text-white'
        }`}>
          {toast.type === 'success' ? <CheckCircle2 size={18} className="text-emerald-400" /> : <AlertCircle size={18} />}
          <span className="text-[11px] font-black tracking-widest">{toast.msg}</span>
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
          {navTabs.map(t => (
            <button key={t.id} onClick={()=>setActiveTab(t.id)} className={`px-6 py-2 rounded-xl text-[10px] font-black tracking-widest transition-all ${activeTab === t.id ? 'bg-white shadow-sm text-slate-900' : 'text-slate-400'}`}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-3">
           <button onClick={() => setShowAiWizard(true)} className="bg-white border border-slate-200 text-slate-600 px-6 py-3 rounded-2xl text-[10px] font-black flex items-center gap-2 shadow-sm hover:bg-slate-50 transition-all">
             <Sparkles size={14} /> AI 起草
           </button>
           <button onClick={() => setShowImportModal(true)} className="bg-white border border-slate-200 text-slate-600 px-6 py-3 rounded-2xl text-[10px] font-black flex items-center gap-2 shadow-sm hover:bg-slate-50 transition-all">
             <UploadCloud size={14} /> Batch Import
           </button>
           <button onClick={handlePublish} disabled={isSaving} className="bg-slate-900 text-white px-10 py-3 rounded-2xl text-[10px] font-black tracking-widest flex items-center gap-2 hover:bg-black transition-all shadow-xl">
             {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}{' '}
             {postStatus === 'published' ? 'Publish Live' : postStatus === 'scheduled' ? 'Schedule' : 'Save Draft'}
           </button>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        {/* 左侧题目大纲（axes 卷不适用：题目直接在矩阵里编，不需要另开大纲） */}
        {quizData.model !== 'axes' && activeTab !== 'seo' && (
        <aside className="w-72 bg-white border-r border-slate-200 flex flex-col shrink-0">
          <div className="p-6 border-b border-slate-50 text-[10px] font-black text-slate-400 tracking-widest">Outline</div>
          <div className="flex-1 overflow-y-auto p-4 space-y-2 no-scrollbar">
            {quizData.questions.map((q, i) => (
              <button key={q.id} onClick={() => { setActiveTab('content'); setCurrentQuestionIndex(i); }} className={`w-full text-left p-4 rounded-2xl transition-all ${currentQuestionIndex === i && activeTab === 'content' ? 'bg-slate-900 text-white shadow-lg' : 'hover:bg-slate-50 text-slate-500'}`}>
                <div className="text-[9px] font-black opacity-30 mb-1">Q{i+1}</div>
                <div className="text-xs font-bold line-clamp-1 italic">{q.title || "Untitled Question"}</div>
              </button>
            ))}
            <button onClick={() => setQuizData({...quizData, questions: [...quizData.questions, { id: `q${Date.now()}`, title: "", weight: 1.0, options: [] }]})} className="w-full py-4 border-2 border-dashed border-slate-100 rounded-2xl text-[10px] font-black text-slate-300 hover:text-slate-900 transition-all">+ New Question</button>
          </div>
        </aside>
        )}

        {/* 中间编辑主区 */}
        <section className={activeTab === 'seo' || quizData.model !== 'axes' ? "flex-1 overflow-y-auto p-12 bg-[#FBFBFC]" : "flex-1 overflow-hidden bg-[#FBFBFC]"}>
          {activeTab === 'seo' ? (
            <div className="max-w-3xl mx-auto space-y-4 animate-in fade-in">
              <div className="rounded-[40px] border border-slate-200 bg-white p-10 shadow-sm">
                <GrowthPanel
                  scope="content"
                  value={growthDraft}
                  onChange={setGrowthDraft}
                  title={quizData.title}
                  // 题干大纲：让描述 / TL;DR / 问答贴着这一卷的真实内容，而不是通用套话
                  body={quizOutline}
                  url={growthUrl}
                  disabled={isSaving}
                />
              </div>
              <p className="px-4 text-[11px] leading-relaxed text-slate-400">
                这些字段与标题、正文一起在右上角的保存按钮里落库，不需要单独保存。保存后前台缓存会自动刷新。
                {growthUrl ? '' : ' 新建的卷还没有前台地址，AI 起草时不会生成社媒链接。'}
              </p>
            </div>
          ) : quizData.model === 'axes' ? (
            activeTab === 'logic' ? (
              <div className="max-w-3xl mx-auto p-12">{modelPicker}</div>
            ) : (
              <QuizAxesEditor
                quiz={axeQuiz}
                onChange={setAxeQuiz}
                view={activeTab === 'results' ? 'archetypes' : 'matrix'}
                onViewChange={(next) => setActiveTab(next === 'archetypes' ? 'results' : 'content')}
              />
            )
          ) : (
          <div className="max-w-3xl mx-auto">
            {activeTab === 'content' && (
              <div className="bg-white rounded-[40px] border border-slate-200 p-10 shadow-sm space-y-10 animate-in fade-in">
                <textarea className="w-full text-3xl font-black italic outline-none placeholder:text-slate-100 leading-tight text-left" value={quizData.questions[currentQuestionIndex]?.title} onChange={(e) => {
                  const n = [...quizData.questions]; n[currentQuestionIndex].title = e.target.value; setQuizData({...quizData, questions: n});
                }} placeholder="What's the question?" />
                <div className="space-y-4">
                  <p className="text-[10px] font-black text-slate-300 tracking-widest">Options & Scores</p>
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
                  <button onClick={() => { const n = [...quizData.questions]; n[currentQuestionIndex].options.push({ id: `o${Date.now()}`, text: "", score: 0, tag: "" }); setQuizData({...quizData, questions: n}); }} className="w-full py-4 border-2 border-dashed border-slate-100 rounded-2xl text-[10px] font-black text-slate-300 hover:text-slate-900 transition-all">+ Add Option</button>
                </div>
              </div>
            )}

            {activeTab === 'results' && (
              <div className="space-y-8 animate-in fade-in">
                <div className="flex justify-between items-center pb-6 border-b border-slate-100">
                  <h3 className="text-2xl font-black italic tracking-tighter flex items-center gap-2"><Sparkles className="text-orange-500"/> Result Mapping</h3>
                  <button onClick={() => setQuizData({...quizData, results: [...quizData.results, { id: `r${Date.now()}`, min_score: 0, max_score: 10, title: "", description: "" }]})} className="bg-slate-900 text-white px-8 py-3 rounded-2xl text-[10px] font-black shadow-lg">+ New Result</button>
                </div>
                {quizData.results.map((res, rIdx) => (
                  <div key={res.id} className="bg-white rounded-[40px] border border-slate-200 p-8 flex gap-8 relative shadow-sm aura-hover-lift">
                    <div className="w-40 space-y-3 shrink-0">
                       <label className="text-[10px] font-black text-slate-400 tracking-widest">Range</label>
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
            
            {activeTab === 'logic' && modelPicker}
          </div>
          )}
        </section>

        {/* 右侧配置栏 (恢复分类管理) */}
        <aside className="w-80 bg-white border-l border-slate-200 p-8 flex flex-col gap-10 shrink-0 overflow-y-auto no-scrollbar">
          {/* 🚀 发布策略（与 BRIEFS 后台同一套交互） */}
          <div className="p-6 rounded-[32px] bg-slate-50 border border-slate-100 space-y-4">
            <span className="text-[10px] font-black text-slate-900 tracking-widest flex items-center gap-2">
              <Clock size={14} className="text-blue-500"/> 发布策略
            </span>

            <div className="grid grid-cols-3 gap-1.5 p-1.5 bg-white rounded-2xl border border-slate-100">
              {(['draft', 'published', 'scheduled'] as const).map(st => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setPostStatus(st)}
                  className={`py-2.5 rounded-xl text-[9px] font-black transition-all ${postStatus === st ? 'bg-slate-900 text-white shadow-md' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  {st === 'draft' ? '草稿' : st === 'published' ? '发布' : '定时'}
                </button>
              ))}
            </div>

            {postStatus === 'scheduled' && (
              <div className="space-y-2 p-4 bg-indigo-50/50 rounded-2xl border border-indigo-50">
                <label className="text-[9px] font-black tracking-widest text-indigo-500 block">上线时间</label>
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
              <span className="text-[10px] font-black text-slate-900 tracking-widest flex items-center gap-2">
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
                <span className="text-[9px] font-black text-slate-400 tracking-widest shrink-0">排序</span>
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
                <span className="text-[10px] font-black text-slate-900 tracking-widest flex items-center gap-2"><Timer size={14} className="text-rose-500"/> Limited Mode</span>
                <button onClick={() => setQuizData(prev => ({...prev, is_limited: !prev.is_limited}))} className={`w-10 h-5 rounded-full transition-all relative ${quizData.is_limited ? 'bg-rose-500' : 'bg-slate-300'}`}>
                  <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${quizData.is_limited ? 'left-6' : 'left-1'}`} />
                </button>
             </div>
             <p className="text-[9px] text-slate-400 font-bold leading-relaxed italic">Enable breathing &quot;LIMITED&quot; badge on cover.</p>
          </div>

          {/* 分类管理 (恢复) */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-black text-slate-400 tracking-widest flex items-center gap-2"><Folder size={14}/> Categories</span>
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
            <span className="text-[10px] font-black text-slate-400 tracking-widest block">Operational Tags</span>
            <div className="flex flex-wrap gap-2">
              {AVAILABLE_TAGS.map(tag => (
                <button key={tag.id} onClick={() => setQuizData(prev => ({...prev, tags: prev.tags.includes(tag.id) ? prev.tags.filter(t => t !== tag.id) : [...prev.tags, tag.id]}))} className={`px-4 py-2 rounded-xl text-[10px] font-bold border transition-all ${quizData.tags.includes(tag.id) ? `${tag.color} scale-105 shadow-sm` : 'bg-white border-slate-100 text-slate-500 hover:border-slate-300'}`}>{tag.icon} {tag.label}</button>
              ))}
            </div>
          </div>

          {/* 封面上传 (WebP 实时反馈) */}
          <div className="space-y-4">
            <span className="text-[10px] font-black text-slate-400 tracking-widest block">Cover Vision</span>
            <input type="file" accept="image/*" className="hidden" ref={fileInputRef} onChange={handleFileUpload} />
            <div onClick={() => !isUploading && fileInputRef.current?.click()} className={`relative aspect-video rounded-[36px] border-2 border-dashed flex items-center justify-center overflow-hidden cursor-pointer group transition-all ${quizData.cover_url ? 'border-transparent shadow-2xl' : 'bg-slate-50 border-slate-100 hover:border-slate-900'}`}>
              {isUploading ? (
                <div className="flex flex-col items-center gap-2">
                  <Loader2 className="animate-spin text-slate-400" />
                  <span className="text-[8px] font-black text-slate-400 tracking-widest">Optimizing WebP...</span>
                </div>
              ) : quizData.cover_url ? (
                <>
                  <img src={quizData.cover_url} className="w-full h-full object-cover" />
                  {quizData.is_limited && <div className="absolute top-4 right-4 bg-rose-500 text-white px-3 py-1 rounded-full text-[8px] font-black tracking-tighter animate-pulse shadow-lg flex items-center gap-1"><Zap size={10} fill="currentColor"/> Limited</div>}
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-all flex items-center justify-center">
                    <span className="text-white text-[9px] font-black tracking-[0.3em]">Update Media</span>
                  </div>
                </>
              ) : <UploadCloud className="text-slate-300" />}
            </div>
          </div>
        </aside>
      </main>

      {/* AI 起草：趋势 → 选题 → 生成 → 应用（逻辑在 lib/quizKit + lib/quizCompile + 三个 API 路由） */}
      <QuizAiWizard
        open={showAiWizard}
        onClose={() => setShowAiWizard(false)}
        onApply={handleAiApply}
      />

      {/* 批量草稿导入：多框 + 提交前校验（逻辑在 lib/quizPack.ts） */}
      <QuizBatchImport
        open={showImportModal}
        onClose={() => setShowImportModal(false)}
        onError={(msg) => showToast(msg, "error")}
        onImported={(count) => {
          showToast(`已创建 ${count} 篇草稿`, "success");
          setShowImportModal(false);
          setTimeout(() => router.push('/admin/quiz-studio'), 1000);
        }}
      />
    </div>
  );
}

export default function QuizStudioWrapper() {
  return (
    <Suspense fallback={<div className="h-screen flex items-center justify-center bg-[#F8F9FB] font-black italic text-slate-300 animate-pulse tracking-widest">Aura Loading...</div>}>
      <QuizEditorContent />
    </Suspense>
  );
}