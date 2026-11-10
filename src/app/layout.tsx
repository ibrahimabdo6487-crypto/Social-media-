import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "مولّد الوسائط — لوحة الإدارة",
  description: "خادم MCP لتوليد الصور والفيديو ودمج المقاطع — لوحة إدارة عربية",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body className="bg-ink-bg text-slate-100 font-sans min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
