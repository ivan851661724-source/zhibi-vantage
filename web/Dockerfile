# 知彼 Vantage · Next.js 前端镜像（Phase 4，docs/03-迁移实施方案.md §Phase 4）
# multi-stage + output:'standalone'：运行态仅拷贝 standalone 产物，不含 node_modules 源与构建缓存。
# ⚠️ rewrites 在构建期固化进 routes-manifest.json —— BACKEND_URL 必须在 builder 阶段注入
#    （容器网络内后端固定为 http://zhibi-vantage:3300；本机 dev 不经此镜像，不受影响）。

# ---------- 阶段 1：构建 ----------
FROM node:22-alpine AS builder
WORKDIR /app

# pnpm（lockfileVersion 9.0）
RUN npm install -g pnpm@10

# 先拷依赖清单，命中层缓存
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# 再拷源码构建（容器内后端地址，构建期固化）
ENV BACKEND_URL=http://zhibi-vantage:3300
COPY web/ ./
RUN pnpm build

# ---------- 阶段 2：运行 ----------
FROM node:22-alpine AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    TZ=Asia/Shanghai \
    BACKEND_URL=http://zhibi-vantage:3300
# Next standalone 读取 HOSTNAME 作为监听地址——默认绑定容器 eth0 IP，
# 会导致容器内 127.0.0.1 健康检查失败；显式 0.0.0.0 监听所有接口。
ENV HOSTNAME=0.0.0.0

WORKDIR /app

# standalone 产物（含精简 server.js + node runtime 依赖），静态资源与 public 单独补拷
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# 非 root 运行
USER node

EXPOSE 3000

# 健康检查：探 /login（Next 渲染页 200 即活）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
