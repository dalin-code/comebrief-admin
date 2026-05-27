'use client'

import Link from 'next/link'
import { useEffect, useState, useRef, useCallback, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
// 🚀 完整导入所有图标，确保无一遗漏
import { 
  ArrowLeft, X, Loader2, Check, Upload, Image as ImageIcon, Dice5, Clock, 
  TrendingUp, Flame, Star, Plus, Minus, Send, Save, Calendar, Zap
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import ImageExtension from '@tiptap/extension-image'

// --- ⚙️ 初始配置 (外部静态数据) ---
const INITIAL_EDITORS = [
  { name: 'Daling', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Dalin' },
  { name: 'Nexus AI Lab', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Nexus' },
  { name: 'Alex Rivera', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Alex' },
  { name: 'Jordan Smith', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Jordan' },
  { name: 'Elena Rodriguez', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Elena' },
]

const INITIAL_LABELS = [
  { id: 'hot', name: 'Trending', icon: <Flame size={12} />, color: 'text-orange-500 bg-orange-50' },
  { id: 'top', name: 'Pinned', icon: <ArrowLeft className="rotate-90" size={12} />, color: 'text-blue-500 bg-blue-50' },
  { id: 'featured', name: 'Staff Pick', icon: <Star size={12} />, color: 'text-purple-500 bg-purple-50' },
  { id: 'new', name: 'Fresh', icon: <Zap size={12} />, color: 'text-emerald-500 bg-emerald-50' },
]

const INITIAL_CATS = ['AI', 'Tech', 'Gaming', 'Travel', 'Home Decor', 'Learning'];

function EditorContentComponent() {
  const router = useRouter(); 
  const searchParams = useSearchParams();
  const articleId = searchParams.get('id');
  
  // --- 🎨 状态管理 ---
  const [isMounted, setIsMounted] = useState(false);
  const [notice, setNotice] = useState<{msg: string, type: 'success' | 'error'} | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showAssetLibrary, setShowAssetLibrary] = useState(false);

  // 内容核心字段
  const [title, setTitle] = useState('');
  const titleRef = useRef<HTMLTextAreaElement>(null);

  // 初始化或更新 title 时自动调整高度
  useEffect(() => {
    if (titleRef.current) {
      titleRef.current.style.height = 'auto';
      titleRef.current.style.height = titleRef.current.scrollHeight + 'px';
    }
  }, [title]);
  
  const [excerpt, setExcerpt] = useState('');
  const [coverUrl, setCoverUrl] = useState('');
  const [authorName, setAuthorName] = useState(INITIAL_EDITORS[0].name);
  const [authorAvatar, setAuthorAvatar] = useState(INITIAL_EDITORS[0].avatar);
  
  // 🚀 新增发布与定时状态管理
  const [postStatus, setPostStatus] = useState<'draft' | 'published' | 'scheduled'>('published');
  const [scheduledAt, setScheduledAt] = useState('');

  // 分类与标签管理 (支持多选与增删)
  const [availableCats, setAvailableCats] = useState(INITIAL_CATS);
  const [selectedCats, setSelectedCats] = useState<string[]>(['AI']);
  const [availableLabels, setAvailableLabels] = useState(INITIAL_LABELS);
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  
  // 交互辅助
  const [isEditingCats, setIsEditingCats] = useState(false);
  const [newCatInput, setNewCatInput] = useState('');
  const [assets, setAssets] = useState<any[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasLoadedRef = useRef(false);

  // --- 🛠️ 核心功能逻辑 ---

  const showToast = useCallback((msg: string, type: 'success' | 'error') => {
    setNotice({ msg, type });
    setTimeout(() => setNotice(null), 3500);
  }, []);

  // 1. 随机作者骰子逻辑
  const randomizeAuthor = () => {
    const randomIdx = Math.floor(Math.random() * INITIAL_EDITORS.length);
    setAuthorName(INITIAL_EDITORS[randomIdx].name);
    setAuthorAvatar(INITIAL_EDITORS[randomIdx].avatar);
    showToast("已随机切换编辑身份", "success");
  };

  // 2. 多选切换逻辑
  const toggleCat = (cat: string) => {
    setSelectedCats(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]);
  };
  const toggleLabel = (id: string) => {
    setSelectedLabels(prev => prev.includes(id) ? prev.filter(l => l !== id) : [...prev, id]);
  };

  // 3. 批量上传图片到 Supabase (自动转换为 WebP)
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const uploadPromises = Array.from(files).map(async (file) => {
        const webpFile = await new Promise<File>((resolve, reject) => {
          const img = new Image();
          img.src = URL.createObjectURL(file);
          img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) return reject(new Error('Canvas context not available'));
            ctx.drawImage(img, 0, 0);
            canvas.toBlob(
              (blob) => {
                if (blob) {
                  const originalName = file.name.replace(/\.[^/.]+$/, "");
                  resolve(new File([blob], `${originalName}.webp`, { type: 'image/webp' }));
                } else {
                  reject(new Error('WebP 转换失败'));
                }
              },
              'image/webp',
              0.85
            );
          };
          img.onerror = () => reject(new Error('图片加载失败'));
        });

        const fileName = `${Math.random().toString(36).substring(2)}.webp`;
        const filePath = `news/${fileName}`;
        const { error } = await supabase.storage.from('images').upload(filePath, webpFile);
        if (error) throw error;
        return fileName;
      });
      await Promise.all(uploadPromises);
      showToast(`成功同步 ${files.length} 张资源图片`, 'success');
      loadAssets(); 
    } catch (err: any) {
      showToast(`上传失败: ${err.message}`, 'error');
    } finally {
      setUploading(false);
    }
  };

  const loadAssets = useCallback(async () => {
    const { data } = await supabase.storage.from('images').list('news', { sortBy: { column: 'created_at', order: 'desc' } });
    if (data) setAssets(data.filter(f => f.name !== '.emptyFolderPlaceholder'));
  }, []);

  // 4. 重构后的核心保存/定时发布逻辑 —— 🚀 已完全闭合且加上路径限制防护锁
  const handleSave = async () => {
    if (!title.trim()) {
      showToast('请输入文章标题', 'error');
      return;
    }

    // 🚀 安全验证：如果是定时发布，必须选择未来的时间
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
      const { data: { session } } = await supabase.auth.getSession();
      
      if (!session) {
        showToast('登录失效，正在为你保存草稿并跳转登录...', 'error');
        // @ts-ignore
        localStorage.setItem('cb_draft_title', title);
        // @ts-ignore
        localStorage.setItem('cb_draft_content', editor?.getHTML() || '');
        
        setTimeout(() => {
          // 🎯 核心隔离看门狗：只允许在管理端路径触发强转
          if (typeof window !== 'undefined' && window.location.pathname.startsWith('/admin')) {
            window.location.href = `/admin/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`;
          }
        }, 2000);
        return;
      }

      // 组装最新发布状态控制
      const payload: any = {
        title,
        excerpt,
        cover_url: coverUrl,
        author_name: authorName,
        author_avatar: authorAvatar,
        category: selectedCats[0] || 'Uncategorized',
        labels: selectedLabels,
        status: postStatus, 
        // @ts-ignore
        content_html: editor?.getHTML() || '',
        scheduled_at: postStatus === 'scheduled' ? new Date(scheduledAt).toISOString() : null,
      };
      
      if (articleId) {
        const { error } = await supabase.from('articles').update(payload).eq('id', articleId);
        if (error) throw error;
        showToast(postStatus === 'draft' ? '草稿更新成功！' : postStatus === 'scheduled' ? '定时排期更新成功！' : '文章发布成功！', 'success');
        setTimeout(() => router.push('/admin/trends'), 1200);
      } else {
        const slug = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).substring(2, 7)}`;
        const { error } = await supabase.from('articles').insert({ 
          ...payload, 
          slug, 
          published_at: postStatus === 'published' ? new Date().toISOString() : null 
        });
        if (error) throw error;
        showToast(postStatus === 'draft' ? '草稿已成功保存！' : postStatus === 'scheduled' ? '定时发送排期成功！' : '文章已正式发布上线！', 'success');
        setTimeout(() => router.push('/admin/trends'), 1200);
      }
    } catch (e: any) {
      showToast(`操作失败: ${e.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  // --- Tiptap 核心编辑器初始化 ---
  const editor = useEditor({
    extensions: [
      StarterKit,
      ImageExtension.configure({
        inline: true,
        allowBase64: true,
      })
    ],
    content: '',
    immediatelyRender: false, 
    editorProps: { 
      attributes: { 
        class: 'prose prose-slate max-w-none min-h-[600px] p-10 md:p-24 outline-none bg-white leading-relaxed' 
      },
      handlePaste: (view, event, slice) => {
        const items = Array.from(event.clipboardData?.items || []);
        for (const item of items) {
          if (item.type.indexOf('image') === 0) {
            event.preventDefault();
            const file = item.getAsFile();
            if (!file) continue;
            
            const uploadImage = async () => {
              try {
                setUploading(true);
                const webpFile = await new Promise<File>((resolve, reject) => {
                  const img = new Image();
                  img.src = URL.createObjectURL(file);
                  img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.width;
                    canvas.height = img.height;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) return reject(new Error('Canvas context not available'));
                    
                    ctx.drawImage(img, 0, 0);
                    canvas.toBlob(
                      (blob) => {
                        if (blob) {
                          const originalName = file.name.replace(/\.[^/.]+$/, "");
                          resolve(new File([blob], `${originalName}.webp`, { type: 'image/webp' }));
                        } else {
                          reject(new Error('WebP 转换失败'));
                        }
                      },
                      'image/webp',
                      0.85
                    );
                  };
                  img.onerror = () => reject(new Error('图片加载失败'));
                });

                const fileName = `${Math.random().toString(36).substring(2)}.webp`;
                const filePath = `news/${fileName}`;
                const { error } = await supabase.storage.from('images').upload(filePath, webpFile);
                
                if (error) throw error;
                const { data } = supabase.storage.from('images').getPublicUrl(filePath);
                
                if (data.publicUrl) {
                  const node = view.state.schema.nodes.image.create({ src: data.publicUrl });
                  const transaction = view.state.tr.replaceSelectionWith(node);
                  view.dispatch(transaction);
                  showToast('图片上传成功', 'success');
                }
              } catch (err: any) {
                showToast(`图片上传失败: ${err.message}`, 'error');
              } finally {
                setUploading(false);
              }
            };
            uploadImage();
            return true;
          }
        }
        return false;
      },
      handleDrop: (view, event, slice, moved) => {
        if (!moved && event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]) {
          const file = event.dataTransfer.files[0];
          if (file.type.indexOf('image') === 0) {
            event.preventDefault();
            
            const uploadImage = async () => {
              try {
                setUploading(true);
                const webpFile = await new Promise<File>((resolve, reject) => {
                  const img = new Image();
                  img.src = URL.createObjectURL(file);
                  img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.width;
                    canvas.height = img.height;
                    const ctx = canvas.getContext('2d');
                    if (!ctx) return reject(new Error('Canvas context not available'));
                    
                    ctx.drawImage(img, 0, 0);
                    canvas.toBlob(
                      (blob) => {
                        if (blob) {
                          const originalName = file.name.replace(/\.[^/.]+$/, "");
                          resolve(new File([blob], `${originalName}.webp`, { type: 'image/webp' }));
                        } else {
                          reject(new Error('WebP 转换失败'));
                        }
                      },
                      'image/webp',
                      0.85
                    );
                  };
                  img.onerror = () => reject(new Error('图片加载失败'));
                });

                const fileName = `${Math.random().toString(36).substring(2)}.webp`;
                const filePath = `news/${fileName}`;
                const { error } = await supabase.storage.from('images').upload(filePath, webpFile);
                
                if (error) throw error;
                const { data } = supabase.storage.from('images').getPublicUrl(filePath);
                
                if (data.publicUrl) {
                  const coordinates = view.posAtCoords({ left: event.clientX, top: event.clientY });
                  const node = view.state.schema.nodes.image.create({ src: data.publicUrl });
                  const transaction = view.state.tr.insert(coordinates?.pos || view.state.selection.to, node);
                  view.dispatch(transaction);
                  showToast('图片上传成功', 'success');
                }
              } catch (err: any) {
                showToast(`图片上传失败: ${err.message}`, 'error');
              } finally {
                setUploading(false);
              }
            };
            uploadImage();
            return true;
          }
        }
        return false;
      }
    }
  });

  // 强制挂载与数据加载保护
  useEffect(() => {
    setIsMounted(true);
    loadAssets();
    
    if (articleId && editor && !hasLoadedRef.current) {
      hasLoadedRef.current = true;
      const loadArticle = async () => {
        try {
          const { data, error } = await supabase.from('articles').select('*').eq('id', articleId).single();
          if (error) throw error;
          if (data) {
            setTitle(data.title || '');
            setExcerpt(data.excerpt || '');
            setCoverUrl(data.cover_url || '');
            setAuthorName(data.author_name || INITIAL_EDITORS[0].name);
            setAuthorAvatar(data.author_avatar || INITIAL_EDITORS[0].avatar);
            if (data.status) setPostStatus(data.status);
            if (data.scheduled_at) {
              // 转换为本地 datetime-local 格式所需的字符串
              const localDate = new Date(data.scheduled_at);
              const offset = localDate.getTimezoneOffset() * 60000;
              const localISOTime = new Date(localDate.getTime() - offset).toISOString().slice(0, 16);
              setScheduledAt(localISOTime);
            }
            if (data.category) setSelectedCats([data.category]);
            if (data.labels && Array.isArray(data.labels)) setSelectedLabels(data.labels);
            if (data.content_html) {
              editor.commands.setContent(data.content_html);
            }
          }
        } catch (e: any) {
          showToast(`加载文章失败: ${e.message}`, 'error');
        }
      };
      loadArticle();
    }
  }, [loadAssets, articleId, editor]);

  if (!isMounted) return null;

  // 根据当前右侧选中的状态，动态决定顶部大按钮的文案与图标
  const getSubmitButtonConfig = () => {
    if (postStatus === 'draft') return { label: articleId ? '保存草稿修改' : '保存为草稿 (Draft)', icon: <Save size={14} /> };
    if (postStatus === 'scheduled') return { label: articleId ? '更新定时发送' : '安排定时发送 (Schedule)', icon: <Calendar size={14} /> };
    return { label: articleId ? '更新文章 (Update)' : '发布上线 (Deploy)', icon: <Send size={14} /> };
  };

  const btnConfig = getSubmitButtonConfig();

  return (
    <div className="min-h-screen bg-[#FBFBFC] text-slate-900 font-sans selection:bg-indigo-100">
      
      {/* 🚀 顶部导航：AI 按钮已被干净利落地移除 */}
      <nav className="sticky top-0 z-[60] bg-white/90 backdrop-blur-3xl border-b border-slate-100 px-8 py-5 flex justify-between items-center">
        <div className="flex items-center gap-6">
          <Link href="/admin/trends" className="w-10 h-10 flex items-center justify-center rounded-2xl bg-white border border-slate-100 hover:shadow-xl transition-all"><ArrowLeft size={18} /></Link>
          <div className="hidden sm:block">
            <h1 className="text-lg font-black italic uppercase leading-none tracking-tighter">ComeBrief Studio</h1>
            <p className="text-[8px] font-black text-slate-400 uppercase tracking-[0.3em] mt-1 italic">内容创作指挥部</p>
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
              onChange={e => {
                setTitle(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = e.target.scrollHeight + 'px';
              }} 
              placeholder="文章标题 (Headline Matrix)..." 
              rows={1} 
              className="w-full text-4xl md:text-3xl font-black text-slate-900 bg-transparent border-none outline-none italic tracking-tighter placeholder:text-slate-100 resize-none overflow-hidden" 
              style={{ minHeight: '60px' }}
            />
            {/* 摘要部分 (Excerpt) */}
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 ml-4">文章摘要 (EXCERPT)</label>
              <textarea 
                value={excerpt} 
                onChange={e => setExcerpt(e.target.value)}
                placeholder="在此输入简短的内容摘要，将显示在列表卡片中..."
                className="w-full p-8 bg-white rounded-[32px] border border-slate-100 outline-none text-sm text-slate-500 font-medium leading-relaxed shadow-sm focus:border-indigo-200 transition-all resize-none h-32"
              />
            </div>
          </div>
          
          <div className="bg-white rounded-[48px] border border-slate-100 shadow-2xl overflow-hidden min-h-[1000px] flex flex-col">
            <div className="flex items-center gap-2 p-4 border-b border-slate-100 bg-slate-50/50">
              <button
                onClick={() => {
                  const url = window.prompt('输入图片 URL')
                  if (url && editor) {
                    editor.chain().focus().setImage({ src: url }).run()
                  }
                }}
                className="p-2 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all"
                title="插入网络图片"
              >
                <ImageIcon size={18} />
              </button>
            </div>
            <div className="flex-1">
              <EditorContent editor={editor} />
            </div>
          </div>
        </div>

        {/* 右侧：配置看板 */}
        <aside className="lg:col-span-4 space-y-8">
          
          {/* 🚀 核心新增：发布策略中心 (状态机 + 定时发送) */}
          <section className="bg-white rounded-[40px] p-8 border border-slate-100 shadow-sm transition-all hover:shadow-md">
            <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-400 mb-6 italic flex items-center gap-2">发布策略 (Strategy) <Clock size={14}/></h3>
            <div className="flex flex-col gap-5">
              {/* 三档切换按钮 */}
              <div className="grid grid-cols-3 gap-2 p-1.5 bg-slate-50 rounded-2xl border border-slate-100">
                {(['draft', 'published', 'scheduled'] as const).map((status) => (
                  <button
                    key={status}
                    type="button"
                    onClick={() => setPostStatus(status)}
                    className={`py-3 rounded-xl text-[9px] font-black uppercase tracking-wider transition-all ${postStatus === status ? 'bg-slate-900 text-white shadow-md scale-102' : 'text-slate-400 hover:text-slate-600'}`}
                  >
                    {status === 'draft' ? '草稿' : status === 'published' ? '立即发布' : '定时发送'}
                  </button>
                ))}
              </div>

              {/* 定时时间选择器：仅在选中 scheduled 时高亮优雅展开 */}
              {postStatus === 'scheduled' && (
                <div className="space-y-2 p-5 bg-indigo-50/40 rounded-3xl border border-indigo-50 animate-in slide-in-from-top-3 duration-200">
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
          
          {/* 运营分类 (Labels) */}
          <section className="bg-white rounded-[40px] p-8 border border-slate-100 shadow-sm transition-all hover:shadow-md">
             <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-400 mb-8 italic flex items-center gap-2">运营配置 <TrendingUp size={14}/></h3>
             <div className="grid grid-cols-2 gap-4">
               {availableLabels.map(label => (
                 <button 
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
               <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-400 italic">话题矩阵</h3>
               <button onClick={() => setIsEditingCats(!isEditingCats)} className="text-slate-400 hover:text-indigo-600 transition-colors"><Plus size={16}/></button>
             </div>
             <div className="flex flex-wrap gap-2 mb-8">
                {availableCats.map(cat => (
                  <div key={cat} className="relative group">
                    <button 
                      onClick={() => toggleCat(cat)} 
                      className={`px-5 py-2.5 rounded-[18px] text-[9px] font-black uppercase tracking-widest transition-all ${selectedCats.includes(cat) ? 'bg-slate-900 text-white shadow-xl scale-105' : 'bg-slate-50 text-slate-400 hover:bg-slate-100'}`}
                    >
                      {cat}
                    </button>
                    {isEditingCats && (
                      <button 
                        onClick={() => setAvailableCats(prev => prev.filter(c => c !== cat))} 
                        className="absolute -top-1 -right-1 w-5 h-5 bg-rose-500 text-white rounded-full flex items-center justify-center shadow-lg hover:scale-110"
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
                   placeholder="新增话题..." 
                   className="flex-1 px-5 py-3 bg-slate-50 rounded-2xl text-[10px] font-black outline-none border-transparent focus:border-indigo-500 transition-all" 
                 />
                 <button onClick={() => { if(newCatInput) {setAvailableCats([...availableCats, newCatInput]); setNewCatInput('')} }} className="w-12 h-12 bg-emerald-500 text-white rounded-2xl flex items-center justify-center shadow-md"><Check size={20}/></button>
               </div>
             )}
          </section>

          {/* 视觉封面 (Cover) */}
          <section className="bg-white rounded-[40px] p-8 border border-slate-100 shadow-sm group">
            <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-400 mb-6 italic">视觉封面 (Cover)</h3>
            {coverUrl ? (
              <div className="relative rounded-[32px] overflow-hidden aspect-video border-4 border-slate-50 shadow-2xl group transition-all">
                <img src={coverUrl} className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-slate-900/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                   <button onClick={() => setCoverUrl('')} className="bg-white text-slate-900 px-6 py-2 rounded-full text-[9px] font-black uppercase shadow-xl hover:scale-110 active:scale-95 transition-all">移除</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setShowAssetLibrary(true)} className="w-full aspect-video border-4 border-dashed border-slate-100 rounded-[32px] flex flex-col items-center justify-center gap-4 bg-slate-50/50 hover:bg-white hover:border-indigo-500 transition-all">
                <ImageIcon size={32} className="text-slate-200" />
                <span className="text-[9px] font-black uppercase text-slate-300 italic">设置封面</span>
              </button>
            )}
          </section>

          {/* 作者 (Dice Control) */}
          <section className="bg-white rounded-[40px] p-8 border border-slate-100 shadow-sm">
             <div className="flex justify-between items-center mb-8">
               <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-400 italic">发布身份</h3>
               <button onClick={randomizeAuthor} className="p-2 bg-indigo-50 text-indigo-600 rounded-xl hover:rotate-180 transition-all duration-500"><Dice5 size={18} /></button>
             </div>
             <div className="flex items-center gap-5 p-6 bg-slate-50 rounded-[32px] border border-slate-100">
                <img src={authorAvatar} className="w-16 h-16 rounded-full border-4 border-white shadow-lg bg-white" alt="avatar" />
                <div className="flex-1 overflow-hidden">
                   <p className="font-black text-slate-900 text-sm truncate">{authorName}</p>
                   <p className="text-[8px] font-black text-indigo-500 uppercase tracking-widest mt-1 italic">Verified Partner</p>
                </div>
             </div>
          </section>
        </aside>
      </div>

      {/* 🚀 媒体库核心 (增强版：支持批量上传) */}
      {showAssetLibrary && (
        <div className="fixed inset-0 z-[100] bg-slate-900/70 backdrop-blur-3xl flex justify-center items-center p-8 animate-in fade-in" onClick={() => setShowAssetLibrary(false)}>
           <div className="w-full max-w-7xl bg-white h-[90vh] rounded-[64px] shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95" onClick={e => e.stopPropagation()}>
              <header className="p-12 border-b flex justify-between items-center bg-slate-50/30">
                 <div className="flex items-center gap-8">
                   <div>
                     <h2 className="text-4xl font-black italic uppercase tracking-tighter">Media Vault</h2>
                     <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-2">媒体资源库 2026</p>
                   </div>
                   <button 
                     onClick={() => fileInputRef.current?.click()}
                     className="px-8 py-4 bg-emerald-500 text-white rounded-[24px] text-[10px] font-black uppercase tracking-widest flex items-center gap-3 shadow-xl hover:bg-emerald-600 transition-all"
                   >
                     {uploading ? <Loader2 className="animate-spin" size={16}/> : <><Upload size={16}/> 批量同步图片</>}
                   </button>
                   <input type="file" multiple hidden ref={fileInputRef} onChange={handleUpload} accept="image/*" />
                 </div>
                 <button onClick={() => setShowAssetLibrary(false)} className="w-16 h-16 border rounded-full flex items-center justify-center bg-white shadow-xl hover:rotate-90 transition-all"><X size={24}/></button>
              </header>
              <div className="flex-1 p-12 overflow-y-auto grid grid-cols-2 md:grid-cols-5 gap-10 no-scrollbar">
                 {assets.map((asset, i) => {
                   const url = supabase.storage.from('images').getPublicUrl(`news/${asset.name}`).data.publicUrl
                   return (
                     <div key={i} className="relative group aspect-square">
                        <div 
                          onClick={() => { setCoverUrl(url); setShowAssetLibrary(false) }} 
                          className="w-full h-full rounded-[40px] overflow-hidden border-2 border-transparent hover:border-indigo-500 transition-all cursor-pointer shadow-xl hover:scale-[1.05]"
                        >
                          <img src={url} className="w-full h-full object-cover" />
                        </div>
                     </div>
                   )
                 })}
              </div>
           </div>
        </div>
      )}
    </div>
  )
}

// 导出组件
export default function UltimateFixedEditor() {
  return (
    <Suspense fallback={<div className="h-screen flex items-center justify-center bg-white font-black italic uppercase text-slate-300 animate-pulse tracking-[0.5em]">Synchronizing Studio Matrix...</div>}>
      <EditorContentComponent />
    </Suspense>
  )
}