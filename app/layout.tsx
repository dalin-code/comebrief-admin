import type { Metadata } from "next";
import "./globals.css"; // 🚀 如果之前提示找不到样式，请确认为 "./globals.css" 或 "@/app/globals.css"

export const metadata: Metadata = {
  title: "ComeBrief Studio",
  description: "内容创作指挥部",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning：浏览器扩展（如 TokenPocket / 各类钱包、翻译插件）
    // 会在 React 加载前往 <html> 上塞自己的属性（data-tp-bcm-channel-* 等），
    // 造成「服务端 HTML 与客户端属性不一致」的 hydration 报错。这个属性只作用于
    // 该标签自身这一层，不会掩盖子树的真实问题。
    <html lang="en" suppressHydrationWarning>
      <body>
        {children}
      </body>
    </html>
  );
}