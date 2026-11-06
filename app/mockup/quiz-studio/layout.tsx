/* eslint-disable @next/next/no-page-custom-font --
   静态稿故意用运行时 <link> 取前台字体（Fraunces / Bricolage / JetBrains Mono）。
   若改走 next/font/google，构建期就多一个「联网失败即挂」的依赖，
   而这份东西只是拿去评审的临时页面。 */
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Quiz Studio · 静态稿 v1",
  description: "Taxonomy / 权重矩阵 / 发布检查 / Autopilot 的可点静态稿（假数据）",
};

/**
 * 静态稿外壳。
 *
 * 字体走运行时 <link> 而不是 next/font/google：静态稿是拿去评审的临时产物，
 * 不该让 `next build` 多一个「联网失败就挂」的构建期依赖。
 * 三个 .mk-* 类对应前台真实站点的 --font-display / --font-sans / --font-mono，
 * 让屏 6 看起来就是 ComeBrief 而不是换了皮的后台。
 */
export default function MockupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@400;600;700&family=Fraunces:ital,opsz,wght@0,9..144,700;1,9..144,700&family=JetBrains+Mono:wght@400;700&display=swap"
      />
      <style>{`
        .mk-display { font-family: "Fraunces", Georgia, "Times New Roman", serif; }
        .mk-sans { font-family: "Bricolage Grotesque", system-ui, -apple-system, "Segoe UI", sans-serif; }
        .mk-mono { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
      `}</style>
      {children}
    </div>
  );
}
