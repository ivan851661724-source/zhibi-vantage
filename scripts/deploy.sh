#!/usr/bin/env bash
# 知彼 Vantage · 阿里云 ECS 一键部署
# 用法：在 ECS 上、包目录内执行：  bash scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "错误：未安装 Docker。请先："
  echo "  curl -fsSL https://get.docker.com | bash -s docker"
  echo "  sudo systemctl enable --now docker"
  exit 1
fi

# .env 不存在则从模板复制
if [ ! -f .env ]; then
  cp .env.example .env
  echo "已从 .env.example 生成 .env，如设置了 MT_MASTER_KEY 请编辑 .env 后再执行"
fi

echo "==> 构建镜像并启动服务（首次约 2-5 分钟）"
docker compose up -d --build

echo "==> 容器状态"
docker compose ps

echo "==> 健康检查（重试 10 次，均经前端 :${WEB_PORT:-3000} 代理）"
for i in $(seq 1 10); do
  if curl -fsS -m 3 "http://127.0.0.1:${WEB_PORT:-3000}/healthz" >/dev/null 2>&1; then
    echo "✓ 后端健康（/healthz 经代理可达）"
    break
  fi
  [ "$i" -eq 10 ] && echo "✗ 后端健康检查超时，请查看：bash scripts/logs.sh" || sleep 3
done
for i in $(seq 1 10); do
  if curl -fsS -m 3 "http://127.0.0.1:${WEB_PORT:-3000}/login" >/dev/null 2>&1; then
    echo "✓ 前端健康：http://127.0.0.1:${WEB_PORT:-3000}"
    break
  fi
  [ "$i" -eq 10 ] && echo "✗ 前端健康检查超时，请查看：docker compose logs zhibi-web" || sleep 3
done

echo ""
echo "部署完成。本机访问： http://localhost:${WEB_PORT:-3000} （Next.js 前端，唯一 Web 入口）"
echo "外网访问： http://<ECS公网IP>:${WEB_PORT:-3000} （需在阿里云安全组放行 ${WEB_PORT:-3000} 端口）"
