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
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}