#!/bin/bash
# zhibi-vantage 自动部署 v3（P0 r2：蓝绿切换 / 统一回滚 / 真实部署状态）
#
# 与 v2 的关键差异：
#   1. 入口不再随部署中断：3002 由宿主机 nginx 持有，前端以 blue(3102)/green(3202)
#      双槽交替，候选容器验证通过后 nginx 原子 reload 切换，旧槽保留 120s 排空期。
#   2. 健康门基线取「候选/新容器启动之后」的 ID 与 RestartCount（v2 取部署前的
#      容器 ID，而容器本就该被替换，导致验收期必然误判回滚）。
#   3. 统一 trap 回滚：从首次改动运行服务起，任何非零退出都回滚，且只回滚一次；
#      构建阶段失败不动运行服务、不回滚。
#   4. 部署状态在仓库外 /var/lib/zhibi-deploy/state.json（原子写）：
#      cron 以 remote main 与 deployed_sha 比较，不再以工作树 HEAD 代替运行版本；
#      同一 failed_sha 不重复部署，除非出现新 SHA 或 FORCE_DEPLOY=1。
#   5. 后端（compose 单实例）在数秒维护窗口内替换：明确 503 维护页，不产生随机 502，
#      同一时刻只有一个后端消费数据卷与 scheduler。
#
# 环境变量：FEISHU_WEBHOOK / FORCE_DEPLOY=1 / ZB_DRILL_HEALTH_FAIL=1 /
#          ZB_DRILL_FAIL_STAGE=build（演练：构建后及早失败，验证"未动服务不回滚"）
set -euo pipefail
cd /opt/zhibi-vantage

INNER_LOCK=/tmp/zhibi-deploy.inner.lock
exec 9>"$INNER_LOCK"
if ! flock -n 9; then
  echo "$(date '+%F %T') deploy: 已有部署在执行，跳过本次（inner lock held）"
  exit 0
fi

STATE_DIR=/var/lib/zhibi-deploy
STATE=$STATE_DIR/state.json
NGX_UPSTREAM=/etc/nginx/conf.d/zhibi-upstream.conf
NGX_MAINT=/etc/nginx/zhibi_maintenance
WEB_PORT=3002
SLOT_BLUE_PORT=3102
SLOT_GREEN_PORT=3202
FEISHU_WEBHOOK="${FEISHU_WEBHOOK:-}"

START_TS=$SECONDS
NOTIFY=0
STAGE=准备
OLD= NEW=
DEPLOY_LOG=$(mktemp /tmp/zhibi-deploy-log.XXXXXX)
ROLLBACK_DONE=0
SERVICE_TOUCHED=0
NGX_SWITCHED=0
MAINT_ON=0
CAND_NAME=""; CAND_PORT=""; ACTIVE_NAME=""; ACTIVE_PORT=""; NEXT_SLOT=""
OLD_API_IMG=""; OLD_WEB_RB_IMG=""; NEW_WEB_IMG=""; NEW_API_IMG=""
BASE_WEB_ID=""; BASE_API_ID=""

mkdir -p "$STATE_DIR"
[ -f "$STATE" ] || printf '{"deployed_sha":"","deployed_web_image_id":"","deployed_api_image_id":"","active_web_slot":"blue","failed_sha":"","deployed_at":""}\n' > "$STATE"

state_get() {
  grep -o "\"$1\":\"[^\"]*\"" "$STATE" 2>/dev/null | head -1 | sed 's/.*:"//; s/"$//' || true
}
state_write() { # $1=deployed_sha $2=web_img $3=api_img $4=slot $5=failed_sha $6=at
  local tmp="$STATE.tmp.$$"
  printf '{"deployed_sha":"%s","deployed_web_image_id":"%s","deployed_api_image_id":"%s","active_web_slot":"%s","failed_sha":"%s","deployed_at":"%s"}\n' \
    "$1" "$2" "$3" "$4" "$5" "$6" > "$tmp" && mv "$tmp" "$STATE"
}

json_esc() { local s=$1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; printf '%s' "$s"; }

feishu_notify() {
  [ -n "$FEISHU_WEBHOOK" ] || { echo "[notify] FEISHU_WEBHOOK 未配置，跳过飞书通知"; return 0; }
  local payload resp
  payload=$(printf '{"msg_type":"interactive","card":{"config":{"wide_screen_mode":true},"header":{"template":"%s","title":{"tag":"plain_text","content":"%s"}},"elements":[{"tag":"div","text":{"tag":"lark_md","content":"%s"}},{"tag":"note","elements":[{"tag":"plain_text","content":"%s · %s"}]}]}}' \
    "$1" "$(json_esc "$2")" "$(json_esc "$3")" "$(json_esc "$(hostname)")" "$(json_esc "$(date '+%F %T %Z')")")
  resp=$(curl -fsS -m 10 -H 'Content-Type: application/json' -d "$payload" "$FEISHU_WEBHOOK" 2>/dev/null || true)
  case "$resp" in *'"code":0'*|*'"StatusCode":0'*) : ;; *) echo "$(date '+%F %T') 警告：飞书通知失败" ;; esac
}

rollback() {
  [ "$ROLLBACK_DONE" = "1" ] && return 0
  ROLLBACK_DONE=1
  local ok=0
  echo "$(date '+%F %T') 触发回滚（stage=$STAGE switched=$NGX_SWITCHED）"
  STAGE="回滚"
  touch "$NGX_MAINT"; MAINT_ON=1

  if [ "$NGX_SWITCHED" = "1" ] && [ -n "$ACTIVE_PORT" ]; then
    printf 'upstream zhibi_web_active {\n    server 127.0.0.1:%s;\n    keepalive 32;\n}\n' "$ACTIVE_PORT" > "$NGX_UPSTREAM"
    nginx -t >/dev/null 2>&1 && nginx -s reload 2>/dev/null && echo "  入口已切回旧槽 $ACTIVE_PORT" || echo "  警告：nginx 回切失败"
    NGX_SWITCHED=0
  fi

  if [ -n "$OLD_API_IMG" ]; then
    docker tag "$OLD_API_IMG" "zhibi-vantage:1.5.0" 2>/dev/null || true
    ( cd /opt/zhibi-vantage && docker compose up -d --no-deps zhibi-vantage 2>&1 | tail -2 ) || echo "  警告：后端回滚启动失败"
  fi

  [ -n "$CAND_NAME" ] && docker rm -f "$CAND_NAME" >/dev/null 2>&1 || true
  rm -f "$NGX_MAINT"; MAINT_ON=0

  sleep 3
  local LOGIN HEALTHZ BAD IMG_WEB IMG_API H_WEB H_API
  LOGIN=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/login" || echo 000)
  HEALTHZ=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/healthz" || echo 000)
  BAD=$(curl -s -m 5 "http://127.0.0.1:$WEB_PORT/login" | grep -oE '/_next/static/[^"\\]+' | sort -u | while read -r a; do
      [ -n "$a" ] || continue
      c=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT$a"); [ "$c" = "200" ] || echo x
    done | wc -l)
  IMG_WEB=$(docker inspect -f '{{.Image}}' "$ACTIVE_NAME" 2>/dev/null || echo none)
  IMG_API=$(docker inspect -f '{{.Image}}' zhibi-vantage 2>/dev/null || echo none)
  H_WEB=$(docker inspect -f '{{.State.Health.Status}}' "$ACTIVE_NAME" 2>/dev/null || echo none)
  H_API=$(docker inspect -f '{{.State.Health.Status}}' zhibi-vantage 2>/dev/null || echo none)
  echo "  回滚验证: /login=$LOGIN /healthz=$HEALTHZ 静态异常=$BAD web=$H_WEB api=$H_API"
  echo "  镜像核对: web=$IMG_WEB (锚点 ${OLD_WEB_RB_IMG:-n/a}) api=$IMG_API (锚点 ${OLD_API_IMG:-n/a})"

  if [ "$LOGIN" = "200" ] && [ "$HEALTHZ" = "200" ] && [ "$BAD" = "0" ] \
     && [ "$IMG_API" = "$OLD_API_IMG" ] && [ "$IMG_WEB" = "$OLD_WEB_RB_IMG" ]; then
    echo "$(date '+%F %T') 回滚完成：旧版本已恢复（镜像与锚点严格一致）"
    ok=1
  else
    echo "$(date '+%F %T') 回滚失败或不完整：需要人工介入"
  fi
  [ "$ok" = "1" ]
}

on_exit() {
  local rc=$1 dur
  if [ "$rc" -ne 0 ] && [ "$SERVICE_TOUCHED" = "1" ] && [ "$ROLLBACK_DONE" = "0" ]; then
    echo "$(date '+%F %T') 非零退出（stage=$STAGE），开始回滚"
    rollback || true
    # 回滚后记录失败 SHA（deployed_sha 保持旧版本不变）
    [ -n "$NEW" ] && state_write "$(state_get deployed_sha)" "$(state_get deployed_web_image_id)" \
      "$(state_get deployed_api_image_id)" "$(state_get active_web_slot)" "$NEW" "$(state_get deployed_at)"
  fi
  dur=$(( SECONDS - START_TS ))
  if [ "$NOTIFY" = "1" ]; then
    if [ "$rc" -eq 0 ]; then
      feishu_notify green "✅ zhibi-vantage 部署成功" "**版本**：$OLD → $NEW\\n**耗时**：${dur}s\\n**健康门**：100 轮 0 失败 · 蓝绿切换"
    else
      feishu_notify red "❌ zhibi-vantage 部署失败" "**阶段**：$STAGE\\n**目标**：$NEW\\n**耗时**：${dur}s\\n**回滚**：$([ "$ROLLBACK_DONE" = "1" ] && echo 已执行 || echo 未执行)"
    fi
  fi
  rm -f "$DEPLOY_LOG"
}
trap 'on_exit $?' EXIT

git fetch origin '+refs/heads/*:refs/remotes/origin/*' --quiet
DEPLOY_REF="${DEPLOY_REF:-main}"    # 审核分支预览：DEPLOY_REF=review/xxx（默认 main）
REMOTE=$(git rev-parse "origin/${DEPLOY_REF}")
DEPLOYED=$(state_get deployed_sha)
FAILED_SHA=$(state_get failed_sha)
ACTIVE_SLOT=$(state_get active_web_slot); [ -n "$ACTIVE_SLOT" ] || ACTIVE_SLOT=blue
if [ "$ACTIVE_SLOT" = "blue" ]; then
  ACTIVE_NAME=zhibi-web-blue;  ACTIVE_PORT=$SLOT_BLUE_PORT
  CAND_NAME=zhibi-web-green;   CAND_PORT=$SLOT_GREEN_PORT; NEXT_SLOT=green
else
  ACTIVE_NAME=zhibi-web-green; ACTIVE_PORT=$SLOT_GREEN_PORT
  CAND_NAME=zhibi-web-blue;    CAND_PORT=$SLOT_BLUE_PORT;  NEXT_SLOT=blue
fi

if [ "${FORCE_DEPLOY:-0}" != "1" ]; then
  if [ "$REMOTE" = "$DEPLOYED" ]; then
    echo "$(date '+%F %T') 无需部署：remote=$REMOTE == deployed_sha"
    exit 0
  fi
  if [ -n "$FAILED_SHA" ] && [ "$REMOTE" = "$FAILED_SHA" ]; then
    echo "$(date '+%F %T') 跳过：$REMOTE 上次部署失败已隔离（failed_sha）"
    exit 0
  fi
fi

NOTIFY=1
OLD=${DEPLOYED:-$(git rev-parse HEAD)}
NEW=$REMOTE
STAGE="git reset"
exec > >(tee -a "$DEPLOY_LOG") 2>&1
echo "$(date '+%F %T') deploy v3: deployed=${DEPLOYED:-none} -> $REMOTE (ref=$DEPLOY_REF active_slot=$ACTIVE_SLOT)"
git reset --hard "origin/${DEPLOY_REF}" --quiet
SHORT=$(git rev-parse --short=7 HEAD)

STAGE="回滚锚点"
OLD_WEB_RB_IMG=$(docker inspect -f '{{.Image}}' "$ACTIVE_NAME" 2>/dev/null || true)
OLD_API_IMG=$(docker inspect -f '{{.Image}}' zhibi-vantage 2>/dev/null || true)
[ -n "$OLD_WEB_RB_IMG" ] && docker tag "$OLD_WEB_RB_IMG" zhibi-web:rollback
[ -n "$OLD_API_IMG" ] && docker tag "$OLD_API_IMG" zhibi-vantage:rollback
echo "anchor: web=${OLD_WEB_RB_IMG:-none} api=${OLD_API_IMG:-none} active=$ACTIVE_NAME:$ACTIVE_PORT"

STAGE="docker compose build"
docker compose build
NEW_WEB_IMG=$(docker inspect -f '{{.Id}}' zhibi-web:0.2.0)
NEW_API_IMG=$(docker inspect -f '{{.Id}}' zhibi-vantage:1.5.0)
docker tag zhibi-web:0.2.0 "zhibi-web:cand-$SHORT"
docker tag zhibi-vantage:1.5.0 "zhibi-vantage:cand-$SHORT"
echo "candidate images: web=$NEW_WEB_IMG api=$NEW_API_IMG (cand-$SHORT)"

if [ "${ZB_DRILL_FAIL_STAGE:-}" = "build" ]; then
  echo "$(date '+%F %T') 演练：构建后主动失败（未改动运行服务，不应回滚）"
  STAGE="演练-构建后失败"
  exit 1
fi

SERVICE_TOUCHED=1

STAGE="启动候选前端"
docker rm -f "$CAND_NAME" >/dev/null 2>&1 || true
ENVFILE=$(mktemp /tmp/zhibi-cand-env.XXXXXX); chmod 600 "$ENVFILE"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$ACTIVE_NAME" > "$ENVFILE" 2>/dev/null || true
NETMODE=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$ACTIVE_NAME" 2>/dev/null || echo bridge)
docker run -d --name "$CAND_NAME" --network "$NETMODE" --restart unless-stopped \
  -p "127.0.0.1:${CAND_PORT}:3000" --env-file "$ENVFILE" "$NEW_WEB_IMG" >/dev/null
rm -f "$ENVFILE"
echo "候选前端已启动：$CAND_NAME @ 127.0.0.1:$CAND_PORT (image $NEW_WEB_IMG)"

WAIT=0; C=000
for i in $(seq 1 30); do
  C=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$CAND_PORT/login" 2>/dev/null || echo 000)
  [ "$C" = "200" ] && break; sleep 2; WAIT=$((WAIT+2))
done
[ "$C" = "200" ] || { echo "$(date '+%F %T') 候选前端 /login=$C"; STAGE="候选前端启动"; exit 1; }
echo "候选前端 /login=200（${WAIT}s）"

STAGE="候选静态资源"
BAD=0
ASSETS=$(curl -s -m 5 "http://127.0.0.1:$CAND_PORT/login" | grep -oE '/_next/static/[^"\\]+' | sort -u)
while IFS= read -r a; do
  [ -n "$a" ] || continue
  case "$a" in *.css) exp="text/css";; *) exp="javascript";; esac
  got=$(curl -s -o /dev/null -m 5 -D - "http://127.0.0.1:$CAND_PORT$a" 2>/dev/null | tr -d '\r' | awk 'BEGIN{IGNORECASE=1}/^HTTP\//{c=$2}/^content-type:/{t=$2}/^$/{exit}END{print c" "t}')
  code=${got%% *}; ct=${got#* }
  { [ "$code" = "200" ] && [[ "$ct" == *"$exp"* ]]; } || { echo "  静态异常 $a -> $code $ct"; BAD=$((BAD+1)); }
done <<< "$ASSETS"
[ "$BAD" -eq 0 ] || { echo "$(date '+%F %T') 候选静态资源异常 $BAD 个"; STAGE="候选静态资源"; exit 1; }
echo "候选静态资源全部 200"

STAGE="后端替换（维护窗口）"
touch "$NGX_MAINT"; MAINT_ON=1
echo "$(date '+%F %T') 进入维护态"
MAINT_T0=$(date +%s)
docker compose up -d --no-deps zhibi-vantage 2>&1 | tail -3
# 就绪探测用容器内直探 HTTP（与 healthcheck 同命令），0.5s 间隔——不依赖
# docker healthcheck 的 30s 周期，把维护窗口从数十秒压到数秒
api_ready() {
  docker exec zhibi-vantage node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3300)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
}
BH=not-ready
for i in $(seq 1 120); do
  if api_ready; then BH=ready; break; fi
  sleep 0.5
done
MAINT_WINDOW=$(( $(date +%s) - MAINT_T0 ))
if [ "$BH" != "ready" ]; then
  echo "$(date '+%F %T') 新后端 60s 内未就绪（$BH）"; STAGE="后端就绪探测"; exit 1
fi
echo "新后端就绪耗时 ${MAINT_WINDOW}s"
CH=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$CAND_PORT/healthz" 2>/dev/null || echo 000)
[ "$CH" = "200" ] || { echo "$(date '+%F %T') 候选 /healthz=$CH"; STAGE="候选后端联通"; exit 1; }
rm -f "$NGX_MAINT"; MAINT_ON=0
echo "新后端 healthy，维护态关闭"

STAGE="nginx 切换"
printf 'upstream zhibi_web_active {\n    server 127.0.0.1:%s;\n    keepalive 32;\n}\n' "$CAND_PORT" > "$NGX_UPSTREAM.new"
nginx -t >/dev/null 2>&1 || { echo "nginx -t 失败，放弃切换"; rm -f "$NGX_UPSTREAM.new"; STAGE="nginx 校验"; exit 1; }
mv "$NGX_UPSTREAM.new" "$NGX_UPSTREAM"
nginx -s reload
NGX_SWITCHED=1
echo "$(date '+%F %T') 入口已切到 $CAND_NAME:$CAND_PORT"

STAGE="健康门-基线"
BASE_WEB_ID=$(docker inspect -f '{{.RestartCount}}/{{.Id}}' "$CAND_NAME")
BASE_API_ID=$(docker inspect -f '{{.RestartCount}}/{{.Id}}' zhibi-vantage)
echo "健康门基线（候选启动后）：web=$BASE_WEB_ID api=$BASE_API_ID"

STAGE="健康门-100轮"
FAIL_REASON=""
for round in $(seq 1 100); do
  W=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/login" 2>/dev/null || echo 000)
  H=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/healthz" 2>/dev/null || echo 000)
  if [ "$W" != "200" ] || [ "$H" != "200" ]; then FAIL_REASON="round=$round /login=$W /healthz=$H"; break; fi
  if [ $((round % 5)) -eq 0 ]; then
    SBAD=$(curl -s -m 5 "http://127.0.0.1:$WEB_PORT/login" | grep -oE '/_next/static/[^"\\]+' | sort -u | while read -r a; do
        [ -n "$a" ] || continue
        c=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT$a"); [ "$c" = "200" ] || echo x
      done | wc -l)
    [ "$SBAD" = "0" ] || { FAIL_REASON="round=$round 静态资源 $SBAD 个异常"; break; }
  fi
  if [ $((round % 10)) -eq 0 ]; then
    CW=$(docker inspect -f '{{.RestartCount}}/{{.Id}}' "$CAND_NAME" 2>/dev/null || echo changed)
    CA=$(docker inspect -f '{{.RestartCount}}/{{.Id}}' zhibi-vantage 2>/dev/null || echo changed)
    [ "$CW" = "$BASE_WEB_ID" ] || { FAIL_REASON="round=$round 候选前端容器变化"; break; }
    [ "$CA" = "$BASE_API_ID" ] || { FAIL_REASON="round=$round 后端容器变化"; break; }
  fi
  if [ "${ZB_DRILL_HEALTH_FAIL:-0}" = "1" ] && [ "$round" -eq 3 ]; then
    FAIL_REASON="round=3 演练钩子"; break
  fi
  sleep 3
done
if [ -n "$FAIL_REASON" ]; then
  echo "$(date '+%F %T') 健康门未通过（$FAIL_REASON）"
  STAGE="健康门-100轮"
  exit 1
fi

STAGE="更新部署状态"
state_write "$REMOTE" "$NEW_WEB_IMG" "$NEW_API_IMG" "$NEXT_SLOT" "" "$(date -u '+%FT%TZ')"
docker tag "$NEW_WEB_IMG" "zhibi-web:deployed-$SHORT"
docker tag "$NEW_API_IMG" "zhibi-vantage:deployed-$SHORT"

STAGE="旧槽排空"
echo "$(date '+%F %T') 旧槽 $ACTIVE_NAME 排空 120s 后停止"
sleep 120
docker stop "$ACTIVE_NAME" >/dev/null 2>&1 || true
echo "旧槽已停止（zhibi-web:rollback 保留供回滚）"

docker image prune -f --filter "until=48h" >/dev/null 2>&1 || true
echo "$(date '+%F %T') deploy done: $REMOTE (slot=$NEXT_SLOT web=$NEW_WEB_IMG api=$NEW_API_IMG)"
