import { MetadataRoute } from 'next'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',            // 允许爬虫抓取首页和内容页（为了 SEO）
      disallow: '/admin/',   // 严禁爬虫进入任何以 /admin 开头的路径
    },
    // 换成你的正式域名，方便搜索引擎索引正常内容
    sitemap: 'https://comebrief.com/sitemap.xml', 
  }
}