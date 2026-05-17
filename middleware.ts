import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  // 1. 创建一个响应对象，用于后续写入 Cookie
  let response = NextResponse.next({
    request: { headers: request.headers },
  })

  // 2. 初始化标准的 SSR 客户端
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value
        },
        set(name: string, value: string, options: CookieOptions) {
          // 在请求和响应中同步 Cookie
          request.cookies.set({ name, value, ...options })
          response = NextResponse.next({ request: { headers: request.headers } })
          response.cookies.set({ name, value, ...options })
        },
        // 找到 remove 这一段，改成这样：
remove(name: string, options: CookieOptions) {
  // 🚀 修复点：remove 函数参数里没有 value，我们要手动给它空字符串
  request.cookies.set({
    name,
    value: '', // 这里手动设为空
    ...options,
  })
  response = NextResponse.next({
    request: { headers: request.headers },
  })
  response.cookies.set({
    name,
    value: '', // 这里手动设为空
    ...options,
  })
},
      },
    }
  )

  // 3. 安全检查：获取当前登录用户
  const { data: { user } } = await supabase.auth.getUser()

  const isLoginPage = request.nextUrl.pathname.startsWith('/admin/login')
  const isAdminPage = request.nextUrl.pathname.startsWith('/admin')

  // 🚀 4. 门禁逻辑
  // 情况 A：没登录却想进后台 -> 踢回登录页
  if (!user && isAdminPage && !isLoginPage) {
    return NextResponse.redirect(new URL('/admin/login', request.url))
  }

  // 情况 B：已经登录了还想进登录页 -> 直接送进后台首页
  if (user && isLoginPage) {
    return NextResponse.redirect(new URL('/admin', request.url))
  }

  return response
}

export const config = {
  // 拦截所有 admin 路径，但排除静态资源（如图片、图标）
  matcher: [
    '/admin/:path*',
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}