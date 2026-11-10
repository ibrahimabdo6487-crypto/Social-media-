import "./globals.css";
import type { Metadata } from "next";
export const metadata: Metadata = { title: "MCP Media Generator", description: "خادم MCP لتوليد الصور والفيديو ودمج المقاطع" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="ar" dir="rtl"><body className="min-h-screen">{children}</body></html>);
}
