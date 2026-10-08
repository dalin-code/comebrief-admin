'use client'

import Link from 'next/link'
import { useEffect, useState, useMemo, useCallback } from 'react'
import { 
  Eye, Pencil, Plus, Search, Trash2, X, Loader2, Clock, Zap, 
  Layers, CheckSquare, Square, Tag, Sparkles, TrendingUp, Globe, Star, AlertCircle
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import {
  effectiveStatus,
  markPublishedLocally,
  publishedAtOf,
  publishDueRows,
} from '@/lib/scheduled'

// --- 🚀 1. 核心配置 ---
const MASTER_CATEGORIES = ['Entertainment', 'Leisure', 'Emotion', 'Tech', 'Learning', 'Travel', 'AI', 'Animals', 'Home Decor', 'Gaming'];
const EDITORS = [
  { name: 'Dalin Lu', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Dalin' },
  { name: 'Nexus AI', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=Nexus' },
  { name: 'Alex Rivera', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Alex' },
  { name: 'Elena Rod', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Elena' }
];

// --- 🚀 1.1 列表列定义 ---
// RICH 依赖阶段 0 的 SQL（10_schema.sql）新增的字段；BASE 是永远存在的保底列。
// 若 RICH 查询报「列不存在」，自动降级到 BASE，保证页面不会整体崩掉。
const ARTICLE_COLS_RICH =
  'id, title, slug, status, cover_url, category, created_at, published_at, scheduled_at, is_featured, featured_order, publish_error';
const ARTICLE_COLS_BASE = 'id, title, slug, status, cover_url, category, created_at';

async function fetchArticleRows() {
  // 显式标注 any：降级查询返回的列更少，与 RICH 的形状不同，
  // 让 TS 去比较两者的类型毫无意义。
  let res: any = await supabase
    .from('articles')
    .select(ARTICLE_COLS_RICH)
    .order('created_at', { ascending: false });

  if (res.error && /Could not find|does not exist/i.test(String(res.error.message || ''))) {
    console.warn('[trends] 主推/定时字段不可用，降级为基础列：', res.error.message);
    res = await supabase
      .from('articles')
      .select(ARTICLE_COLS_BASE)
      .order('created_at', { ascending: false });
  }

  if (res.error) throw res.error;
  return (res.data || []) as any[];
}

// --- 🚀 1.2 状态徽章 ---
// 后台里 status 现在有四种取值，之前只用「published / 其它」两色区分，
// 定时内容会和草稿混在一起看不出来。
const STATUS_STYLE: Record<string, string> = {
  published: 'bg-emerald-100 text-emerald-600',
  scheduled: 'bg-indigo-100 text-indigo-600',
  draft: 'bg-amber-100 text-amber-600',
  failed: 'bg-rose-100 text-rose-600',
};

const STATUS_LABEL: Record<string, string> = {
  published: '已发布',
  scheduled: '定时',
  draft: '草稿',
  failed: '失败',
};

const formatDateTime = (value?: string | null) => {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

// --- 🚀 2. 深度拟人长文引擎 ---
const getSoulfulProse = (cat: string, title: string) => {
  const content = `
    <p>As we navigate the shifting landscape of mid-2026, the <strong>${cat}</strong> sector has reached a critical inflection point. This intelligence report deep dives into the neural shifts and economic ripples caused by recent market deployments. This is not merely a technical upgrade; it's a fundamental rewrite of the operative logic that defines how global users interact with information fragments.</p>
    <h2>The Architecture of Disruption</h2>
    <p>The core disruption within ${cat} is driven by what experts call "Fluid Intent Synthesis." Unlike the static models of the previous decade, today's nodes possess a persistent inner monologue—a secondary processing layer that evaluates outcomes before generating a response. This creates a psychological depth that mimics human hesitation, a pause in the digital pulse that signals the birth of discretion.</p>
    <p>Technical benchmarks from Q2 2026 indicate a 400% increase in integration across Western markets. This transition marks the end of high-friction interaction and the birth of cognitive environments where the user and the system breathe in sync.</p>
    <blockquote>"The matrix is no longer a tool; it is the landscape of our soul. We are the architects of its intent," says the lead contributor to this ${cat} study.</blockquote>
    <h3>Strategic Outlook 2027</h3>
    <p>The economic ripples are being felt globally. Early adopters report a 300% increase in alignment metrics. Furthermore, the democratization of high-tier intelligence has allowed 1-person agencies to compete directly with Fortune 500 incumbents. Looking toward 2027, the roadmap suggests a full merger with Spatial OS 3.0, moving interaction from 2D screens into volumetric, intent-driven spaces.</p>
  `;
  // 重复拼接确保视觉字数够厚
  return `<div class="premium-node"><h1>${title}</h1>${content}${content}</div>`;
};

export default function TrendsManagementHub() {
  const [rows, setRows] = useState<any[]>([]);
  const [busy, setBusy] = useState(true);
  const [q, setQ] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  
  // 预览专用状态
  const [previewData, setPreviewData] = useState<any>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  // 「立即检查定时队列」按钮的忙碌态
  const [publishing, setPublishing] = useState(false);

  // --- 🚀 A. 加载数据 + 到点自愈 + 静默补齐分类 ---
  const loadData = useCallback(async () => {
    setBusy(true);
    try {
      let data = await fetchArticleRows();

      // 到点的定时内容先真正翻成 published，再落到本地状态。
      // 不翻的话就会出现「前台已经能看到、后台还写着定时」的不一致；
      // 这里的 published_at 取 scheduled_at，与 /api/cron/publish 的策略一致。
      // 写库失败（未登录 / RLS 拒绝）不阻断列表 —— 展示层还有 effectiveStatus 兜底。
      const { flipped } = await publishDueRows(supabase, 'articles', data);
      data = markPublishedLocally(data, flipped);

      // 历史数据里 category 为空的记录，静默补成 'AI' 后再刷新一次
      if (data.some(r => !r.category)) {
        await supabase.from('articles').update({ category: 'AI' }).is('category', null);
        setRows(await fetchArticleRows());
      } else {
        setRows(data);
      }
    } catch (e) { console.error(e); } finally { setBusy(false); }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // --- 🚀 A2. 手动检查定时队列 ---
  // 外部调度器（/api/cron/publish + GitHub Actions / Vercel Cron）没配好或漏跑时，
  // 这是「到点就发布」的兜底入口：立即把库里已到点的定时内容翻成 published。
  const handlePublishDue = async () => {
    setPublishing(true);
    try {
      const fresh = await fetchArticleRows();
      const { flipped, failed } = await publishDueRows(supabase, 'articles', fresh);
      if (flipped.length) await loadData();

      const lines = [
        flipped.length ? `已发布 ${flipped.length} 篇到点内容` : '没有到点待发布的定时内容',
        failed.length ? `${failed.length} 篇发布失败：${failed[0].error}` : '',
      ].filter(Boolean);
      alert(lines.join('\n'));
    } catch (e: any) {
      alert(`检查定时队列失败：${e?.message || e}`);
    } finally {
      setPublishing(false);
    }
  };

  // --- 🚀 B. 实时预览逻辑：精准抓取正文 (修复点) ---
  const handleOpenPreview = async (id: string) => {
    setPreviewBusy(true);
    try {
      const { data, error } = await supabase.from('articles').select('*').eq('id', id).single();
      if (error) throw error;
      setPreviewData(data); // 此时 data 包含完整的 content_html
    } catch (e) { alert("预览内容拉取失败"); } finally { setPreviewBusy(false); }
  };

  // --- 🚀 C. 趋势调研生成 ---
  const handlePremiumSync = async () => {
    if (!confirm("开始执行趋势调研并同步 3 篇深度资讯？")) return;
    setBusy(true);
    try {
      const selectedCats = [...MASTER_CATEGORIES].sort(() => Math.random() - 0.5).slice(0, 3);
      const selectedAuthors = [...EDITORS].sort(() => Math.random() - 0.5).slice(0, 3);
      
      const payload = selectedCats.map((cat, idx) => {
        const author = selectedAuthors[idx];
        const title = `${cat} Frontiers: The 2026 Strategic Evolution`;
        return {
          id: crypto.randomUUID(),
          title,
          excerpt: `A comprehensive intelligence report on ${cat} verified by ${author.name}.`,
          category: cat,
          author_name: author.name,
          author_avatar: author.avatar,
          status: 'published',
          published_at: new Date(Date.now() - (idx * 20 * 3600000)).toISOString(),
          content_html: getSoulfulProse(cat, title),
          slug: cat.toLowerCase() + '-' + Math.random().toString(36).slice(2, 7)
        };
      });
      await supabase.from('articles').insert(payload);
      loadData();
    } catch (e: any) { alert(e.message); } finally { setBusy(false); }
  };

  // --- 🚀 D. 删除逻辑 ---
  const onDelete = async (id: string) => {
    if (!confirm("粉碎此条资讯？")) return;
    await supabase.from('articles').delete().eq('id', id);
    loadData();
  };

  const onBatchDelete = async () => {
    if (!confirm(`确认粉碎选中的 ${selectedIds.length} 项？`)) return;
    await supabase.from('articles').delete().in('id', selectedIds);
    setSelectedIds([]);
    loadData();
  };

  // --- 🚀 E. 主推位切换（is_featured / featured_order） ---
  // 置顶时把 featured_order 设为当前最小值 - 1，保证最新勾选的排最前；
  // 取消时归零。先做乐观更新，失败再回滚重拉。
  const toggleFeatured = async (row: any) => {
    const next = !row.is_featured;
    const minOrder = rows.reduce(
      (min, r) => (r.is_featured ? Math.min(min, Number(r.featured_order) || 0) : min),
      0
    );
    const payload = next
      ? { is_featured: true, featured_order: minOrder - 1 }
      : { is_featured: false, featured_order: 0 };

    setRows(prev => prev.map(r => (r.id === row.id ? { ...r, ...payload } : r)));

    const { error } = await supabase.from('articles').update(payload).eq('id', row.id);
    if (error) {
      alert(`主推切换失败：${error.message}`);
      loadData();
    }
  };

  const filtered = useMemo(() => rows
    // 展示状态与前台可见性规则对齐：到点的定时内容按「已发布」显示，
    // 这样后台看到的徽章和访客在 ComeBrief 上看到的永远一致。
    .map(r => ({ ...r, display_status: effectiveStatus(r) }))
    .filter(r => (r.title || '').toLowerCase().includes(q.toLowerCase()) || (r.category || '').toLowerCase().includes(q.toLowerCase())), [q, rows]);

  return (
    <div className="min-h-screen bg-[#F8FAFC] p-4 md:p-10 font-sans selection:bg-emerald-500/30 text-slate-900">
      <div className="max-w-7xl mx-auto">
        <header className="flex flex-col md:flex-row justify-between items-start md:items-end mb-12 gap-6">
          <div className="space-y-2">
            <h1 className="text-4xl md:text-5xl font-black italic tracking-tighter uppercase">TRENDS <span className="text-slate-200">/</span> <span className="text-emerald-500">MATRIX</span></h1>
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400">Content Control Center</p>
          </div>
          <div className="flex gap-3 w-full md:w-auto">
            <button onClick={handlePublishDue} disabled={publishing} title="把已到点的定时内容立即翻为已发布（外部定时器漏跑时的兜底入口）" className="flex-1 md:flex-none h-14 px-6 bg-white border border-slate-200 rounded-[20px] flex items-center justify-center gap-3 font-black text-[10px] uppercase hover:bg-slate-50 transition-all disabled:opacity-60"><Zap size={16} className="text-amber-500"/> {publishing ? 'Publishing...' : 'Publish Due'}</button>
            <button onClick={handlePremiumSync} className="flex-1 md:flex-none h-14 px-6 bg-white border border-slate-200 rounded-[20px] flex items-center justify-center gap-3 font-black text-[10px] uppercase hover:bg-slate-50 transition-all"><Sparkles size={16} className="text-indigo-500"/> AI Premium x3</button>
            <Link href="/admin/trends/edit" className="h-14 bg-slate-900 text-white px-8 rounded-[24px] flex items-center justify-center gap-3 font-black hover:bg-emerald-600 transition-all shadow-xl shadow-emerald-500/10 active:scale-95 group"><Plus size={20} /><span>NEW POST</span></Link>
          </div>
        </header>

        {selectedIds.length > 0 && (
          <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-[100] bg-slate-900 text-white px-8 py-5 rounded-[32px] shadow-2xl flex items-center gap-8 animate-in slide-in-from-bottom-10 border border-white/10 backdrop-blur-xl">
            <span className="font-black italic text-emerald-400 uppercase tracking-widest text-sm">{selectedIds.length} Nodes</span>
            <button onClick={onBatchDelete} className="flex items-center gap-2 text-rose-400 font-black uppercase text-[10px] tracking-widest"><Trash2 size={16} /> Bulk Shred</button>
            <button onClick={() => setSelectedIds([])} className="p-2 hover:bg-white/10 rounded-full"><X size={18}/></button>
          </div>
        )}

        <div className="mb-8 relative group"><Search className="absolute left-6 top-1/2 -translate-y-1/2 text-slate-400" size={20} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search..." className="w-full h-16 pl-16 pr-6 bg-white border border-slate-200 rounded-[28px] focus:border-emerald-500/50 outline-none transition-all shadow-sm font-medium" /></div>

        <div className="bg-white rounded-[44px] border border-slate-200 overflow-hidden shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-slate-50/50 border-b border-slate-100 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">
                  <th className="px-8 py-7 w-12 text-center"><button onClick={() => setSelectedIds(selectedIds.length === filtered.length ? [] : filtered.map(r=>r.id))}><CheckSquare size={20} /></button></th>
                  <th className="px-6 py-7">Visual</th>
                  <th className="px-6 py-7">Intelligence</th>
                  <th className="px-6 py-7">Classification</th>
                  <th className="px-6 py-7 text-center">Featured</th>
                  <th className="px-6 py-7">Timeline</th>
                  <th className="px-8 py-7 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filtered.map(r => (
                  <tr key={r.id} className={`group transition-all duration-300 ${selectedIds.includes(r.id) ? 'bg-emerald-50/40' : 'hover:bg-slate-50/60'}`}>
                    <td className="px-8 py-7 text-center">
                      <button onClick={() => setSelectedIds(prev => prev.includes(r.id) ? prev.filter(id=>id!==r.id) : [...prev, r.id])} className={selectedIds.includes(r.id) ? 'text-emerald-500' : 'text-slate-300'}><CheckSquare size={20} /></button>
                    </td>
                    <td className="px-6 py-7">
                      <div className="w-20 h-12 rounded-xl bg-slate-100 overflow-hidden border border-slate-200 shadow-inner">
                        {r.cover_url ? <img src={r.cover_url} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-slate-300"><Layers size={16}/></div>}
                      </div>
                    </td>
                    <td className="px-6 py-7">
                      <div className="font-black text-slate-800 text-lg leading-tight line-clamp-1 group-hover:text-emerald-600 transition-colors">{r.title || 'Untitled'}</div>
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        <span className={`text-[8px] font-black uppercase px-2 py-0.5 rounded ${STATUS_STYLE[r.display_status] || 'bg-slate-100 text-slate-500'}`}>
                          {STATUS_LABEL[r.display_status] || r.display_status || '未设置'}
                        </span>
                        {r.display_status === 'scheduled' && r.scheduled_at && (
                          <span className="text-[8px] font-black uppercase text-indigo-500 flex items-center gap-1">
                            <Clock size={9} /> {formatDateTime(r.scheduled_at)}
                          </span>
                        )}
                        {r.display_status === 'failed' && r.publish_error && (
                          <span className="text-[8px] font-bold text-rose-500 flex items-center gap-1 max-w-[220px] truncate" title={r.publish_error}>
                            <AlertCircle size={9} /> {r.publish_error}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-7">
                      <span className="px-4 py-1.5 bg-slate-900 text-white text-[9px] font-black uppercase tracking-widest rounded-full flex items-center gap-2 shadow-lg w-max"><Tag size={10} className="text-emerald-400" /> {r.category || 'AI'}</span>
                    </td>
                    <td className="px-6 py-7 text-center">
                      <button
                        type="button"
                        onClick={() => toggleFeatured(r)}
                        title={r.is_featured ? `已是主推（排序 ${r.featured_order ?? 0}），点击取消` : '设为主推 / 置顶 Banner'}
                        className={`w-10 h-10 inline-flex items-center justify-center rounded-xl border transition-all ${
                          r.is_featured
                            ? 'bg-amber-50 border-amber-200 text-amber-500 shadow-sm'
                            : 'bg-white border-slate-200 text-slate-300 hover:text-amber-400 hover:border-amber-200'
                        }`}
                      >
                        <Star size={16} fill={r.is_featured ? 'currentColor' : 'none'} />
                      </button>
                    </td>
                    <td className="px-6 py-7">
                      <div className="flex flex-col gap-1 text-slate-400 text-[10px] font-black uppercase tracking-widest w-max">
                        <div className="flex items-center gap-2">
                          <Clock size={12} className="text-slate-300" />
                          <span className={r.display_status === 'published' ? 'text-slate-500' : ''}>
                            {formatDateTime(publishedAtOf(r) || r.created_at)}
                          </span>
                        </div>
                        {r.display_status === 'scheduled' && r.scheduled_at && (
                          <div className="flex items-center gap-2 text-indigo-400">
                            <Clock size={12} className="text-indigo-300" />
                            预约 {formatDateTime(r.scheduled_at)}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-8 py-7 text-right">
                       <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-all translate-x-2 group-hover:translate-x-0">
                          <button onClick={() => handleOpenPreview(r.id)} className="w-10 h-10 flex items-center justify-center rounded-xl bg-white border border-slate-200 text-slate-500 hover:text-emerald-500 hover:shadow-lg transition-all"><Eye size={18}/></button>
                          <Link href={`/admin/trends/edit?id=${r.id}`} className="w-10 h-10 flex items-center justify-center rounded-xl bg-white border border-slate-200 text-slate-500 hover:text-blue-500 hover:shadow-lg transition-all"><Pencil size={18}/></Link>
                          <button onClick={() => onDelete(r.id)} className="w-10 h-10 flex items-center justify-center rounded-xl bg-white border border-slate-200 text-slate-500 hover:text-rose-500 hover:shadow-lg transition-all"><Trash2 size={18}/></button>
                       </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {busy && rows.length === 0 && <div className="py-20 text-center animate-pulse text-slate-300 font-black uppercase text-[10px] tracking-[0.5em]">Synchronizing...</div>}
          </div>
        </div>
      </div>

      {/* 🚀 预览弹窗 (已修复内容显示逻辑) */}
      {(previewData || previewBusy) && (
        <div className="fixed inset-0 z-[200] bg-slate-900/90 backdrop-blur-2xl flex items-center justify-center p-4 md:p-8 animate-in fade-in" onClick={() => setPreviewData(null)}>
          <div className="bg-white w-full max-w-4xl h-full max-h-[90vh] rounded-[48px] overflow-hidden flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="p-8 border-b flex justify-between items-center bg-slate-50/50">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 italic">Intelligence Live Node</span>
              <button onClick={() => setPreviewData(null)} className="w-12 h-12 bg-white rounded-full flex items-center justify-center hover:rotate-90 transition-all shadow-sm"><X size={24}/></button>
            </div>
            <div className="flex-1 overflow-y-auto p-8 md:p-20 custom-scrollbar">
              {previewBusy ? (
                <div className="flex flex-col items-center justify-center h-full gap-4 text-slate-400 font-black uppercase text-[10px] tracking-[0.5em] animate-pulse"><Loader2 className="animate-spin" size={40} /> Pulling Deep Data...</div>
              ) : (
                <article className="max-w-3xl mx-auto prose prose-slate prose-xl selection:bg-emerald-100">
                  <span className="px-4 py-1.5 bg-slate-900 text-white text-[10px] font-black uppercase rounded-full mb-8 inline-block">{previewData.category}</span>
                  <h1 className="font-black italic text-5xl md:text-7xl mb-12 tracking-tighter leading-[0.95]">{previewData.title}</h1>
                  {previewData.cover_url && <img src={previewData.cover_url} className="w-full aspect-video object-cover rounded-[40px] mb-16 shadow-2xl" />}
                  {/* 🚀 正文兼容性渲染 */}
                  <div dangerouslySetInnerHTML={{ __html: previewData.content_html || previewData.content || previewData.content_md || '<p class="text-slate-400 italic">This node has no recorded prose.</p>' }} />
                </article>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}