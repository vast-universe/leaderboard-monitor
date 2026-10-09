import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BTC 5 分钟监控",
  description: "目标钱包的 BTC 5 分钟持仓、成交与实时盘口监控",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
