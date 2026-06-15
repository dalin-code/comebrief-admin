'use client'

import Link from 'next/link'
import { useEffect, useState, useRef, useCallback, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { 
  ArrowLeft, Loader2, Image as ImageIcon, Dice5, Clock, 
  TrendingUp, Flame, Star, Plus, Minus, Send, Save, Calendar, Zap,
  Bold, Heading3, Quote, List, Sparkles, Upload, Check
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import ImageExtension from '@tiptap/extension-image'

const INITIAL_EDITORS = [
  { name: 'Daling Lin', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Daling&backgroundColor=b6e3f4' },
  { name: 'Nexus AI Lab', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Nexus&backgroundColor=ffd5dc' },
  { name: 'Alex Rivera', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Alex&backgroundColor=c0aede' },
  { name: 'Jordan Smith', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Jordan&backgroundColor=ffe0a3' },
  { name: 'Elena Rodriguez', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Elena&backgroundColor=9bd1d9' },
  { name: 'Marcus Chen', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Marcus&backgroundColor=f5b7a8' },
]

const INITIAL_LABELS = [
  { id: 'hot', name: 'Trending', icon: <Flame size={12} />, color: 'text-orange-500 bg-orange-50' },
  { id: 'top', name: 'Pinned', icon: <ArrowLeft className="rotate-90" size={12} />, color: 'text-blue-500 bg-blue-50' },
  { id: 'featured', name: 'Staff Pick', icon: <Star size={12} />, color: 'text-purple-500 bg-purple-50' },
  { id: 'new', name: 'Fresh', icon: <Zap size={12} />, color: 'text-emerald-500 bg-emerald-50' },
]

function EditorContentComponent() {
  const router = useRouter(); 
  const searchParams = useSearchParams();
  const articleId = searchParams.get('id');
  
  const [isMounted, setIsMounted] = useState(false);
  const [notice, setNotice] = useState<{msg: string, type: 'success' | 'error'} | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [title, setTitle] = useState('');
  const titleRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (titleRef.current) {
      titleRef.current.style.height = 'auto';
      titleRef.current.style.height = titleRef.current.scrollHeight + 'px';
    }
  }, [title]);
  
  const [excerpt, setExcerpt] = useState('');
  const [coverUrl, setCoverUrl] = useState('');
  const [coverUrlShare, setCoverUrlShare] = useState('');
  const [authorName, setAuthorName] = useState(INITIAL_EDITORS[0].name);
  const [authorAvatar, setAuthorAvatar] = useState(INITIAL_EDITORS[0].avatar);
  
  const [postStatus, setPostStatus] = useState<'draft' | 'published' | 'scheduled'>('published');
  const [scheduledAt, setScheduledAt] = useState('');

  const [availableCats, setAvailableCats] = useState<string[]>([]);
  const [selectedCats, setSelectedCats] = useState<string[]>([]);
  const [availableLabels] = useState(INITIAL_LABELS);
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  
  const [isEditingCats, setIsEditingCats] = useState(false);
  const [newCatInput, setNewCatInput] = useState('');
  
  // 🚀 核心正位：精简物理直调本地图片所用的两个 Input 引用
  const coverFileInputRef = useRef<HTMLInputElement>(null);
  const hasLoadedRef = useRef(false);

  const showToast = useCallback((msg: string, type: 'success' | 'error') => {
    setNotice({ msg, type });
    setTimeout(() => setNotice(null), 3500);
  }, []);

  // 🚀 核心优化 3：图片单张直传 Supabase 存储池核心逻辑（自动 WebP 压缩 + 双投喂）
  const uploadSingleImage = async (file: File) => {
    const baseName = file.name.replace(/\.[^/.]+$/, "");
    const fileStamp = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    
    // 1. 上传高清原图卡片（投喂社交盲抓）
    const originalExt = file.name.split('.').pop() || 'jpg';
    const originalFilePath = `news/${fileStamp}_original.${originalExt}`;
    const { error: originalError } = await supabase.storage
      .from('images')
      .upload(originalFilePath, file, { cacheControl: '3600', upsert: true });
    
    if (originalError) throw originalError;

    // 2. 上传轻量 WebP（投喂前台极速爆发）
    const webpFile = await new Promise<File>((resolve, reject) => {
      const img = new Image();
      img.src = URL.createObjectURL(file);
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Canvas context failure'));
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((blob) => {
          if (blob) resolve(new File([blob], `${baseName}.webp`, { type: 'image/webp' }));
          else reject(new Error('WebP compression failed'));
        }, 'image/webp', 0.85);
      };
      img.onerror = () => reject(new Error('Image load failed'));
    });

    const webpFilePath = `news/${fileStamp}.webp`;
    const { error: webpError } = await supabase.storage
      .from('images')
      .upload(webpFilePath, webpFile, { cacheControl: '3600', upsert: true });
    
    if (webpError) throw webpError;

    const originalUrl = supabase.storage.from('images').getPublicUrl(originalFilePath).data.publicUrl;
    const webpUrl = supabase.storage.from('images').getPublicUrl(webpFilePath).data.publicUrl;

    return { originalUrl, webpUrl };
  };

  // 封面直接上传拦截器
  const handleCoverUploadDirect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const urls = await uploadSingleImage(file);
      setCoverUrl(urls.webpUrl);
      setCoverUrlShare(urls.originalUrl);
      showToast('高奢视觉封面并轨成功！', 'success');
    } catch (err: any) {
      showToast(`封面上传失败: ${err.message}`, 'error');
    } finally {
      setUploading(false);
    }
  };

  const editor = useEditor({
    extensions: [
      StarterKit,
      ImageExtension.configure({ inline: true, allowBase64: true })
    ],
    content: '',
    immediatelyRender: false, 
    editorProps: { 
      attributes: { 
        class: 'prose prose-slate max-w-none min-h-[600px] p-10 md:p-16 outline-none bg-white leading-relaxed text-left' 
      }
    }
  });

  useEffect(() => {
    setIsMounted(true);
    
    const initEditorAndArticle = async () => {
      try {
        const { data: catData } = await supabase
          .from('categories')
          .select('name')
          .order('created_at', { ascending: true });
        
        let currentPool = catData && catData.length > 0 
          ? catData.map((c: any) => c.name) 
          : ['AI', 'Tech', 'Gaming'];

        if (articleId && editor && !hasLoadedRef.current) {
          hasLoadedRef.current = true;
          const { data, error } = await supabase.from('articles').select('*').eq('id', articleId).single();
          if (error) throw error;
          if (data) {
            setTitle(data.title || '');
            setExcerpt(data.excerpt || '');
            setCoverUrl(data.cover_url || '');
            setCoverUrlShare(data.cover_url_share || '');
            setAuthorName(data.author_name || INITIAL_EDITORS[0].name);
            setAuthorAvatar(data.author_avatar || INITIAL_EDITORS[0].avatar);
            if (data.status) setPostStatus(data.status);
            if (data.scheduled_at) {
              const localDate = new Date(data.scheduled_at);
              const offset = localDate.getTimezoneOffset() * 60000;
              setScheduledAt(new Date(localDate.getTime() - offset).toISOString().slice(0, 16));
            }
            
            if (data.category) {
              if (!currentPool.includes(data.category)) currentPool.push(data.category);
              setSelectedCats([data.category]);
            }
            if (data.labels && Array.isArray(data.labels)) setSelectedLabels(data.labels);
            
            setTimeout(() => {
              editor.commands.setContent(data.content_html || '');
            }, 50);
          }
        } else if (!articleId && currentPool.length > 0) {
          setSelectedCats([currentPool[0]]);
        }
        setAvailableCats(currentPool);
      } catch (e: any) {
        console.error('总控室拉取失败:', e.message);
      }
    };

    if (editor) {
      initEditorAndArticle();
    }
  }, [articleId, editor]);

  const handleAutoExtractExcerpt = () => {
    if (!editor) return;
    const text = editor.getText();
    if (!text.trim()) {
      showToast('正文空空如也，无法提炼脉络！', 'error');
      return;
    }
    const cleanText = text.replace(/\s+/g, ' ').trim();
    setExcerpt(cleanText.slice(0, 130) + (cleanText.length > 130 ? '...' : ''));
    showToast('已全自动为你打包好高精度摘要！', 'success');
  };

  const randomizeAuthor = () => {
    const randomIdx = Math.floor(Math.random() * INITIAL_EDITORS.length);
    setAuthorName(INITIAL_EDITORS[randomIdx].name);
    setAuthorAvatar(INITIAL_EDITORS[randomIdx].avatar);
    showToast("已随机切换编辑身份", "success");
  };

  const toggleCat = (cat: string) => {
    setSelectedCats([cat]);
  };
  const toggleLabel = (id: string) => {
    setSelectedLabels(prev => prev.includes(id) ? prev.filter(l => l !== id) : [...prev, id]);
  };

  const handleAddNewCatClick = () => {
    const trimmed = newCatInput.trim();
    if (!trimmed) return;
    if (availableCats.includes(trimmed)) {
      showToast('该话题分类已存在', 'error');
      return;
    }
    setAvailableCats(prev => [...prev, trimmed]);
    setSelectedCats([trimmed]); 
    setNewCatInput('');
    showToast('新话题就绪', 'success');
  };

  const handleSave = async () => {
    if (!title.trim()) {
      showToast('请输入文章标题', 'error');
      return;
    }

    if (postStatus === 'scheduled') {
      if (!scheduledAt) {
        showToast('请选择定时发送的具体时间', 'error');
        return;
      }
      if (new Date(scheduledAt).getTime() <= Date.now()) {
        showToast('定时发送时间必须晚于当前时间', 'error');
        return;
      }
    }

    setSaving(true);
    try {
      if (selectedCats?.length > 0) {
        for (const cat of selectedCats) {
          const { data: checkData } = await supabase.from('categories').select('name').eq('name', cat);
          if (!checkData || checkData.length === 0) {
            await supabase.from('categories').insert([{ name: cat }]);
          }
        }
      }

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        showToast('登录失效，保存副本中...', 'error');
        return;
      }

      const currentIsoTime = new Date().toISOString();
      const payload: any = {
        title,
        excerpt,
        cover_url: coverUrl,
        cover_url_share: coverUrlShare,
        author_name: authorName,
        author_avatar: authorAvatar,
        category: selectedCats[0] || 'Uncategorized',
        labels: selectedLabels,
        status: postStatus, 
        content_html: editor?.getHTML() || '',
        scheduled_at: postStatus === 'scheduled' ? new Date(scheduledAt).toISOString() : null,
      };
      
      if (articleId) {
        if (postStatus === 'published') {
          payload.published_at = currentIsoTime;
        }
        const { error } = await supabase.from('articles').update(payload).eq('id', articleId);
        if (error) throw error;
        showToast('文章大动脉修改同步成功！', 'success');
        setTimeout(() => router.push('/admin/trends'), 1200);
      } else {
        const slug = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).substring(2, 7)}`;
        const { error } = await supabase.from('articles').insert({ 
          ...payload, 
          slug, 
          published_at: postStatus === 'published' ? currentIsoTime : null 
        });
        if (error) throw error;
        showToast('新热点文章已全盘发布上线！🚀', 'success');
        setTimeout(() => router.push('/admin/trends'), 1200);
      }
    } catch (e: any) {
      showToast(`操作失败: ${e.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!isMounted) return null;

  const getSubmitButtonConfig = () => {
    if (postStatus === 'draft') return { label: '保存为草稿', icon: <Save size={14} /> };
    if (postStatus === 'scheduled') return { label: '排期定时发送', icon: <Calendar size={14} /> };
    return { label: articleId ? '更新文章 (Update)' : '发布上线 (Deploy)', icon: <Send size={14} /> };
  };

  const btnConfig = getSubmitButtonConfig();

  return (
    <div className="min-h-screen bg-[#FBFBFC] text-slate-900 font-sans selection:bg-indigo-100">
      {/* 🚀 顶部导航 */}
      <nav className="sticky top-0 z-[60] bg-white/90 backdrop-blur-3xl border-b border-slate-100 px-8 py-5 flex justify-between items-center">
        <div className="flex items-center gap-6">
          <Link href="/admin/trends" className="w-10 h-10 flex items-center justify-center rounded-2xl bg-white border border-slate-100 hover:shadow-xl transition-all"><ArrowLeft size={18} /></Link>
          <div className="hidden sm:block">
            <h1 className="text-lg font-black italic uppercase leading-none tracking-tighter text-left">ComeBrief Studio</h1>
            <p className="text-[8px] font-black text-slate-400 uppercase tracking-[0.3em] mt-1 italic text-left">内容创作指挥部</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
           <button 
             onClick={handleSave}
             disabled={saving}
             className={`h-12 px-10 text-white rounded-2xl font-black text-[10px] uppercase shadow-2xl bg-slate-900 flex items-center gap-3 transition-all ${saving ? 'opacity-50 cursor-not-allowed' : 'hover:scale-105'}`}>
             {saving ? <Loader2 size={14} className="animate-spin" /> : btnConfig.icon} 
             {btnConfig.label}
           </button>
        </div>
      </nav>

      {/* 浮动通知 */}
      {notice && (
        <div className={`fixed top-24 left-1/2 -translate-x-1/2 z-[100] px-8 py-4 rounded-3xl shadow-2xl font-black text-[10px] uppercase tracking-widest animate-in fade-in slide-in-from-top-4 ${notice.type === 'success' ? 'bg-slate-900 text-white' : 'bg-rose-500 text-white'}`}>
          {notice.msg}
        </div>
      )}

      <div className="max-w-[1440px] mx-auto px-8 py-12 grid grid-cols-1 lg:grid-cols-12 gap-12">
        {/* 左侧：正文编辑区 */}
        <div className="lg:col-span-8 space-y-10">
          <div className="space-y-6">
            <textarea 
              ref={titleRef}
              value={title} 
              onChange={e => setTitle(e.target.value)} 
              placeholder="文章标题 (Headline Matrix)..." 
              rows={1} 
              className="w-full text-4xl md:text-3xl font-black text-slate-900 bg-transparent border-none outline-none italic tracking-tighter placeholder:text-slate-200 resize-none overflow-hidden text-left" 
              style={{ minHeight: '60px' }}
            />
            
            <div className="space-y-2">
              <div className="flex justify-between items-center px-4">
                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">文章摘要 (EXCERPT)</label>
                <button 
                  type="button" 
                  onClick={handleAutoExtractExcerpt}
                  className="flex items-center gap-1.5 text-[9px] font-black uppercase text-indigo-500 hover:text-indigo-600 bg-indigo-50 px-3 py-1 rounded-full transition-all hover:scale-105"
                >
                  <Sparkles size={11}/> AI 一键生成摘要
                </button>
              </div>
              <textarea 
                value={excerpt} 
                onChange={e => setExcerpt(e.target.value)}
                placeholder="在此输入简短的内容摘要，或者点击上方 AI 自动智能提取..."
                className="w-full p-8 bg-white rounded-[32px] border border-slate-100 outline-none text-sm text-slate-500 font-medium leading-relaxed shadow-sm focus:border-indigo-200 transition-all resize-none h-28"
              />
            </div>
          </div>
          
          {/* 🚀 铁血重装：彻底根除遮挡、自带防穿透白底的富文本控制中心 */}
          <div className="bg-white rounded-[48px] border border-slate-100 shadow-2xl overflow-hidden min-h-[1000px] flex flex-col">
            {editor && (
              <div className="flex flex-wrap items-center gap-1 p-4 border-b border-slate-200 bg-slate-50/90 sticky top-[80px] z-40 backdrop-blur-md w-full">
                <button
                  type="button"
                  onClick={() => editor.chain().focus().toggleBold().run()}
                  className={`p-2 rounded-xl transition-all ${editor.isActive('bold') ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-200/60'}`}
                  title="加粗"
                >
                  <Bold size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
                  className={`p-2 rounded-xl transition-all ${editor.isActive('heading', { level: 3 }) ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-200/60'}`}
                  title="H3 标题"
                >
                  <Heading3 size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => editor.chain().focus().toggleBulletList().run()}
                  className={`p-2 rounded-xl transition-all ${editor.isActive('bulletList') ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-200/60'}`}
                  title="无序列表"
                >
                  <List size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => editor.chain().focus().toggleBlockquote().run()}
                  className={`p-2 rounded-xl transition-all ${editor.isActive('blockquote') ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-200/60'}`}
                  title="引用块"
                >
                  <Quote size={16} />
                </button>
                
                <div className="w-[1px] h-4 bg-slate-200 mx-2" />

                {/* 富文本内部点击直调本地上传 */}
                <label className="p-2 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all cursor-pointer" title="直接上传并插入本地图片">
                  <ImageIcon size={16} />
                  <input 
                    type="file" 
                    className="hidden" 
                    accept="image/*" 
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      showToast('正在向云端输送图片流...', 'success');
                      try {
                        const urls = await uploadSingleImage(file);
                        editor.chain().focus().setImage({ src: urls.webpUrl }).run();
                        showToast('图片成功无缝并轨插入正文！', 'success');
                      } catch (err: any) {
                        showToast(`插入失败: ${err.message}`, 'error');
                      }
                    }}
                  />
                </label>
              </div>
            )}
            <div className="flex-1 relative">
              <EditorContent editor={editor} />
            </div>
          </div>
        </div>

        {/* 右侧：配置看板 */}
        <aside className="lg:col-span-4 space-y-8">
          {/* 发布策略中心 */}
          <section className="bg-white rounded-[40px] p-8 border border-slate-100 shadow-sm transition-all hover:shadow-md">
            <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-400 mb-6 italic flex items-center gap-2 text-left">发布策略 (Strategy) <Clock size={14}/></h3>
            <div className="flex flex-col gap-5">
              <div className="grid grid-cols-3 gap-2 p-1.5 bg-slate-50 rounded-2xl border border-slate-100">
                {(['draft', 'published', 'scheduled'] as const).map((status) => (
                  <button
                    key={status}
                    type="button"
                    onClick={() => setPostStatus(status)}
                    className={`py-3 rounded-xl text-[9px] font-black uppercase tracking-wider transition-all ${postStatus === status ? 'bg-slate-900 text-white shadow-md scale-102' : 'text-slate-400 hover:text-slate-600'}`}
                  >
                    {status === 'draft' ? '草稿' : status === 'published' ? '发布' : '定时'}
                  </button>
                ))}
              </div>

              {postStatus === 'scheduled' && (
                <div className="space-y-2 p-5 bg-indigo-50/40 rounded-3xl border border-indigo-50 animate-in slide-in-from-top-3 duration-200 text-left">
                  <label className="text-[8px] font-black uppercase tracking-widest text-indigo-500 block ml-1">选择海外发射时间 (Local Time)</label>
                  <input
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={(e) => setScheduledAt(e.target.value)}
                    className="w-full px-4 py-3 bg-white border border-slate-100 text-xs font-bold rounded-xl text-slate-700 outline-none focus:border-indigo-500 transition-all shadow-inner"
                  />
                </div>
              )}
            </div>
          </section>
          
          {/* 运营配置 */}
          <section className="bg-white rounded-[40px] p-8 border border-slate-100 shadow-sm transition-all hover:shadow-md">
             <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-400 mb-8 italic flex items-center gap-2 text-left">运营配置 <TrendingUp size={14}/></h3>
             <div className="grid grid-cols-2 gap-4">
               {availableLabels.map(label => (
                 <button 
                   type="button"
                   key={label.id} 
                   onClick={() => toggleLabel(label.id)} 
                   className={`flex items-center justify-center gap-2 px-4 py-5 rounded-[28px] text-[9px] font-black uppercase transition-all border ${selectedLabels.includes(label.id) ? `${label.color} border-current shadow-lg scale-95` : 'bg-slate-50 text-slate-400 border-transparent hover:bg-slate-100'}`}
                 >
                   {label.icon} {label.name}
                 </button>
               ))}
             </div>
          </section>

          {/* 话题矩阵 (Categories) */}
          <section className="bg-white rounded-[40px] p-8 border border-slate-100 shadow-sm">
             <div className="flex justify-between items-center mb-8">
               <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-400 italic text-left">话题矩阵</h3>
               <button type="button" onClick={() => setIsEditingCats(!isEditingCats)} className="text-slate-400 hover:text-indigo-600 transition-colors"><Plus size={16}/></button>
             </div>
             <div className="flex flex-wrap gap-2 mb-8 justify-start">
                {availableCats.map(cat => (
                  <div key={cat} className="relative group">
                    <button 
                      type="button"
                      onClick={() => toggleCat(cat)} 
                      className={`px-5 py-2.5 rounded-[18px] text-[9px] font-black uppercase tracking-widest transition-all ${selectedCats.includes(cat) ? 'bg-slate-900 text-white shadow-xl scale-105' : 'bg-slate-50 text-slate-400 hover:bg-slate-100'}`}
                    >
                      <span>{cat}</span>
                    </button>
                    {isEditingCats && (
                      <button 
                        type="button"
                        onClick={async () => {
                          await supabase.from('categories').delete().eq('name', cat);
                          setAvailableCats(prev => prev.filter(c => c !== cat));
                          setSelectedCats(prev => prev.filter(c => c !== cat));
                        }} 
                        className="absolute -top-1 -right-1 w-5 h-5 bg-rose-500 text-white rounded-full flex items-center justify-center shadow-lg hover:scale-110 z-10"
                      >
                        <Minus size={10}/>
                      </button>
                    )}
                  </div>
                ))}
             </div>
             {isEditingCats && (
               <div className="flex gap-2 animate-in slide-in-from-top-2">
                 <input 
                   value={newCatInput} 
                   onChange={e => setNewCatInput(e.target.value)} 
                   onKeyDown={e => e.key === 'Enter' && handleAddNewCatClick()}
                   placeholder="新增话题..." 
                   className="flex-1 px-5 py-3 bg-slate-50 rounded-2xl text-[10px] font-black outline-none border-transparent focus:border-indigo-500 transition-all" 
                 />
                 <button type="button" onClick={handleAddNewCatClick} className="w-12 h-12 bg-emerald-500 text-white rounded-2xl flex items-center justify-center shadow-md"><Check size={20}/></button>
               </div>
             )}
          </section>

          {/* 视觉封面 (Cover) —— 🚀 核心优化 3：砍掉沉重资源库，点击直接呼唤原生选择框 */}
          <section className="bg-white rounded-[40px] p-8 border border-slate-100 shadow-sm group">
            <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-400 mb-6 italic text-left">视觉封面 (Cover)</h3>
            {coverUrl ? (
              <div className="relative rounded-[32px] overflow-hidden aspect-video border-4 border-slate-50 shadow-2xl group transition-all">
                <img src={coverUrl} className="w-full h-full object-cover" alt="cover" />
                <div className="absolute inset-0 bg-slate-900/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3">
                  <button 
                    type="button" 
                    onClick={() => { setCoverUrl(''); setCoverUrlShare(''); }} 
                    className="bg-white text-slate-900 px-6 py-2 rounded-full text-[9px] font-black uppercase shadow-xl hover:scale-110 active:scale-95 transition-all"
                  >
                    移除
                  </button>
                  <button 
                    type="button" 
                    onClick={() => coverFileInputRef.current?.click()} 
                    className="bg-cyan-500 text-white px-6 py-2 rounded-full text-[9px] font-black uppercase shadow-xl hover:scale-110 active:scale-95 transition-all"
                  >
                    {uploading ? "传输中..." : "更换"}
                  </button>
                </div>
              </div>
            ) : (
              <button 
                type="button" 
                onClick={() => coverFileInputRef.current?.click()} 
                className="w-full aspect-video border-4 border-dashed border-slate-100 rounded-[32px] flex flex-col items-center justify-center gap-4 bg-slate-50/50 hover:bg-white hover:border-cyan-500 transition-all"
              >
                {uploading ? (
                  <Loader2 className="animate-spin text-cyan-500" size={32} />
                ) : (
                  <>
                    <Upload size={32} className="text-slate-200" />
                    <span className="text-[9px] font-black uppercase text-slate-300 italic">点击直调本地图片</span>
                  </>
                )}
              </button>
            )}
            <input 
              type="file" 
              ref={coverFileInputRef} 
              className="hidden" 
              accept="image/*" 
              onChange={handleCoverUploadDirect} 
            />
          </section>

          {/* 发布身份 */}
          <section className="bg-white rounded-[40px] p-8 border border-slate-100 shadow-sm">
             <div className="flex justify-between items-center mb-8">
               <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-400 italic text-left">发布身份</h3>
               <button type="button" onClick={randomizeAuthor} className="p-2 bg-indigo-50 text-indigo-600 rounded-xl hover:rotate-180 transition-all duration-500"><Dice5 size={18} /></button>
             </div>
             <div className="flex items-center gap-5 p-6 bg-slate-50 rounded-[32px] border border-slate-100 text-left">
                <img src={authorAvatar} className="w-16 h-16 rounded-full border-4 border-white shadow-lg bg-white" alt="avatar" />
                <div className="flex-1 overflow-hidden">
                   <p className="font-black text-slate-900 text-sm truncate">{authorName}</p>
                   <p className="text-[8px] font-black text-indigo-500 uppercase tracking-widest mt-1 italic">Verified Partner</p>
                </div>
             </div>
          </section>
        </aside>
      </div>
    </div>
  )
}

export default function UltimateFixedEditor() {
  return (
    <Suspense fallback={<div className="h-screen flex items-center justify-center bg-white font-black italic uppercase text-slate-300 animate-pulse tracking-[0.5em]">Synchronizing Studio Matrix...</div>}>
      <EditorContentComponent />
    </Suspense>
  )
}