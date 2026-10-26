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
# 用法：bash scripts/deploy-regression.sh [--skip-rebuild]
# 会真实执行部署与回滚，耗时约 15–25 分钟。
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
if [ "$SKIP_REBUILD" = "0" ]; then
  echo "  （--no-cache 重建，确保镜像 ID 必变，约 3-5 分钟）"
  docker compose build --no-cache >/tmp/p0-rebuild.log 2>&1
  tail -2 /tmp/p0-rebuild.log | sed 's/^/    | /'
fi
( probe_loop success /tmp/p0-probe-success.txt 300 ) &
PROBE=$!
out=$(FORCE_DEPLOY=1 timeout 900 bash scripts/deploy-cron.sh 2>&1; echo "RC=$?")
wait $PROBE 2>/dev/null
echo "$out" | grep -E "deploy done|candidate images|入口已切|健康门基线|RC=" | sed 's/^/    | /'
case "$out" in *RC=0*) ok "真实部署成功完成" ;; *) bad "真实部署失败" ;; esac
read -r TOTAL NON200 <<< "$(summarize '成功部署全过程' /tmp/p0-probe-success.txt)"
[ "$NON200" -eq 0 ] && ok "全过程 0 次非 200（无 502/连接拒绝）" || bad "全过程 $NON200 次非 200（$TOTAL 次中）"
SLOT_AFTER=$(docker ps --filter name=zhibi-web --format '{{.Names}}' | head -1)
IMG_AFTER=$(docker inspect -f '{{.Image}}' "$SLOT_AFTER" 2>/dev/null || echo none)
[ "$IMG_BEFORE" != "$IMG_AFTER" ] && ok "镜像 ID 已变化（$IMG_BEFORE -> $IMG_AFTER）" || bad "镜像 ID 未变化（$IMG_BEFORE）"
[ "$SLOT_BEFORE" != "$SLOT_AFTER" ] && ok "容器槽位已切换（$SLOT_BEFORE -> $SLOT_AFTER）" || bad "容器槽位未切换（$SLOT_BEFORE）"
DEPLOYED_SHA=$(grep -o '"deployed_sha":"[^"]*"' "$STATE" | sed 's/.*:"//; s/"$//')
[ -n "$DEPLOYED_SHA" ] && ok "deployed_sha=$DEPLOYED_SHA" || bad "deployed_sha 为空"
STATE_IMG=$(grep -o '"deployed_web_image_id":"[^"]*"' "$STATE" | sed 's/.*:"//; s/"$//')
[ "$STATE_IMG" = "$IMG_AFTER" ] && ok "state 镜像 == 实际运行镜像（$IMG_AFTER）" || bad "state 镜像($STATE_IMG) != 运行($IMG_AFTER)"

echo "== R5+R6 失败回滚全过程 + failed_sha 隔离 =="
( probe_loop rollback /tmp/p0-probe-rollback.txt 200 ) &
PROBE=$!
out=$(ZB_DRILL_HEALTH_FAIL=1 FORCE_DEPLOY=1 timeout 900 bash scripts/deploy-cron.sh 2>&1; echo "RC=$?")
wait $PROBE 2>/dev/null
echo "$out" | grep -E "健康门未通过|回滚完成|回滚失败|RC=" | head -5 | sed 's/^/    | /'
case "$out" in *RC=1*) ok "失败部署非零退出" ;; *) bad "失败部署退出码异常" ;; esac
read -r TOTAL NON200 <<< "$(summarize '失败回滚全过程' /tmp/p0-probe-rollback.txt)"
PERM=$(awk '$3=="502" || $3=="000"' /tmp/p0-probe-rollback.txt | wc -l)
MAINT=$(awk '$3=="503"' /tmp/p0-probe-rollback.txt | wc -l)
[ "$PERM" -eq 0 ] && ok "回滚全过程无 502/连接拒绝（维护态 503 共 $MAINT 次，属明确维护响应）" || bad "回滚全过程出现 $PERM 次 502/000"
printf '%s' "$out" | grep -q "回滚完成" && ok "回滚完成并严格核对镜像" || bad "回滚未完成"
FAILED_STATE=$(grep -o '"failed_sha":"[^"]*"' "$STATE" | sed 's/.*:"//; s/"$//')
[ -n "$FAILED_STATE" ] && ok "failed_sha 已记录（$FAILED_STATE）" || bad "failed_sha 未记录"
out2=$(timeout 60 bash scripts/deploy-cron.sh 2>&1)
case "$out2" in *"已隔离"*|*"无需部署"*) ok "再次调用不重复部署：$(echo "$out2" | tail -1)" ;; *) bad "失败 SHA 被重复部署" ;; esac
IMG_AFTER_ROLLBACK=$(docker inspect -f '{{.Image}}' "$(docker ps --filter name=zhibi-web --format '{{.Names}}' | head -1)" 2>/dev/null || echo none)
[ "$IMG_AFTER_ROLLBACK" = "$IMG_AFTER" ] && ok "回滚后运行镜像 == 上一成功版本（$IMG_AFTER_ROLLBACK）" || bad "回滚镜像不一致（$IMG_AFTER_ROLLBACK vs $IMG_AFTER）"
DEPLOYED_AFTER=$(grep -o '"deployed_sha":"[^"]*"' "$STATE" | sed 's/.*:"//; s/"$//')
[ "$DEPLOYED_AFTER" = "$DEPLOYED_SHA" ] && ok "回滚后 deployed_sha 保持上一成功版本（$DEPLOYED_AFTER）" || bad "deployed_sha 被失败版本覆盖（$DEPLOYED_AFTER）"

echo ""
echo "== 回归结果: PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ]
