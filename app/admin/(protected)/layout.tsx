import { Sidebar } from "@/app/admin/_components/Sidebar";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-slate-50/50">
      {/* 🛡️ 这是整个后台唯一的侧边栏入口 */}
      <Sidebar />
      
      <main className="flex-1 min-w-0 overflow-y-auto">
        {children}
      </main>
    </div>
  );
}