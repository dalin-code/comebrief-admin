'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null)

  useEffect(() => {
    const checkAuth = async () => {
      try {
        // 🚀 核心自救第一步：获取当前浏览器的物理绝对路径
        const currentPath = window.location.pathname

        // 💡 核心免死金牌：如果当前人就在登录页 '/admin/login'，直接放行，绝对不拦截、不套娃！
        if (currentPath === '/admin/login') {
          setIsAuthenticated(true)
          return
        }

        // 🚀 核心自救第二步：如果去的是受保护后台，老老实实检查凭证
        const { data: { session } } = await supabase.auth.getSession()
        
        if (!session) {
          console.warn("🔒 客户端未授权：正在安全拦截并遣送回登录页...")
          // 没登录，全自动带着当前他想去的路径，强行丢回登录页
          window.location.href = `/admin/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`
        } else {
          // 凭证合法，放行
          setIsAuthenticated(true)
        }
      } catch (error) {
        console.error("安全边界捕获到异常:", error)
        window.location.href = '/admin/login'
      }
    }

    checkAuth()
  }, [])

  // 1. 握手和验证期间，展示设计师极简骨架屏
  if (isAuthenticated === null) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#FBFBFC] font-sans">
        <div className="flex flex-col items-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-slate-900" />
          <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400 italic animate-pulse">
            AURA SECURITY BOUNDARY SYNCING...
          </p>
        </div>
      </div>
    )
  }

  // 2. 🔓 验证放行
  return <>{children}</>
}