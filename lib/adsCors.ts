import type { NextRequest } from 'next/server'

/**
 * 前台（www.comebrief.com）跨域调用后台广告接口时共用的 CORS 口径。
 *
 * 之前是「回声式」：请求带什么 Origin 就回什么 —— 等于任何站点都能借访客
 * 浏览器读这份配置。现在只回显白名单里的来源，可用 `ADS_ALLOWED_ORIGINS`
 * （逗号分隔）覆盖；预览域名、本地端口记得加进去。
 */
export const DEFAULT_ALLOWED_ORIGINS = [
  'https://comebrief.com',
  'https://www.comebrief.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]

export function allowedOrigins() {
  const custom = (process.env.ADS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return custom.length ? custom : DEFAULT_ALLOWED_ORIGINS
}

export function adsCorsHeaders(req: NextRequest, methods = 'GET, OPTIONS') {
  const origin = req.headers.get('origin') || ''
  const list = allowedOrigins()
  const permitted = Boolean(origin) && (list.includes('*') || list.includes(origin))
  return {
    ...(permitted ? { 'Access-Control-Allow-Origin': origin } : {}),
    Vary: 'Origin',
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  }
}
