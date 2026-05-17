"use client";

import React, { useState, useEffect } from "react";
import { 
  Plus, Search, BookOpen, Eye, Edit3, Trash2, 
  Layers, Loader2, Image as ImageIcon
} from "lucide-react";
import { useRouter } from "next/navigation";
import { supabase } from '@/lib/supabase';

export default function StoryListPage() {
  const router = useRouter();
  const [stories, setStories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const loadStories = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("stories")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setStories(data || []);
    } catch (err) {
      console.error("加载失败:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStories();
  }, []);

  // 🚀 强化后的删除功能：增加状态反馈
  const handleDelete = async (e: React.MouseEvent, id: string, title: string) => {
    e.stopPropagation(); // 防止触发行点击
    if (!confirm(`确定要永久删除故事《${title}》吗？`)) return;
    
    try {
      const { error } = await supabase.from("stories").delete().eq("id", id);
      if (error) throw error;
      
      alert("删除成功");
      // 立即更新本地状态，不需要等 loadStories，用户体验更丝滑
      setStories(prev => prev.filter(s => s.id !== id));
    } catch (err: any) {
      alert(`删除失败: ${err.message || "未知错误"}`);
      console.error(err);
    }
  };

  return (
    <div className="min-h-screen bg-[#F8F9FB] p-6 md:p-10 text-left">
      <div className="max-w-7xl mx-auto">
        
        {/* 头部：紧凑型设计 */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8">
          <div>
            <div className="flex items-center gap-3">
              <div className="bg-slate-900 p-2 rounded-xl text-white shadow-lg"><BookOpen size={20} /></div>
              <h2 className="text-2xl font-black italic uppercase tracking-tighter text-slate-900">Story Studio</h2>
            </div>
          </div>

          <div className="flex items-center gap-3">
             <div className="relative group hidden sm:block">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300" size={14} />
                <input className="bg-white border border-slate-200 rounded-xl pl-10 pr-4 py-2.5 text-[10px] font-bold uppercase outline-none focus:border-slate-900 transition-all w-48 shadow-sm" placeholder="搜索..." />
             </div>
             <button 
               onClick={() => router.push('/admin/stories/create')}
               className="bg-slate-900 text-white px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-black shadow-lg transition-all flex items-center gap-2"
             >
               <Plus size={14} /> 新增
             </button>
          </div>
        </div>

        {/* 列表区域：纤细行设计 */}
        <div className="space-y-3">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 text-slate-400">
              <Loader2 className="animate-spin mb-3" size={24} />
              <p className="text-[9px] font-bold uppercase tracking-widest">同步中...</p>
            </div>
          ) : stories.length === 0 ? (
            <div className="text-center py-12 bg-white border border-dashed border-slate-200 rounded-[24px]">
              <p className="text-slate-400 font-bold text-xs uppercase">空空如也</p>
            </div>
          ) : (
            stories.map((story) => {
              const episodeCount = story.raw_data?.episodes?.length || 0;
              return (
                <div 
                  key={story.id} 
                  className="bg-white border border-slate-100 rounded-[20px] p-3 flex items-center gap-6 group hover:shadow-md hover:border-slate-300 transition-all"
                >
                  {/* 小尺寸封面图 */}
                  <div className="w-16 h-16 bg-slate-50 rounded-[14px] overflow-hidden shrink-0 border border-slate-100">
                    {story.cover_url ? (
                      <img src={story.cover_url} className="w-full h-full object-cover" /> 
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-slate-200"><ImageIcon size={20} /></div>
                    )}
                  </div>

                  {/* 核心标题信息 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-1">
                      <h3 className="text-sm font-black text-slate-900 truncate uppercase italic tracking-tight">{story.title || "未命名"}</h3>
                      <span className={`text-[8px] font-black px-2 py-0.5 rounded-md uppercase ${story.active ? 'bg-emerald-50 text-emerald-500' : 'bg-slate-100 text-slate-400'}`}>
                          {story.active ? 'Active' : 'Draft'}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-[9px] font-bold text-slate-400 uppercase tracking-widest">
                       <span className="flex items-center gap-1"><Layers size={10}/> {episodeCount} Episodes</span>
                       <span className="flex items-center gap-1"><Eye size={10}/> 0 Views</span>
                    </div>
                  </div>

                  {/* 紧凑操作区 */}
                  <div className="flex items-center gap-2 pr-2">
                    <button 
                      onClick={() => router.push(`/admin/stories/create?id=${story.id}`)}
                      className="p-2.5 bg-slate-50 text-slate-400 rounded-xl hover:bg-slate-900 hover:text-white transition-all shadow-sm"
                      title="编辑"
                    >
                      <Edit3 size={14} />
                    </button>
                    <button 
                      onClick={(e) => handleDelete(e, story.id, story.title)}
                      className="p-2.5 bg-slate-50 text-slate-400 rounded-xl hover:bg-rose-500 hover:text-white transition-all shadow-sm"
                      title="删除"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}