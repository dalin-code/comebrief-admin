import { redirect } from "next/navigation";

export default function RootPage() {
  // 🚀 当有人访问根目录 http://localhost:3000/ 时
  // 直接把他强制“传送”到后台管理页
  redirect("/admin"); 
}