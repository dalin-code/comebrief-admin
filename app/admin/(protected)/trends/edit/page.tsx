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
import AiHealthCard from '@/app/admin/_components/AiHealthCard'
import { buildArticleSlug, countChineseChars, htmlToPlainText, isMostlyChinese, isUsableSlug, pickChineseOriginal, resolveBilingualDraft, splitTranslationChunks } from '@/lib/storyPrompt'
import { DEFAULT_EDITOR_PERSONA, EDITOR_PERSONAS, randomEditorPersona, type EditorPersona } from '@/lib/editors'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * 一次翻译多少汉字。
 *
 * 1 段 = 一次请求。整篇一次性翻的时候，一篇 3000 字的中文会同时撞上
 * 「模型输出上限」和「路由 60 秒超时」，站长的体感就是「文章一长就翻译不了」。
 * 切成 900 字一段之后，每段单独一次请求，长文也翻得完，还能显示「第 2/5 段」。
 * 这个数字与 lib/storyPrompt 的 TRANSLATE_CHUNK_CHARS 是同一个口径。
 */
const TRANSLATE_CHUNK_CHARS = 900

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

/**
 * 多话题列（articles.categories）是 45 号迁移才加的。
 *
 * 线上曾经出现过「代码先发、SQL 还没跑」：保存时 PostgREST 直接报
 * `Could not find the 'categories' column ... in the schema cache`，
 * 站长只看到一屏红字，文章也发不出去。这里识别这种错误，单话题时降级
 * 成旧字段 category 照常保存；多话题则明确告诉站长先跑迁移，避免悄悄丢话题。
 */
const CATEGORIES_MIGRATION_HINT =
  '数据库还没启用多话题（articles.categories）。请先在 Supabase SQL Editor 运行 supabase/45_article_categories.sql，再刷新本页。'

function isMissingCategoriesColumnError(error: unknown): boolean {
  const err = error as { message?: unknown; code?: unknown } | null
  const msg = String(err?.message || '')
  const code = String(err?.code || '')
  return (
    /Could not find the 'categories' column/i.test(msg) ||
    /column\s+articles\.categories\s+does\s+not\s+exist/i.test(msg) ||
    ((code === '42703' || code === 'PGRST204') && /categories/i.test(msg))
  )
}

/**
 * 把这次用到的话题补进 `categories` 表 —— 它是前台页签的真源
 * （后台「话题矩阵」里列了什么、什么顺序，前台 /briefs 的筛选条就是什么，
 * 见 ComeBrief `lib/categories.ts` 的 `categoryTabs`）。
 *
 * ⚠️ 只能在**文章写库成功之后**调用。这段以前跑在保存流程的最前面（登录校验
 *    之前、写库之前），于是只要后面哪一步失败 —— 登录票过期、文章更新抛错 ——
 *    库里就已经多出一个「后台矩阵里有、却没有任何文章用它」的孤儿话题，
 *    前台永远不给它页签。站长看到的就是「后台加了标签，网站没同步显示」。
 *    （2026-10-16 线上「Crime Fiction」正是这个形态：`categories` 里有，
 *     `articles.category` 里 0 行。）
 *
 * 失败只记日志、不抛：文章已经存好了，一行话题没补上不该把整次保存判成失败 ——
 * 前台会把「文章里有、后台矩阵里没有」的话题按字母序补在页签末尾，内容不会丢。
 */
async function upsertCategories(client: SupabaseClient, cats: string[]) {
  for (const raw of cats || []) {
    const name = String(raw || '').trim();
    if (!name) continue;

    const { data, error } = await client.from('categories').select('name').eq('name', name);
    if (error) {
      console.log('[categories] 读话题失败，跳过这一条 ——', name, error.message);
      continue;
    }
    if (data && data.length > 0) continue;

    const { error: insertError } = await client.from('categories').insert([{ name }]);
    if (insertError) console.log('[categories] 新话题落库失败 ——', name, insertError.message);
  }
}

/**
 * 「保存成功 → 请前台立刻刷新」。
 *
 * 浏览器不碰 `REVALIDATE_SECRET`，只带自己那张登录票来敲后台的转发路由
 * （app/api/admin/revalidate/route.ts），由服务端换密钥去打前台 —— 密钥进浏览器
 * 就等于公开。前台 `/`、`/briefs`、`/briefs/[slug]` 都是 ISR（revalidate = 60），
 * 没有这一下就要等最多一分钟；没配那两个变量时这里静默跳过，行为与以前完全一致。
 *
 * 位置很关键：必须在写库成功之后。保存失败还去刷前台，只会让站长看到「页面动了
 * 但内容没变」，反而更像坏了。
 */
async function pingFrontendRevalidate(token: string) {
  try {
    const res = await fetch('/api/admin/revalidate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.ok === false) {
      console.log(
        '[revalidate] 前台没有立刻刷新（不影响已保存的内容）——',
        json?.error || `HTTP ${res.status}`
      );
    }
  } catch (e: any) {
    console.log('[revalidate] 通知前台异常（不影响已保存的内容）——', e?.message || e);
  }
}

function EditorContentComponent() {
  const router = useRouter(); 
  const searchParams = useSearchParams();
  const articleId = searchParams.get('id');
  
  const [isMounted, setIsMounted] = useState(false);
  const [notice, setNotice] = useState<{msg: string, type: 'success' | 'error' | 'info'} | null>(null);
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
  //    页签初值先按「新建稿 / 改稿」给一个猜测，真正的值由载入时的
  //    resolveBilingualDraft 根据两边实际内容决定：有英文正文停英文，只有中文
  //    正文停中文原稿（新建稿两边都空 → 中文原稿）。
  const [lang, setLang] = useState<'zh' | 'en'>(articleId ? 'en' : 'zh');
  /** 页签的最新值。异步回调里读 state 会拿到旧闭包，正文归属必须认这个 ref。 */
  const langRef = useRef<'zh' | 'en'>(articleId ? 'en' : 'zh');
  const [titleZh, setTitleZh] = useState('');
  const [excerptZh, setExcerptZh] = useState('');
  const [translatedAt, setTranslatedAt] = useState<string | null>(null);
  const [zhUpdatedAt, setZhUpdatedAt] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  /** 分批翻译时的进度文案（例如「正在翻译第 2/5 段…」）；只有一段时是空串 */
  const [translateStep, setTranslateStep] = useState('');
  const [extractingExcerpt, setExtractingExcerpt] = useState(false);
  const [generatingCover, setGeneratingCover] = useState(false);
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
  /** 最新的封面值。翻译结束时的「没有封面才自动生成」不能看旧闭包。 */
  const coverUrlRef = useRef('');
  const coverUrlShareRef = useRef('');
  /** 正在跑的 AI 封面任务。保存前会等它，避免「刚生成完就跳走、封面没进库」。 */
  const coverTaskRef = useRef<Promise<void> | null>(null);
  const [authorName, setAuthorName] = useState(DEFAULT_EDITOR_PERSONA.name);
  const [authorAvatar, setAuthorAvatar] = useState(DEFAULT_EDITOR_PERSONA.avatar);
  /** 「发布身份」的 20 组头像面板是否展开（默认收起，别把侧栏撑太长） */
  const [authorPickerOpen, setAuthorPickerOpen] = useState(false);
  
  const [postStatus, setPostStatus] = useState<'draft' | 'published' | 'scheduled'>('published');
  const [scheduledAt, setScheduledAt] = useState('');

  const [availableCats, setAvailableCats] = useState<string[]>([]);
  const [selectedCats, setSelectedCats] = useState<string[]>([]);
  /**
   * 封面生成可能在翻译结束后才落地；那个异步回调里的 selectedCats 是闭包旧值。
   * 生成时读 ref，保证用上站长此刻真正选中的话题矩阵。
   */
  const selectedCatsRef = useRef<string[]>([]);
  useEffect(() => {
    selectedCatsRef.current = selectedCats;
  }, [selectedCats]);
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
  /**
   * 上一次生成摘要是「复用」来的吗？
   * 是的话，这一下再点「生成摘要」就得强制重新问模型（请求体带 fresh: true）——
   * 否则后端 5 分钟内的记忆会一直把同一个结果还回来，站长会以为按钮坏了。
   */
  const excerptFreshRef = useRef(false);

  /**
   * 浮动提示。
   *
   * 两个坑都是 2026-10-10 那张截图教出来的：
   *   ① 时长写死 3500ms —— 「主模型限流、兜底也限流、去哪儿改配置」这种要读完才能动，
   *      3.5 秒根本不够，红字一闪而过，站长只知道「又挂了」。错误现在留 8 秒。
   *   ② 定时器没管住 —— 连续弹两条时，第一条的定时器会把第二条提前抹掉。
   *      现在共用同一个 ref：新提示进来先把旧的收掉，后弹的那条才能活满自己的时间。
   */
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string, type: 'success' | 'error' | 'info') => {
    setNotice({ msg, type });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setNotice(null), type === 'error' ? 8000 : type === 'info' ? 5500 : 3500);
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
      coverUrlRef.current = urls.webpUrl;
      coverUrlShareRef.current = urls.originalUrl;
      setCoverUrl(urls.webpUrl);
      setCoverUrlShare(urls.originalUrl);
      showToast('高奢视觉封面并轨成功！', 'success');
    } catch (err: any) {
      showToast(`封面上传失败: ${err.message}`, 'error');
    } finally {
      setUploading(false);
    }
  };

  /** 清空封面（同时清掉「有没有人工封面」的判断依据）。 */
  const clearCover = () => {
    coverUrlRef.current = '';
    coverUrlShareRef.current = '';
    setCoverUrl('');
    setCoverUrlShare('');
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
            // 先按「哪份正文属于哪一边」落位，再决定打开哪个页签。
            // 这一步是本次修复的核心：以前这里无条件把 content_html 塞进编辑器，
            // 而页签初值是 'en' —— 一旦 content_html 里是中文，中文页签就会显示
            // 英文列里的中文，翻译 / 保存也会把两边的内容写反。
            const draft = resolveBilingualDraft({
              titleEn: data.title,
              titleZh: data.title_zh,
              excerptEn: data.excerpt,
              excerptZh: data.excerpt_zh,
              htmlEn: data.content_html,
              htmlZh: data.content_zh_html,
            });
            setTitle(draft.titleEn);
            setExcerpt(draft.excerptEn);
            setTitleZh(draft.titleZh);
            setExcerptZh(draft.excerptZh);
            setTranslatedAt(data.translated_at || null);
            setZhUpdatedAt(data.zh_updated_at || null);
            setSlug(data.slug || '');
            setStoryCombo(data.story_combo && typeof data.story_combo === 'object' ? data.story_combo : { length: 1500 });
            zhHtmlRef.current = draft.htmlZh;
            enHtmlRef.current = draft.htmlEn;
            setZhReady(Boolean(draft.htmlZh || draft.titleZh));
            lastSavedZhRef.current = {
              html: draft.htmlZh,
              title: draft.titleZh,
              excerpt: draft.excerptZh,
            };
            setCoverUrl(data.cover_url || '');
            setCoverUrlShare(data.cover_url_share || '');
            coverUrlRef.current = data.cover_url || '';
            coverUrlShareRef.current = data.cover_url_share || '';
            setAuthorName(data.author_name || DEFAULT_EDITOR_PERSONA.name);
            setAuthorAvatar(data.author_avatar || DEFAULT_EDITOR_PERSONA.avatar);
            if (data.status) setPostStatus(data.status);
            if (data.scheduled_at) {
              const localDate = new Date(data.scheduled_at);
              const offset = localDate.getTimezoneOffset() * 60000;
              setScheduledAt(new Date(localDate.getTime() - offset).toISOString().slice(0, 16));
            }

            const loadedCats = Array.isArray(data.categories)
              ? data.categories.map((cat: unknown) => String(cat || '').trim()).filter(Boolean)
              : data.category
                ? [String(data.category).trim()]
                : [];
            // selectedCats[0] 就是主话题。历史数据里 categories[] 的顺序不一定可靠，
            // 以 category 列为准把它提到第一位；封面生成和再次保存都依赖这个顺序。
            const primaryCat = String(data.category || '').trim();
            const orderedCats = primaryCat
              ? [primaryCat, ...loadedCats.filter((cat) => cat.toLowerCase() !== primaryCat.toLowerCase())]
              : loadedCats;
            for (const cat of orderedCats) {
              if (!currentPool.some((c: string) => c.toLowerCase() === cat.toLowerCase())) currentPool.push(cat);
            }
            setSelectedCats(orderedCats);

            if (data.labels && Array.isArray(data.labels)) setSelectedLabels(data.labels);

            const initialHtml = draft.initialLang === 'zh' ? draft.htmlZh : draft.htmlEn;
            langRef.current = draft.initialLang;
            setLang(draft.initialLang);
            // 直接写，不再 setTimeout：延迟写会在站长已经切页签之后落地，
            // 把另一边的正文覆盖到当前页签上（正是「中文页签显示英文」的另一种成因）。
            editor.commands.setContent(initialHtml);
            if (draft.recovered) {
              showToast('检测到中文正文停在英文列里，已放回「中文原稿」页签；保存后会修正前台内容', 'info');
            }
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
    const activeLang = langRef.current;
    const bodyHtml = captureActiveBody(activeLang) || '';
    const bodyText = htmlToPlainText(bodyHtml);
    if (bodyText.length < 80) {
      // 英文页签还空着、中文那边有正文 → 该说的是「先去翻译」，而不是「去写点东西」
      const zhSide = pickZhCandidate(activeLang === 'en' ? 'en' : 'zh');
      showToast(
        activeLang === 'en' && htmlToPlainText(zhSide.html).length >= 80
          ? '英文版还是空的：先点「母语化重写 → 英文」翻出来，再生成英文摘要'
          : '正文太短了，写点内容再生成摘要',
        'error'
      );
      return;
    }
    // 页签停在英文、正文却是中文：这时候问模型要「英文摘要」，它会顺着正文语言
    // 吐一段中文回来，写进 excerpt 就是前台挂一段中文。直接指路，别浪费一次调用。
    if (activeLang === 'en' && isMostlyChinese(bodyText)) {
      showToast('这段正文是中文：中文摘要请切到「中文原稿」页签，英文摘要等翻译完再生成', 'error');
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
        body: JSON.stringify({
          language: activeLang,
          title: activeLang === 'zh' ? titleZh : title,
          html: bodyHtml,
          // 上一次是复用出来的 → 这一下点「再生成一次」就该真的重新问模型（见下面的提示）
          fresh: excerptFreshRef.current,
        }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || !json?.ok) {
        // 模型类故障给个去处：右侧「AI 自检」能把「谁挂了、哪把 Key 缺了」摊开
        const hint = ['rate', 'quota', 'auth', 'notfound'].includes(String(json?.kind || ''))
          ? '\n（右侧「AI 自检」可以直接查是哪个模型 / 哪把 Key 的问题）'
          : '';
        throw new Error(`${json?.error || `生成摘要失败（${resp.status}）`}${hint}`);
      }
      const text = String(json.data?.excerpt || '');
      if (activeLang === 'zh') setExcerptZh(text);
      else setExcerpt(text);
      // 后端 5 分钟内问过同一段正文时会直接复用（省额度），得说清楚 —— 否则站长会觉得「点了没反应」
      const reused = json.data?.cached === true;
      excerptFreshRef.current = reused;
      showToast(
        reused
          ? '5 分钟内刚生成过同一段正文，这次直接复用了上次的结果（省额度）。\n再点一次「生成摘要」就会真的重新生成。'
          : activeLang === 'zh'
            ? '中文摘要已生成'
            : '英文摘要已生成',
        reused ? 'info' : 'success'
      );
    } catch (e: any) {
      showToast(e?.message || '生成摘要失败', 'error');
    } finally {
      setExtractingExcerpt(false);
    }
  };

  /* ---------------- 双语页签 / 母语化重写 ---------------- */

  /** 当前页签的正文 HTML */
  const getActiveBody = () => editor?.getHTML() || '';

  /**
   * 把编辑器里这一边存回对应的 ref。
   * 所有异步动作（切页签 / 翻译 / 保存）开始前都必须先调它 —— 不能拿 `lang`
   * state 猜，异步回调里的闭包可能还停在上一个页签。
   */
  const captureActiveBody = (activeLang: 'zh' | 'en' = langRef.current) => {
    const html = getActiveBody();
    if (activeLang === 'zh') {
      zhHtmlRef.current = html;
      setZhReady(htmlToPlainText(html).length > 0);
    } else {
      enHtmlRef.current = html;
    }
    return html;
  };

  /** 英文正文（不管现在停在哪个页签） */
  const getEnBody = (activeLang: 'zh' | 'en' = langRef.current) =>
    activeLang === 'en' ? getActiveBody() : enHtmlRef.current;

  /**
   * 「中文原稿」到底在哪一边 —— 真正的判断在 lib/storyPrompt 的 pickChineseOriginal 里
   * （纯函数，好测）。这里只负责告诉它「正经位置」和「另一边」分别是哪个输入框。
   */
  const pickZhCandidate = (activeLang: 'zh' | 'en' = langRef.current) =>
    pickChineseOriginal({
      official: activeLang === 'zh' ? getActiveBody() : zhHtmlRef.current,
      others: activeLang === 'zh' ? [enHtmlRef.current] : [getActiveBody(), enHtmlRef.current],
    });

  /** 中文正文（不管现在停在哪个页签） */
  const getZhBody = () => pickZhCandidate().html;
  /** 给「接着写下去」用：当前中文正文的纯文本 */
  const getCurrentZhText = () => htmlToPlainText(getZhBody());

  /**
   * 切页签 = 「把当前正文存回旧页签」+「把新页签的正文装进编辑器」+「改页签」，
   * 三件事必须在同一次调用里完成。
   *
   * 以前是 `setLang(next)` 和 `editor.commands.setContent(...)` 分开写、且判断用
   * `lang` state：异步翻译刚结束时闭包里的 lang 还是旧值，页签和正文就会错位
   * （典型表现：翻译完了，中文页签下却是英文正文）。
   *
   * forcedHtml：翻译 / AI 创作刚产出新正文时直接传进来，避免先写 ref 再读一遍。
   */
  const switchLang = (next: 'zh' | 'en', forcedHtml?: string) => {
    if (!editor) return;
    const active = langRef.current;
    if (next === active && forcedHtml === undefined) return;

    const current = editor.getHTML();
    if (active === 'zh') {
      zhHtmlRef.current = current;
      setZhReady(htmlToPlainText(current).length > 0);
    } else {
      enHtmlRef.current = current;
    }

    const target = forcedHtml !== undefined ? forcedHtml : next === 'zh' ? zhHtmlRef.current : enHtmlRef.current;
    if (next === 'zh') {
      zhHtmlRef.current = target;
      setZhReady(htmlToPlainText(target).length > 0);
    } else {
      enHtmlRef.current = target;
    }

    langRef.current = next;
    setLang(next);
    editor.commands.setContent(target);
  };

  /**
   * AI 封面。
   *
   * 手动：封面卡片上「AI 生成封面 / AI 重绘」按钮。
   * 自动：翻译成功且这篇文章还没有封面时，由 handleTranslate 触发一次；已有封面
   *      （手动上传或上一轮生成）绝不覆盖 —— 站长挑过的图不能因为重译就没了。
   *
   * 复用 /api/ai/draw：它内部会先用模型把标题 + 摘要 + 正文开头 + 话题矩阵转成
   * 绘图提示词，再把图传到 images 桶，返回 { ok, url }。这里只负责取票、显示忙碌态、
   * 把 URL 写进封面。话题按「主话题优先」传过去，让画面锚定在这篇故事的核心上。
   */
  const generateCover = async (opts?: {
    title?: string
    excerpt?: string
    html?: string
    language?: 'zh' | 'en'
    auto?: boolean
  }) => {
    if (opts?.auto && coverUrlRef.current.trim()) return;

    const sourceLang = opts?.language || langRef.current;
    const sourceTitle =
      String(opts?.title || (sourceLang === 'zh' ? titleZh : title) || titleZh || title).trim();
    if (!sourceTitle) {
      // 自动生成是翻译后的顺手动作，没标题不该打断翻译成功提示
      if (!opts?.auto) showToast('先写一个标题，再让 AI 画封面', 'error');
      return;
    }

    const sourceHtmlFromRef = sourceLang === 'zh' ? zhHtmlRef.current : enHtmlRef.current;
    const sourceHtml = opts?.html !== undefined ? opts.html : sourceHtmlFromRef || getActiveBody();
    const bodyText = htmlToPlainText(sourceHtml).trim();
    // 自动补封面发生在翻译成功后的同一次回调里，setExcerpt 还没重渲染；
    // 所以自动流程必须把 enExcerpt 显式传进来。手动生成则读当前页签的摘要。
    const sourceExcerpt =
      opts?.excerpt !== undefined
        ? String(opts.excerpt).trim()
        : String(sourceLang === 'zh' ? excerptZh : excerpt).trim();
    const openingParagraph = (bodyText.split(/\n+/).map((p) => p.trim()).find(Boolean) || '').slice(0, 700);
    // 第一个是主话题：后端据此决定画面主体，其余话题只补充环境 / 道具 / 氛围。
    const topicTags = selectedCatsRef.current
      .map((cat) => cat.trim())
      .filter(Boolean)
      .slice(0, 5);

    setGeneratingCover(true);
    try {
      const token = await getFreshAccessToken();
      if (!token) throw new Error('登录状态失效，请刷新页面');
      const resp = await fetch('/api/ai/draw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          title: sourceTitle,
          excerpt: sourceExcerpt.slice(0, 600),
          opening: openingParagraph,
          markdown: (bodyText || sourceTitle).slice(0, 6000),
          language: sourceLang,
          categories: topicTags,
        }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || !json?.ok || !json?.url) {
        throw new Error(json?.error || `生成封面失败（${resp.status}）`);
      }
      const url = String(json.url);
      coverUrlRef.current = url;
      setCoverUrl(url);
      // AI 出图就是 1024×576 的分享图，直接兼作高清分享封面。
      coverUrlShareRef.current = url;
      setCoverUrlShare(url);
      showToast(opts?.auto ? '英文版已就绪，顺手生成了一张封面 —— 不满意可以点「AI 重绘」' : 'AI 封面已生成', 'success');
    } catch (e: any) {
      showToast(`封面生成失败：${e?.message || '请重试'}`, opts?.auto ? 'info' : 'error');
    } finally {
      setGeneratingCover(false);
    }
  };

  /**
   * 包一层任务句柄：保存时若封面还在画，先等这一单结束再写库。
   * generateCover 自己吞掉错误，所以这里 await 不会把保存流程炸掉。
   */
  const runCoverGeneration = (opts?: {
    title?: string
    excerpt?: string
    html?: string
    language?: 'zh' | 'en'
    auto?: boolean
  }) => {
    const task = generateCover(opts);
    coverTaskRef.current = task;
    void task.finally(() => {
      if (coverTaskRef.current === task) coverTaskRef.current = null;
    });
    return task;
  };

  /**
   * 把「一段中文」送去翻译，失败自动重试一次。
   *
   * 单独抽出来是因为分批翻译要在循环里调用它 N 次；每次都要现取登录票
   * （一张票撑不完十分钟，长文翻到第五段时旧票早过期了）。
   *
   * 429 也纳入重试 —— 但必须按对面说的等：
   *   以前只认 502/503/504，于是「这一分钟点得太密」这种**等 20 秒就好**的情况
   *   直接甩给站长自己重试；反过来说，后端把 429 的宽度当成 502 又不对。
   *   现在后端会在 body 里带 retryAfterMs（有上限），这里据此等一次：
   *     · retryAfterMs ≤ 8 秒 → 等它，然后重发（多数情况这一下就成了）
   *     · 更长（每日额度用尽之类）→ 不等，立刻把话递给站长，别白转 20 秒圈
   */
  const translatePart = async (payload: Record<string, unknown>) => {
    const send = async () => {
      const token = await getFreshAccessToken();
      if (!token) throw new Error('登录状态失效，请刷新页面');
      const resp = await fetch('/api/ai/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const json = await resp.json().catch(() => ({}));
      return { resp, json };
    };

    let { resp, json } = await send();
    // 502/503/504 是「这次没成」而不是「你不该这么做」——换张票再来一次
    const askedWaitMs = Number((json as any)?.retryAfterMs) || 0;
    const worthRetrying =
      [502, 503, 504].includes(resp.status) || (resp.status === 429 && askedWaitMs > 0 && askedWaitMs <= 8000);
    if (!resp.ok && worthRetrying) {
      const waitMs = askedWaitMs > 0 && askedWaitMs <= 8000 ? askedWaitMs : 800;
      if (waitMs > 1200) setTranslateStep(`被模型限流了，${Math.ceil(waitMs / 1000)} 秒后自动重试这一段…`);
      await new Promise((r) => setTimeout(r, waitMs));
      ({ resp, json } = await send());
    }
    if (!resp.ok || !json?.ok) throw new Error(json?.error || `翻译失败（${resp.status}）`);
    return (json.data || {}) as Record<string, any>;
  };

  // 🌐 母语化重写：把中文原稿变成「像英语作家直接写的」英文版
  //
  // 长文必须分批翻：整篇一次性翻的时候，一篇 3000 字的中文会同时撞上
  // 「模型单次输出上限」和「路由 60 秒超时」，站长看到的就是「翻译不了」。
  // 现在按段落切成 900 字一段，一段一次请求 —— 长文照样翻得完，还能显示翻到第几段。
  const handleTranslate = async (opts?: { activeLang?: 'zh' | 'en' }) => {
    if (!editor) return;
    // activeLang：给「发布护栏 → 先去翻译」那颗按钮用的。它先 switchLang('zh') 再调
    // 这里，而 setLang 是异步的，这一帧闭包里读到的 lang 还是旧值（'en'），
    // 于是「中文原稿在哪一边」会判断错。
    const active = opts?.activeLang || langRef.current;
    captureActiveBody(active);
    const picked = pickZhCandidate(active);
    const zhBody = picked.html;
    const zhText = htmlToPlainText(zhBody);
    if (zhText.length < 80) {
      // 说清楚该去哪儿写：以前只丢一句「太短了」，站长对着满屏中文根本摸不着头脑
      showToast('中文原稿还是空的：先切到「中文原稿」页签写完正文，再回来翻译', 'error');
      return;
    }
    // 中文是从英文页签那边捡回来的（页签错位）：先放回中文原稿。
    // 不放回去的话，保存时它会被当成英文版写进 content_html，中文原稿那一栏永远是空的。
    if (picked.recovered) {
      zhHtmlRef.current = zhBody;
      setZhReady(true);
      if (active === 'zh') editor.commands.setContent(zhBody);
      showToast('检测到中文正文停在英文页签里，已先放回「中文原稿」', 'success');
    }
    const alreadyHasEn = Boolean(title.trim()) || htmlToPlainText(getEnBody(active)).length > 80;
    if (alreadyHasEn && !window.confirm('翻译会用新的英文版覆盖现有的英文标题 / 摘要 / 正文。要继续吗？')) return;
    // 中文原稿统一以刚才挑好的这一份为准（原来是「停在中文页签就从编辑器抓一份」）
    zhHtmlRef.current = zhBody;

    const chunks = splitTranslationChunks(zhText, TRANSLATE_CHUNK_CHARS);
    const total = Math.max(1, chunks.length);

    setTranslating(true);
    setTranslateStep('');
    try {
      let enTitle = '';
      let enExcerpt = '';
      /** 名词对照表：第 1 段的产物，后面每一段都要带上，否则同一个角色会翻成两个名字 */
      let glossary = '';
      const enBodies: string[] = [];
      const warnings: string[] = [];

      for (let i = 0; i < total; i++) {
        const part = i + 1;
        // 只有多段才显示进度 —— 单段就是一次普通翻译，别多给一行噪音
        if (total > 1) setTranslateStep(`正在翻译第 ${part}/${total} 段…`);
        const data = await translatePart({
          title: titleZh.trim() || zhText.slice(0, 30),
          excerpt: excerptZh,
          // 多段时只发这一段；单段沿用老路子（整篇 HTML 一起发）
          ...(total > 1 ? {} : { html: zhBody }),
          fullText: zhText.slice(0, 20000),
          text: chunks[i],
          part,
          parts: total,
          // 上一段英文的尾巴：让它从断掉的地方接上，而不是自己另起一段
          prevTail: htmlToPlainText(enBodies.join('\n')).slice(-400),
          glossary,
        });
        if (data.title) enTitle = String(data.title);
        if (data.excerpt) enExcerpt = String(data.excerpt);
        if (data.glossary) glossary = String(data.glossary);
        if (data.html) enBodies.push(String(data.html));
        if (Array.isArray(data.warnings)) warnings.push(...data.warnings.map(String));
        // 每一段都写回编辑器：万一第 4 段失败，前 3 段已经能看到，不用从头再来
        if (total > 1) {
          const partial = enBodies.join('\n')
          if (isMostlyChinese(htmlToPlainText(partial), 20)) {
            throw new Error(`第 ${part} 段翻译结果仍然是中文，已停止并保留原来的英文版`)
          }
          enHtmlRef.current = partial;
          if (active === 'en') editor.commands.setContent(partial);
        }
      }

      const enHtml = enBodies.join('\n');
      if (!enHtml.trim()) throw new Error('没有拿到英文正文，请重试一次');
      // 模型偶尔会把中文原样吐回来（或者只翻了一半）。这份内容一旦写进
      // content_html，前台又会挂中文 —— 宁可不落位，让站长重试。
      if (isMostlyChinese(htmlToPlainText(enHtml), 20)) {
        throw new Error('翻译结果仍然是中文，已拦下（没有覆盖现有英文版）。请检查模型配置后重试一次');
      }

      enHtmlRef.current = enHtml;
      if (enTitle) setTitle(enTitle);
      if (enExcerpt) setExcerpt(enExcerpt);
      setTranslatedAt(new Date().toISOString());
      // 页签 + 正文一次切过去：绝不能再出现「页签是英文、编辑器里还是中文」
      // 或反过来的错位（本次线上故障的根因）。
      switchLang('en', enHtml);
      // 中文标题生成的网址是一串横杠 —— 既然有了英文标题，顺手把网址修好
      if (!isUsableSlug(slug)) {
        const fixed = buildArticleSlug(enTitle || title);
        if (fixed) setSlug(fixed);
      }
      warnings.forEach((w) => showToast(w, 'error'));
      showToast(
        total > 1
          ? `英文版已就绪（中文 ${countChineseChars(zhText)} 字，分 ${total} 段翻完）—— 记得点右上角「保存」`
          : '英文版已就绪 —— 记得点右上角「保存」',
        'success'
      );

      // 自动补封面：只在「这篇文章本来就没有封面」时做。
      // generateCover 内部还会再看一次 coverUrlRef（翻译期间站长可能手动传了图），
      // 所以不会覆盖任何人工选择。
      if (!coverUrlRef.current.trim()) {
        void runCoverGeneration({
          title: enTitle || title,
          excerpt: enExcerpt,
          html: enHtml,
          language: 'en',
          auto: true,
        });
      }
    } catch (e: any) {
      showToast(e?.message || '翻译失败', 'error');
    } finally {
      setTranslating(false);
      setTranslateStep('');
    }
  };

  /* ---------------- AI 创作面板回填 ---------------- */

  // 生成好中文稿 → 写进中文页签（英文版原封不动，等你去翻译）
  const handleComposerApply = (story: GeneratedStory) => {
    if (!editor) return;
    captureActiveBody(langRef.current);
    zhHtmlRef.current = story.html;
    setTitleZh(story.title);
    setExcerptZh(story.excerpt);
    setZhReady(true);
    switchLang('zh', story.html);
    setComposerOpen(false);
    showToast('中文稿已写进编辑器 —— 定稿后点「母语化重写 → 英文」', 'success');
  };

  // 「接着写下去」：把新段落接在中文正文末尾
  const handleComposerAppend = (html: string) => {
    if (!editor) return;
    const active = langRef.current;
    const current = active === 'zh' ? editor.getHTML() : zhHtmlRef.current;
    const merged = `${current}${html}`;
    zhHtmlRef.current = merged;
    switchLang('zh', merged);
    setZhReady(true);
  };

  /** 骰子：随机换一个编辑身份（避开当前这个，免得连抽两次是同一个人） */
  const randomizeAuthor = () => {
    const next = randomEditorPersona(authorName);
    setAuthorName(next.name);
    setAuthorAvatar(next.avatar);
    showToast(`已随机切换编辑身份：${next.name} · ${next.role}`, "success");
  };

  /** 从 20 组名册里点选一组（名字 + 头像一起换，保持搭配） */
  const applyPersona = (persona: EditorPersona) => {
    setAuthorName(persona.name);
    setAuthorAvatar(persona.avatar);
    showToast(`发布身份：${persona.name} · ${persona.role}`, "success");
  };

  /**
   * 话题矩阵是多选：点一下加入，再点一下移出。
   * 第一个选中的话题是「主话题」（article.category / 前台卡片标题位），
   * 剩下的作为 tags 展示（卡片显示「主话题 +N」）。
   */
  const toggleCat = (cat: string) => {
    setSelectedCats(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]);
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
      // 服务端保存成功后顺手敲了前台的门（app/api/admin/categories/reorder）——
      // 前台 /briefs 是 ISR（revalidate = 60）：通知到了就是立刻，没配变量就最多一分钟
      showToast(
        json?.frontend?.ok
          ? '话题顺序已保存 —— 前台已同步刷新'
          : '话题顺序已保存 —— 前台最多一分钟后按这个顺序排',
        'success'
      );
    } catch (e: any) {
      setAvailableCats(previous);
      showToast(e?.message || '保存顺序失败', 'error');
    }
  };

  /**
   * 从话题矩阵里删掉一个话题。
   *
   * 删话题不只是删掉 `categories` 里那一行 —— 前台页签是按文章的
   * `categories[]` 现算的，所以服务端会**先逐篇把这个话题从数组里摘掉
   * （摘空了才并进兜底话题「Other」），再删话题本身**
   * （见 app/api/admin/categories/delete/route.ts）。
   * 不这么做，文章会留着一个没人认识的值，前台照样多出一个页签。
   *
   * 顺序与拖动排序一致：先改界面给反馈，落库失败就把话题放回原位。
   */
  const removeCat = async (cat: string) => {
    const confirmed = window.confirm(
      `删除话题「${cat}」后，它会从所有文章的 tags 里移除；只有这个话题的文章会并进「Other」。确定删除吗？`
    );
    if (!confirmed) return;

    const previousCats = availableCats;
    const previousSelected = selectedCats;
    setAvailableCats(prev => prev.filter(c => c !== cat));
    setSelectedCats(prev => prev.filter(c => c !== cat));

    try {
      const token = await getFreshAccessToken();
      if (!token) throw new Error('登录状态失效，请刷新页面重新登录');
      const resp = await fetch('/api/admin/categories/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: cat }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || !json?.ok) throw new Error(json?.error || `删除话题失败（${resp.status}）`);
      const moved = Number(json?.moved) || 0;
      // 前台页签的真源就是后台话题矩阵，所以删掉这一行，前台就再也不会出现它；
      // 名下的文章已由服务端并进兜底话题「Other」。缓存那边服务端也顺手通知了。
      const where = json?.frontend?.ok ? '，前台已同步刷新' : '，前台最多一分钟后更新';
      showToast(
        moved > 0
          ? `已删除「${cat}」，${moved} 篇文章已移除该话题${where}`
          : `已删除「${cat}」${where}`,
        'success'
      );
    } catch (e: any) {
      setAvailableCats(previousCats);
      setSelectedCats(previousSelected);
      showToast(e?.message || '删除话题失败', 'error');
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
    if (availableCats.some(c => c.toLowerCase() === trimmed.toLowerCase())) {
      showToast('该话题分类已存在', 'error');
      return;
    }
    setAvailableCats(prev => [...prev, trimmed]);
    setSelectedCats(prev => prev.some(c => c.toLowerCase() === trimmed.toLowerCase()) ? prev : [...prev, trimmed]);
    setNewCatInput('');
    showToast('新话题已加入矩阵并选中', 'success');
  };

  const handleSave = async () => {
    // 先把编辑器里这一边落回 ref，再决定两边各自是什么。
    // 只看 `lang` state 的话，翻译刚结束 / 页签刚切完的那一帧会写反。
    const activeNow = langRef.current;
    captureActiveBody(activeNow);

    // 标题看的是"当前页签"那一边：在中文页签只填了中文标题也算填了
    const titleNow = activeNow === 'zh' ? titleZh : title;
    if (!titleNow.trim()) {
      showToast(activeNow === 'zh' ? '请先填中文标题（或切到 English 页签填英文标题）' : '请输入文章标题', 'error');
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

    // 保存前再抹一次「错列」：content_html 必须是英文，中文只能待在
    // content_zh_html。这段与载入时的 resolveBilingualDraft 是同一套规则，
    // 所以「打开时救回来的中文」在保存时不会被写回英文列。
    const draft = resolveBilingualDraft({
      titleEn: title,
      titleZh,
      excerptEn: excerpt,
      excerptZh,
      htmlEn: enHtmlRef.current,
      htmlZh: zhHtmlRef.current,
    });
    if (draft.recovered) {
      enHtmlRef.current = draft.htmlEn;
      zhHtmlRef.current = draft.htmlZh;
      showToast('已把中文正文从英文列挪回「中文原稿」，本次保存会修正前台内容', 'info');
    }

    // 🛑 发布护栏：英文那一版还是空的（或只有中文稿）就别让前台发出一篇空文章
    //    判断只看「英文正文」——标题有、正文空，读者一样是点开一篇空文。
    const enBodyText = htmlToPlainText(draft.htmlEn);
    const englishEmpty = enBodyText.length < 40;
    if ((postStatus === 'published' || postStatus === 'scheduled') && englishEmpty && !guardOverrideRef.current) {
      setPublishGuard(true);
      return;
    }

    setSaving(true);
    try {
      // 翻译后的自动封面可能还在画。先等它，避免封面刚回来、页面已经跳走。
      const pendingCover = coverTaskRef.current;
      if (pendingCover) {
        showToast('AI 封面还在生成，保存会等它完成…', 'info');
        await pendingCover;
      }
      const token = await getFreshAccessToken();
      if (!token) {
        showToast('登录失效，保存副本中...', 'error');
        return;
      }

      const currentIsoTime = new Date().toISOString();
      // categories / category 双写：category 保留为主话题，兼容只读这一列的
      // 旧页面与 SEO 字段；categories 才是编辑页这次多选的真源。
      const primaryCategory = selectedCats[0] || 'Other';
      const savedCategories = selectedCats.length > 0 ? selectedCats : [primaryCategory];
      const payload: any = {
        title: draft.titleEn,
        excerpt: draft.excerptEn,
        cover_url: coverUrlRef.current,
        cover_url_share: coverUrlShareRef.current,
        author_name: authorName,
        author_avatar: authorAvatar,
        category: primaryCategory,
        categories: savedCategories,
        labels: selectedLabels,
        status: postStatus,
        // ⚠️ 这里必须用「英文那一版」：中文页签下编辑器里装的是中文稿，不能存进 content_html
        content_html: draft.htmlEn,
        scheduled_at: postStatus === 'scheduled' ? new Date(scheduledAt).toISOString() : null,
        // 编辑页只提供 draft / published / scheduled 三态，能走到这里就说明
        // 这次保存已经让内容重新处于已知状态 —— 之前定时失败留下的原因必须清掉，
        // 否则库里会一直挂着一条早就解决的 publish_error。
        publish_error: null,
      };

      // 🌐 中文原稿一并保存（前台永远读 title / excerpt / content_html 这三列英文）
      const zhHtmlNow = draft.htmlZh;
      payload.title_zh = draft.titleZh || null;
      payload.excerpt_zh = draft.excerptZh || null;
      payload.content_zh_html = zhHtmlNow || null;
      payload.story_combo = storyCombo || null;
      if (translatedAt) payload.translated_at = translatedAt;
      const zhChanged =
        zhHtmlNow !== lastSavedZhRef.current.html ||
        draft.titleZh !== lastSavedZhRef.current.title ||
        draft.excerptZh !== lastSavedZhRef.current.excerpt;
      if (zhChanged) payload.zh_updated_at = currentIsoTime;
      
      if (articleId) {
        if (postStatus === 'published') {
          payload.published_at = currentIsoTime;
        }
        if (!isUsableSlug(slug)) {
          // 中文标题建出来的文章，网址是一串横杠 —— 既然有英文标题了就顺手修好
          const fixedSlug = buildArticleSlug(draft.titleEn);
          if (fixedSlug) payload.slug = fixedSlug;
        }
      }

      // 新文章：网址一律用英文标题生成（中文标题只会生成一串横杠）
      const newSlug = articleId
        ? ''
        : buildArticleSlug(draft.titleEn) ||
          `post-${Date.now().toString(36)}${Math.random().toString(36).substring(2, 5)}`;

      const writeArticle = async (body: any) => {
        if (articleId) return await supabase.from('articles').update(body).eq('id', articleId);
        return await supabase.from('articles').insert({
          ...body,
          slug: newSlug,
          published_at: postStatus === 'published' ? currentIsoTime : null,
        });
      };

      // 先按新结构写；如果线上还没跑 45 号迁移（articles.categories 不存在），
      // 单话题文章降级成旧字段 category 照常保存，别让一次缺列把发布整个卡死。
      // 多话题不能降级 —— 那会悄悄丢掉站长勾选的话题，必须明确要求先跑迁移。
      let categoriesDropped = false;
      let writeResult = await writeArticle(payload);
      if (writeResult.error && isMissingCategoriesColumnError(writeResult.error)) {
        if (savedCategories.length > 1) {
          throw new Error(`${CATEGORIES_MIGRATION_HINT} 当前选择了多个话题，无法降级保存。`);
        }
        const legacyPayload = { ...payload };
        delete legacyPayload.categories;
        categoriesDropped = true;
        writeResult = await writeArticle(legacyPayload);
      }
      if (writeResult.error) throw writeResult.error;

      lastSavedZhRef.current = { html: zhHtmlNow, title: draft.titleZh, excerpt: draft.excerptZh };
      if (zhChanged) setZhUpdatedAt(currentIsoTime);
      if (categoriesDropped) {
        showToast(`文章已保存；${CATEGORIES_MIGRATION_HINT} 本次只写入了主话题。`, 'info');
      } else if (articleId) {
        showToast('文章大动脉修改同步成功！', 'success');
      } else {
        showToast('新热点文章已全盘发布上线！🚀', 'success');
      }
      setTimeout(() => router.push('/admin/trends'), categoriesDropped ? 2800 : 1200);

      // 走到这里说明文章确实写进库了 —— 现在才补话题、才通知前台刷新。
      // 顺序不能反：先补话题再写文章，中途失败就会留下「后台矩阵有、文章没有」
      // 的孤儿话题（见 upsertCategories 的注释）。
      await upsertCategories(supabase, selectedCats);
      await pingFrontendRevalidate(token);
    } catch (e: any) {
      const msg = String(e?.message || '');
      // 原始 PostgREST 报错只有英文「schema cache」，站长看不懂也不会知道要跑哪份 SQL。
      if (isMissingCategoriesColumnError(e)) {
        showToast(CATEGORIES_MIGRATION_HINT, 'error');
      } else {
        showToast(`操作失败: ${msg}`, 'error');
      }
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

      {/* 浮动通知 —— 错误可能是一整句话（「哪个模型被限流、多久恢复」），
          所以给它一个最大宽度并允许换行；点一下就能收掉，不用干等它自己消失 */}
      {notice && (
        <div
          onClick={() => setNotice(null)}
          className={`fixed top-24 left-1/2 -translate-x-1/2 z-[100] px-7 py-4 rounded-3xl shadow-2xl font-black text-[11px] leading-relaxed tracking-normal whitespace-pre-line text-center max-w-[min(560px,92vw)] break-words cursor-pointer animate-in fade-in slide-in-from-top-4 ${notice.type === 'success' ? 'bg-slate-900 text-white' : notice.type === 'info' ? 'bg-amber-500 text-white' : 'bg-rose-500 text-white'}`}
        >
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
        onClick={() => handleTranslate()}
        disabled={translating}
        className={`h-10 px-5 rounded-2xl text-[10px] font-black uppercase tracking-wider flex items-center gap-2 transition-all ${
          translating ? 'bg-slate-100 text-slate-400' : 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100'
        }`}
      >
        {translating ? <Loader2 size={13} className="animate-spin" /> : <Languages size={13} />}
        {translating ? (translateStep || '母语化重写中…') : hasEn ? '重新翻译成英文' : '母语化重写 → 英文'}
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
          {/* 🩺 AI 自检：平时收起成一行；AI 报错时点开就能看见「谁挂了、哪把 Key 缺了」 */}
          <AiHealthCard />
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
                      title="点一下加入 / 移出；第一个选中的是主话题；按住拖动可以调整页签顺序"
                      className={`px-5 py-2.5 rounded-[18px] text-[9px] font-black uppercase tracking-widest transition-all ${
                        selectedCats.includes(cat) ? 'bg-slate-900 text-white shadow-xl scale-105' : 'bg-slate-50 text-slate-400 hover:bg-slate-100'
                      } ${isDragging ? 'opacity-40 cursor-grabbing' : 'cursor-grab'} ${
                        isDropTarget ? 'ring-2 ring-indigo-400 ring-offset-2 scale-105' : ''
                      }`}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {cat}
                        {selectedCats.includes(cat) && (
                          <span className={`text-[7px] px-1.5 py-0.5 rounded-full ${selectedCats.indexOf(cat) === 0 ? 'bg-emerald-400 text-slate-900' : 'bg-white/20 text-white'}`}>
                            {selectedCats.indexOf(cat) === 0 ? '主' : `#${selectedCats.indexOf(cat) + 1}`}
                          </span>
                        )}
                      </span>
                    </button>
                    {/* 兜底话题「Other」不给删：其他话题的文章都要并进它
                        （服务端 app/api/admin/categories/delete 也会拦一道） */}
                    {isEditingCats && cat.toLowerCase() !== 'other' && (
                      <button 
                        type="button"
                        onClick={() => void removeCat(cat)} 
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
               可多选：第一个选中的是主话题，卡片显示「主话题 +N」。拖动标签调整的是前台页签的先后顺序。
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

          {/* 视觉封面 (Cover)：本地上传 + AI 生成（AI 只在没有封面时自动补） */}
          <section className="bg-white rounded-[40px] p-8 border border-slate-100 shadow-sm group">
            <div className="flex items-center justify-between gap-3 mb-6">
              <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-slate-400 italic text-left">视觉封面 (Cover)</h3>
              {generatingCover && (
                <span className="inline-flex items-center gap-1.5 text-[8px] font-black uppercase tracking-widest text-cyan-500">
                  <Loader2 size={11} className="animate-spin" /> AI 绘制中
                </span>
              )}
            </div>
            {coverUrl ? (
              <>
                <div className="relative rounded-[32px] overflow-hidden aspect-video border-4 border-slate-50 shadow-2xl group transition-all">
                  <img src={coverUrl} className="w-full h-full object-cover" alt="cover" />
                  <div className="absolute inset-0 bg-slate-900/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3">
                    <button
                      type="button"
                      onClick={clearCover}
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
                <button
                  type="button"
                  onClick={() => void runCoverGeneration()}
                  disabled={generatingCover || uploading}
                  className="mt-3 w-full h-10 rounded-2xl bg-slate-900 text-white text-[9px] font-black uppercase tracking-widest inline-flex items-center justify-center gap-2 hover:bg-cyan-600 transition-all disabled:opacity-50"
                >
                  {generatingCover ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                  {generatingCover ? '正在重绘…' : 'AI 重绘封面'}
                </button>
              </>
            ) : (
              <div className="w-full aspect-video border-4 border-dashed border-slate-100 rounded-[32px] flex flex-col items-center justify-center gap-3 bg-slate-50/50">
                {uploading || generatingCover ? (
                  <Loader2 className="animate-spin text-cyan-500" size={32} />
                ) : (
                  <>
                    <ImageIcon size={30} className="text-slate-200" />
                    <span className="text-[9px] font-black uppercase text-slate-300 italic">还没有封面</span>
                  </>
                )}
              </div>
            )}

            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => coverFileInputRef.current?.click()}
                disabled={uploading || generatingCover}
                className="h-10 rounded-2xl border border-slate-200 text-slate-500 text-[9px] font-black uppercase tracking-wider inline-flex items-center justify-center gap-1.5 hover:border-cyan-400 hover:text-cyan-600 transition-all disabled:opacity-50"
              >
                <Upload size={12} /> 本地上传
              </button>
              <button
                type="button"
                onClick={() => void runCoverGeneration()}
                disabled={uploading || generatingCover}
                className="h-10 rounded-2xl bg-cyan-50 text-cyan-600 text-[9px] font-black uppercase tracking-wider inline-flex items-center justify-center gap-1.5 hover:bg-cyan-100 transition-all disabled:opacity-50"
              >
                {generatingCover ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                AI 生成
              </button>
            </div>
            <p className="mt-3 text-[8px] font-bold leading-relaxed text-slate-300 text-left">
              AI 会结合标题、摘要、正文开头与所选话题构图：主话题决定主体，其余话题补充环境与氛围。翻译成功且当前没有封面时会自动生成一张；手动上传或已经生成过的封面不会被覆盖。
            </p>
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
               <div className="flex items-center gap-2">
                 <button
                   type="button"
                   onClick={() => setAuthorPickerOpen((v) => !v)}
                   className={`px-3 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all ${
                     authorPickerOpen ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                   }`}
                 >
                   {authorPickerOpen ? '收起' : `名册 ${EDITOR_PERSONAS.length}`}
                 </button>
                 <button type="button" onClick={randomizeAuthor} title="随机换一个编辑身份" className="p-2 bg-indigo-50 text-indigo-600 rounded-xl hover:rotate-180 transition-all duration-500"><Dice5 size={18} /></button>
               </div>
             </div>
             <div className="flex items-center gap-5 p-6 bg-slate-50 rounded-[32px] border border-slate-100 text-left">
                <img src={authorAvatar} className="w-16 h-16 rounded-full border-4 border-white shadow-lg bg-white object-cover" alt="avatar" />
                <div className="flex-1 overflow-hidden">
                   <input
                     value={authorName}
                     onChange={(e) => setAuthorName(e.target.value)}
                     placeholder="署名"
                     className="w-full bg-transparent font-black text-slate-900 text-sm truncate outline-none border-b border-transparent focus:border-indigo-200 transition-all"
                   />
                   <p className="text-[8px] font-black text-indigo-500 uppercase tracking-widest mt-1 italic">Verified Partner</p>
                </div>
             </div>

             {authorPickerOpen && (
               <div className="mt-4 space-y-3">
                 <p className="text-[9px] font-bold text-slate-400 leading-relaxed text-left">
                   名字和头像是配套的：点一组就整组换过来，也可以直接改上面那行署名。
                 </p>
                 <div className="max-h-72 overflow-y-auto grid grid-cols-2 gap-2 pr-1">
                   {EDITOR_PERSONAS.map((persona) => {
                     const active = authorName.trim().toLowerCase() === persona.name.toLowerCase();
                     return (
                       <button
                         key={persona.name}
                         type="button"
                         onClick={() => applyPersona(persona)}
                         title={persona.role}
                         className={`flex items-center gap-3 p-3 rounded-2xl border text-left transition-all ${
                           active ? 'border-indigo-300 bg-indigo-50' : 'border-slate-100 bg-white hover:border-slate-300'
                         }`}
                       >
                         <img src={persona.avatar} alt="" className="w-9 h-9 rounded-full bg-slate-100 shrink-0" />
                         <span className="min-w-0">
                           <span className="block text-[11px] font-black text-slate-800 truncate">{persona.name}</span>
                           <span className="block text-[8px] font-bold text-slate-400 uppercase tracking-wider truncate">{persona.role}</span>
                         </span>
                       </button>
                     );
                   })}
                 </div>
               </div>
             )}
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
                onClick={() => { setPublishGuard(false); switchLang('zh'); handleTranslate({ activeLang: 'zh' }); }}
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
        sourceArticleId={articleId}
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