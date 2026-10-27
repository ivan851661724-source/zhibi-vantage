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
# cron 每分钟 deploy.sh 持 inner lock 做 fetch（1-3s），--reconcile 可能拿到锁冲突
# 空转；带重试的 reconcile：直到输出含 reconcile: 行或超次。
reconcile_retry() {
  local out="" i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    out=$(ZB_IGNORE_PAUSE=1 timeout 300 bash scripts/deploy-cron.sh --reconcile 2>&1 || true)
    printf '%s' "$out" | grep -q "reconcile:" && { printf '%s' "$out"; return 0; }
    sleep 5
  done
  printf '%s' "$out"; return 1
}
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
  # cron 每分钟的 deploy.sh 会在 inner lock 内做 git fetch（1-3s），偶发锁冲突使
  # 演练空转退出；检测到即重试（最多 5 次）。
  local log="$1"; shift
  local attempt
  for attempt in 1 2 3 4 5; do
    env ZB_TEST_SECRET_MARKER="$MARKER" ZB_HEALTH_ROUNDS=$HEALTH_ROUNDS_DRILL \
        DEPLOY_REF="$DEPLOY_REF" FORCE_DEPLOY=1 ZB_IGNORE_PAUSE=1 "$@" \
        bash scripts/deploy-cron.sh > "$log" 2>&1
    grep -q "inner lock held" "$log" 2>/dev/null || return $?
    echo "    | 演练遇到 inner lock 冲突（cron 巡检），5s 后重试（$attempt/5）"
    sleep 5
  done
  return $?
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

echo "== R17 ZB_SKIP_BUILD 无 drill 标记必须拒绝 =="
CAND17_W=$(pick_diff "$(docker inspect -f '{{.Image}}' "$(docker ps --filter name=zhibi-web --format '{{.Names}}' | head -1)")" zhibi-web)
CAND17_A=$(pick_diff "$(docker inspect -f '{{.Image}}' zhibi-vantage)" zhibi-vantage)
outR17=$(env ZB_SKIP_BUILD=1 ZB_CANDIDATE_WEB_IMG="$CAND17_W" ZB_CANDIDATE_API_IMG="$CAND17_A" \
  DEPLOY_REF="$DEPLOY_REF" FORCE_DEPLOY=1 ZB_IGNORE_PAUSE=1 timeout 60 bash scripts/deploy-cron.sh 2>&1 || true)
case "$outR17" in *"仅限 ZB_DRILL_MODE=1"*) ok "无 drill 标记的 ZB_SKIP_BUILD 被拒绝（cron/main 部署无法走历史镜像路径）" ;; *) bad "ZB_SKIP_BUILD 未被拦截：$(echo "$outR17" | tail -1)" ;; esac
outR17b=$(env ZB_TEST_SECRET_MARKER="$MARKER" ZB_DRILL_MODE=1 ZB_DRILL_FAIL_STAGE=build FORCE_DEPLOY=1 ZB_IGNORE_PAUSE=1 timeout 60 bash scripts/deploy-cron.sh 2>&1 || true)
echo "$outR17b" | grep -q "拒绝" && bad "带 drill 标记的正常演练被误拒" || ok "ZB_DRILL_MODE=1 演练不受影响"

echo "== R3+R4 真实替换（缓存串行构建）+ 成功部署全过程探测 =="
# r4：R3 改走真实缓存构建路径（禁止裸 compose build：后端→前端串行、低优先级），
# 用 docker shim 记录每次 docker 调用时间戳，行为级证明两服务没有并行构建；
# 探测自 spawn 前启动，覆盖整个构建/部署窗口。
IMG_BEFORE=$(docker inspect -f '{{.Image}}' "$(docker ps --filter name=zhibi-web --format '{{.Names}}' | head -1)")
SLOT_BEFORE=$(docker ps --filter name=zhibi-web --format '{{.Names}}' | head -1)
OLD_SLOT_LIST=$(docker exec "$SLOT_BEFORE" find /app/.next/static -type f 2>/dev/null | sed 's|^/app||' | sort)
REAL_DOCKER=$(command -v docker)
SHIM_DIR=/tmp/r4-docker-shim; rm -rf "$SHIM_DIR"; mkdir -p "$SHIM_DIR"
CALLLOG=/tmp/r4-docker-calls.log; : > "$CALLLOG"
cat > "$SHIM_DIR/docker" <<EOF
#!/bin/bash
printf 'CALL %s START %s\n' "\$(date +%s.%3N)" "\$*" >> "$CALLLOG"
$REAL_DOCKER "\$@"
RC=\$?
printf 'CALL %s END rc=%s %s\n' "\$(date +%s.%3N)" "\$RC" "\$*" >> "$CALLLOG"
exit \$RC
EOF
chmod +x "$SHIM_DIR/docker"
# 源码检查：禁止裸 docker compose build
if grep -qE 'docker compose build[[:space:]]*$' scripts/deploy-cron.sh; then
  bad "源码存在裸 docker compose build"
else
  ok "源码检查：无裸 docker compose build（按服务显式构建）"
fi
PROBE_FILE=/tmp/p0-probe-success.txt
start_probe "$PROBE_FILE"          # 探测先于部署子进程启动（覆盖构建窗口）
run_drill /tmp/p0-reg-r3.log PATH="$SHIM_DIR:$PATH"   # 无 ZB_SKIP_BUILD → 真缓存构建
DRILL_RC=$?
DEPLOY_EXIT_TS=$(date +%s)
finish_probe "$PROBE_FILE" "$DEPLOY_EXIT_TS"   # 退出后继续探测 ≥60s
out=$(cat /tmp/p0-reg-r3.log)
echo "$out" | grep -E "deploy done|串行|label 自检|入口已切|部署状态已提交|旧槽已停止|候选静态已归档" | sed 's/^/    | /'
[ "$DRILL_RC" = "0" ] && ok "真实部署成功完成（缓存串行构建）" || bad "真实部署失败 rc=$DRILL_RC"
# 串行构建行为证明：恰好 2 次 compose build，后端→前端顺序，且不重叠
B_STARTS=$(awk '/ START .*compose build/ && !/config|version|ps|logs/ {print}' "$CALLLOG" | grep -E 'build (zhibi-vantage|zhibi-web)( |$)' || true)
N_API=$(printf '%s\n' "$B_STARTS" | grep -c 'build zhibi-vantage' || true)
N_WEB=$(printf '%s\n' "$B_STARTS" | grep -c 'build zhibi-web' || true)
T_API=$(printf '%s\n' "$B_STARTS" | awk '/build zhibi-vantage/{print $2; exit}')
T_WEB=$(printf '%s\n' "$B_STARTS" | awk '/build zhibi-web/{print $2; exit}')
T_API_END=$(awk '/ END .*build zhibi-vantage/{print $2; exit}' "$CALLLOG")
if [ "${N_API:-0}" = "1" ] && [ "${N_WEB:-0}" = "1" ] && awk "BEGIN{exit !($T_API <= $T_WEB)}" 2>/dev/null \
   && awk "BEGIN{exit !($T_API_END <= $T_WEB)}" 2>/dev/null; then
  ok "串行构建证明：zhibi-vantage($T_API)→结束($T_API_END) 先于 zhibi-web($T_WEB) 启动，无并行"
else
  bad "串行构建证明失败（api=$N_API web=$N_WEB T_API=$T_API T_API_END=$T_API_END T_WEB=$T_WEB）"
fi
assert_probe_clean "成功部署全过程（含构建窗口与退出后60s）" "$PROBE_FILE"
if [ "$DRILL_RC" = "0" ]; then
  MW=$(maint_window "$PROBE_FILE")
  awk "BEGIN{exit !($MW<=15)}" && ok "后端维护窗口 ${MW}s（明确 503，≤15s）" || bad "后端维护窗口 ${MW}s 超过 15s"
fi
SLOT_AFTER=$(docker ps --filter name=zhibi-web --format '{{.Names}}' | head -1)
IMG_AFTER=$(docker inspect -f '{{.Image}}' "$SLOT_AFTER" 2>/dev/null || echo none)
[ "$IMG_BEFORE" != "$IMG_AFTER" ] && ok "镜像 ID 已变化" || bad "镜像 ID 未变化"
[ "$SLOT_BEFORE" != "$SLOT_AFTER" ] && ok "容器槽位已切换（$SLOT_BEFORE -> $SLOT_AFTER）" || bad "容器槽位未切换"
DEPLOYED_SHA=$(state_field deployed_sha)
[ "$DEPLOYED_SHA" = "$(git rev-parse "origin/$DEPLOY_REF" 2>/dev/null || git rev-parse HEAD)" ] && ok "deployed_sha == 部署目标（${DEPLOYED_SHA:0:12}）" || bad "deployed_sha 异常：$DEPLOYED_SHA"
STATE_IMG=$(state_field deployed_web_image_id)
[ "$STATE_IMG" = "$IMG_AFTER" ] && ok "state 镜像 == 实际运行镜像" || bad "state 镜像 != 运行镜像"
LBL_W=$(docker image inspect -f '{{index .Config.Labels "zb.commit"}}' "$IMG_AFTER" 2>/dev/null || echo "")
[ "$LBL_W" = "$(git rev-parse "origin/$DEPLOY_REF" 2>/dev/null || git rev-parse HEAD)" ] \
  && ok "运行 web 镜像 zb.commit label == 部署目标（构建溯源闭合）" \
  || bad "运行 web 镜像 label 异常：${LBL_W:-<无>}"
[ -f "$STATE_DIR/release-$(git rev-parse --short=7 "$DEPLOYED_SHA" 2>/dev/null).json" ] \
  && ok "release manifest 已随正式部署落盘" || bad "正式部署缺 release manifest"
# 正式状态快照（回归演练可能污染 state，结束时按此恢复）
STATE_FORMAL=/tmp/p0-state-formal.json
cp "$STATE" "$STATE_FORMAL"
FORMAL_SHA=$(state_field deployed_sha); FORMAL_WEB=$(state_field deployed_web_image_id)
FORMAL_API=$(state_field deployed_api_image_id); FORMAL_SLOT=$(state_field active_web_slot)
echo "  正式状态快照：sha=${FORMAL_SHA:0:12} slot=$FORMAL_SLOT web=${FORMAL_WEB:7:12} api=${FORMAL_API:7:12}"

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
run_drill /tmp/p0-reg-r5.log ZB_DRILL_MODE=1 ZB_DRILL_HEALTH_FAIL=1 $(drill_envs)
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
# 演练钩子（ZB_DRILL_HEALTH_FAIL）按设计不污染 failed_sha（r2 定版护栏：演练失败
# 不代表该提交真的坏）。真实失败 SHA 的隔离语义用确定性状态注入验证：
FAILED_STATE=$(state_field failed_sha)
[ -z "$FAILED_STATE" ] && ok "演练失败未污染 failed_sha（护栏生效）" || bad "演练失败被记入 failed_sha：$FAILED_STATE"
state_force "$PREV_SHA" "$REMOTE_SHA"
out2=$(ZB_IGNORE_PAUSE=1 timeout 60 bash scripts/deploy-cron.sh 2>&1 || true)
case "$out2" in *"已隔离"*) ok "失败 SHA 隔离生效：$(echo "$out2" | tail -1)" ;; *) bad "失败 SHA 未被隔离：$(echo "$out2" | tail -1)" ;; esac
state_force "$PREV_SHA" ""
IMG_AFTER_ROLLBACK=$(docker inspect -f '{{.Image}}' "$(docker ps --filter name=zhibi-web --format '{{.Names}}' | head -1)" 2>/dev/null || echo none)
[ "$IMG_AFTER_ROLLBACK" = "$IMG_AFTER" ] && ok "回滚后运行镜像 == 上一成功版本" || bad "回滚镜像不一致"
DEPLOYED_AFTER=$(state_field deployed_sha)
[ "$DEPLOYED_AFTER" = "$PREV_SHA" ] && ok "回滚后 deployed_sha 保持旧版本（${DEPLOYED_AFTER:0:12}）" || bad "deployed_sha 被失败版本覆盖（$DEPLOYED_AFTER）"

echo "== R6b 已部署版本不会被记为失败版本（护栏）=="
state_force "$REMOTE_SHA" ""
run_drill /tmp/p0-reg-r6b.log ZB_DRILL_MODE=1 ZB_DRILL_HEALTH_FAIL=1 $(drill_envs)
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
  rm -f "$log"   # 消除与子进程 truncate 的竞态：陈旧日志会让标记误匹配
  local dpid="" i seen=0 attempt
  for attempt in 1 2 3; do
    env ZB_TEST_SECRET_MARKER="$MARKER" ZB_HEALTH_ROUNDS=$HEALTH_ROUNDS_DRILL \
        ZB_DRILL_MODE=1 \
        DEPLOY_REF="$DEPLOY_REF" FORCE_DEPLOY=1 ZB_IGNORE_PAUSE=1 $(drill_envs) \
        bash scripts/deploy-cron.sh > "$log" 2>&1 &
    dpid=$!
    seen=0
    for i in $(seq 1 60); do
      grep -q "候选前端已启动\|inner lock held" "$log" 2>/dev/null && break
      kill -0 "$dpid" 2>/dev/null || break
      sleep 1
    done
    grep -q "inner lock held" "$log" 2>/dev/null && { echo "    | 演练遇到 inner lock 冲突，5s 后重试（$attempt/3）"; sleep 5; continue; }
    break
  done
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
  rcout=$(reconcile_retry); local rrc=$?
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

echo "== R15 state_write 完成后 SIGTERM（提交窗口，不得出现状态新版/运行旧版）=="
state_force "$PREV_SHA" ""
PROBE_FILE=/tmp/p0-probe-r15.txt
start_probe "$PROBE_FILE"
run_drill /tmp/p0-reg-r15.log ZB_DRILL_MODE=1 ZB_TEST_SIGTERM_AFTER_STATE_WRITE=1 $(drill_envs)
R15_RC=$?
DEPLOY_EXIT_TS=$(date +%s)
finish_probe "$PROBE_FILE" "$DEPLOY_EXIT_TS"
out15=$(cat /tmp/p0-reg-r15.log)
case "$out15" in *"state_write 完成后立即向自身发送 SIGTERM"*) ok "R15 钩子触发：SIGTERM 落在 state_write 与 COMMITTED 置位之间（rc=$R15_RC）" ;; *) bad "R15 钩子未触发（部署未到达提交点，rc=$R15_RC）" ;; esac
echo "$out15" | grep -q "触发回滚" && bad "R15 提交窗口 SIGTERM 触发了回滚" || ok "R15 未回滚"
echo "$out15" | grep -q "视为已提交，不回滚" && ok "R15 on_exit 以持久状态判定为已提交（提交窗口兜底生效）" || bad "R15 on_exit 兜底未生效"
outR15=$(reconcile_retry || true)
echo "$outR15" | grep "reconcile:" | tail -2 | sed 's/^/    | /'
assert_consistent "R15"
R15SHA=$(state_field deployed_sha)
[ "$R15SHA" = "$REMOTE_SHA" ] && ok "R15 状态为提交的新版且运行一致（${R15SHA:0:12}）" || bad "R15 状态异常：$R15SHA"
assert_probe_clean "R15 全过程（含退出后60s）" "$PROBE_FILE"

echo "== R16 nginx 切换后 SIGKILL（无 trap）→ reconcile 必须恢复旧版本 =="
cp "$STATE_FORMAL" "$STATE"
outR16p=$(reconcile_retry || true)
state_force "$PREV_SHA" ""
log16=/tmp/p0-sigkill-switch.log
rm -f "$log16"
DP16=""
for AT16 in 1 2 3; do
  env ZB_TEST_SECRET_MARKER="$MARKER" ZB_HEALTH_ROUNDS=$HEALTH_ROUNDS_DRILL ZB_DRILL_MODE=1 \
      DEPLOY_REF="$DEPLOY_REF" FORCE_DEPLOY=1 ZB_IGNORE_PAUSE=1 $(drill_envs) \
      bash scripts/deploy-cron.sh > "$log16" 2>&1 &
  DP16=$!
  for i in $(seq 1 60); do
    grep -q "候选前端已启动\|inner lock held" "$log16" 2>/dev/null && break
    kill -0 "$DP16" 2>/dev/null || break
    sleep 1
  done
  grep -q "inner lock held" "$log16" 2>/dev/null && { echo "    | 演练遇到 inner lock 冲突，5s 后重试（$AT16/3）"; sleep 5; continue; }
  break
done
SEEN16=0
for i in $(seq 1 240); do
  grep -q "入口已切到" "$log16" 2>/dev/null && { SEEN16=1; break; }
  kill -0 "$DP16" 2>/dev/null || break
  sleep 1
done
[ "$SEEN16" = "1" ] || echo "    | 标记未出现（部署提前退出）"
sleep 2
kill -9 "$DP16" 2>/dev/null || true
wait "$DP16" 2>/dev/null; R16_RC=$?
echo "  SIGKILL 后退出码 rc=$R16_RC（无 trap，无回滚执行）"
outR16=$(reconcile_retry || true)
echo "$outR16" | grep "reconcile:" | head -4 | sed 's/^/    | /'
echo "$outR16" | grep -q "不允许滚动提交" && ok "R16 reconcile 按 phase 门控拒绝滚动提交（phase=switched < health_verified）" \
  || bad "R16 reconcile 未按 phase 门控（输出：$(echo "$outR16" | grep 'reconcile:' | head -1)）"
assert_consistent "R16"
R16SHA=$(state_field deployed_sha)
[ "$R16SHA" = "$PREV_SHA" ] && ok "R16 状态保持旧版本（${R16SHA:0:12}，未被硬中断的部署滚动提交）" \
  || bad "R16 状态被滚动提交为 ${R16SHA:0:12}"
EC16=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/login" 2>/dev/null || echo 000)
[ "$EC16" = "200" ] && ok "R16 恢复后入口 200（旧版本实际在服务）" || bad "R16 恢复后入口 $EC16"

echo "== R16b health_verified 持久化后 SIGKILL（无 trap）→ reconcile 允许滚动提交 =="
cp "$STATE_FORMAL" "$STATE"
outR16bp=$(reconcile_retry || true)
state_force "$PREV_SHA" ""
for AT16B in 1 2 3; do
  rm -f /tmp/p0-sigkill-verified.log
  env ZB_TEST_SECRET_MARKER="$MARKER" ZB_HEALTH_ROUNDS=$HEALTH_ROUNDS_DRILL ZB_DRILL_MODE=1 \
      ZB_TEST_SIGKILL_AFTER_HEALTH_VERIFY=1 \
      DEPLOY_REF="$DEPLOY_REF" FORCE_DEPLOY=1 ZB_IGNORE_PAUSE=1 $(drill_envs) \
      bash scripts/deploy-cron.sh > /tmp/p0-sigkill-verified.log 2>&1
  R16B_RC=$?
  grep -q "inner lock held" /tmp/p0-sigkill-verified.log 2>/dev/null || break
  echo "    | 演练遇到 inner lock 冲突，5s 后重试（$AT16B/3）"
  sleep 5
done
grep -q "health_verified 登记后立即 SIGKILL" /tmp/p0-sigkill-verified.log \
  && ok "R16b 钩子触发：SIGKILL 落在 phase=health_verified 持久化之后（rc=$R16B_RC，无 trap）" \
  || bad "R16b 钩子未触发"
outR16b=$(reconcile_retry || true)
echo "$outR16b" | grep "reconcile:" | head -3 | sed 's/^/    | /'
echo "$outR16b" | grep -q "复验通过 → 滚动提交" && ok "R16b reconcile 在 phase=health_verified 下滚动提交（复验入口/静态/容器/镜像后）" \
  || bad "R16b reconcile 未滚动提交"
assert_consistent "R16b"
R16BSHA=$(state_field deployed_sha)
[ "$R16BSHA" = "$REMOTE_SHA" ] && ok "R16b 滚动提交后的状态 = 部署目标（${R16BSHA:0:12}）" || bad "R16b 状态异常：$R16BSHA"
EC16B=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/login" 2>/dev/null || echo 000)
[ "$EC16B" = "200" ] && ok "R16b 滚动提交后入口 200" || bad "R16b 入口 $EC16B"

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
out6=$(reconcile_retry || true)
echo "$out6" | grep "reconcile:" | tail -2 | sed 's/^/    | /'
assert_consistent "R13 结束态"

echo "== R14 正式状态恢复（drill 不得污染正式 state）=="
cp "$STATE_FORMAL" "$STATE"
outR14=$(reconcile_retry || true)
echo "$outR14" | grep "reconcile:" | tail -2 | sed 's/^/    | /'
assert_consistent "R14 正式恢复"
R14SHA=$(state_field deployed_sha); R14WEB=$(state_field deployed_web_image_id); R14API=$(state_field deployed_api_image_id)
if [ "$R14SHA" = "$FORMAL_SHA" ] && [ "$R14WEB" = "$FORMAL_WEB" ] && [ "$R14API" = "$FORMAL_API" ]; then
  ok "R14 结束态 == 正式版本（sha=${FORMAL_SHA:0:12} web=${FORMAL_WEB:7:12} api=${FORMAL_API:7:12}）——演练未污染正式 state"
else
  bad "R14 正式状态恢复失败（$R14SHA / ${R14WEB:7:12} / ${R14API:7:12}）"
fi
EC14=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/login" 2>/dev/null || echo 000)
[ "$EC14" = "200" ] && ok "R14 恢复后入口 200" || bad "R14 恢复后入口 $EC14"

flock -n "$INNER_LOCK" true 2>/dev/null && ok "R8 锁在成功与失败路径均释放" || bad "锁泄漏"

echo ""
echo "== 回归结果: PASS=$PASS FAIL=$FAIL =="
echo "（受控假密钥标记 $MARKER 仅用于本轮残留扫描，未配置任何真实凭据）"
[ "$FAIL" -eq 0 ]
