#!/bin/bash
# zhibi-vantage 自动部署（借鉴 cartback）：GitHub main 有新提交 → 拉取 → docker compose 构建 → 重建容器
# cron 每分钟调一次（flock 防重入，见 /etc/cron.d/zhibi-deploy）；也可手动执行：bash /opt/zhibi-vantage/deploy.sh
# 部署结果推送飞书群机器人：仅当本次真实发生部署（远端有新提交，或 FORCE_DEPLOY=1 强制重建）时
# 推送成功/失败卡片；无新提交的例行检查不推送，避免每分钟刷屏。可用环境变量 FEISHU_WEBHOOK 覆盖目标。
set -euo pipefail
cd /opt/zhibi-vantage

FEISHU_WEBHOOK="${FEISHU_WEBHOOK:-}"  # 值机群 webhook 不入库：部署机 .env 提供（泄露=任何人可向群发消息）
HOST_TAG=$(hostname)
START_TS=$SECONDS
NOTIFY=0          # 置 1 表示本次发生了真实部署，结束时无论成败都推送飞书
STAGE=准备
OLD= NEW=
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
  payload=$(printf '{"msg_type":"interactive","card":{"config":{"wide_screen_mode":true},"header":{"template":"%s","title":{"tag":"plain_text","content":"%s"}},"elements":[{"tag":"div","text":{"tag":"lark_md","content":"%s"}},{"tag":"note","elements":[{"tag":"plain_text","content":"%s · %s · 完整日志：/var/log/zhibi-deploy.log"}]}]}}' \
    "$1" "$(json_esc "$2")" "$(json_esc "$3")" "$(json_esc "$HOST_TAG")" "$(json_esc "$(date '+%F %T %Z')")")
  # 飞书被安全设置拦截（关键词/签名）时也返回 HTTP 200，必须校验响应体 code
  resp=$(curl -fsS -m 10 -H 'Content-Type: application/json' -d "$payload" "$FEISHU_WEBHOOK" 2>/dev/null || true)
  case "$resp" in
    *'"code":0'*|*'"StatusCode":0'*) : ;;
    *) echo "$(date '+%F %T') deploy: 警告：飞书通知发送失败 resp=${resp:-<empty>}" ;;
  esac
}

on_exit() { # EXIT 兜底：真实部署过才推送（成功 green；失败 red 附失败阶段与日志尾部）
  local rc=$1 color title body dur log_tail
  dur=$(( SECONDS - START_TS ))
  if [ "$NOTIFY" != 1 ]; then rm -f "$DEPLOY_LOG"; return 0; fi
  sleep 1  # 等 tee 缓冲落盘，再截取日志尾部
  if [ "$rc" -eq 0 ]; then
    color=green
    title="✅ zhibi-vantage 部署成功"
    body=$(printf '**版本**：%s → %s\n**耗时**：%ss\n**健康检查**：后端 healthy · 前端 200' "$OLD" "$NEW" "$dur")
  else
    color=red
    title="❌ zhibi-vantage 部署失败"
    log_tail=$(tail -c 1000 "$DEPLOY_LOG" 2>/dev/null || true)
    body=$(printf '**失败阶段**：%s\n**目标版本**：%s\n**耗时**：%ss\n**日志尾部**：\n%s' "$STAGE" "$NEW" "$dur" "$log_tail")
  fi
  feishu_notify "$color" "$title" "$body"
  rm -f "$DEPLOY_LOG"
}
trap 'on_exit $?' EXIT

git fetch origin main --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" = "$REMOTE" ] && [ "${FORCE_DEPLOY:-0}" != 1 ]; then exit 0; fi

NOTIFY=1
OLD=$LOCAL
NEW=$REMOTE
STAGE="git reset"
exec > >(tee -a "$DEPLOY_LOG") 2>&1
echo "$(date '+%F %T') deploy: $LOCAL -> $REMOTE"
git reset --hard origin/main --quiet

# WEB_PORT 在 .env（不入库）：宿主机入口端口（3000 被 cartback-frontend 占用，现用 3002）
WEB_PORT=3000
[ -f .env ] && . ./.env && WEB_PORT=${WEB_PORT:-3000}

STAGE="docker compose build"
docker compose build
STAGE="docker compose up"
docker compose up -d --remove-orphans

# 健康门：后端 healthy + 前端 200，最多等 60s；不通过判定部署失败并推送飞书
# （镜像标签未动，可 docker tag 手工回退）
STAGE="健康检查"
S=none; W=000
for i in $(seq 1 30); do
  S=$(docker inspect -f '{{.State.Health.Status}}' zhibi-vantage 2>/dev/null || echo none)
  W=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$WEB_PORT/login 2>/dev/null || echo 000)
  [ "$S" = "healthy" ] && [ "$W" = "200" ] && break
  sleep 2
done
if [ "$S" = "healthy" ] && [ "$W" = "200" ]; then
  echo "$(date '+%F %T') backend=$S web=$W deploy done: $REMOTE"
else
  echo "$(date '+%F %T') backend=$S web=$W 健康检查未通过，判定部署失败: $REMOTE"
  exit 1
fi
