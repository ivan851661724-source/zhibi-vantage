import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '知彼 Vantage',
  description: '竞品信号雷达 —— 降价 · 上新 · 开新店 · 差评暴涨，替你盯着的对手',
  icons: { icon: '/logo.svg' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
