import type { Metadata } from "next";
import { TRPCProvider } from "@/lib/trpc/react";
import "./globals.css";

export const metadata: Metadata = {
  title: "ViMax Studio · 生图工坊",
  description: "AI 图像生成工作室",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen antialiased">
        <TRPCProvider>{children}</TRPCProvider>
      </body>
    </html>
  );
}
