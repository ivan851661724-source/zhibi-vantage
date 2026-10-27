#!/bin/bash
# zhibi-vantage 部署回归 v2（P0 r2）
#   R1  部署锁互斥（第二个实例立即退出）
#   R2  构建期失败不动运行服务（ZB_DRILL_FAIL_STAGE=build，不触发回滚）
#   R3  真实替换：镜像 ID 变化 + 容器槽位变化
#   R4  成功部署全过程 100ms 高频探测：0 次 502 / 连接拒绝
#   R5  失败回滚全过程 100ms 高频探测：回滚后镜像与上一成功版本严格一致
#   R6  failed_sha 不重复部署
#   R7  缓存头实测（HTML no-store、static immutable、API 不可共享缓存、404 不长期缓存）
#   R8  锁在成功与失败路径均释放
# 用法：bash scripts/deploy-regression.sh
# 全程不执行 --no-cache 重建（机制演练用 ZB_SKIP_BUILD 显式候选镜像）。
# 会真实执行部署与回滚，耗时约 10–15 分钟。
set -uo pipefail
cd /opt/zhibi-vantage

WEB_PORT=3002
STATE=/var/lib/zhibi-deploy/state.json
PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
SKIP_REBUILD=0
[ "${1:-}" = "--skip-rebuild" ] && SKIP_REBUILD=1
ACTIVE_NAME=$(docker ps --filter name=zhibi-web --format '{{.Names}}' | head -1)

probe_loop() { # $1=label $2=outfile $3=seconds
  local end=$(( $(date +%s) + $3 ))
  : > "$2"
  while [ "$(date +%s)" -lt "$end" ]; do
    for p in /login /healthz; do
      c=$(curl -s -o /dev/null -m 4 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT$p" 2>/dev/null || echo 000)
      printf '%s %s %s\n' "$(date +%H:%M:%S.%3N)" "$p" "$c" >> "$2"
    done
    sleep 0.1
  done
}

maint_window() { # 输出 503 连续窗口时长（秒，保留 1 位）
  awk '$3=="503"{split($1,t,":"); s=t[1]*3600+t[2]*60+t[3]; if(min==""||s<min)min=s; if(s>max)max=s; n++} END{if(n>0)printf "%.1f", max-min; else printf "0"}' "$1"
}
summarize() { # $1=label $2=file
  local total fails
  total=$(wc -l < "$2" 2>/dev/null || echo 0)
  fails=$(awk '$3!="200"' "$2" 2>/dev/null | wc -l)
  echo "  $1: total=$total 非200=$fails"
  [ "$fails" -gt 0 ] && awk '$3!="200"{print "     "$0}' "$2" | head -12
  echo "$total $fails"
}

echo "== R7 缓存头实测 =="
HTML_CC=$(curl -sI -m 5 "http://127.0.0.1:$WEB_PORT/login" | tr -d '\r' | grep -i '^cache-control:' | head -1)
case "$HTML_CC" in *no-store*) ok "HTML no-store: $HTML_CC" ;; *) bad "HTML 缓存头异常: ${HTML_CC:-<无>}" ;; esac
CH=$(curl -s -m 5 "http://127.0.0.1:$WEB_PORT/login" | grep -oE '/_next/static/[^"\\]+' | head -1)
CH_CC=$(curl -sI -m 5 "http://127.0.0.1:$WEB_PORT$CH" | tr -d '\r' | grep -i '^cache-control:' | head -1)
case "$CH_CC" in *immutable*) ok "static immutable: $CH_CC" ;; *) bad "static 缓存头异常: ${CH_CC:-<无>}" ;; esac
API_CC=$(curl -sI -m 5 "http://127.0.0.1:$WEB_PORT/api/healthz" | tr -d '\r' | grep -i '^cache-control:' | head -1)
case "$API_CC" in *no-store*|*no-cache*|*private*) ok "API 不可共享缓存: $API_CC" ;; *) bad "API 缓存头异常: ${API_CC:-<无>}" ;; esac
NF_CC=$(curl -sI -m 5 "http://127.0.0.1:$WEB_PORT/no-such-page-$$" | tr -d '\r' | grep -i '^cache-control:' | head -1)
case "$NF_CC" in *no-store*|*no-cache*) ok "404 不长期缓存: $NF_CC" ;; *) bad "404 缓存头异常: ${NF_CC:-<无>}" ;; esac

echo "== R1 锁互斥 =="
INNER_LOCK=/tmp/zhibi-deploy.inner.lock
( exec 9>"$INNER_LOCK"; flock 9; sleep 6 ) &
HOLDER=$!
sleep 0.5
out=$(timeout 10 bash scripts/deploy-cron.sh 2>&1 || true)
wait $HOLDER 2>/dev/null
case "$out" in *"inner lock held"*) ok "并发部署被拒绝" ;; *) bad "并发未被拒绝" ;; esac

echo "== R8 锁释放 =="
flock -n "$INNER_LOCK" true 2>/dev/null && ok "锁可重新获取" || bad "锁泄漏"

echo "== R2 构建期失败不动运行服务 =="
BEFORE_CONTAINERS=$(docker ps --filter name=zhibi-web --format '{{.Names}}' | tr '\n' ',')
out=$(ZB_DRILL_FAIL_STAGE=build FORCE_DEPLOY=1 timeout 600 bash scripts/deploy-cron.sh 2>&1; echo "RC=$?")
echo "$out" | tail -2 | sed 's/^/    | /'
case "$out" in *RC=1*) ok "构建期失败非零退出" ;; *) bad "构建期失败退出码异常" ;; esac
printf '%s' "$out" | grep -q "触发回滚" && bad "构建期失败触发了无意义回滚" || ok "构建期失败未触发回滚"
AFTER_CONTAINERS=$(docker ps --filter name=zhibi-web --format '{{.Names}}' | tr '\n' ',')
AFTER_LOGIN=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/login")
[ "$BEFORE_CONTAINERS" = "$AFTER_CONTAINERS" ] && ok "运行容器未被改动（$AFTER_CONTAINERS）" || bad "容器被改动：$BEFORE_CONTAINERS -> $AFTER_CONTAINERS"
[ "$AFTER_LOGIN" = "200" ] && ok "旧服务继续服务（/login=200）" || bad "旧服务中断：/login=$AFTER_LOGIN"

echo "== R3+R4 真实替换 + 成功部署全过程探测 =="
IMG_BEFORE=$(docker inspect -f '{{.Image}}' "$ACTIVE_NAME" 2>/dev/null || echo none)
SLOT_BEFORE="$ACTIVE_NAME"
RUN_API_IMG=$(docker inspect -f '{{.Image}}' zhibi-vantage 2>/dev/null || echo none)
# 本机禁止 --no-cache 全量重建（曾两次压垮宿主机）。真实替换改用"显式提供的
# 历史镜像"证明：镜像 ID 必不同、容器必替换、chunk 必跨 release。
pick_diff() { # $1=运行镜像ID $2=仓库前缀 → 输出第一个与运行不同的 tag
  for t in $(docker images --format '{{.Repository}}:{{.Tag}}' | grep "^$2:"); do
    id=$(docker inspect -f '{{.Id}}' "$t" 2>/dev/null || true)
    [ -n "$id" ] && [ "$id" != "$1" ] && { echo "$t"; return; }
  done
}
CAND_WEB=$(pick_diff "$IMG_BEFORE" zhibi-web)
CAND_API=$(pick_diff "$RUN_API_IMG" zhibi-vantage)
if [ -n "$CAND_WEB" ] && [ -n "$CAND_API" ]; then
  echo "  替换演练候选：web=$CAND_WEB api=$CAND_API（显式提供，均非当前运行镜像）"
  DEPLOY_ENVS=(ZB_SKIP_BUILD=1 "ZB_CANDIDATE_WEB_IMG=$CAND_WEB" "ZB_CANDIDATE_API_IMG=$CAND_API" FORCE_DEPLOY=1)
else
  echo "  无可用历史镜像，回退为缓存构建（仍禁止 --no-cache）"
  DEPLOY_ENVS=(FORCE_DEPLOY=1)
fi
( probe_loop success /tmp/p0-probe-success.txt 300 ) &
PROBE=$!
out=$(env "${DEPLOY_ENVS[@]}" timeout 900 bash scripts/deploy-cron.sh 2>&1; echo "RC=$?")
wait $PROBE 2>/dev/null
echo "$out" | grep -E "deploy done|candidate images|入口已切|健康门基线|RC=" | sed 's/^/    | /'
case "$out" in *RC=0*) ok "真实部署成功完成" ;; *) bad "真实部署失败" ;; esac
read -r TOTAL NON200 <<< "$(summarize '成功部署全过程' /tmp/p0-probe-success.txt | tail -1)"
P502=$(awk '$3=="502"||$3=="000"' /tmp/p0-probe-success.txt | wc -l)
P503=$(awk '$3=="503"' /tmp/p0-probe-success.txt | wc -l)
MW=$(maint_window /tmp/p0-probe-success.txt)
[ "$P502" -eq 0 ] && ok "全过程 0 次 502/连接拒绝（$TOTAL 次请求，503 维护态 $P503 次）" || bad "全过程出现 $P502 次 502/连接拒绝（$TOTAL 次请求）"
awk "BEGIN{exit !($MW<=15)}" && ok "后端维护窗口 ${MW}s（明确 503，≤15s）" || bad "后端维护窗口 ${MW}s 超过 15s"
SLOT_AFTER=$(docker ps --filter name=zhibi-web --format '{{.Names}}' | head -1)
IMG_AFTER=$(docker inspect -f '{{.Image}}' "$SLOT_AFTER" 2>/dev/null || echo none)
[ "$IMG_BEFORE" != "$IMG_AFTER" ] && ok "镜像 ID 已变化（$IMG_BEFORE -> $IMG_AFTER）" || bad "镜像 ID 未变化（$IMG_BEFORE）"
[ "$SLOT_BEFORE" != "$SLOT_AFTER" ] && ok "容器槽位已切换（$SLOT_BEFORE -> $SLOT_AFTER）" || bad "容器槽位未切换（$SLOT_BEFORE）"
DEPLOYED_SHA=$(grep -o '"deployed_sha":"[^"]*"' "$STATE" | sed 's/.*:"//; s/"$//')
[ -n "$DEPLOYED_SHA" ] && ok "deployed_sha=$DEPLOYED_SHA" || bad "deployed_sha 为空"
STATE_IMG=$(grep -o '"deployed_web_image_id":"[^"]*"' "$STATE" | sed 's/.*:"//; s/"$//')
[ "$STATE_IMG" = "$IMG_AFTER" ] && ok "state 镜像 == 实际运行镜像（$IMG_AFTER）" || bad "state 镜像($STATE_IMG) != 运行($IMG_AFTER)"

echo "== R5+R6 失败回滚全过程 + failed_sha 隔离 =="
# 真实语义：这次部署的是「新提交」，已部署的是旧版本——failed_sha 才有记录空间。
# 若用「已部署的同一个 SHA」演练，按设计不得记录 failed_sha（见 R6b）。
STATE_SAVE=/tmp/p0-state-save.json
cp "$STATE" "$STATE_SAVE"
PREV_SHA=$(git rev-parse HEAD~1)
REMOTE_SHA=$(git rev-parse "origin/${DEPLOY_REF:-main}")
state_field() { grep -o "\"$1\":\"[^\"]*\"" "$STATE" | sed 's/.*:"//; s/"$//'; }
state_force() { # $1=deployed_sha $2=failed_sha
  printf '{"deployed_sha":"%s","deployed_web_image_id":"%s","deployed_api_image_id":"%s","active_web_slot":"%s","failed_sha":"%s","deployed_at":"%s"}\n' \
    "$1" "$(state_field deployed_web_image_id)" "$(state_field deployed_api_image_id)" \
    "$(state_field active_web_slot)" "$2" "$(date -u '+%FT%TZ')" > "$STATE"
}
state_force "$PREV_SHA" ""
echo "  演练前置：deployed_sha=$PREV_SHA（旧版本） 候选=$REMOTE_SHA"
( probe_loop rollback /tmp/p0-probe-rollback.txt 200 ) &
PROBE=$!
# 候选在演练时刻现选：R3 之后运行镜像已变，脚本启动时捕获的 IMG_BEFORE 可能
# 恰好等于当前运行镜像而被 skip-build 拒绝
NOW_WEB=$(docker inspect -f '{{.Image}}' "$(docker ps --filter name=zhibi-web --format '{{.Names}}' | head -1)")
NOW_API=$(docker inspect -f '{{.Image}}' zhibi-vantage)
DRILL_WEB=$(pick_diff "$NOW_WEB" zhibi-web)
DRILL_API=$(pick_diff "$NOW_API" zhibi-vantage)
out=$(ZB_DRILL_HEALTH_FAIL=1 ZB_SKIP_BUILD=1 ZB_CANDIDATE_WEB_IMG="$DRILL_WEB" ZB_CANDIDATE_API_IMG="$DRILL_API" FORCE_DEPLOY=1 timeout 900 bash scripts/deploy-cron.sh 2>&1; echo "RC=$?")
wait $PROBE 2>/dev/null
echo "$out" | grep -E "健康门未通过|回滚完成|回滚失败|RC=" | head -5 | sed 's/^/    | /'
case "$out" in *RC=1*) ok "失败部署非零退出" ;; *) bad "失败部署退出码异常" ;; esac
read -r TOTAL NON200 <<< "$(summarize '失败回滚全过程' /tmp/p0-probe-rollback.txt | tail -1)"
PERM=$(awk '$3=="502" || $3=="000"' /tmp/p0-probe-rollback.txt | wc -l)
MAINT=$(awk '$3=="503"' /tmp/p0-probe-rollback.txt | wc -l)
[ "$PERM" -eq 0 ] && ok "回滚全过程无 502/连接拒绝（维护态 503 共 $MAINT 次，属明确维护响应）" || bad "回滚全过程出现 $PERM 次 502/000"
printf '%s' "$out" | grep -q "回滚完成" && ok "回滚完成并严格核对镜像" || bad "回滚未完成"
RB_SEC=$(printf '%s' "$out" | grep -oE "回滚耗时 [0-9]+s" | head -1 | grep -oE "[0-9]+" || echo 999)
[ "${RB_SEC:-999}" -le 30 ] && ok "回滚耗时 ${RB_SEC}s（≤30s）" || bad "回滚耗时 ${RB_SEC}s 超过 30s"
FAILED_STATE=$(state_field failed_sha)
[ "$FAILED_STATE" = "$REMOTE_SHA" ] && ok "failed_sha 记录为候选提交（${REMOTE_SHA:0:12}）" || bad "failed_sha 异常：$FAILED_STATE"
out2=$(ZB_IGNORE_PAUSE=1 timeout 60 bash scripts/deploy-cron.sh 2>&1)
case "$out2" in *"已隔离"*) ok "再次调用被隔离：$(echo "$out2" | tail -1)" ;; *) bad "失败 SHA 被重复部署：$(echo "$out2" | tail -1)" ;; esac
IMG_AFTER_ROLLBACK=$(docker inspect -f '{{.Image}}' "$(docker ps --filter name=zhibi-web --format '{{.Names}}' | head -1)" 2>/dev/null || echo none)
[ "$IMG_AFTER_ROLLBACK" = "$IMG_AFTER" ] && ok "回滚后运行镜像 == 上一成功版本（$IMG_AFTER_ROLLBACK）" || bad "回滚镜像不一致（$IMG_AFTER_ROLLBACK vs $IMG_AFTER）"
DEPLOYED_AFTER=$(state_field deployed_sha)
[ "$DEPLOYED_AFTER" = "$PREV_SHA" ] && ok "回滚后 deployed_sha 保持旧版本（${DEPLOYED_AFTER:0:12}）" || bad "deployed_sha 被失败版本覆盖（$DEPLOYED_AFTER）"

echo "== R6b 已部署版本不会被记为失败版本（护栏）=="
state_force "$REMOTE_SHA" ""
out3=$(ZB_DRILL_HEALTH_FAIL=1 ZB_SKIP_BUILD=1 ZB_CANDIDATE_WEB_IMG="$DRILL_WEB" ZB_CANDIDATE_API_IMG="$DRILL_API" FORCE_DEPLOY=1 timeout 900 bash scripts/deploy-cron.sh 2>&1; echo "RC=$?")
case "$out3" in *RC=1*) ok "演练部署按预期失败" ;; *) bad "演练部署退出码异常" ;; esac
FAILED_AFTER3=$(state_field failed_sha)
[ -z "$FAILED_AFTER3" ] && ok "failed_sha 保持为空（运行中的版本不会自相矛盾）" || bad "failed_sha 被写入正在运行的版本：$FAILED_AFTER3"
out4=$(ZB_IGNORE_PAUSE=1 timeout 60 bash scripts/deploy-cron.sh 2>&1)
case "$out4" in *"无需部署"*) ok "再次调用判定无需部署：$(echo "$out4" | tail -1)" ;; *) bad "状态判定异常：$(echo "$out4" | tail -1)" ;; esac
state_force "$REMOTE_SHA" ""
echo "  状态已复原：deployed_sha=${REMOTE_SHA:0:12} failed_sha=空"

echo ""
echo "== 回归结果: PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ]
