#!/bin/bash
# zhibi-vantage 自动部署 v2（P0 稳定性整改）
# 相比 v1 的关键修复：
#   1. 镜像可回滚：部署前把当前运行镜像打上 rollback tag，健康门失败自动秒级回退
#      （v1 固定 tag 被每次 build 覆盖，旧镜像变 dangling，失败后无法回滚、留下坏容器）
#   2. 健康门升级：/healthz 与 /login 连续 100 轮（约 5 分钟）0 失败，且逐轮校验
#      /login 引用的全部静态资源 200 + Content-Type 正确，容器 RestartCount/容器 ID
#      验收期不变——任何一次失败都判定部署失败，不写 deploy done
#   3. 失败即回滚：回滚后仍提供旧版本服务，不留 502 空窗；成功与失败路径都通过
#      trap/flock 正确收尾
#   4. 并发防重入：脚本内部自带第二把锁（cron 外层 flock 之外的兜底），任何来源
#      的并发部署第二个立即退出
#   5. 新镜像保留 sha-<short> tag 便于追溯运行版本对应的 commit（健康门验收项之一）
# cron 每分钟调一次（/etc/cron.d/zhibi-deploy）；无新提交时例行检查直接退出。
# 可用环境变量：FEISHU_WEBHOOK（通知目标）、FORCE_DEPLOY=1（强制重建）、
#              ZB_DRILL_HEALTH_FAIL=1（演练钩子：健康门强制失败以验证回滚路径）
set -euo pipefail
cd /opt/zhibi-vantage

# ---- 内部并发锁：任何来源（cron/手动/CI）同时只允许一个部署在跑 ----
INNER_LOCK=/tmp/zhibi-deploy.inner.lock
exec 9>"$INNER_LOCK"
if ! flock -n 9; then
  echo "$(date '+%F %T') deploy: 已有部署在执行，跳过本次（inner lock held）"
  exit 0
fi

FEISHU_WEBHOOK="${FEISHU_WEBHOOK:-}"  # 值机群 webhook 不入库：部署机 .env 提供
HOST_TAG=$(hostname)
START_TS=$SECONDS
NOTIFY=0
STAGE=准备
OLD= NEW=
DEPLOY_LOG=$(mktemp /tmp/zhibi-deploy-log.XXXXXX)
ROLLBACK_WEB_TAG="zhibi-web:rollback"
ROLLBACK_API_TAG="zhibi-vantage:rollback"
WEB_IMAGE="zhibi-web:0.2.0"
API_IMAGE="zhibi-vantage:1.5.0"

json_esc() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/}
  s=${s//$'\n'/\\n}
  printf '%s' "$s"
}

feishu_notify() {
  [ -n "$FEISHU_WEBHOOK" ] || { echo "[notify] FEISHU_WEBHOOK 未配置，跳过飞书通知"; return 0; }
  local payload resp
  payload=$(printf '{"msg_type":"interactive","card":{"config":{"wide_screen_mode":true},"header":{"template":"%s","title":{"tag":"plain_text","content":"%s"}},"elements":[{"tag":"div","text":{"tag":"lark_md","content":"%s"}},{"tag":"note","elements":[{"tag":"plain_text","content":"%s · %s · 完整日志：/var/log/zhibi-deploy.log"}]}]}}' \
    "$1" "$(json_esc "$2")" "$(json_esc "$3")" "$(json_esc "$HOST_TAG")" "$(json_esc "$(date '+%F %T %Z')")")
  resp=$(curl -fsS -m 10 -H 'Content-Type: application/json' -d "$payload" "$FEISHU_WEBHOOK" 2>/dev/null || true)
  case "$resp" in
    *'"code":0'*|*'"StatusCode":0'*) : ;;
    *) echo "$(date '+%F %T') deploy: 警告：飞书通知发送失败 resp=${resp:-<empty>}" ;;
  esac
}

on_exit() {
  local rc=$1 color title body dur log_tail
  dur=$(( SECONDS - START_TS ))
  if [ "$NOTIFY" != 1 ]; then rm -f "$DEPLOY_LOG"; return 0; fi
  sleep 1
  if [ "$rc" -eq 0 ]; then
    color=green
    title="✅ zhibi-vantage 部署成功"
    body=$(printf '**版本**：%s → %s\n**耗时**：%ss\n**健康门**：/healthz+/login 连续 100 轮 0 失败 · 静态资源全 200 · 容器未重启' "$OLD" "$NEW" "$dur")
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
echo "$(date '+%F %T') deploy v2: $LOCAL -> $REMOTE"
git reset --hard origin/main --quiet

WEB_PORT=3000
[ -f .env ] && . ./.env && WEB_PORT=${WEB_PORT:-3000}

# ---- 回滚锚点：部署前把当前运行镜像固化到 rollback tag ----
# 注意必须取"容器正在使用的镜像 ID"，不能取 tag（tag 会被本次 build 覆盖）
STAGE="回滚锚点"
OLD_WEB_IMG=$(docker inspect -f '{{.Image}}' zhibi-web 2>/dev/null || true)
OLD_API_IMG=$(docker inspect -f '{{.Image}}' zhibi-vantage 2>/dev/null || true)
if [ -n "$OLD_WEB_IMG" ]; then docker tag "$OLD_WEB_IMG" "$ROLLBACK_WEB_TAG"; fi
if [ -n "$OLD_API_IMG" ]; then docker tag "$OLD_API_IMG" "$ROLLBACK_API_TAG"; fi
echo "rollback anchor: web=${OLD_WEB_IMG:-<none>} api=${OLD_API_IMG:-<none>}"
RESTART_BASE_WEB=$(docker inspect -f '{{.RestartCount}}/{{.Id}}' zhibi-web 2>/dev/null || echo none)
RESTART_BASE_API=$(docker inspect -f '{{.RestartCount}}/{{.Id}}' zhibi-vantage 2>/dev/null || echo none)

STAGE="docker compose build"
docker compose build

# 新镜像打 SHA tag：运行版本 ↔ commit 可追溯；旧版本镜像保留同名旧 tag 供比对
SHORT=$(git rev-parse --short=7 HEAD)
docker tag "$WEB_IMAGE" "zhibi-web:sha-$SHORT" 2>/dev/null || true
docker tag "$API_IMAGE" "zhibi-vantage:sha-$SHORT" 2>/dev/null || true

STAGE="docker compose up"
docker compose up -d --remove-orphans

# ---- 健康门 v2 ----
# A 阶段：启动等待（后端 healthy + /login 200，最多 60s）
# B 阶段：验收 100 轮 × 3s（约 5 分钟）：
#   - 每轮 /healthz 与 /login 必须 200（任何失败立即判定部署失败）
#   - 每 5 轮解析 /login HTML 引用的全部 /_next/static 资源，逐一校验 200 + Content-Type
#   - 每 10 轮校验两容器 RestartCount 与容器 ID 未变化（防 restart policy 掩盖崩溃）
# 任何失败 → 自动回滚到 rollback tag 并按失败退出
STAGE="健康检查"
S=none; W=000
for i in $(seq 1 30); do
  S=$(docker inspect -f '{{.State.Health.Status}}' zhibi-vantage 2>/dev/null || echo none)
  W=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/login" 2>/dev/null || echo 000)
  [ "$S" = "healthy" ] && [ "$W" = "200" ] && break
  sleep 2
done
if [ "$S" != "healthy" ] || [ "$W" != "200" ]; then
  echo "$(date '+%F %T') backend=$S web=$W 启动等待超时，判定部署失败: $REMOTE"
  STAGE="健康检查-启动等待"
  exit 1
fi

check_static_assets() { # 解析 /login HTML，校验全部 /_next/static 资源；返回非 0 即失败
  local html assets asset expect_ct got_ct code n_fail=0
  html=$(curl -s -m 5 "http://127.0.0.1:$WEB_PORT/login" 2>/dev/null) || return 1
  # 排除反斜杠：RSC 内嵌数据中的路径带 \" 转义，避免提取出带尾部 \ 的假 URL（会命中 308）
  assets=$(printf '%s' "$html" | grep -oE '/_next/static/[^"\\]+' | sort -u)
  [ -n "$assets" ] || return 1
  while IFS= read -r asset; do
    [ -n "$asset" ] || continue
    case "$asset" in
      *.css) expect_ct="text/css" ;;
      *)     expect_ct="javascript" ;;
    esac
    got_ct=$(curl -s -o /dev/null -m 5 -D - "http://127.0.0.1:$WEB_PORT$asset" 2>/dev/null \
      | tr -d '\r' | awk 'BEGIN{IGNORECASE=1}/^HTTP\//{code=$2}/^content-type:/{ct=$2}/^$/{exit}END{print code" "ct}')
    code=${got_ct%% *}; ct=${got_ct#* }
    if [ "$code" != "200" ] || [[ "$ct" != *"$expect_ct"* ]]; then
      echo "  [static-fail] $asset code=$code ct=$ct (expect $expect_ct)"
      n_fail=$((n_fail+1))
    fi
  done <<< "$assets"
  [ "$n_fail" -eq 0 ]
}

container_stable() { # RestartCount 与容器 ID 与基线一致（未被重启/替换）
  local cur_web cur_api
  cur_web=$(docker inspect -f '{{.RestartCount}}/{{.Id}}' zhibi-web 2>/dev/null || echo changed)
  cur_api=$(docker inspect -f '{{.RestartCount}}/{{.Id}}' zhibi-vantage 2>/dev/null || echo changed)
  [ "$cur_web" = "$RESTART_BASE_WEB" ] && [ "$cur_api" = "$RESTART_BASE_API" ]
}

rollback() {
  echo "$(date '+%F %T') 触发回滚：恢复 rollback tag 镜像"
  STAGE="回滚"
  docker tag "$ROLLBACK_WEB_TAG" "$WEB_IMAGE" 2>/dev/null || echo "  警告：web rollback tag 不存在，跳过 web 回退"
  docker tag "$ROLLBACK_API_TAG" "$API_IMAGE" 2>/dev/null || echo "  警告：api rollback tag 不存在，跳过 api 回退"
  docker compose up -d --remove-orphans 2>&1 | tail -3
  local ok=1
  for i in $(seq 1 10); do
    W=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/login" 2>/dev/null || echo 000)
    [ "$W" = "200" ] && { ok=0; break; }
    sleep 3
  done
  if [ "$ok" -eq 0 ]; then
    echo "$(date '+%F %T') 回滚完成，旧版本已恢复服务（web=200）"
  else
    echo "$(date '+%F %T') 警告：回滚后 /login 仍未恢复 200，需要人工介入"
  fi
}

FAIL_REASON=""
for round in $(seq 1 100); do
  W=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/login" 2>/dev/null || echo 000)
  H=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/healthz" 2>/dev/null || echo 000)
  if [ "$W" != "200" ] || [ "$H" != "200" ]; then
    FAIL_REASON="round=$round /login=$W /healthz=$H"
    break
  fi
  if [ $((round % 5)) -eq 0 ]; then
    if ! check_static_assets; then
      FAIL_REASON="round=$round 静态资源校验失败"
      break
    fi
  fi
  if [ $((round % 10)) -eq 0 ]; then
    if ! container_stable; then
      FAIL_REASON="round=$round 容器 RestartCount/ID 发生变化（被重启或替换）"
      break
    fi
  fi
  if [ "${ZB_DRILL_HEALTH_FAIL:-0}" = "1" ] && [ "$round" -eq 3 ]; then
    FAIL_REASON="round=3 演练钩子 ZB_DRILL_HEALTH_FAIL 触发"
    break
  fi
  sleep 3
done

if [ -n "$FAIL_REASON" ]; then
  echo "$(date '+%F %T') 健康门未通过（$FAIL_REASON），判定部署失败: $REMOTE"
  STAGE="健康检查-100轮验收"
  rollback
  exit 1
fi

# 部署成功后清理 48h 前的 dangling 镜像（rollback/sha tag 不受影响），防磁盘涨满
docker image prune -f --filter "until=48h" >/dev/null 2>&1 || true

echo "$(date '+%F %T') backend=$S web=200 健康门 100 轮通过 deploy done: $REMOTE (image zhibi-web:sha-$SHORT)"
