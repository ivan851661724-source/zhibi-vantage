#!/usr/bin/env bash
# 知彼 Vantage · 阿里云 ECS 一键部署
# 用法：在 ECS 上、包目录内执行：  bash scripts/deploy.sh
# 部署结果推送飞书群机器人（成功/失败均推；目标可用环境变量 FEISHU_WEBHOOK 覆盖，
# 脚本内置默认值即当前值班群机器人）。健康检查不通过按部署失败处理（exit 1）。
set -euo pipefail
cd "$(dirname "$0")/.."

FEISHU_WEBHOOK="${FEISHU_WEBHOOK:-}"  # 值机群 webhook 不入库：部署机 .env 提供（泄露=任何人可向群发消息）
HOST_TAG=$(hostname)
START_TS=$SECONDS
STAGE=准备
VERSION=$(git rev-parse --short HEAD 2>/dev/null || echo "非 git 目录")
DEPLOY_LOG=$(mktemp /tmp/zhibi-deploy-log.XXXXXX)

json_esc() { # 字符串 → 可安全嵌入 JSON 字符串的字面量
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/}
  s=${s//$'\n'/\\n}
  printf '%s' "$s"
}

feishu_notify() { # $1=green|red  $2=标题  $3=lark_md 正文
  [ -n "$FEISHU_WEBHOOK" ] || { echo "[notify] FEISHU_WEBHOOK 未配置，跳过飞书通知"; return 0; }
  local payload resp
  payload=$(printf '{"msg_type":"interactive","card":{"config":{"wide_screen_mode":true},"header":{"template":"%s","title":{"tag":"plain_text","content":"%s"}},"elements":[{"tag":"div","text":{"tag":"lark_md","content":"%s"}},{"tag":"note","elements":[{"tag":"plain_text","content":"%s · %s"}]}]}}' \
    "$1" "$(json_esc "$2")" "$(json_esc "$3")" "$(json_esc "$HOST_TAG")" "$(json_esc "$(date '+%F %T %Z')")")
  # 飞书被安全设置拦截（关键词/签名）时也返回 HTTP 200，必须校验响应体 code
  resp=$(curl -fsS -m 10 -H 'Content-Type: application/json' -d "$payload" "$FEISHU_WEBHOOK" 2>/dev/null || true)
  case "$resp" in
    *'"code":0'*|*'"StatusCode":0'*) : ;;
    *) echo "$(date '+%F %T') 警告：飞书通知发送失败 resp=${resp:-<empty>}" ;;
  esac
}

on_exit() { # EXIT 兜底：成功 green；失败 red 附失败阶段与日志尾部
  local rc=$1 color title body dur log_tail
  dur=$(( SECONDS - START_TS ))
  sleep 1  # 等 tee 缓冲落盘，再截取日志尾部
  if [ "$rc" -eq 0 ]; then
    color=green
    title="✅ zhibi-vantage 部署成功"
    body=$(printf '**版本**：%s\n**耗时**：%ss\n**健康检查**：后端 healthy · 前端 200' "$VERSION" "$dur")
  else
    color=red
    title="❌ zhibi-vantage 部署失败"
    log_tail=$(tail -c 1000 "$DEPLOY_LOG" 2>/dev/null || true)
    body=$(printf '**失败阶段**：%s\n**版本**：%s\n**耗时**：%ss\n**日志尾部**：\n%s' "$STAGE" "$VERSION" "$dur" "$log_tail")
  fi
  feishu_notify "$color" "$title" "$body"
  rm -f "$DEPLOY_LOG"
}
trap 'on_exit $?' EXIT
exec > >(tee -a "$DEPLOY_LOG") 2>&1

STAGE="Docker 环境检查"
if ! command -v docker >/dev/null 2>&1; then
  echo "错误：未安装 Docker。请先："
  echo "  curl -fsSL https://get.docker.com | bash -s docker"
  echo "  sudo systemctl enable --now docker"
  exit 1
fi

STAGE=".env 初始化"
# .env 不存在则从模板复制
if [ ! -f .env ]; then
  cp .env.example .env
  echo "已从 .env.example 生成 .env，如设置了 MT_MASTER_KEY 请编辑 .env 后再执行"
fi

STAGE="构建并启动"
echo "==> 构建镜像并启动服务（首次约 2-5 分钟）"
docker compose up -d --build

echo "==> 容器状态"
docker compose ps

STAGE="健康检查"
BACKEND_OK=0; WEB_OK=0
echo "==> 健康检查（重试 10 次，均经前端 :${WEB_PORT:-3000} 代理）"
for i in $(seq 1 10); do
  if curl -fsS -m 3 "http://127.0.0.1:${WEB_PORT:-3000}/healthz" >/dev/null 2>&1; then
    echo "✓ 后端健康（/healthz 经代理可达）"
    BACKEND_OK=1
    break
  fi
  [ "$i" -eq 10 ] && echo "✗ 后端健康检查超时，请查看：bash scripts/logs.sh" || sleep 3
done
for i in $(seq 1 10); do
  if curl -fsS -m 3 "http://127.0.0.1:${WEB_PORT:-3000}/login" >/dev/null 2>&1; then
    echo "✓ 前端健康：http://127.0.0.1:${WEB_PORT:-3000}"
    WEB_OK=1
    break
  fi
  [ "$i" -eq 10 ] && echo "✗ 前端健康检查超时，请查看：docker compose logs zhibi-web" || sleep 3
done

if [ "$BACKEND_OK" != 1 ] || [ "$WEB_OK" != 1 ]; then
  echo "✗ 部署失败（后端健康=$BACKEND_OK 前端健康=$WEB_OK），已推送飞书告警"
  exit 1
fi

echo ""
echo "部署完成。本机访问： http://localhost:${WEB_PORT:-3000} （Next.js 前端，唯一 Web 入口）"
echo "外网访问： http://<ECS公网IP>:${WEB_PORT:-3000} （需在阿里云安全组放行 ${WEB_PORT:-3000} 端口）"
