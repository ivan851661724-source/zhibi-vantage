import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '知彼 Vantage',
  description: '竞品信号雷达 —— 降价 · 上新 · 开新店 · 差评暴涨，替你盯着的对手',
  icons: { icon: '/logo.svg' },
};

// 移动端必备：未声明 viewport 时浏览器按 980px 桌面视口渲染后再缩放，
// 导致 SVG <text> 的 CJK 字符被压成几像素的模糊块，看起来像"乱码"。
// 这里同时禁止用户在移动端缩放，保证矩阵/列表的视觉一致。
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#0F1217',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
