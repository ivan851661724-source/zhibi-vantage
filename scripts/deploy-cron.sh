#!/bin/bash
# zhibi-vantage 自动部署 v4（P0 r3：提交态收敛 / 静态多版本归档 / 密钥零残留 / 预构建镜像）
#
# 与 v3 的关键差异：
#   1. 部署状态只在全部必要步骤与最终核验完成后原子提交（v3 在健康门后、排空前提交，
#      排空期被打断会出现"状态=新版、运行=旧版"的自相矛盾）。提交置 COMMITTED=1，
#      此后仅剩旧槽排空/归档修剪/镜像清理等容错步骤，任何异常不再回滚运行版本。
#   2. reconcile()：脚本每次启动（含 cron 命中暂停标记前）先做四方一致性核对——
#      状态文件 vs nginx active upstream vs 实际容器 vs 镜像 ID。被打断的部署若已
#      实际接管入口且健康 → 滚动提交；否则按状态文件恢复。--reconcile 可单独运行。
#   3. 静态资源多版本归档 /var/lib/zhibi-static：内容哈希文件名跨 release 累积，
#      nginx 第一层直供磁盘，旧页面在旧槽停止（超过 120s 排空窗）后仍能加载全部 chunk。
#   4. 含容器环境变量的临时文件一律登记（registered-tmp.list），由统一 EXIT trap 清理，
#      候选启动失败/SIGTERM/回滚失败路径均不残留。
#   5. 预构建镜像部署路径（ZB_PREBUILT_WEB/API）：按 zb.commit/zb.tree label 校验
#      镜像来源与目标提交一致，不一致拒绝；缓存构建路径在构建后同样自检 label（fail-closed）。
#      本机永远禁止 --no-cache 全量重建（1.9GB 内存两次压死实录）。
#
# 环境变量：FEISHU_WEBHOOK / FORCE_DEPLOY=1 / ZB_IGNORE_PAUSE=1 / DEPLOY_REF=<git ref> /
#   ZB_SKIP_BUILD=1 + ZB_CANDIDATE_WEB_IMG/API_IMG（机制演练，显式历史镜像）/
#   ZB_PREBUILT_WEB_IMG + ZB_PREBUILT_API_IMG（预构建部署，强制 label 校验）/
#   ZB_DRILL_HEALTH_FAIL=1（健康门演练钩子）/ ZB_DRILL_FAIL_STAGE=build /
#   ZB_HEALTH_ROUNDS（默认 100；演练可降）/ ZB_TEST_SECRET_MARKER（回归：注入受控假密钥标记）
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
INFLIGHT=$STATE_DIR/inflight.json
TMPREG=$STATE_DIR/registered-tmp.list
NGX_UPSTREAM=/etc/nginx/conf.d/zhibi-upstream.conf
NGX_MAINT=/etc/nginx/zhibi_maintenance
STATIC_ARCHIVE=/var/lib/zhibi-static
WEB_PORT=3002
SLOT_BLUE_PORT=3102
SLOT_GREEN_PORT=3202
FEISHU_WEBHOOK="${FEISHU_WEBHOOK:-}"

START_TS=$SECONDS
NOTIFY=0
STAGE=准备
OLD= NEW=
COMMITTED=0
HEALTH_ROUNDS="${ZB_HEALTH_ROUNDS:-100}"

# ---------- 临时文件登记（密钥零残留） ----------
# 所有含容器环境变量/密钥可能性的临时文件必须登记，EXIT trap 统一删除；
# 直接 rm 的内联清理只是优化，兜底永远在 trap。
reg_tmp() { printf '%s\n' "$1" >> "$TMPREG"; }
cleanup_registered_tmp() {
  if [ -f "$TMPREG" ]; then
    while IFS= read -r f; do
      [ -n "$f" ] && rm -f "$f" 2>/dev/null || true
    done < "$TMPREG"
    rm -f "$TMPREG"
  fi
}
mkdir -p "$STATE_DIR"
DEPLOY_LOG=$(mktemp /tmp/zhibi-deploy-log.XXXXXX)
reg_tmp "$DEPLOY_LOG"
ROLLBACK_DONE=0
SERVICE_TOUCHED=0
NGX_SWITCHED=0
MAINT_ON=0
CAND_NAME=""; CAND_PORT=""; ACTIVE_NAME=""; ACTIVE_PORT=""; NEXT_SLOT=""
OLD_API_IMG=""; OLD_WEB_RB_IMG=""; NEW_WEB_IMG=""; NEW_API_IMG=""
BASE_WEB_ID=""; BASE_API_ID=""

INFLIGHT=$STATE_DIR/inflight.json
NGX_UPSTREAM=/etc/nginx/conf.d/zhibi-upstream.conf
NGX_MAINT=/etc/nginx/zhibi_maintenance
STATIC_ARCHIVE=/var/lib/zhibi-static
WEB_PORT=3002
SLOT_BLUE_PORT=3102
SLOT_GREEN_PORT=3202
FEISHU_WEBHOOK="${FEISHU_WEBHOOK:-}"

mkdir -p "$STATIC_ARCHIVE/_next/static"
[ -f "$STATE" ] || printf '{"deployed_sha":"","deployed_web_image_id":"","deployed_api_image_id":"","active_web_slot":"blue","failed_sha":"","deployed_at":""}\n' > "$STATE"

# 跨重启的暂停标记：cron 命中即记录并退出（flock 会随重启消失，不能只靠锁）。
# 人工/回归（FORCE_DEPLOY=1 或 ZB_IGNORE_PAUSE=1）显式越过。reconcile 在此之前已执行。
PAUSED_HIT=0
if [ -f "$STATE_DIR/deploy-paused" ] && [ "${FORCE_DEPLOY:-0}" != "1" ] && [ "${ZB_IGNORE_PAUSE:-0}" != "1" ]; then
  PAUSED_HIT=1
fi

state_get() { # $1=key $2=file(可选，默认 state.json)
  local f="${2:-$STATE}"
  grep -o "\"$1\":\"[^\"]*\"" "$f" 2>/dev/null | head -1 | sed 's/.*:"//; s/"$//' || true
}
state_write() { # $1=deployed_sha $2=web_img $3=api_img $4=slot $5=failed_sha $6=at
  local tmp="$STATE.tmp.$$"
  printf '{"deployed_sha":"%s","deployed_web_image_id":"%s","deployed_api_image_id":"%s","active_web_slot":"%s","failed_sha":"%s","deployed_at":"%s"}\n' \
    "$1" "$2" "$3" "$4" "$5" "$6" > "$tmp" && mv "$tmp" "$STATE"
}
inflight_write() { # $1=target_sha $2=web_img $3=api_img $4=slot
  local tmp="$INFLIGHT.tmp.$$"
  printf '{"target_sha":"%s","web_img":"%s","api_img":"%s","slot":"%s","ts":"%s"}\n' \
    "$1" "$2" "$3" "$4" "$(date -u '+%FT%TZ')" > "$tmp" && mv "$tmp" "$INFLIGHT"
}

port_of_slot() { case "$1" in blue) echo "$SLOT_BLUE_PORT";; green) echo "$SLOT_GREEN_PORT";; *) echo "";; esac; }
slot_of_port() { case "$1" in "$SLOT_BLUE_PORT") echo blue;; "$SLOT_GREEN_PORT") echo green;; *) echo "";; esac; }
name_of_slot() { case "$1" in blue) echo zhibi-web-blue;; green) echo zhibi-web-green;; *) echo "";; esac; }
nginx_active_port() {
  awk '/^upstream zhibi_web_active/,/^}/' "$NGX_UPSTREAM" 2>/dev/null \
    | grep -oE '127\.0\.0\.1:[0-9]+' | head -1 | cut -d: -f2 || echo ""
}
write_upstream_file() { # $1=active_port $2=previous_port
  printf 'upstream zhibi_web_active {\n    server 127.0.0.1:%s;\n    keepalive 32;\n}\nupstream zhibi_web_previous {\n    server 127.0.0.1:%s;\n    keepalive 8;\n}\n' "$1" "$2" > "$NGX_UPSTREAM.new"
}
container_running() { docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null | grep -q '^running$'; }
container_healthy() { docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null | grep -q '^healthy$'; }
api_ready() {
  docker exec zhibi-vantage node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3300)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
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

resource_preflight() {
  local avail_mb swap_mb disk_gb load1 cores builds reasons=""
  local min_mb=800
  [ "${ZB_SKIP_BUILD:-0}" = "1" ] && min_mb=400
  avail_mb=$(free -m | awk '/^Mem:/{print $7}')
  swap_mb=$(free -m | awk '/^Swap:/{print $2}')
  disk_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
  load1=$(cut -d' ' -f1 /proc/loadavg)
  cores=$(nproc)
  builds=$(pgrep -cf 'docker build|compose build|buildkit|deploy\.sh' 2>/dev/null || true)
  echo "资源预检: 内存可用=${avail_mb}MB swap=${swap_mb}MB 磁盘可用=${disk_gb}GB load1=$load1 cores=$cores 构建/部署进程=${builds:-0}（含自身）"
  [ "${avail_mb:-0}" -ge "$min_mb" ] || reasons="$reasons 可用内存${avail_mb}MB<${min_mb}MB;"
  [ "${disk_gb:-0}" -ge 2 ] || reasons="$reasons 磁盘可用${disk_gb}GB<2GB;"
  awk "BEGIN{exit !($load1 <= $cores * 2)}" || reasons="$reasons load1=$load1 超过 ${cores}x2;"
  if [ -n "$reasons" ]; then
    echo "资源预检未通过：$reasons —— 在修改运行服务前退出"
    return 1
  fi
}

# ---------- 静态资源多版本归档 ----------
# 内容哈希文件名跨 release 唯一，直接累积合并；nginx 第一层从磁盘直供。
archive_static_from() { # $1=container  失败返回非零（调用方决定容错等级）
  local c="$1"
  docker cp "$c":/app/.next/static/. "$STATIC_ARCHIVE/_next/static/" >/dev/null 2>&1 || return 1
  chmod -R a+rX "$STATIC_ARCHIVE" 2>/dev/null || true
  return 0
}
archive_prune() {
  local n
  n=$(find "$STATIC_ARCHIVE" -type f -mtime +60 2>/dev/null | wc -l || echo 0)
  [ "${n:-0}" -gt 0 ] && find "$STATIC_ARCHIVE" -type f -mtime +60 -delete 2>/dev/null || true
  echo "静态归档修剪: 清理 ${n:-0} 个超过 60 天的文件（保留总量 $(du -sh "$STATIC_ARCHIVE" 2>/dev/null | cut -f1)）"
}

# ---------- 回滚（仅 COMMITTED=0 时允许到达） ----------
rollback() {
  [ "$ROLLBACK_DONE" = "1" ] && return 0
  ROLLBACK_DONE=1
  local ok=0
  local rb_t0; rb_t0=$(date +%s)
  echo "$(date '+%F %T') 触发回滚（stage=$STAGE switched=$NGX_SWITCHED）"
  STAGE="回滚"
  touch "$NGX_MAINT"; MAINT_ON=1

  if [ "$NGX_SWITCHED" = "1" ] && [ -n "$ACTIVE_PORT" ]; then
    write_upstream_file "$ACTIVE_PORT" "$ACTIVE_PORT"
    nginx -t >/dev/null 2>&1 && nginx -s reload 2>/dev/null && echo "  入口已切回旧槽 $ACTIVE_PORT" || echo "  警告：nginx 回切失败"
    NGX_SWITCHED=0
  fi

  if [ -n "$OLD_API_IMG" ]; then
    docker tag "$OLD_API_IMG" "zhibi-vantage:1.5.0" 2>/dev/null || true
    ( cd /opt/zhibi-vantage && docker compose up -d --no-deps zhibi-vantage 2>&1 | tail -2 ) || echo "  警告：后端回滚启动失败"
  fi

  [ -n "$CAND_NAME" ] && docker rm -f "$CAND_NAME" >/dev/null 2>&1 || true
  rm -f "$INFLIGHT"
  # 后端就绪后再撤维护态：否则恢复窗口内的请求会穿透到启动中的后端拿 500
  local ri
  for ri in $(seq 1 60); do
    if api_ready; then break; fi
    sleep 0.5
  done
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
    echo "  回滚耗时 $(( $(date +%s) - rb_t0 ))s"
    ok=1
  else
    echo "$(date '+%F %T') 回滚失败或不完整：需要人工介入"
  fi
  [ "$ok" = "1" ]
}

on_exit() {
  local rc=$1 dur
  if [ "$rc" -ne 0 ] && [ "$SERVICE_TOUCHED" = "1" ] && [ "$COMMITTED" = "0" ] && [ "$ROLLBACK_DONE" = "0" ]; then
    echo "$(date '+%F %T') 非零退出（stage=$STAGE），开始回滚"
    rollback || true
    if [ -n "$NEW" ] && [ "${ZB_DRILL_HEALTH_FAIL:-0}" != "1" ] && [ "$NEW" != "$(state_get deployed_sha)" ]; then
      state_write "$(state_get deployed_sha)" "$(state_get deployed_web_image_id)" \
        "$(state_get deployed_api_image_id)" "$(state_get active_web_slot)" "$NEW" "$(state_get deployed_at)"
    fi
  elif [ "$rc" -ne 0 ] && [ "$COMMITTED" = "1" ]; then
    # committed 后不回滚运行版本：状态文件、入口、容器已三方一致，
    # 剩余步骤（排空/修剪）全部容错，异常只记录。
    echo "$(date '+%F %T') 已提交态退出（rc=$rc，stage=$STAGE）：不回滚运行版本"
  fi
  dur=$(( SECONDS - START_TS ))
  if [ "$NOTIFY" = "1" ]; then
    if [ "$rc" -eq 0 ]; then
      feishu_notify green "✅ zhibi-vantage 部署成功" "**版本**：$OLD → $NEW\\n**耗时**：${dur}s\\n**健康门**：${HEALTH_ROUNDS} 轮 0 失败 · 蓝绿切换 · 状态已提交"
    else
      feishu_notify red "❌ zhibi-vantage 部署失败" "**阶段**：$STAGE\\n**目标**：$NEW\\n**耗时**：${dur}s\\n**回滚**：$([ "$ROLLBACK_DONE" = "1" ] && echo 已执行 || { [ "$COMMITTED" = "1" ] && echo 不适用-已提交态 || echo 未执行; })"
    fi
  fi
  cleanup_registered_tmp
}
trap 'on_exit $?' EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# ---------- reconcile：四方一致性核对（状态文件 / nginx / 容器 / 镜像） ----------
# 被打断部署的两种收敛方向：
#   A. nginx 已指向 inflight 候选且候选与后端均健康 → 滚动提交（写状态，视为部署完成）
#   B. 其余一切不一致 → 以状态文件为准恢复（回切 nginx、重建槽容器、回滚后端镜像）
reconcile() {
  local s_sha s_web s_api s_slot s_port ngx_port actual_name actual_img actual_up b_img
  s_sha=$(state_get deployed_sha); s_web=$(state_get deployed_web_image_id)
  s_api=$(state_get deployed_api_image_id); s_slot=$(state_get active_web_slot)
  [ -n "$s_slot" ] || s_slot=blue
  s_port=$(port_of_slot "$s_slot")
  ngx_port=$(nginx_active_port)
  actual_name=$(name_of_slot "$(slot_of_port "$ngx_port")")
  actual_img=$(docker inspect -f '{{.Image}}' "$actual_name" 2>/dev/null || echo none)
  if container_running "$actual_name"; then actual_up=1; else actual_up=0; fi
  b_img=$(docker inspect -f '{{.Image}}' zhibi-vantage 2>/dev/null || echo none)

  local if_target if_web if_api if_slot
  if_target=$(state_get target_sha "$INFLIGHT" 2>/dev/null || true)
  if_web=$(state_get web_img "$INFLIGHT" 2>/dev/null || true)
  if_api=$(state_get api_img "$INFLIGHT" 2>/dev/null || true)
  if_slot=$(state_get slot "$INFLIGHT" 2>/dev/null || true)

  # A. 滚动提交：被打断的部署已实际接管入口，且候选/后端均健康
  if [ "$actual_up" = "1" ] && [ "$ngx_port" != "$s_port" ] && [ -n "$if_target" ] \
     && [ "$actual_img" = "$if_web" ] && container_healthy "$actual_name" \
     && [ "$b_img" = "$if_api" ] && container_healthy zhibi-vantage; then
    echo "reconcile: 被打断的部署已实际接管入口且健康 → 滚动提交 $if_target (slot=$if_slot)"
    state_write "$if_target" "$if_web" "$if_api" "$if_slot" "" "$(date -u '+%FT%TZ')"
    docker tag "$if_web" "zhibi-web:deployed-$(git rev-parse --short=7 "$if_target" 2>/dev/null || echo unknown)" 2>/dev/null || true
    docker tag "$if_api" "zhibi-vantage:deployed-$(git rev-parse --short=7 "$if_target" 2>/dev/null || echo unknown)" 2>/dev/null || true
    rm -f "$INFLIGHT"
    s_sha=$if_target; s_web=$if_web; s_api=$if_api; s_slot=$if_slot; s_port=$(port_of_slot "$s_slot")
  fi

  # 一致性判定（滚动提交后按新状态判定）
  local consistent=1
  [ "$ngx_port" = "$s_port" ] || consistent=0
  [ "$actual_img" = "$s_web" ] || consistent=0
  [ "$b_img" = "$s_api" ] || consistent=0
  [ "$actual_up" = "1" ] || consistent=0

  if [ "$consistent" = "1" ]; then
    rm -f "$INFLIGHT"
    # 清理非 active 槽的残留容器（重启后 unless-stopped 会把两个槽都拉起来）
    local other
    for other in zhibi-web-blue zhibi-web-green; do
      [ "$other" = "$(name_of_slot "$s_slot")" ] && continue
      if container_running "$other"; then
        echo "reconcile: 停止非活动槽残留容器 $other"
        docker rm -f "$other" >/dev/null 2>&1 || true
      fi
    done
    echo "reconcile: 四方一致（sha=${s_sha:0:12} slot=$s_slot nginx=$ngx_port web=${s_web:7:12} api=${s_api:7:12}）"
    return 0
  fi

  echo "reconcile: 不一致（nginx=$ngx_port state_slot=$s_port 容器在跑=$actual_up web镜像=${actual_img:7:12} 状态web=${s_web:7:12} api镜像=${b_img:7:12} 状态api=${s_api:7:12}）→ 以状态文件恢复"
  # B1. 恢复状态槽容器
  local sname; sname=$(name_of_slot "$s_slot")
  if ! container_running "$sname"; then
    if docker inspect "$sname" >/dev/null 2>&1; then
      docker start "$sname" >/dev/null 2>&1 || true
    else
      local net; net=$(docker inspect -f '{{.HostConfig.NetworkMode}}' zhibi-vantage 2>/dev/null || echo bridge)
      echo "reconcile: 重建槽容器 $sname（镜像 ${s_web:7:12}）"
      docker run -d --name "$sname" --network "$net" --restart unless-stopped \
        -p "127.0.0.1:${s_port}:3000" "$s_web" >/dev/null 2>&1 || true
    fi
  fi
  # B2. 回切 nginx
  write_upstream_file "$s_port" "$s_port"
  nginx -t >/dev/null 2>&1 && nginx -s reload 2>/dev/null || echo "reconcile: 警告 nginx 回切失败"
  # B3. 后端镜像与状态一致
  if [ -n "$s_api" ] && [ "$b_img" != "$s_api" ]; then
    echo "reconcile: 后端镜像回滚到状态锚点 ${s_api:7:12}"
    docker tag "$s_api" "zhibi-vantage:1.5.0" 2>/dev/null || true
    ( cd /opt/zhibi-vantage && docker compose up -d --no-deps zhibi-vantage 2>&1 | tail -1 ) || true
  fi
  # B4. 移除候选/残留槽容器
  local other
  for other in zhibi-web-blue zhibi-web-green; do
    [ "$other" = "$sname" ] && continue
    docker rm -f "$other" >/dev/null 2>&1 || true
  done
  rm -f "$INFLIGHT"
  # B5. 就绪核验
  local i ok=1
  for i in $(seq 1 60); do
    if api_ready; then break; fi; sleep 0.5
  done
  api_ready || ok=0
  local ec; ec=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/login" 2>/dev/null || echo 000)
  echo "reconcile: 恢复完成 backend_ready=$ok entry=/login=$ec"
  [ "$ok" = "1" ] && [ "$ec" = "200" ]
}

# --reconcile 模式：只做核对与恢复，不部署
if [ "${1:-}" = "--reconcile" ]; then
  if reconcile; then
    echo "reconcile: OK"
    exit 0
  else
    echo "reconcile: 恢复后仍不健康，需人工介入"
    exit 1
  fi
fi

# 每次（含被暂停拦截的 cron 命中）先核对一致性
if ! reconcile; then
  echo "$(date '+%F %T') reconcile 失败：跳过本次部署，需人工介入"
  exit 1
fi

if [ "$PAUSED_HIT" = "1" ]; then
  echo "$(date '+%F %T') deploy paused by $STATE_DIR/deploy-paused, skip"
  exit 0
fi

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
echo "$(date '+%F %T') deploy v4: deployed=${DEPLOYED:-none} -> $REMOTE (ref=$DEPLOY_REF active_slot=$ACTIVE_SLOT)"
git reset --hard "origin/${DEPLOY_REF}" --quiet
SHORT=$(git rev-parse --short=7 HEAD)
TREE=$(git rev-parse 'HEAD^{tree}')
HEALTH_ROUNDS="${ZB_HEALTH_ROUNDS:-100}"
echo "目标: commit=$SHORT tree=$TREE 健康门=${HEALTH_ROUNDS} 轮"
STAGE="资源预检"
resource_preflight || exit 1

STAGE="回滚锚点"
OLD_WEB_RB_IMG=$(docker inspect -f '{{.Image}}' "$ACTIVE_NAME" 2>/dev/null || true)
OLD_API_IMG=$(docker inspect -f '{{.Image}}' zhibi-vantage 2>/dev/null || true)
[ -n "$OLD_WEB_RB_IMG" ] && docker tag "$OLD_WEB_RB_IMG" zhibi-web:rollback
[ -n "$OLD_API_IMG" ] && docker tag "$OLD_API_IMG" zhibi-vantage:rollback
echo "anchor: web=${OLD_WEB_RB_IMG:-none} api=${OLD_API_IMG:-none} active=$ACTIVE_NAME:$ACTIVE_PORT"

# 静态归档自举：把当前运行版本的静态资源先并入归档（幂等，内容哈希去重）。
# 失败仅告警——候选归档失败才是硬失败。
if archive_static_from "$ACTIVE_NAME"; then
  echo "静态归档自举: $ACTIVE_NAME → $STATIC_ARCHIVE（$(find "$STATIC_ARCHIVE" -type f | wc -l) 个文件）"
else
  echo "警告：静态归档自举失败（当前版本 chunk 依赖槽回退层）"
fi

STAGE="镜像准备"
if [ -n "${ZB_PREBUILT_WEB_IMG:-}" ] || [ -n "${ZB_PREBUILT_API_IMG:-}" ]; then
  # 预构建镜像部署（生产推荐路径）：镜像必须自带 zb.commit/zb.tree label，
  # 且与本次目标提交/树完全一致——来源不明或错位的镜像一律拒绝。
  [ -n "${ZB_PREBUILT_WEB_IMG:-}" ] && [ -n "${ZB_PREBUILT_API_IMG:-}" ] || { echo "ZB_PREBUILT_WEB_IMG 与 ZB_PREBUILT_API_IMG 必须同时提供"; exit 1; }
  docker image inspect "$ZB_PREBUILT_WEB_IMG" >/dev/null 2>&1 || { echo "预构建 web 镜像不存在: $ZB_PREBUILT_WEB_IMG"; exit 1; }
  docker image inspect "$ZB_PREBUILT_API_IMG" >/dev/null 2>&1 || { echo "预构建 api 镜像不存在: $ZB_PREBUILT_API_IMG"; exit 1; }
  NEW_WEB_IMG=$(docker inspect -f '{{.Id}}' "$ZB_PREBUILT_WEB_IMG")
  NEW_API_IMG=$(docker inspect -f '{{.Id}}' "$ZB_PREBUILT_API_IMG")
  local_check_labels() { # $1=img_id $2=期望commit $3=期望tree $4=名称
    local c t
    c=$(docker image inspect -f '{{index .Config.Labels "zb.commit"}}' "$1" 2>/dev/null || echo "")
    t=$(docker image inspect -f '{{index .Config.Labels "zb.tree"}}' "$1" 2>/dev/null || echo "")
    [ "$c" = "$2" ] && [ "$t" = "$3" ] || { echo "拒绝 $4：label 校验失败（zb.commit=$c zb.tree=$t 期望 $2/$3）"; return 1; }
  }
  local_check_labels "$NEW_WEB_IMG" "$REMOTE" "$TREE" "预构建 web 镜像" || exit 1
  local_check_labels "$NEW_API_IMG" "$REMOTE" "$TREE" "预构建 api 镜像" || exit 1
  [ "$NEW_WEB_IMG" != "$OLD_WEB_RB_IMG" ] || { echo "预构建 web 镜像与运行镜像相同，拒绝"; exit 1; }
  [ "$NEW_API_IMG" != "$OLD_API_IMG" ] || { echo "预构建 api 镜像与运行镜像相同，拒绝"; exit 1; }
  echo "预构建镜像校验通过: web=$NEW_WEB_IMG api=$NEW_API_IMG"
  docker tag "$NEW_WEB_IMG" zhibi-web:0.2.0
  docker tag "$NEW_API_IMG" zhibi-vantage:1.5.0
elif [ "${ZB_SKIP_BUILD:-0}" = "1" ]; then
  # 机制回归专用：候选镜像必须由调用方显式提供，且与当前运行镜像不同。
  [ -n "${ZB_CANDIDATE_WEB_IMG:-}" ] || { echo "ZB_SKIP_BUILD 需要 ZB_CANDIDATE_WEB_IMG"; exit 1; }
  [ -n "${ZB_CANDIDATE_API_IMG:-}" ] || { echo "ZB_SKIP_BUILD 需要 ZB_CANDIDATE_API_IMG"; exit 1; }
  docker image inspect "$ZB_CANDIDATE_WEB_IMG" >/dev/null 2>&1 || { echo "候选 web 镜像不存在: $ZB_CANDIDATE_WEB_IMG"; exit 1; }
  docker image inspect "$ZB_CANDIDATE_API_IMG" >/dev/null 2>&1 || { echo "候选 api 镜像不存在: $ZB_CANDIDATE_API_IMG"; exit 1; }
  NEW_WEB_IMG=$(docker inspect -f '{{.Id}}' "$ZB_CANDIDATE_WEB_IMG")
  NEW_API_IMG=$(docker inspect -f '{{.Id}}' "$ZB_CANDIDATE_API_IMG")
  [ "$NEW_WEB_IMG" != "$OLD_WEB_RB_IMG" ] || { echo "候选 web 镜像与运行镜像相同，拒绝"; exit 1; }
  [ "$NEW_API_IMG" != "$OLD_API_IMG" ] || { echo "候选 api 镜像与运行镜像相同，拒绝"; exit 1; }
  echo "ZB_SKIP_BUILD：候选镜像由调用方显式提供 web=$NEW_WEB_IMG api=$NEW_API_IMG"
  docker tag "$NEW_WEB_IMG" zhibi-web:0.2.0
  docker tag "$NEW_API_IMG" zhibi-vantage:1.5.0
else
  # 缓存构建（cron 正式路径）：串行、禁止 --no-cache、构建后 label 自检 fail-closed。
  STAGE="构建前资源预检"
  resource_preflight || exit 1
  STAGE="docker compose build"
  ZB_COMMIT="$REMOTE" ZB_TREE="$TREE" docker compose build
  NEW_WEB_IMG=$(docker inspect -f '{{.Id}}' zhibi-web:0.2.0)
  NEW_API_IMG=$(docker inspect -f '{{.Id}}' zhibi-vantage:1.5.0)
  local_check_labels() { # $1=img_id $2=期望commit $3=期望tree $4=名称
    local c t
    c=$(docker image inspect -f '{{index .Config.Labels "zb.commit"}}' "$1" 2>/dev/null || echo "")
    t=$(docker image inspect -f '{{index .Config.Labels "zb.tree"}}' "$1" 2>/dev/null || echo "")
    [ "$c" = "$2" ] && [ "$t" = "$3" ] || { echo "拒绝 $4：label 校验失败（zb.commit=$c zb.tree=$t 期望 $2/$3）"; return 1; }
  }
  local_check_labels "$NEW_WEB_IMG" "$REMOTE" "$TREE" "构建产物 web 镜像" || exit 1
  local_check_labels "$NEW_API_IMG" "$REMOTE" "$TREE" "构建产物 api 镜像" || exit 1
  echo "缓存构建完成且 label 自检通过: web=$NEW_WEB_IMG api=$NEW_API_IMG"
fi
docker tag "$NEW_WEB_IMG" "zhibi-web:cand-$SHORT"
docker tag "$NEW_API_IMG" "zhibi-vantage:cand-$SHORT"
echo "candidate images: web=$NEW_WEB_IMG api=$NEW_API_IMG (cand-$SHORT)"

if [ "${ZB_DRILL_FAIL_STAGE:-}" = "build" ]; then
  echo "$(date '+%F %T') 演练：构建后主动失败（未改动运行服务，不应回滚）"
  STAGE="演练-构建后失败"
  exit 1
fi

# 首次改动运行服务：登记 in-flight 状态（供 reconcile 滚动提交/恢复判定）
inflight_write "$REMOTE" "$NEW_WEB_IMG" "$NEW_API_IMG" "$NEXT_SLOT"
SERVICE_TOUCHED=1

STAGE="启动候选前端"
docker rm -f "$CAND_NAME" >/dev/null 2>&1 || true
ENVFILE=$(mktemp /tmp/zhibi-cand-env.XXXXXX); chmod 600 "$ENVFILE"; reg_tmp "$ENVFILE"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$ACTIVE_NAME" > "$ENVFILE" 2>/dev/null || true
# 回归钩子：注入受控假密钥标记（验证临时文件零残留；非回归不设置）
if [ -n "${ZB_TEST_SECRET_MARKER:-}" ]; then
  echo "ZB_TEST_SECRET_MARKER=${ZB_TEST_SECRET_MARKER}" >> "$ENVFILE"
  echo "回归钩子：已向候选 env 注入受控假密钥标记（值不打印）"
fi
NETMODE=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$ACTIVE_NAME" 2>/dev/null || echo bridge)
docker run -d --name "$CAND_NAME" --network "$NETMODE" --restart unless-stopped \
  -p "127.0.0.1:${CAND_PORT}:3000" --env-file "$ENVFILE" "$NEW_WEB_IMG" >/dev/null
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

STAGE="候选静态归档"
# 候选静态资源并入磁盘归档（硬失败：归档是旧页面保护的根基，缺位不得上线）
if archive_static_from "$CAND_NAME"; then
  echo "候选静态已归档（归档总文件 $(find "$STATIC_ARCHIVE" -type f | wc -l) 个）"
else
  echo "$(date '+%F %T') 候选静态归档失败——旧页面保护缺位，拒绝上线"
  STAGE="候选静态归档"
  exit 1
fi

STAGE="后端替换（维护窗口）"
touch "$NGX_MAINT"; MAINT_ON=1
echo "$(date '+%F %T') 进入维护态"
MAINT_T0=$(date +%s)
sleep 2
docker compose up -d --no-deps zhibi-vantage 2>&1 | tail -3
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
write_upstream_file "$CAND_PORT" "$ACTIVE_PORT"
nginx -t >/dev/null 2>&1 || { echo "nginx -t 失败，放弃切换"; rm -f "$NGX_UPSTREAM.new"; STAGE="nginx 校验"; exit 1; }
mv "$NGX_UPSTREAM.new" "$NGX_UPSTREAM"
nginx -s reload
NGX_SWITCHED=1
echo "$(date '+%F %T') 入口已切到 $CAND_NAME:$CAND_PORT"

STAGE="健康门-基线"
BASE_WEB_ID=$(docker inspect -f '{{.RestartCount}}/{{.Id}}' "$CAND_NAME")
BASE_API_ID=$(docker inspect -f '{{.RestartCount}}/{{.Id}}' zhibi-vantage)
echo "健康门基线（候选启动后）：web=$BASE_WEB_ID api=$BASE_API_ID"

STAGE="健康门-${HEALTH_ROUNDS}轮"
FAIL_REASON=""
for round in $(seq 1 "$HEALTH_ROUNDS"); do
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
  STAGE="健康门"
  exit 1
fi

STAGE="最终核验（提交前）"
FV_FAIL=""
for path in /login /healthz /api/healthz; do
  C=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT$path" 2>/dev/null || echo 000)
  [ "$C" = "200" ] || FV_FAIL="$FV_FAIL $path=$C"
done
SBAD=$(curl -s -m 5 "http://127.0.0.1:$WEB_PORT/login" | grep -oE '/_next/static/[^"\\]+' | sort -u | while read -r a; do
    [ -n "$a" ] || continue
    c=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT$a"); [ "$c" = "200" ] || echo x
  done | wc -l)
[ "$SBAD" = "0" ] || FV_FAIL="$FV_FAIL 静态异常=$SBAD"
container_healthy "$CAND_NAME" || FV_FAIL="$FV_FAIL 候选容器非healthy"
container_healthy zhibi-vantage || FV_FAIL="$FV_FAIL 后端非healthy"
if [ -n "$FV_FAIL" ]; then
  echo "$(date '+%F %T') 最终核验未通过（$FV_FAIL）"
  STAGE="最终核验"
  exit 1
fi
echo "最终核验通过：入口三端点 200、静态 0 异常、双容器 healthy"

STAGE="提交部署状态"
# 唯一的状态提交点：全部必要步骤与最终核验完成后原子写入。
# 此后 COMMITTED=1，剩余步骤全部容错，任何异常不再回滚运行版本。
state_write "$REMOTE" "$NEW_WEB_IMG" "$NEW_API_IMG" "$NEXT_SLOT" "" "$(date -u '+%FT%TZ')"
rm -f "$INFLIGHT"
docker tag "$NEW_WEB_IMG" "zhibi-web:deployed-$SHORT"
docker tag "$NEW_API_IMG" "zhibi-vantage:deployed-$SHORT"
WEB_DIGEST=$(docker image inspect -f '{{join .RepoDigests ","}}' "$NEW_WEB_IMG" 2>/dev/null || echo "local-only")
API_DIGEST=$(docker image inspect -f '{{join .RepoDigests ","}}' "$NEW_API_IMG" 2>/dev/null || echo "local-only")
BUILD_MODE="cached-build"
if [ -n "${ZB_PREBUILT_WEB_IMG:-}" ]; then BUILD_MODE="prebuilt";
elif [ "${ZB_SKIP_BUILD:-0}" = "1" ]; then BUILD_MODE="drill"; fi
cat > "$STATE_DIR/release-$SHORT.json" <<EOF
{"commit":"$REMOTE","tree":"$TREE","web_image_id":"$NEW_WEB_IMG","api_image_id":"$NEW_API_IMG","web_repo_digests":"$WEB_DIGEST","api_repo_digests":"$API_DIGEST","slot":"$NEXT_SLOT","build_mode":"$BUILD_MODE","deployed_at":"$(date -u '+%FT%TZ')"}
EOF
COMMITTED=1
echo "$(date '+%F %T') 部署状态已提交：sha=$REMOTE slot=$NEXT_SLOT web=${NEW_WEB_IMG:7:12} api=${NEW_API_IMG:7:12}（release-$SHORT.json）"

STAGE="旧槽排空"
echo "$(date '+%F %T') 旧槽 $ACTIVE_NAME 排空 120s 后停止（静态保护由磁盘归档承担，不再依赖槽存活）"
sleep 120
docker stop "$ACTIVE_NAME" >/dev/null 2>&1 || true
echo "旧槽已停止（zhibi-web:rollback 镜像保留）"

STAGE="归档修剪与镜像清理"
archive_prune || true
docker image prune -f --filter "until=48h" >/dev/null 2>&1 || true
echo "$(date '+%F %T') deploy done: $REMOTE (slot=$NEXT_SLOT web=$NEW_WEB_IMG api=$NEW_API_IMG)"
