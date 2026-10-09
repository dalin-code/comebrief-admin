'use client'

import Link from 'next/link'
import { useEffect, useState, useRef, useCallback, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { 
  ArrowLeft, Loader2, Image as ImageIcon, Dice5, Clock, 
  TrendingUp, Flame, Star, Plus, Minus, Send, Save, Calendar, Zap,
  Bold, Heading3, Quote, List, Sparkles, Upload, Check, Languages, AlertTriangle
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { anonStorageClient, getFreshAccessToken, isAuthTokenError } from '@/lib/clientAuth'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import ImageExtension from '@tiptap/extension-image'
import { StoryComposer, type GeneratedStory } from '@/app/admin/_components/StoryComposer'
import { buildArticleSlug, countChineseChars, htmlToPlainText, isUsableSlug } from '@/lib/storyPrompt'
import type { SupabaseClient } from '@supabase/supabase-js'

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

/**
 * 一对待上传到 `images` 桶的图片：高清原图（投喂社交盲抓）+ 轻量 WebP（投喂前台）。
 */
type ImageUploadPair = {
  originalFile: File
  originalPath: string
  webpFile: File
  webpPath: string
}

/**
 * 把「原图 + WebP」一对文件送进 `images` 桶，返回两条公开链接。
 *
 * 单独抽出来是因为这套动作要在三种客户端上各走一遍（登录态 / 换票重试 /
 * 匿名兜底），写成一份才不会三处走样。
 */
async function putImagePair(client: SupabaseClient, pair: ImageUploadPair) {
  const { error: originalError } = await client.storage
    .from('images')
    .upload(pair.originalPath, pair.originalFile, { cacheControl: '3600', upsert: true });
  if (originalError) throw originalError;

  const { error: webpError } = await client.storage
    .from('images')
    .upload(pair.webpPath, pair.webpFile, { cacheControl: '3600', upsert: true });
  if (webpError) throw webpError;

  return {
    originalUrl: client.storage.from('images').getPublicUrl(pair.originalPath).data.publicUrl,
    webpUrl: client.storage.from('images').getPublicUrl(pair.webpPath).data.publicUrl,
  };
}

/** 把 from 挪到 to 的位置；位置无效或原地不动时返回 null（调用方据此跳过落库）。 */
function moveItem<T>(list: T[], from: T, to: T): T[] | null {
  const fromIdx = list.indexOf(from);
  const toIdx = list.indexOf(to);
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return null;
  const next = [...list];
  next.splice(toIdx, 0, next.splice(fromIdx, 1)[0]);
  return next;
}

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

  // 🌐 双语：中文 = 原稿（只有后台看得到），英文 = 前台真正显示的那一版。
  //    title / excerpt / 编辑器里的内容 = 当前页签这一边，另一边暂存在 ref 里。
  const [lang, setLang] = useState<'zh' | 'en'>('en');
  const [titleZh, setTitleZh] = useState('');
  const [excerptZh, setExcerptZh] = useState('');
  const [translatedAt, setTranslatedAt] = useState<string | null>(null);
  const [zhUpdatedAt, setZhUpdatedAt] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [extractingExcerpt, setExtractingExcerpt] = useState(false);
  const [zhReady, setZhReady] = useState(false);
  const [slug, setSlug] = useState('');
  const [composerOpen, setComposerOpen] = useState(false);
  const [storyCombo, setStoryCombo] = useState<any>({ length: 1500 });
  const [publishGuard, setPublishGuard] = useState(false);
  const enHtmlRef = useRef('');
  const zhHtmlRef = useRef('');
  const lastSavedZhRef = useRef({ html: '', title: '', excerpt: '' });
  const guardOverrideRef = useRef(false);

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
  // 话题矩阵拖动排序：draggingCat = 手里正提着的那张，dragOverCat = 正悬停的那张（只为落点高亮）
  const [draggingCat, setDraggingCat] = useState<string | null>(null);
  const [dragOverCat, setDragOverCat] = useState<string | null>(null);
  
  // 🚀 核心正位：精简物理直调本地图片所用的两个 Input 引用
  const coverFileInputRef = useRef<HTMLInputElement>(null);
  const hasLoadedRef = useRef(false);

  const showToast = useCallback((msg: string, type: 'success' | 'error') => {
    setNotice({ msg, type });
    setTimeout(() => setNotice(null), 3500);
  }, []);

  /**
   * 把图片传进 Storage —— 带三层自救（站长只会看到「失败」这一个终点，
   * 但中间那两层能把绝大多数「莫名 403」就地消化掉）：
   *
   *   ① 出发前先换一张没过期的票。Storage 拿的是 supabase-js 缓存的 session
   *      token，而它不看 `exp` —— 后台标签页挂久了这就是一颗定时炸弹，
   *      撞上去的报错是 `"exp" claim timestamp check failed`（站长看到的
   *      「封面上传失败」就是它），跟图片、跟桶都没关系。
   *   ② 仍然被拒 → 硬刷新换一张新票重发一次。
   *   ③ 还是被拒 → 走不带登录态的公开通道（`images` 桶对匿名写入开放，
   *      与前台访客同权限）。宁可图片先传上去、让站长自己去重新登录，
   *      也不要他对着一个传不上封面的后台发呆。
   */
  const uploadToImages = async (pair: ImageUploadPair) => {
    await getFreshAccessToken(false);
    try {
      return await putImagePair(supabase, pair);
    } catch (err: any) {
      if (!isAuthTokenError(err?.message)) throw err;
      console.warn('[upload] 登录态被 Storage 拒绝，换票重试：', err?.message);
      await getFreshAccessToken(true);
      try {
        return await putImagePair(supabase, pair);
      } catch (retryErr: any) {
        if (!isAuthTokenError(retryErr?.message)) throw retryErr;
        console.warn('[upload] 换票后仍被拒，改走公开通道：', retryErr?.message);
        const urls = await putImagePair(anonStorageClient, pair);
        showToast('登录态已过期，这张图走的是公开通道。建议退出后台重新登录一次。', 'error');
        return urls;
      }
    }
  };

  // 🚀 核心优化 3：图片单张直传 Supabase 存储池核心逻辑（自动 WebP 压缩 + 双投喂）
  const uploadSingleImage = async (file: File) => {
    const fileStamp = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    // 1. 高清原图卡片（投喂社交盲抓）
    const originalExt = file.name.split('.').pop() || 'jpg';
    const originalFilePath = `news/${fileStamp}_original.${originalExt}`;

    // 2. 轻量 WebP（投喂前台极速爆发）
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
          if (blob) resolve(new File([blob], `${fileStamp}.webp`, { type: 'image/webp' }));
          else reject(new Error('WebP compression failed'));
        }, 'image/webp', 0.85);
      };
      img.onerror = () => reject(new Error('Image load failed'));
    });

    return uploadToImages({
      originalFile: file,
      originalPath: originalFilePath,
      webpFile,
      webpPath: `news/${fileStamp}.webp`,
    });
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
      },
      
      // 🚀【铁血并轨】：全自动劫持剪贴板粘贴，实现截图/复制图片秒级直传 Supabase
      handlePaste: (view, event) => {
        const items = Array.from(event.clipboardData?.items || []);
        
        // 在剪贴板中检索是否存在图片流（无论是微信截图、网页复制还是本地图片复制）
        const imageItem = items.find(item => item.type.indexOf("image") !== -1);
        
        if (imageItem) {
          // 🔥 拦截核心：坚决阻止浏览器把垃圾 Base64 脏数据默认塞进内容，防止数据库直接撑爆白屏
          event.preventDefault();
          const file = imageItem.getAsFile();
          if (!file) return false;

          showToast('已检测到赛博剪贴板图片流，正在极速压缩上传云端...', 'success');

          // 投喂给你写好的高奢单张直传管道
          uploadSingleImage(file).then(urls => {
            // 获取当前编辑器的绝对光标位置，原位刺入上传成功的 WebP URL
            const { schema } = view.state;
            const node = schema.nodes.image.create({ src: urls.webpUrl });
            const transaction = view.state.tr.replaceSelectionWith(node);
            view.dispatch(transaction);
            
            showToast('图片已完美并轨转化为轻量化 WebP 注入正文！', 'success');
          }).catch(err => {
            showToast(`粘贴图片直传失败: ${err.message}`, 'error');
          });

          return true; // 告诉 Tiptap，这个粘贴事件已经被站长高阶消化了
        }
        return false; // 普通文本直接放行，不影响日常打字和改稿
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
          // 顺序就是站长拖出来的顺序（存在 created_at 上，见
          // app/api/admin/categories/reorder/route.ts）。
          // 第二个 order 是必须的：同一天建出来的话题 created_at 一模一样，
          // 只按它排的话 Postgres 每次返回的先后都能不一样，前台页签会自己跳。
          .order('created_at', { ascending: true })
          .order('id', { ascending: true });
        
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
            setTitleZh(data.title_zh || '');
            setExcerptZh(data.excerpt_zh || '');
            setTranslatedAt(data.translated_at || null);
            setZhUpdatedAt(data.zh_updated_at || null);
            setSlug(data.slug || '');
            setStoryCombo(data.story_combo && typeof data.story_combo === 'object' ? data.story_combo : { length: 1500 });
            zhHtmlRef.current = data.content_zh_html || '';
            enHtmlRef.current = data.content_html || '';
            setZhReady(Boolean(data.content_zh_html || data.title_zh));
            lastSavedZhRef.current = {
              html: data.content_zh_html || '',
              title: data.title_zh || '',
              excerpt: data.excerpt_zh || '',
            };
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

  // ✨ 真的 AI 摘要（原来那颗按钮只是把正文前 130 个字截下来，文案是假的）
  //    跟着当前页签的语言走：中文页签 → 写进 excerpt_zh；英文页签 → 写进 excerpt（前台显示的那栏）
  const handleAutoExtractExcerpt = async () => {
    if (!editor) return;
    const bodyHtml = editor.getHTML() || '';
    if (htmlToPlainText(bodyHtml).length < 80) {
      showToast('正文太短了，写点内容再生成摘要', 'error');
      return;
    }
    setExtractingExcerpt(true);
    try {
      // 换一张新鲜票：页面挂久了 getSession() 里那张可能已经被后台判过期
      const token = await getFreshAccessToken();
      if (!token) throw new Error('登录状态失效，请刷新页面');
      const resp = await fetch('/api/ai/excerpt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ language: lang, title: lang === 'zh' ? titleZh : title, html: bodyHtml }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || !json?.ok) throw new Error(json?.error || `生成摘要失败（${resp.status}）`);
      const text = String(json.data?.excerpt || '');
      if (lang === 'zh') setExcerptZh(text);
      else setExcerpt(text);
      showToast(lang === 'zh' ? '中文摘要已生成' : '英文摘要已生成', 'success');
    } catch (e: any) {
      showToast(e?.message || '生成摘要失败', 'error');
    } finally {
      setExtractingExcerpt(false);
    }
  };

  /* ---------------- 双语页签 / 母语化重写 ---------------- */

  /** 当前页签的正文 HTML */
  const getActiveBody = () => editor?.getHTML() || '';
  /** 英文正文（不管现在停在哪个页签） */
  const getEnBody = () => (lang === 'en' ? getActiveBody() : enHtmlRef.current);
  /** 中文正文（不管现在停在哪个页签） */
  const getZhBody = () => (lang === 'zh' ? getActiveBody() : zhHtmlRef.current);
  /** 给「接着写下去」用：当前中文正文的纯文本 */
  const getCurrentZhText = () => htmlToPlainText(getZhBody());

  // 切页签前先把当前这一边存好，再把另一边塞回编辑器
  const switchLang = (next: 'zh' | 'en') => {
    if (!editor || next === lang) return;
    if (lang === 'zh') {
      const html = editor.getHTML();
      zhHtmlRef.current = html;
      setZhReady(htmlToPlainText(html).length > 0);
    } else {
      enHtmlRef.current = editor.getHTML();
    }
    setLang(next);
    editor.commands.setContent(next === 'zh' ? zhHtmlRef.current : enHtmlRef.current);
  };

  // 🌐 母语化重写：把中文原稿变成「像英语作家直接写的」英文版
  const handleTranslate = async () => {
    if (!editor) return;
    const zhBody = getZhBody();
    const zhText = htmlToPlainText(zhBody);
    if (zhText.length < 80) {
      showToast('中文正文太短了，先写完再翻译', 'error');
      return;
    }
    const alreadyHasEn = Boolean(title.trim()) || htmlToPlainText(getEnBody()).length > 80;
    if (alreadyHasEn && !window.confirm('翻译会用新的英文版覆盖现有的英文标题 / 摘要 / 正文。要继续吗？')) return;
    if (lang === 'zh') zhHtmlRef.current = editor.getHTML();

    setTranslating(true);
    try {
      const token = await getFreshAccessToken();
      if (!token) throw new Error('登录状态失效，请刷新页面');
      const resp = await fetch('/api/ai/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          title: titleZh.trim() || zhText.slice(0, 30),
          excerpt: excerptZh,
          html: zhBody,
          length: countChineseChars(zhText),
        }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || !json?.ok) throw new Error(json?.error || `翻译失败（${resp.status}）`);
      const d = json.data || {};
      const enHtml = String(d.html || '');
      enHtmlRef.current = enHtml;
      setTitle(String(d.title || ''));
      setExcerpt(String(d.excerpt || ''));
      setTranslatedAt(new Date().toISOString());
      setLang('en');
      editor.commands.setContent(enHtml);
      // 中文标题生成的网址是一串横杠 —— 既然有了英文标题，顺手把网址修好
      if (!isUsableSlug(slug)) {
        const fixed = buildArticleSlug(String(d.title || ''));
        if (fixed) setSlug(fixed);
      }
      if (Array.isArray(d.warnings)) d.warnings.forEach((w: string) => showToast(w, 'error'));
      showToast('英文版已就绪 —— 记得点右上角「保存」', 'success');
    } catch (e: any) {
      showToast(e?.message || '翻译失败', 'error');
    } finally {
      setTranslating(false);
    }
  };

  /* ---------------- AI 创作面板回填 ---------------- */

  // 生成好中文稿 → 写进中文页签（英文版原封不动，等你去翻译）
  const handleComposerApply = (story: GeneratedStory) => {
    if (!editor) return;
    if (lang === 'en') enHtmlRef.current = editor.getHTML();
    zhHtmlRef.current = story.html;
    setTitleZh(story.title);
    setExcerptZh(story.excerpt);
    setZhReady(true);
    setLang('zh');
    editor.commands.setContent(story.html);
    setComposerOpen(false);
    showToast('中文稿已写进编辑器 —— 定稿后点「母语化重写 → 英文」', 'success');
  };

  // 「接着写下去」：把新段落接在中文正文末尾
  const handleComposerAppend = (html: string) => {
    if (!editor) return;
    if (lang === 'en') {
      enHtmlRef.current = editor.getHTML();
      setLang('zh');
    }
    const cur = lang === 'zh' ? editor.getHTML() : zhHtmlRef.current;
    editor.commands.setContent(`${cur}${html}`);
    zhHtmlRef.current = editor.getHTML();
    setZhReady(true);
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

  /**
   * 把当前的排列顺序落库（第 i 个标签 = 基准 + i 秒）。
   *
   * 顺序不在前端算完就算完 —— 前台「All」后面那排页签读的就是这张表，所以
   * 存不上就得把界面退回改动前：宁可显示「没排上」，也不能让站长以为排好了、
   * 前台却是另一个顺序。
   */
  const persistCatOrder = async (order: string[], previous: string[]) => {
    try {
      const token = await getFreshAccessToken();
      if (!token) throw new Error('登录状态失效，请刷新页面重新登录');
      const resp = await fetch('/api/admin/categories/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ order }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || !json?.ok) throw new Error(json?.error || `保存顺序失败（${resp.status}）`);
      // 前台的 /briefs 是 ISR（revalidate = 60），所以不是「立刻」，最多等一分钟
      showToast('话题顺序已保存 —— 前台刷新后按这个顺序排（最多一分钟）', 'success');
    } catch (e: any) {
      setAvailableCats(previous);
      showToast(e?.message || '保存顺序失败', 'error');
    }
  };

  /** 松手：把手里那张插到落点那张的位置，先改界面再落库（落库失败会退回来）。 */
  const handleCatDrop = (target: string) => {
    const moved = draggingCat;
    setDraggingCat(null);
    setDragOverCat(null);
    if (!moved) return;
    const next = moveItem(availableCats, moved, target);
    if (!next) return;
    const previous = availableCats;
    setAvailableCats(next);
    void persistCatOrder(next, previous);
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
    // 标题看的是"当前页签"那一边：在中文页签只填了中文标题也算填了
    const titleNow = lang === 'zh' ? titleZh : title;
    if (!titleNow.trim()) {
      showToast(lang === 'zh' ? '请先填中文标题（或切到 English 页签填英文标题）' : '请输入文章标题', 'error');
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

    // 🛑 发布护栏：英文那一版还是空的（或只有中文稿）就别让前台发出一篇空文章
    //    判断只看「英文正文」——标题有、正文空，读者一样是点开一篇空文。
    const enBodyText = htmlToPlainText(getEnBody());
    const englishEmpty = enBodyText.length < 40;
    if ((postStatus === 'published' || postStatus === 'scheduled') && englishEmpty && !guardOverrideRef.current) {
      setPublishGuard(true);
      return;
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

      const token = await getFreshAccessToken();
      if (!token) {
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
        // ⚠️ 这里必须用「英文那一版」：中文页签下编辑器里装的是中文稿，不能存进 content_html
        content_html: getEnBody(),
        scheduled_at: postStatus === 'scheduled' ? new Date(scheduledAt).toISOString() : null,
        // 编辑页只提供 draft / published / scheduled 三态，能走到这里就说明
        // 这次保存已经让内容重新处于已知状态 —— 之前定时失败留下的原因必须清掉，
        // 否则库里会一直挂着一条早就解决的 publish_error。
        publish_error: null,
      };

      // 🌐 中文原稿一并保存（前台永远读 title / excerpt / content_html 这三列英文）
      const zhHtmlNow = lang === 'zh' ? (editor?.getHTML() || '') : zhHtmlRef.current;
      payload.title_zh = titleZh || null;
      payload.excerpt_zh = excerptZh || null;
      payload.content_zh_html = zhHtmlNow || null;
      payload.story_combo = storyCombo || null;
      if (translatedAt) payload.translated_at = translatedAt;
      const zhChanged =
        zhHtmlNow !== lastSavedZhRef.current.html ||
        titleZh !== lastSavedZhRef.current.title ||
        excerptZh !== lastSavedZhRef.current.excerpt;
      if (zhChanged) payload.zh_updated_at = currentIsoTime;
      
      if (articleId) {
        if (postStatus === 'published') {
          payload.published_at = currentIsoTime;
        }
        if (!isUsableSlug(slug)) {
          // 中文标题建出来的文章，网址是一串横杠 —— 既然有英文标题了就顺手修好
          const fixedSlug = buildArticleSlug(title);
          if (fixedSlug) payload.slug = fixedSlug;
        }
        const { error } = await supabase.from('articles').update(payload).eq('id', articleId);
        if (error) throw error;
        lastSavedZhRef.current = { html: zhHtmlNow, title: titleZh, excerpt: excerptZh };
        if (zhChanged) setZhUpdatedAt(currentIsoTime);
        showToast('文章大动脉修改同步成功！', 'success');
        setTimeout(() => router.push('/admin/trends'), 1200);
      } else {
        // 新文章：网址一律用英文标题生成（中文标题只会生成一串横杠）
        const newSlug =
          buildArticleSlug(title) ||
          `post-${Date.now().toString(36)}${Math.random().toString(36).substring(2, 5)}`;
        const { error } = await supabase.from('articles').insert({ 
          ...payload, 
          slug: newSlug, 
          published_at: postStatus === 'published' ? currentIsoTime : null 
        });
        if (error) throw error;
        lastSavedZhRef.current = { html: zhHtmlNow, title: titleZh, excerpt: excerptZh };
        if (zhChanged) setZhUpdatedAt(currentIsoTime);
        showToast('新热点文章已全盘发布上线！🚀', 'success');
        setTimeout(() => router.push('/admin/trends'), 1200);
      }
    } catch (e: any) {
      showToast(`操作失败: ${e.message}`, 'error');
    } finally {
      guardOverrideRef.current = false;
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

  // 🌐 翻译状态的两种"不新鲜"：从来没翻过 / 翻过之后中文又改了
  const hasEn = Boolean(title.trim()) || htmlToPlainText(getEnBody()).length > 0;
  const zhStamp = zhUpdatedAt ? new Date(zhUpdatedAt).getTime() : 0;
  const enStamp = translatedAt ? new Date(translatedAt).getTime() : 0;
  const notTranslatedYet = zhReady && !translatedAt;
  const enStale = zhReady && Boolean(translatedAt) && enStamp < zhStamp;

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
             type="button"
             onClick={() => setComposerOpen(true)}
             title="选标签，让 AI 写一篇中文短篇"
             className="h-12 px-6 bg-white border border-slate-200 text-slate-700 rounded-2xl font-black text-[10px] uppercase flex items-center gap-2 hover:border-indigo-300 hover:text-indigo-600 transition-all"
           >
             <Sparkles size={14} className="text-indigo-500" /> AI 创作
           </button>
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
    {/* 🌐 语言页签：中文是原稿（只有你看到），英文才是前台真正显示的那一版 */}
    <div className="flex flex-wrap items-center gap-3">
      <div className="inline-flex p-1 bg-slate-100 rounded-2xl">
        <button
          type="button"
          onClick={() => switchLang('zh')}
          className={`px-5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all ${
            lang === 'zh' ? 'bg-white text-slate-900 shadow' : 'text-slate-400 hover:text-slate-600'
          }`}
        >
          中文原稿
        </button>
        <button
          type="button"
          onClick={() => switchLang('en')}
          className={`px-5 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-wider flex items-center gap-2 transition-all ${
            lang === 'en' ? 'bg-white text-slate-900 shadow' : 'text-slate-400 hover:text-slate-600'
          }`}
        >
          English（前台显示）
          {(enStale || notTranslatedYet) && <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />}
        </button>
      </div>

      <button
        type="button"
        onClick={handleTranslate}
        disabled={translating}
        className={`h-10 px-5 rounded-2xl text-[10px] font-black uppercase tracking-wider flex items-center gap-2 transition-all ${
          translating ? 'bg-slate-100 text-slate-400' : 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100'
        }`}
      >
        {translating ? <Loader2 size={13} className="animate-spin" /> : <Languages size={13} />}
        {translating ? '母语化重写中…' : hasEn ? '重新翻译成英文' : '母语化重写 → 英文'}
      </button>
    </div>

    {(enStale || notTranslatedYet) && (
      <div className="flex items-start gap-2.5 p-4 rounded-2xl bg-amber-50 border border-amber-100 text-left">
        <AlertTriangle size={14} className="text-amber-500 mt-0.5 shrink-0" />
        <p className="text-[10px] font-bold text-amber-700 leading-relaxed">
          {notTranslatedYet
            ? '这篇还没有英文版。前台读的是英文内容 —— 不翻译就发布，读者点开会看到一篇空文章。'
            : '中文原稿在上次翻译之后又改动过，英文版可能已经不是最新内容了，建议再翻译一次。'}
        </p>
      </div>
    )}

    <textarea 
      ref={titleRef}
      value={lang === 'zh' ? titleZh : title} 
      onChange={e => (lang === 'zh' ? setTitleZh(e.target.value) : setTitle(e.target.value))} 
      placeholder={lang === 'zh' ? '中文标题（例如：他在凌晨三点收到自己发来的短信）...' : '文章标题 (Headline Matrix)...'} 
      rows={1} 
      className="w-full text-4xl md:text-3xl font-black text-slate-900 bg-transparent border-none outline-none italic tracking-tighter placeholder:text-slate-200 resize-none overflow-hidden text-left" 
      style={{ minHeight: '60px' }}
    />
    
    <div className="space-y-2">
      <div className="flex justify-between items-center px-4">
        <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">{lang === 'zh' ? '中文摘要 (EXCERPT_ZH)' : '文章摘要 (EXCERPT · 前台显示)'}</label>
        <button 
          type="button" 
          onClick={handleAutoExtractExcerpt}
          disabled={extractingExcerpt}
          className="flex items-center gap-1.5 text-[9px] font-black uppercase text-indigo-500 hover:text-indigo-600 bg-indigo-50 px-3 py-1 rounded-full transition-all hover:scale-105"
        >
          {extractingExcerpt ? <Loader2 size={11} className="animate-spin"/> : <Sparkles size={11}/>} {extractingExcerpt ? '正在写摘要…' : 'AI 一键生成摘要'}
        </button>
      </div>
      <textarea 
        value={lang === 'zh' ? excerptZh : excerpt} 
        onChange={e => (lang === 'zh' ? setExcerptZh(e.target.value) : setExcerpt(e.target.value))}
        placeholder={lang === 'zh' ? '在此输入中文摘要，或点上方 AI 自动提取...' : '在此输入简短的内容摘要，或者点击上方 AI 自动智能提取...'}
        className="w-full p-8 bg-white rounded-[32px] border border-slate-100 outline-none text-sm text-slate-500 font-medium leading-relaxed shadow-sm focus:border-indigo-200 transition-all resize-none h-28"
      />
    </div>
  </div>
  
  {/* 🚀 铁血重装：彻底根除遮挡、自带防穿透白底的富文本控制中心 */}
  <div className="bg-white rounded-[48px] border border-slate-100 shadow-2xl overflow-hidden min-h-[1000px] flex flex-col relative z-10">
    {editor && (
      /* 🟢 修复重点：精细化控制吸顶高度（可根据前台Header高度微调为 0 或 64px），拉高 z-index 至 50，加入实体白底与轻量阴影分割线，坚决不让正文穿透 */
      <div className="flex flex-wrap items-center gap-1 p-4 border-b border-slate-200 bg-white sticky top-0 md:top-[64px] z-50 shadow-sm w-full backdrop-blur-md">
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
    <div className="flex-1 relative p-2">
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
             <div className="flex flex-wrap gap-2 mb-3 justify-start">
                {availableCats.map(cat => {
                  const isDragging = draggingCat === cat;
                  const isDropTarget = Boolean(draggingCat) && dragOverCat === cat && !isDragging;
                  return (
                  <div
                    key={cat}
                    className="relative group"
                    // 落点：拖动中才生效，顺手把浏览器默认的「不允许放下」拦掉
                    onDragOver={(e) => {
                      if (!draggingCat) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      setDragOverCat(prev => (prev === cat ? prev : cat));
                    }}
                    onDrop={(e) => { e.preventDefault(); handleCatDrop(cat); }}
                  >
                    <button 
                      type="button"
                      draggable
                      onDragStart={(e) => {
                        setDraggingCat(cat);
                        e.dataTransfer.effectAllowed = 'move';
                        // Firefox 不设 data 就不触发拖拽，随便塞点东西进去
                        e.dataTransfer.setData('text/plain', cat);
                      }}
                      onDragEnd={() => { setDraggingCat(null); setDragOverCat(null); }}
                      onClick={() => toggleCat(cat)} 
                      title="点一下选中；按住拖动可以调整先后顺序"
                      className={`px-5 py-2.5 rounded-[18px] text-[9px] font-black uppercase tracking-widest transition-all ${
                        selectedCats.includes(cat) ? 'bg-slate-900 text-white shadow-xl scale-105' : 'bg-slate-50 text-slate-400 hover:bg-slate-100'
                      } ${isDragging ? 'opacity-40 cursor-grabbing' : 'cursor-grab'} ${
                        isDropTarget ? 'ring-2 ring-indigo-400 ring-offset-2 scale-105' : ''
                      }`}
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
                  );
                })}
             </div>
             <p className="mb-8 text-[9px] font-bold tracking-wider text-slate-300 text-left">
               拖动标签可以调整先后顺序 —— 前台页签「All」后面就按这个顺序排
             </p>
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

      {/* 🛑 发布护栏：英文还是空的，就别让读者点开一篇空文章 */}
      {publishGuard && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm px-6">
          <div className="w-full max-w-lg bg-white rounded-[40px] p-10 shadow-2xl space-y-6 text-left">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-2xl bg-amber-50 flex items-center justify-center shrink-0">
                <AlertTriangle size={22} className="text-amber-500" />
              </div>
              <div className="space-y-2">
                <h3 className="text-lg font-black italic tracking-tighter">英文版还是空的</h3>
                <p className="text-[11px] text-slate-500 font-medium leading-relaxed">
                  前台只显示英文那一版（标题 / 摘要 / 正文）。这一篇的英文还是空的，直接发布的话，读者点开会看到一篇空文章。
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => { setPublishGuard(false); switchLang('zh'); handleTranslate(); }}
                className="h-14 rounded-2xl bg-slate-900 text-white font-black text-[11px] uppercase tracking-widest hover:scale-[1.01] active:scale-95 transition-all flex items-center justify-center gap-2"
              >
                <Languages size={15} /> 先去翻译（推荐）
              </button>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => { setPublishGuard(false); guardOverrideRef.current = true; handleSave(); }}
                  className="flex-1 h-12 rounded-2xl border border-rose-200 text-rose-500 font-black text-[10px] uppercase tracking-widest hover:bg-rose-50 transition-all"
                >
                  仍然发布
                </button>
                <button
                  type="button"
                  onClick={() => setPublishGuard(false)}
                  className="flex-1 h-12 rounded-2xl border border-slate-200 text-slate-400 font-black text-[10px] uppercase tracking-widest hover:bg-slate-50 transition-all"
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ✨ AI 创作面板 */}
      <StoryComposer
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        onApply={handleComposerApply}
        getCurrentZhText={getCurrentZhText}
        onAppend={handleComposerAppend}
        combo={storyCombo}
        onComboChange={setStoryCombo}
        hasExistingContent={Boolean(htmlToPlainText(getZhBody()).trim())}
        showToast={showToast}
      />
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