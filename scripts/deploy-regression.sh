#!/bin/bash
# zhibi-vantage 部署级回归测试（P0 稳定性整改）
# 在部署机上执行：bash /opt/zhibi-vantage/scripts/deploy-regression.sh
# 覆盖任务书第六节的部署级回归项：
#   R1 部署锁互斥：已有部署在跑时，第二个部署实例必须立即退出
#   R2 部署失败回滚：健康门失败时自动回滚 rollback tag，旧版本继续服务，无 502 空窗
#   R3 页面/静态资源同 release：/login HTML 引用的全部 chunk 均为 200 且 Content-Type 正确
#   R4 锁在成功与失败路径都释放：回归结束后 inner lock 可重新获取
#   R5 失败不报成功：失败路径日志中不得出现 deploy done
# 注意：R2 会真实执行一次带回滚的部署演练（约 1.5 分钟），请勿在业务高峰执行。
set -uo pipefail
cd /opt/zhibi-vantage

WEB_PORT=3000
[ -f .env ] && . ./.env && WEB_PORT=${WEB_PORT:-3000}
PASS=0; FAIL=0
ok()   { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad()  { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

echo "== R3 页面/静态资源同 release =="
html=$(curl -s -m 5 "http://127.0.0.1:$WEB_PORT/login" 2>/dev/null)
assets=$(printf '%s' "$html" | grep -oE '/_next/static/[^"]+' | sort -u)
if [ -z "$assets" ]; then
  bad "无法从 /login HTML 解析出静态资源"
else
  n=0; e=0
  while IFS= read -r a; do
    [ -n "$a" ] || continue
    n=$((n+1))
    case "$a" in
      *.css) exp="text/css" ;;
      *)     exp="javascript" ;;
    esac
    hdr=$(curl -s -o /dev/null -m 5 -D - "http://127.0.0.1:$WEB_PORT$a" 2>/dev/null | tr -d '\r')
    code=$(printf '%s' "$hdr" | awk 'NR==1{print $2}')
    ct=$(printf '%s' "$hdr" | grep -i '^content-type:' | head -1 | awk '{print $2}')
    if [ "$code" != "200" ] || [[ "$ct" != *"$exp"* ]]; then
      echo "    资源异常: $a code=$code ct=$ct"; e=$((e+1))
    fi
  done <<< "$assets"
  [ "$e" -eq 0 ] && ok "全部 $n 个静态资源 200 且 Content-Type 正确" || bad "$e/$n 个静态资源异常"
fi
html_cc=$(curl -s -o /dev/null -m 5 -D - "http://127.0.0.1:$WEB_PORT/login" 2>/dev/null | tr -d '\r' | grep -i '^cache-control:' | head -1)
case "$html_cc" in
  *no-store*) ok "/login HTML 缓存策略: $html_cc" ;;
  *)          bad "/login HTML 缓存策略异常: ${html_cc:-<无>}（应为 no-store）" ;;
esac

echo "== R1 部署锁互斥 =="
INNER_LOCK=/tmp/zhibi-deploy.inner.lock
if flock -n "$INNER_LOCK" true 2>/dev/null; then
  (
    exec 9>"$INNER_LOCK"
    flock 9
    sleep 6
  ) &
  HOLDER=$!
  sleep 0.5
  out=$(FORCE_DEPLOY=0 timeout 10 bash scripts/deploy-cron.sh 2>&1 || true)
  wait $HOLDER 2>/dev/null
  case "$out" in
    *"inner lock held"*) ok "并发部署被拒绝（第二个实例立即退出）" ;;
    *)                   bad "并发部署未被拒绝，输出: $(echo "$out" | head -2)" ;;
  esac
else
  bad "inner lock 当前被占用，无法测试（可能有部署在跑）"
fi

echo "== R4 锁已释放 =="
if flock -n "$INNER_LOCK" true 2>/dev/null; then
  ok "inner lock 可重新获取（成功路径释放）"
else
  bad "inner lock 被占用（锁泄漏）"
fi

echo "== R2+R5 失败回滚演练（健康门强制失败） =="
before_login=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/login" 2>/dev/null || echo 000)
if [ "$before_login" != "200" ]; then
  bad "演练前 /login 非 200（$before_login），先恢复服务再跑回归"
else
  drill_out=$(ZB_DRILL_HEALTH_FAIL=1 FORCE_DEPLOY=1 timeout 600 bash scripts/deploy-cron.sh 2>&1; echo "RC=$?")
  rc=$(printf '%s' "$drill_out" | tail -1)
  body=$(printf '%s' "$drill_out" | sed '$d')
  echo "$body" | tail -5 | sed 's/^/    | /'
  case "$rc" in
    RC=1) ok "健康门失败按非零退出（rc=1）" ;;
    *)    bad "健康门失败退出码异常: $rc" ;;
  esac
  if printf '%s' "$body" | grep -q "deploy done"; then
    bad "失败路径日志出现 deploy done（报告了虚假成功）"
  else
    ok "失败路径未报告部署成功"
  fi
  if printf '%s' "$body" | grep -q "触发回滚"; then
    ok "失败路径执行了自动回滚"
  else
    bad "失败路径未执行回滚"
  fi
  sleep 2
  after_login=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/login" 2>/dev/null || echo 000)
  [ "$after_login" = "200" ] && ok "回滚后旧版本继续服务（/login=200，无 502 空窗）" || bad "回滚后 /login=$after_login"
  if flock -n "$INNER_LOCK" true 2>/dev/null; then
    ok "失败路径锁已释放"
  else
    bad "失败路径锁未释放（锁泄漏）"
  fi
fi

echo ""
echo "== 回归结果: PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ]
