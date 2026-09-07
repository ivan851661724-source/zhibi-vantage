// 知彼 Vantage · Next.js 前端配置
// 串联方式（docs/01-前端架构规范.md §3）：前端不实现业务 API，仅反向代理到零依赖后端。
// 开发：BACKEND_URL 默认 http://127.0.0.1:3300；容器内为 http://zhibi-vantage:3300。
import type { NextConfig } from 'next';

const BACKEND = process.env.BACKEND_URL || 'http://127.0.0.1:3300';

// 基础安全响应头（此前全站无任何安全头；CSP 的 script-src 需 'unsafe-inline'
// 以兼容 Next.js 内联引导脚本，属已知取舍——重点是 frame 防点击劫持与 nosniff）
const SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
];

const nextConfig: NextConfig = {
  output: 'standalone', // 容器化（docs/03 §4）：运行态仅拷贝 standalone 产物
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${BACKEND}/api/:path*` },
      { source: '/metrics', destination: `${BACKEND}/metrics` },
      { source: '/healthz', destination: `${BACKEND}/healthz` },
    ];
  },
};

export default nextConfig;
