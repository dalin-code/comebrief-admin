// 📁 路径: app/layout.tsx
import "./globals.css";
import { Inter } from "next/font/google";

const inter = Inter({ subsets: ["latin"] });

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className={`${inter.className} antialiased min-h-screen bg-[#F8FAFC] dark:bg-[#020617] text-slate-900 dark:text-slate-200 transition-colors duration-300`}>
        {children}
      </body>
    </html>
  );
}