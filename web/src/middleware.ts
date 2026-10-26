// 知彼 Vantage · 响应头中间件（P0 稳定性整改：缓存策略修正）
//
// 背景根因：App Router 页面此前返回 `Cache-Control: s-maxage=31536000`（一年）。
// 每次部署 Next 会重新生成 buildId，全部 chunk 随之改名；浏览器或中间代理缓存住的
// 旧 HTML 会继续引用已被新镜像删除的旧 chunk，产生随机 502 / chunk load error /
// ERR_HTTP_RESPONSE_CODE_FAILURE。详见 docs/operations/01_部署与运行.md 健康门一节。
//
// 策略：
// - /_next/static/*（内容哈希文件）不进本中间件（matcher 排除），保持 Next 默认的
//   `public, max-age=31536000, immutable` 长缓存；
// - 其余一切响应（HTML / App Router 页面 / 经 rewrite 代理的 API 响应）一律
//   `no-store, max-age=0`：页面与其引用的静态资源永远来自同一 release。
import { NextResponse, type NextRequest } from 'next/server';

const NO_STORE = 'no-store, max-age=0';

export function middleware(_req: NextRequest) {
  const res = NextResponse.next();
  res.headers.set('Cache-Control', NO_STORE);
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
