#!/bin/bash
# zhibi-vantage 部署回归 v3（P0 r3）
#   R1   部署锁互斥
#   R2   构建期失败不动运行服务
#   R7   缓存头实测（含静态归档层 immutable）
#   R3+R4  真实替换 + 成功部署全过程探测：探测自部署子进程启动前开始，
#          持续到部署进程退出后 ≥60s；分类 200/503/500/502/000/TIMEOUT/ECONNRESET
#   R11  静态多版本归档：旧槽停止后，旧 release 独有 chunk 仍 200（>120s 保护）
#   R5+R6  失败回滚全过程探测 + failed_sha 隔离
#   R6b  已部署版本不被记为失败版本
#   R9   SIGTERM 三断点（nginx 切换后 / 健康门期间 / 状态提交后旧槽处理期间）
#        ×(trap 收敛 + --reconcile + 四方一致性核对 + 全过程探测)
#   R10  密钥临时文件零残留（受控假密钥标记扫描 /tmp 与 /var/lib/zhibi-deploy）
#   R12  预构建镜像 label 校验：来源与目标提交不一致必须拒绝
#   R13  结束态 reconcile 总核对
# 用法：bash scripts/deploy-regression.sh
# 全程不执行 --no-cache 重建（机制演练用 ZB_SKIP_BUILD 显式历史镜像；
# 正式路径为缓存串行构建 + label 自检）。会真实执行部署与回滚，耗时约 20–30 分钟。
set -uo pipefail
cd /opt/zhibi-vantage

WEB_PORT=3002
STATE_DIR=/var/lib/zhibi-deploy
STATE=$STATE_DIR/state.json
INFLIGHT=$STATE_DIR/inflight.json
PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

# 演练默认以当前工作树所在分支为部署目标（保证 git reset 后跑的仍是本轮脚本）
DEPLOY_REF=${DEPLOY_REF:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}
export DEPLOY_REF
HEALTH_ROUNDS_DRILL=10        # 演练健康门降轮（cron 正式路径恒 100）
MARKER="zb-r3-fake-secret-$(date +%s)-$$"   # 受控假密钥标记（仅存在于临时 env 文件）

port_of_slot() { case "$1" in blue) echo 3102;; green) echo 3202;; *) echo "";; esac; }
state_field() { grep -o "\"$1\":\"[^\"]*\"" "$STATE" 2>/dev/null | head -1 | sed 's/.*:"//; s/"$//' || true; }
nginx_active_port() { awk '/^upstream zhibi_web_active/,/^}/' /etc/nginx/conf.d/zhibi-upstream.conf 2>/dev/null | grep -oE '127\.0\.0\.1:[0-9]+' | head -1 | cut -d: -f2 || echo ""; }

# ---------- 探测（覆盖部署全程 + 退出后 60s，分类输出） ----------
probe_once() { # $1=url → 200/503/500/502/000/TIMEOUT/ECONNRESET/ERR<rc>
  local out rc
  out=$(curl -s -o /dev/null -m 4 -w '%{http_code}' "$1" 2>/dev/null); rc=$?
  if [ "$rc" = "0" ]; then echo "$out"; return; fi
  case $rc in
    28) echo "TIMEOUT" ;;
    7)  echo "000" ;;
    56) echo "ECONNRESET" ;;
    *)  echo "ERR$rc" ;;
  esac
}
start_probe() { # $1=outfile —— 在部署子进程启动【前】调用
  : > "$1"; rm -f "$1.stop"
  (
    while [ ! -f "$1.stop" ]; do
      for p in /login /healthz; do
        printf '%s %s %s\n' "$(date +%H:%M:%S.%3N)" "$p" "$(probe_once "http://127.0.0.1:$WEB_PORT$p")" >> "$1"
      done
      sleep 0.1
    done
  ) &
  PROBE_PID=$!
}
finish_probe() { # $1=outfile $2=部署进程退出时刻(epoch) —— 保证退出后 ≥60s 覆盖
  local remain=$(( 60 - ($(date +%s) - $2) ))
  if [ "$remain" -gt 0 ]; then sleep "$remain"; fi
  touch "$1.stop"
  wait "$PROBE_PID" 2>/dev/null || true
}
classify() { # $1=file → 一行分类统计
  awk '{
    c=$3
    if (c=="TIMEOUT") t++; else if (c=="ECONNRESET") r++; else if (c=="000") z++;
    else if (c ~ /^ERR/) e++; else if (c=="200") ok++; else o[c]++
  } END {
    printf "200=%d", ok+0
    for (k in o) printf " %s=%d", k, o[k]
    printf " | 000=%d TIMEOUT=%d ECONNRESET=%d ERR=%d\n", z+0, t+0, r+0, e+0
  }' "$1"
}
unexpected_count() { # $1=file → 500/502/000/TIMEOUT/ECONNRESET/ERR* 总数
  awk '$3=="500"||$3=="502"||$3=="000"||$3=="TIMEOUT"||$3=="ECONNRESET"||$3 ~ /^ERR/' "$1" 2>/dev/null | wc -l
}
assert_probe_clean() { # $1=标签 $2=file（断言 0 非预期；503 属明确维护态允许存在）
  local total unexp
  total=$(wc -l < "$2" 2>/dev/null || echo 0)
  unexp=$(unexpected_count "$2")
  if [ "$unexp" -eq 0 ]; then
    ok "$1: $total 次探测 0 非预期（$(classify "$2")）"
  else
    bad "$1: $unexp/$total 次非预期（$(classify "$2")）"
    awk '$3=="500"||$3=="502"||$3=="000"||$3=="TIMEOUT"||$3=="ECONNRESET"||$3 ~ /^ERR/' "$2" | head -8 | sed 's/^/       /'
  fi
}
maint_window() {
  awk '$3=="503"{split($1,t,":"); s=t[1]*3600+t[2]*60+t[3]; if(min==""||s<min)min=s; if(s>max)max=s; n++} END{if(n>0)printf "%.1f", max-min; else printf "0"}' "$1"
}

# ---------- 四方一致性核对 ----------
assert_consistent() { # $1=标签
  local s_sha s_web s_api s_slot s_port ngx_port act_name act_img b_img okc=1
  s_sha=$(state_field deployed_sha); s_web=$(state_field deployed_web_image_id)
  s_api=$(state_field deployed_api_image_id); s_slot=$(state_field active_web_slot)
  s_port=$(port_of_slot "$s_slot")
  ngx_port=$(nginx_active_port)
  act_name="zhibi-web-$s_slot"
  act_img=$(docker inspect -f '{{.Image}}' "$act_name" 2>/dev/null || echo none)
  b_img=$(docker inspect -f '{{.Image}}' zhibi-vantage 2>/dev/null || echo none)
  [ -n "$s_sha" ] || { bad "$1: deployed_sha 为空"; okc=0; }
  [ "$ngx_port" = "$s_port" ] || { bad "$1: nginx active($ngx_port) != 状态槽($s_slot=$s_port)"; okc=0; }
  [ "$act_img" = "$s_web" ] || { bad "$1: 槽容器镜像($act_img) != 状态 web($s_web)"; okc=0; }
  [ "$b_img" = "$s_api" ] || { bad "$1: 后端镜像($b_img) != 状态 api($s_api)"; okc=0; }
  if [ -f "$INFLIGHT" ]; then bad "$1: inflight.json 残留"; okc=0; fi
  if [ "$okc" = "1" ]; then
    ok "$1: 四方一致（sha=${s_sha:0:12} slot=$s_slot nginx=$ngx_port web=${s_web:7:12} api=${s_api:7:12}）"
  fi
}

pick_diff() { # $1=运行镜像ID $2=仓库前缀 → 第一个与运行不同的 tag
  local t id
  for t in $(docker images --format '{{.Repository}}:{{.Tag}}' | grep "^$2:"); do
    id=$(docker inspect -f '{{.Id}}' "$t" 2>/dev/null || true)
    [ -n "$id" ] && [ "$id" != "$1" ] && { echo "$t"; return; }
  done
}
drill_envs() { # 演练时刻现选候选（运行镜像随演练变化）
  local now_web now_api dw da
  now_web=$(docker inspect -f '{{.Image}}' "$(docker ps --filter name=zhibi-web --format '{{.Names}}' | head -1)")
  now_api=$(docker inspect -f '{{.Image}}' zhibi-vantage)
  dw=$(pick_diff "$now_web" zhibi-web)
  da=$(pick_diff "$now_api" zhibi-vantage)
  if [ -n "$dw" ] && [ -n "$da" ]; then
    echo "ZB_SKIP_BUILD=1 ZB_CANDIDATE_WEB_IMG=$dw ZB_CANDIDATE_API_IMG=$da"
  else
    echo ""   # 无历史镜像可用：回落缓存串行构建（仍禁 --no-cache）
  fi
}
run_drill() { # $1=log 前缀 + 其余 env 已在调用方给出 → 执行并回显输出
  local log="$1"; shift
  env ZB_TEST_SECRET_MARKER="$MARKER" ZB_HEALTH_ROUNDS=$HEALTH_ROUNDS_DRILL \
      DEPLOY_REF="$DEPLOY_REF" FORCE_DEPLOY=1 ZB_IGNORE_PAUSE=1 "$@" \
      bash scripts/deploy-cron.sh > "$log" 2>&1
}

echo "== R7 缓存头实测 =="
HTML_CC=$(curl -sI -m 5 "http://127.0.0.1:$WEB_PORT/login" | tr -d '\r' | grep -i '^cache-control:' | head -1)
case "$HTML_CC" in *no-store*) ok "HTML no-store: $HTML_CC" ;; *) bad "HTML 缓存头异常: ${HTML_CC:-<无>}" ;; esac
CH=$(curl -s -m 5 "http://127.0.0.1:$WEB_PORT/login" | grep -oE '/_next/static/[^"\\]+' | head -1)
CH_CC=$(curl -sI -m 5 "http://127.0.0.1:$WEB_PORT$CH" | tr -d '\r' | grep -i '^cache-control:' | head -1)
case "$CH_CC" in *immutable*) ok "static immutable: $CH_CC" ;; *) bad "static 缓存头异常: ${CH_CC:-<无>}" ;; esac
API_CC=$(curl -sI -m 5 "http://127.0.0.1:$WEB_PORT/api/healthz" | tr -d '\r' | grep -i '^cache-control:' | head -1)
case "$API_CC" in *no-store*|*no-cache*|*private*) ok "API 不可共享缓存: $API_CC" ;; *) bad "API 缓存头异常: ${API_CC:-<无>}" ;; esac

echo "== R1 锁互斥 =="
INNER_LOCK=/tmp/zhibi-deploy.inner.lock
( exec 9>"$INNER_LOCK"; flock 9; sleep 6 ) &
HOLDER=$!
sleep 0.5
out=$(timeout 10 bash scripts/deploy-cron.sh 2>&1 || true)
wait $HOLDER 2>/dev/null
case "$out" in *"inner lock held"*) ok "并发部署被拒绝" ;; *) bad "并发未被拒绝" ;; esac
flock -n "$INNER_LOCK" true 2>/dev/null && ok "锁可重新获取（R8 前置）" || bad "锁泄漏"

echo "== R2 构建期失败不动运行服务 =="
BEFORE_CONTAINERS=$(docker ps --filter name=zhibi-web --format '{{.Names}}' | tr '\n' ',')
run_drill /tmp/p0-reg-r2.log ZB_DRILL_FAIL_STAGE=build
out=$(cat /tmp/p0-reg-r2.log)
case "$out" in *"演练：构建后主动失败"*) ok "构建期失败非零退出" ;; *) bad "构建期失败路径异常（未见到演练标记）" ;; esac
echo "$out" | grep -q "触发回滚" && bad "构建期失败触发了无意义回滚" || ok "构建期失败未触发回滚"
AFTER_CONTAINERS=$(docker ps --filter name=zhibi-web --format '{{.Names}}' | tr '\n' ',')
AFTER_LOGIN=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/login")
[ "$BEFORE_CONTAINERS" = "$AFTER_CONTAINERS" ] && ok "运行容器未被改动（$AFTER_CONTAINERS）" || bad "容器被改动：$BEFORE_CONTAINERS -> $AFTER_CONTAINERS"
[ "$AFTER_LOGIN" = "200" ] && ok "旧服务继续服务（/login=200）" || bad "旧服务中断：/login=$AFTER_LOGIN"

echo "== R3+R4 真实替换 + 成功部署全过程探测 =="
IMG_BEFORE=$(docker inspect -f '{{.Image}}' "$(docker ps --filter name=zhibi-web --format '{{.Names}}' | head -1)")
SLOT_BEFORE=$(docker ps --filter name=zhibi-web --format '{{.Names}}' | head -1)
OLD_SLOT_LIST=$(docker exec "$SLOT_BEFORE" find /app/.next/static -type f 2>/dev/null | sed 's|^/app||' | sort)
PROBE_FILE=/tmp/p0-probe-success.txt
start_probe "$PROBE_FILE"          # 探测先于部署子进程启动
run_drill /tmp/p0-reg-r3.log $(drill_envs)
DRILL_RC=$?
DEPLOY_EXIT_TS=$(date +%s)
finish_probe "$PROBE_FILE" "$DEPLOY_EXIT_TS"   # 退出后继续探测 ≥60s
out=$(cat /tmp/p0-reg-r3.log)
echo "$out" | grep -E "deploy done|candidate images|入口已切|部署状态已提交|旧槽已停止|候选静态已归档" | sed 's/^/    | /'
[ "$DRILL_RC" = "0" ] && ok "真实部署成功完成" || bad "真实部署失败 rc=$DRILL_RC"
assert_probe_clean "成功部署全过程（含退出后60s）" "$PROBE_FILE"
MW=$(maint_window "$PROBE_FILE")
awk "BEGIN{exit !($MW<=15)}" && ok "后端维护窗口 ${MW}s（明确 503，≤15s）" || bad "后端维护窗口 ${MW}s 超过 15s"
SLOT_AFTER=$(docker ps --filter name=zhibi-web --format '{{.Names}}' | head -1)
IMG_AFTER=$(docker inspect -f '{{.Image}}' "$SLOT_AFTER" 2>/dev/null || echo none)
[ "$IMG_BEFORE" != "$IMG_AFTER" ] && ok "镜像 ID 已变化" || bad "镜像 ID 未变化"
[ "$SLOT_BEFORE" != "$SLOT_AFTER" ] && ok "容器槽位已切换（$SLOT_BEFORE -> $SLOT_AFTER）" || bad "容器槽位未切换"
DEPLOYED_SHA=$(state_field deployed_sha)
[ "$DEPLOYED_SHA" = "$(git rev-parse "origin/$DEPLOY_REF" 2>/dev/null || git rev-parse HEAD)" ] && ok "deployed_sha == 部署目标（${DEPLOYED_SHA:0:12}）" || bad "deployed_sha 异常：$DEPLOYED_SHA"
STATE_IMG=$(state_field deployed_web_image_id)
[ "$STATE_IMG" = "$IMG_AFTER" ] && ok "state 镜像 == 实际运行镜像" || bad "state 镜像 != 运行镜像"
# 候选镜像 label 自检（缓存构建/演练镜像均应打标；演练用历史镜像可能无 label——只记录不判失败）
LBL_W=$(docker image inspect -f '{{index .Config.Labels "zb.commit"}}' "$IMG_AFTER" 2>/dev/null || echo "")
echo "  info: 运行 web 镜像 zb.commit=${LBL_W:-<无>}（演练历史镜像可无 label）"

echo "== R11 静态多版本归档（旧槽已停止，保护必须超过 120s 排空窗）=="
if printf '%s' "$out" | grep -q "旧槽已停止"; then
  ok "本轮部署已包含旧槽停止（r11 前置成立）"
  NEW_SLOT_LIST=$(docker exec "$SLOT_AFTER" find /app/.next/static -type f 2>/dev/null | sed 's|^/app||' | sort)
  ONLY_OLD=$(comm -23 <(printf '%s\n' "$OLD_SLOT_LIST") <(printf '%s\n' "$NEW_SLOT_LIST") | head -5)
  N_OLD=$(printf '%s' "$ONLY_OLD" | grep -c . || true)
  if [ "${N_OLD:-0}" -gt 0 ]; then
    ALL200=1
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      c=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT$f")
      [ "$c" = "200" ] || { echo "       旧 chunk 失败 $f -> $c"; ALL200=0; }
    done <<< "$ONLY_OLD"
    [ "$ALL200" = "1" ] && ok "旧 release 独有 chunk ×$N_OLD 经入口全部 200（磁盘归档生效，槽已停止）" \
      || bad "旧槽停止后旧 chunk 出现非 200"
  else
    echo "  info: 两版本静态集合无差集（演练镜像静态相同），改用归档目录存在性核验"
    AF=$(find /var/lib/zhibi-static/_next/static -type f 2>/dev/null | wc -l)
    [ "${AF:-0}" -gt 0 ] && ok "静态归档目录非空（$AF 个文件）" || bad "静态归档目录为空"
  fi
  # 归档层命中核验：归档文件直接走 nginx root（不经容器）
  SAMPLE=$(find /var/lib/zhibi-static/_next/static -type f 2>/dev/null | head -1 | sed 's|^/var/lib/zhibi-static||')
  [ -n "$SAMPLE" ] && { SC=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT$SAMPLE"); \
    [ "$SC" = "200" ] && ok "归档样本经入口 200（$SAMPLE）" || bad "归档样本经入口 $SC"; }
else
  bad "本轮部署未见旧槽停止步骤，R11 前置不成立"
fi

echo "== R5+R6 失败回滚全过程 + failed_sha 隔离 =="
STATE_SAVE=/tmp/p0-state-save.json
cp "$STATE" "$STATE_SAVE"
REMOTE_SHA=$(git rev-parse "origin/$DEPLOY_REF" 2>/dev/null || git rev-parse HEAD)
PREV_SHA=$(git rev-parse HEAD~1 2>/dev/null || echo "$REMOTE_SHA")
state_force() { # $1=deployed_sha $2=failed_sha
  printf '{"deployed_sha":"%s","deployed_web_image_id":"%s","deployed_api_image_id":"%s","active_web_slot":"%s","failed_sha":"%s","deployed_at":"%s"}\n' \
    "$1" "$(state_field deployed_web_image_id)" "$(state_field deployed_api_image_id)" \
    "$(state_field active_web_slot)" "$2" "$(date -u '+%FT%TZ')" > "$STATE"
}
state_force "$PREV_SHA" ""
echo "  演练前置：deployed_sha=$PREV_SHA（旧版本） 候选=$REMOTE_SHA"
PROBE_FILE=/tmp/p0-probe-rollback.txt
start_probe "$PROBE_FILE"
run_drill /tmp/p0-reg-r5.log ZB_DRILL_HEALTH_FAIL=1 $(drill_envs)
DRILL_RC=$?
DEPLOY_EXIT_TS=$(date +%s)
finish_probe "$PROBE_FILE" "$DEPLOY_EXIT_TS"
out=$(cat /tmp/p0-reg-r5.log)
echo "$out" | grep -E "健康门未通过|回滚完成|回滚失败" | head -3 | sed 's/^/    | /'
[ "$DRILL_RC" = "1" ] && ok "失败部署非零退出" || bad "失败部署退出码异常 rc=$DRILL_RC"
assert_probe_clean "失败回滚全过程（含退出后60s）" "$PROBE_FILE"
printf '%s' "$out" | grep -q "回滚完成" && ok "回滚完成并严格核对镜像" || bad "回滚未完成"
RB_SEC=$(printf '%s' "$out" | grep -oE "回滚耗时 [0-9]+s" | head -1 | grep -oE "[0-9]+" || echo 999)
[ "${RB_SEC:-999}" -le 30 ] && ok "回滚耗时 ${RB_SEC}s（≤30s）" || bad "回滚耗时 ${RB_SEC}s 超过 30s"
FAILED_STATE=$(state_field failed_sha)
[ "$FAILED_STATE" = "$REMOTE_SHA" ] && ok "failed_sha 记录为候选提交（${REMOTE_SHA:0:12}）" || bad "failed_sha 异常：$FAILED_STATE"
out2=$(ZB_IGNORE_PAUSE=1 timeout 60 bash scripts/deploy-cron.sh 2>&1 || true)
case "$out2" in *"已隔离"*) ok "再次调用被隔离：$(echo "$out2" | tail -1)" ;; *) bad "失败 SHA 被重复部署：$(echo "$out2" | tail -1)" ;; esac
IMG_AFTER_ROLLBACK=$(docker inspect -f '{{.Image}}' "$(docker ps --filter name=zhibi-web --format '{{.Names}}' | head -1)" 2>/dev/null || echo none)
[ "$IMG_AFTER_ROLLBACK" = "$IMG_AFTER" ] && ok "回滚后运行镜像 == 上一成功版本" || bad "回滚镜像不一致"
DEPLOYED_AFTER=$(state_field deployed_sha)
[ "$DEPLOYED_AFTER" = "$PREV_SHA" ] && ok "回滚后 deployed_sha 保持旧版本（${DEPLOYED_AFTER:0:12}）" || bad "deployed_sha 被失败版本覆盖（$DEPLOYED_AFTER）"

echo "== R6b 已部署版本不会被记为失败版本（护栏）=="
state_force "$REMOTE_SHA" ""
run_drill /tmp/p0-reg-r6b.log ZB_DRILL_HEALTH_FAIL=1 $(drill_envs)
out3=$(cat /tmp/p0-reg-r6b.log)
case "$(tail -c 200 /tmp/p0-reg-r6b.log)" in *"rc=1"*|*回滚完成*|*健康门未通过*) ok "演练部署按预期失败" ;; *) bad "演练部署退出异常" ;; esac
FAILED_AFTER3=$(state_field failed_sha)
[ -z "$FAILED_AFTER3" ] && ok "failed_sha 保持为空（运行中的版本不会自相矛盾）" || bad "failed_sha 被写入正在运行的版本：$FAILED_AFTER3"
state_force "$REMOTE_SHA" ""
echo "  状态已复原：deployed_sha=${REMOTE_SHA:0:12} failed_sha=空"

echo "== R9 SIGTERM 三断点 ×（trap 收敛 + reconcile + 四方一致 + 全程探测）=="
sigterm_drill() { # $1=tag $2=等待标记 $3=标记后等待秒 $4=期望 rollback|committed
  local tag="$1" mark="$2" waits="$3" expect="$4"
  local log="/tmp/p0-sigterm-$tag.log" pf="/tmp/p0-probe-sigterm-$tag.txt"
  echo "  --- SIGTERM-$tag（期望：$expect）---"
  if [ "$expect" = "rollback" ]; then
    state_force "$PREV_SHA" ""   # 回滚语义演练：先把状态重置为旧版本
    echo "    | 演练前置：deployed_sha=${PREV_SHA:0:12}（旧版本）"
  fi
  start_probe "$pf"
  env ZB_TEST_SECRET_MARKER="$MARKER" ZB_HEALTH_ROUNDS=$HEALTH_ROUNDS_DRILL \
      DEPLOY_REF="$DEPLOY_REF" FORCE_DEPLOY=1 ZB_IGNORE_PAUSE=1 $(drill_envs) \
      bash scripts/deploy-cron.sh > "$log" 2>&1 &
  local dpid=$! i seen=0
  for i in $(seq 1 420); do
    if grep -q "$mark" "$log" 2>/dev/null; then seen=1; break; fi
    kill -0 "$dpid" 2>/dev/null || break
    sleep 1
  done
  if [ "$seen" = "1" ]; then
    sleep "$waits"
  else
    echo "    | 标记未出现（部署提前退出）"
  fi
  kill -TERM "$dpid" 2>/dev/null || true
  wait "$dpid" 2>/dev/null; local rc=$?
  local exit_ts=$(date +%s)
  finish_probe "$pf" "$exit_ts"
  [ "$rc" != "0" ] && ok "SIGTERM-$tag: 进程以非零退出（rc=$rc）" || bad "SIGTERM-$tag: 进程正常退出（未收到信号？）"
  # 重启脚本 → reconcile 自动核对四方
  local rcout
  rcout=$(ZB_IGNORE_PAUSE=1 timeout 300 bash scripts/deploy-cron.sh --reconcile 2>&1); local rrc=$?
  echo "$rcout" | grep -E "reconcile:" | head -3 | sed 's/^/    | /'
  [ "$rrc" = "0" ] && ok "SIGTERM-$tag: reconcile 收敛成功" || bad "SIGTERM-$tag: reconcile 失败"
  assert_consistent "SIGTERM-$tag"
  assert_probe_clean "SIGTERM-$tag 全过程（含退出后60s）" "$pf"
  # 期望语义核对
  local dsha; dsha=$(state_field deployed_sha)
  if [ "$expect" = "rollback" ]; then
    [ "$dsha" != "$REMOTE_SHA" ] && ok "SIGTERM-$tag: 状态保持旧版本（${dsha:0:12}，未出现状态新版/运行旧版）" \
      || bad "SIGTERM-$tag: 状态被提交为新版（预期回滚保持旧版）"
  else
    [ "$dsha" = "$REMOTE_SHA" ] && ok "SIGTERM-$tag: 已提交态不被回滚（状态与运行一致 ${dsha:0:12}）" \
      || bad "SIGTERM-$tag: 已提交态被错误回滚（deployed_sha=${dsha:0:12}）"
  fi
}
sigterm_drill after-switch "入口已切到" 3 rollback
sigterm_drill health-gate "健康门基线" 6 rollback
sigterm_drill post-commit "部署状态已提交" 6 committed

echo "== R10 密钥临时文件零残留 =="
sleep 2   # 等 EXIT trap 的清理完全落地
HITS=$(grep -rl "$MARKER" /tmp/zhibi-cand-env.* /tmp/zhibi-deploy-log.* /var/lib/zhibi-deploy 2>/dev/null | grep -v Binary | wc -l)
HITS2=$(grep -rl "$MARKER" /tmp 2>/dev/null | wc -l)
if [ "${HITS:-0}" = "0" ] && [ "${HITS2:-0}" = "0" ]; then
  ok "受控假密钥标记零残留（/tmp 全域 + /var/lib/zhibi-deploy；标记 $MARKER）"
else
  bad "发现标记残留：/tmp/zhibi-* 与状态目录 $HITS 处、/tmp 全域 $HITS2 处"
  grep -rl "$MARKER" /tmp /var/lib/zhibi-deploy 2>/dev/null | head -5 | sed 's/^/       /'
fi
[ -f "$STATE_DIR/registered-tmp.list" ] && bad "registered-tmp.list 未随 EXIT 清理" || ok "临时文件登记表已随 EXIT 清空"

echo "== R12 预构建镜像 label 校验（来源不一致必须拒绝）=="
docker tag "$(docker inspect -f '{{.Id}}' zhibi-web:0.2.0)" zhibi-web:fake-prebuilt 2>/dev/null || true
BEFORE_C=$(docker ps --filter name=zhibi-web --format '{{.Names}}' | tr '\n' ',')
out5=$(env ZB_PREBUILT_WEB_IMG=zhibi-web:fake-prebuilt ZB_PREBUILT_API_IMG=zhibi-vantage:1.5.0 \
  DEPLOY_REF="$DEPLOY_REF" FORCE_DEPLOY=1 ZB_IGNORE_PAUSE=1 timeout 120 bash scripts/deploy-cron.sh 2>&1 || true)
case "$out5" in *"label 校验失败"*) ok "无 label 预构建镜像被拒绝" ;; *) bad "预构建校验未拦截（输出：$(echo "$out5" | tail -2 | tr '\n' ' ')）" ;; esac
AFTER_C=$(docker ps --filter name=zhibi-web --format '{{.Names}}' | tr '\n' ',')
[ "$BEFORE_C" = "$AFTER_C" ] && ok "拒绝路径未改动运行容器" || bad "拒绝路径改动了容器：$BEFORE_C -> $AFTER_C"
docker rmi zhibi-web:fake-prebuilt >/dev/null 2>&1 || true

echo "== R13 结束态 reconcile 总核对 =="
out6=$(ZB_IGNORE_PAUSE=1 timeout 300 bash scripts/deploy-cron.sh --reconcile 2>&1 || true)
echo "$out6" | grep "reconcile:" | tail -2 | sed 's/^/    | /'
assert_consistent "R13 结束态"
flock -n "$INNER_LOCK" true 2>/dev/null && ok "R8 锁在成功与失败路径均释放" || bad "锁泄漏"

echo ""
echo "== 回归结果: PASS=$PASS FAIL=$FAIL =="
echo "（受控假密钥标记 $MARKER 仅用于本轮残留扫描，未配置任何真实凭据）"
[ "$FAIL" -eq 0 ]
