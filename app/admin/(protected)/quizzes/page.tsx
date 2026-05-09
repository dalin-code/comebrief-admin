"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import { 
  Edit3, Trash2, Plus, 
  Image as ImageIcon, 
  Search, Info, RefreshCcw, Loader2, ArrowRight, Zap, AlertCircle
} from "lucide-react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase"; // 🚀 关键：必须使用 import 进来的单例，不要在组件内 createClient

export default function QuizListPage() {
  const [quizzes, setQuizzes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  
  // 🚀 核心修复 1：使用 useRef 记录是否正在请求，强行阻止并发重叠
  const isFetchingBus = useRef(false);

  const fetchQuizzes = useCallback(async (silent = false) => {
    if (isFetchingBus.current) return;
    isFetchingBus.current = true;
    
    if (!silent) setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase
        .from('quizzes')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      
      setQuizzes(data || []);
    } catch (err) {
      console.error("Fetch Error:", err);
      setError("Failed to fetch quizzes. Please check your connection.");
    } finally {
      setLoading(false);
      setIsRefreshing(false);
      isFetchingBus.current = false;
    }
  }, []); 

  // 🚀 核心修复 2：绝对空数组 []。如果这里还是死循环，说明你的页面外层 layout 也在重绘。
  useEffect(() => {
    fetchQuizzes();
  }, [fetchQuizzes]);

  const handleDelete = async (id: string) => {
    if (!confirm("Confirm to delete this quiz?")) return;
    const { error } = await supabase.from('quizzes').delete().eq('id', id);
    if (!error) fetchQuizzes(true);
  };

  return (
    <div className="p-10 bg-[#F8F9FB] min-h-screen text-left font-sans">
      <div className="max-w-7xl mx-auto space-y-8">
        
        {/* Header */}
        <div className="flex justify-between items-end border-b border-slate-200 pb-8">
          <div>
            <h1 className="text-4xl font-black italic uppercase tracking-tighter text-slate-900 leading-none">
              Quiz <span className="text-slate-200">Library</span>
            </h1>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em] mt-2">Manage your interactive matrix</p>
          </div>
          <div className="flex gap-4">
            <button 
              onClick={() => { setIsRefreshing(true); fetchQuizzes(true); }}
              className="p-4 bg-white border border-slate-200 text-slate-400 hover:text-slate-900 rounded-2xl transition-all"
            >
              <RefreshCcw size={18} className={isRefreshing ? "animate-spin" : ""} />
            </button>
            <button 
              onClick={() => router.push('/admin/quizzes/create')} // 🚀 路径已匹配你的文件夹：create
              className="bg-slate-900 text-white px-8 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:scale-105 transition-all shadow-xl flex items-center gap-2"
            >
              <Plus size={16}/> Create New Quiz
            </button>
          </div>
        </div>

        {/* List Table */}
        <div className="bg-white rounded-[40px] border border-slate-200 overflow-hidden shadow-sm">
          {loading ? (
            <div className="p-32 text-center">
              <Loader2 className="animate-spin mx-auto text-slate-200 mb-4" size={32} />
              <p className="text-[10px] font-black text-slate-300 uppercase tracking-widest">Loading Matrix Data...</p>
            </div>
          ) : error ? (
            <div className="p-32 text-center">
              <AlertCircle size={40} className="mx-auto text-red-400 mb-4" />
              <p className="text-red-500 font-bold italic text-sm uppercase mb-2">{error}</p>
              <button 
                onClick={() => fetchQuizzes()}
                className="bg-slate-900 text-white px-6 py-2 rounded-xl text-xs font-bold uppercase hover:scale-105 transition-all"
              >
                Retry
              </button>
            </div>
          ) : quizzes.length === 0 ? (
            <div className="p-32 text-center">
              <Info size={40} className="mx-auto text-slate-100 mb-4" />
              <p className="text-slate-300 font-bold italic text-sm uppercase">No Records Found</p>
            </div>
          ) : (
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50/50 border-b border-slate-100">
                  <th className="p-8 text-[10px] font-black uppercase text-slate-400 tracking-widest">Information</th>
                  <th className="p-8 text-[10px] font-black uppercase text-slate-400 tracking-widest">Categories</th>
                  <th className="p-8 text-[10px] font-black uppercase text-slate-400 tracking-widest">Status</th>
                  <th className="p-8 text-[10px] font-black uppercase text-slate-400 tracking-widest text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {quizzes.map((quiz: any) => (
                  <tr key={quiz.id} className="hover:bg-slate-50/50 transition-colors group">
                    <td className="p-8">
                      <div className="flex items-center gap-4">
                        <div className="w-16 h-12 bg-slate-100 rounded-xl overflow-hidden shrink-0 border border-slate-200">
                          {quiz.cover_url ? (
                            <img src={`${quiz.cover_url}?t=${Date.now()}`} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-slate-200">
                              <ImageIcon size={16}/>
                            </div>
                          )}
                        </div>
                        <div className="space-y-1">
                          <p className="font-bold text-slate-900 uppercase italic line-clamp-1">{quiz.title || "Untethered Data"}</p>
                          <div className="flex gap-2">
                             {quiz.tags?.slice(0,2).map((t:string) => (
                               <span key={t} className="text-[7px] font-black bg-slate-100 text-slate-400 px-1.5 py-0.5 rounded uppercase">{t}</span>
                             ))}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="p-8">
                      <div className="flex gap-1 flex-wrap">
                        {quiz.categories?.map((cat:string) => (
                          <span key={cat} className="text-[9px] font-bold text-blue-500 bg-blue-50 px-3 py-1 rounded-full border border-blue-100 uppercase">{cat}</span>
                        ))}
                      </div>
                    </td>
                    <td className="p-8">
                       <div className="flex items-center gap-2">
                         <div className={`w-1.5 h-1.5 rounded-full ${quiz.active ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`} />
                         <span className={`text-[8px] font-black uppercase ${quiz.active ? 'text-emerald-600' : 'text-slate-400'}`}>
                           {quiz.active ? 'Live' : 'Draft'}
                         </span>
                       </div>
                    </td>
                    <td className="p-8 text-right">
                      <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-all translate-x-2 group-hover:translate-x-0">
                        <button 
                          onClick={() => router.push(`/admin/quizzes/create?id=${quiz.id}`)} // 🚀 跳转至 create
                          className="p-3 bg-white border border-slate-200 text-slate-400 hover:text-slate-900 rounded-xl transition-all"
                        >
                          <Edit3 size={16}/>
                        </button>
                        <button 
                          onClick={() => handleDelete(quiz.id)}
                          className="p-3 bg-white border border-slate-200 text-slate-400 hover:text-rose-500 rounded-xl transition-all"
                        >
                          <Trash2 size={16}/>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}