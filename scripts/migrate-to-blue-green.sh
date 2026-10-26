#!/bin/bash
# 一次性迁移：把 3002 从 docker-proxy 交接给 nginx 稳定入口 + 前端 blue 槽（3102）
# 背景：v2 及之前 compose 直接把宿主机 3002 映射到容器，容器重建必然产生端口空窗。
#      v3 起 3002 由 nginx 持有，前端在 blue(3102)/green(3202) 两槽间蓝绿切换。
# 迁移窗口：停止旧 web → nginx 接管，约 3–6 秒（一次性；此后部署不再中断入口）。
# 幂等：已迁移（nginx 已在 3002 监听）时直接退出。
# 回退：脚本失败时自动恢复 compose 直连（docker start zhibi-web）+ 停 blue 槽。
set -euo pipefail
cd /opt/zhibi-vantage

# 实际运行版本（不是工作树 HEAD）：迁移时运行中的 web 镜像来自哪个 commit 必须显式传入
DEPLOYED_SHA="${DEPLOYED_SHA:-}"
WEB_PORT=3002
BLUE=zhibi-web-blue
BLUE_PORT=3102
STATE_DIR=/var/lib/zhibi-deploy
STATE=$STATE_DIR/state.json
SRC_CONF=scripts/nginx/zhibi.conf
SRC_MAINT=scripts/nginx/zhibi-maintenance.html

log() { echo "$(date '+%F %T') [migrate] $*"; }

# 幂等检查
if ss -tlnp 2>/dev/null | grep -q ":${WEB_PORT} .*nginx"; then
  log "nginx 已持有 $WEB_PORT，迁移已完成，退出"
  exit 0
fi

# 前置：旧入口必须可用
curl -sf -o /dev/null -m 5 "http://127.0.0.1:${WEB_PORT}/login" || { log "旧入口不可用，中止"; exit 1; }

log "1/7 安装 nginx 配置"
install -D -m 644 "$SRC_CONF" /etc/nginx/conf.d/zhibi.conf
install -D -m 644 "$SRC_MAINT" /etc/nginx/zhibi-maintenance.html
printf 'upstream zhibi_web_active {\n    server 127.0.0.1:%s;\n    keepalive 32;\n}\nupstream zhibi_web_previous {\n    server 127.0.0.1:%s;\n    keepalive 8;\n}\n' "$BLUE_PORT" "$BLUE_PORT" > /etc/nginx/conf.d/zhibi-upstream.conf
nginx -t >/dev/null 2>&1 || { log "nginx 配置语法错误，中止（未改动运行服务）"; exit 1; }

log "2/7 从当前 web 容器克隆 blue 槽（3102）"
docker rm -f "$BLUE" >/dev/null 2>&1 || true
ENVFILE=$(mktemp /tmp/zhibi-mig-env.XXXXXX); chmod 600 "$ENVFILE"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' zhibi-web > "$ENVFILE"
NET=$(docker inspect -f '{{.HostConfig.NetworkMode}}' zhibi-web)
IMG=$(docker inspect -f '{{.Image}}' zhibi-web)
docker run -d --name "$BLUE" --network "$NET" --restart unless-stopped \
  -p "127.0.0.1:${BLUE_PORT}:3000" --env-file "$ENVFILE" "$IMG" >/dev/null
rm -f "$ENVFILE"
log "blue 槽已启动：$BLUE @ 127.0.0.1:$BLUE_PORT (image $IMG)"

log "3/7 验证 blue 槽"
C=000
for i in $(seq 1 30); do
  C=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:${BLUE_PORT}/login" || echo 000)
  [ "$C" = "200" ] && break; sleep 2
done
if [ "$C" != "200" ]; then
  log "blue 槽不可用（$C），停止并中止"
  docker rm -f "$BLUE" >/dev/null 2>&1 || true
  exit 1
fi
log "blue 槽 /login=200"

log "4/7 停止 compose web（释放 $WEB_PORT）"
docker stop zhibi-web >/dev/null 2>&1 || true

log "5/7 nginx 接管 $WEB_PORT"
if ! nginx -t >/dev/null 2>&1; then
  log "nginx -t 失败，回退：恢复 compose web"
  docker start zhibi-web >/dev/null 2>&1 || true
  docker rm -f "$BLUE" >/dev/null 2>&1 || true
  exit 1
fi
nginx -s reload
sleep 2
ss -tlnp 2>/dev/null | grep -q ":${WEB_PORT} .*nginx" || {
  log "nginx 未监听 $WEB_PORT，回退"
  docker start zhibi-web >/dev/null 2>&1 || true
  docker rm -f "$BLUE" >/dev/null 2>&1 || true
  exit 1
}

log "6/7 验证新入口"
N=000
for i in $(seq 1 15); do
  N=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/login" || echo 000)
  [ "$N" = "200" ] && break; sleep 1
done
H=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/healthz" || echo 000)
log "新入口 /login=$N /healthz=$H"
if [ "$N" != "200" ] || [ "$H" != "200" ]; then
  log "新入口不可用，回退 compose 直连"
  printf 'upstream zhibi_web_active {\n    server 127.0.0.1:%s;\n    keepalive 32;\n}\nupstream zhibi_web_previous {\n    server 127.0.0.1:%s;\n    keepalive 8;\n}\n' "$BLUE_PORT" "$BLUE_PORT" > /etc/nginx/conf.d/zhibi-upstream.conf
  docker rm -f "$BLUE" >/dev/null 2>&1 || true
  docker start zhibi-web >/dev/null 2>&1 || true
  exit 1
fi

log "7/7 初始化部署状态（deployed_sha=$SHA）"
mkdir -p "$STATE_DIR"
WEB_IMG=$(docker inspect -f '{{.Image}}' "$BLUE")
API_IMG=$(docker inspect -f '{{.Image}}' zhibi-vantage)
SHA="${DEPLOYED_SHA:-$(git rev-parse HEAD)}"
printf '{"deployed_sha":"%s","deployed_web_image_id":"%s","deployed_api_image_id":"%s","active_web_slot":"blue","failed_sha":"","deployed_at":"%s"}\n' \
  "$SHA" "$WEB_IMG" "$API_IMG" "$(date -u '+%FT%TZ')" > "$STATE"
log "state: $STATE"

log "迁移完成：3002 = nginx → $BLUE(3102)；旧 compose web 已停止（保留可回退）"
