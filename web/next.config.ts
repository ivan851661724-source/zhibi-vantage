// 知彼 Vantage · Next.js 前端配置
// 串联方式（docs/01-前端架构规范.md §3）：前端不实现业务 API，仅反向代理到零依赖后端。
// 开发：BACKEND_URL 默认 http://127.0.0.1:3300；容器内为 http://zhibi-vantage:3300。
import type { NextConfig } from 'next';

const BACKEND = process.env.BACKEND_URL || 'http://127.0.0.1:3300';

const nextConfig: NextConfig = {
  output: 'standalone', // 容器化（docs/03 §4）：运行态仅拷贝 standalone 产物
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${BACKEND}/api/:path*` },
      { source: '/metrics', destination: `${BACKEND}/metrics` },
      { source: '/healthz', destination: `${BACKEND}/healthz` },
    ];
  },
};

export default nextConfig;
