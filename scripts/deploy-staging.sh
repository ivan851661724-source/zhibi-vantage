#!/bin/sh
# ============================================================
# scripts/deploy-staging.sh —— 测试服可重复部署（任一步失败立即停止）
# ------------------------------------------------------------
# 用法（在测试服上运行，参数与密钥都不落仓库）：
#   APP_DIR=/srv/zhibi/app \
#   DATA_DIR=/srv/zhibi/data \
#   BACKUP_DIR=/srv/zhibi/backups \
#   STOP_CMD="sudo systemctl stop zhibi-backend zhibi-web" \
#   START_CMD="sudo systemctl start zhibi-backend zhibi-web" \
#   sh scripts/deploy-staging.sh <期望的 commit SHA>
#
# 可选：
#   SKIP_INSTALL=1      跳过依赖安装
#   SKIP_BUILD=1        跳过前端构建
#   SKIP_SMOKE=1        跳过冒烟
#   API_BASE / WEB_BASE 健康检查地址（默认 127.0.0.1:3300 / :3000）
#
# 密钥纪律：
#   · 只从运行环境（systemd Environment / .env，且 .env 已 gitignore）读取；
#   · 脚本参数、日志、URL 中绝不出现密钥；只打印"已配置/未配置"。
# ============================================================
set -eu

STEP="init"
fail() { echo "[deploy] FAILED at step: $STEP"; exit 1; }
trap fail EXIT

APP_DIR=${APP_DIR:-/srv/zhibi/app}
DATA_DIR=${DATA_DIR:-/srv/zhibi/data}
BACKUP_DIR=${BACKUP_DIR:-/srv/zhibi/backups}
STOP_CMD=${STOP_CMD:-}
START_CMD=${START_CMD:-}
API_BASE=${API_BASE:-http://127.0.0.1:3300}
WEB_BASE=${WEB_BASE:-http://127.0.0.1:3000}
EXPECTED=${1:-}

echo "[deploy] 应用目录 $APP_DIR / 数据目录 $DATA_DIR"

# ---------- 0. 环境自检 ----------
STEP="0-env"
command -v node >/dev/null || { echo "[deploy] 缺少 node"; exit 1; }
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 22 ]; then echo "[deploy] node 需 >= 22（node:sqlite），当前 $NODE_MAJOR"; exit 1; fi
echo "[deploy] node $(node -v) ok"

# 密钥只检查存在性，不打印值
for v in SERPER_API_KEY YOUTUBE_API_KEY DATAFORSEO_LOGIN DATAFORSEO_PASSWORD TIKTOK_CLIENT_KEY TIKTOK_CLIENT_SECRET LLM_API_KEY MT_MASTER_KEY; do
  eval "val=\${$v:-}"
  if [ -n "$val" ]; then echo "[deploy] 环境变量 $v 已配置（值不打印）"; else echo "[deploy] 环境变量 $v 未配置（对应来源将如实显示 not_configured）"; fi
done

# ---------- 1. 校验目标 commit ----------
STEP="1-commit"
cd "$APP_DIR"
HEAD_SHA=$(git rev-parse HEAD)
if [ -z "$EXPECTED" ]; then
  echo "[deploy] 未指定期望 commit，使用当前 HEAD $HEAD_SHA"
else
  if [ "$HEAD_SHA" != "$EXPECTED" ]; then
    echo "[deploy] 当前 HEAD $HEAD_SHA != 期望 $EXPECTED"
    echo "[deploy] 请先：git fetch origin && git checkout $EXPECTED"
    exit 1
  fi
  echo "[deploy] commit 校验通过 $HEAD_SHA"
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "[deploy] 工作区有未提交改动（部署应基于干净提交）："
  git status --porcelain | head -10
  exit 1
fi

# ---------- 2. 停止服务（备份前停写，保证一致性） ----------
STEP="2-stop"
if [ -n "$STOP_CMD" ]; then sh -c "$STOP_CMD"; echo "[deploy] 服务已停止"; else echo "[deploy] 未提供 STOP_CMD：跳过停止（请确认无写入）"; fi

# ---------- 3. 部署前数据库备份 ----------
STEP="3-backup"
TS=$(date +%Y%m%d-%H%M%S)
SNAP="$BACKUP_DIR/$TS"
mkdir -p "$SNAP"
if [ -d "$DATA_DIR" ]; then
  for f in "$DATA_DIR"/*.db "$DATA_DIR"/*.json; do
    [ -e "$f" ] || continue
    cp -a "$f" "$SNAP/" 2>/dev/null || true
  done
  echo "[deploy] 数据库备份完成：$SNAP"
  echo "$HEAD_SHA" > "$SNAP/COMMIT"
  ls -1 "$SNAP" | head -20
else
  echo "[deploy] 数据目录不存在（首次部署）：$DATA_DIR"
fi

# ---------- 4. 安装依赖 ----------
STEP="4-install"
if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  if [ -d "$APP_DIR/web" ]; then
    (cd "$APP_DIR/web" && npm ci --no-audit --no-fund)
    echo "[deploy] 前端依赖安装完成"
  fi
else
  echo "[deploy] SKIP_INSTALL=1，跳过依赖安装"
fi

# ---------- 5. 数据库加法迁移 ----------
STEP="5-migrate"
ZB_DATA_DIR="$DATA_DIR" node "$APP_DIR/scripts/migrate-db.js"

# ---------- 6. 前端生产构建 ----------
STEP="6-build"
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  (cd "$APP_DIR/web" && npx next build)
  echo "[deploy] 前端构建完成"
else
  echo "[deploy] SKIP_BUILD=1，跳过构建"
fi

# ---------- 7. 启动/重启服务 ----------
STEP="7-start"
if [ -n "$START_CMD" ]; then sh -c "$START_CMD"; echo "[deploy] 服务已启动"; else echo "[deploy] 未提供 START_CMD：请手动启动后端与前端后继续"; fi

# ---------- 8. 健康检查（最多等 120s） ----------
STEP="8-health"
i=0
until curl -fsS "$API_BASE/healthz" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 40 ]; then echo "[deploy] 后端健康检查超时：$API_BASE/healthz"; exit 1; fi
  sleep 3
done
echo "[deploy] 后端健康：$API_BASE/healthz"
curl -fsS -o /dev/null "$WEB_BASE/brands" && echo "[deploy] 前端可达：$WEB_BASE/brands" || echo "[deploy] 前端 /brands 返回非 2xx（前端可能需登录，属正常）"

# ---------- 9. 冒烟 ----------
STEP="9-smoke"
if [ "${SKIP_SMOKE:-0}" != "1" ]; then
  node "$APP_DIR/scripts/staging-smoke.js" --api "$API_BASE" --project "${SMOKE_PROJECT_ID:-}"
else
  echo "[deploy] SKIP_SMOKE=1，跳过冒烟"
fi

trap - EXIT
echo "[deploy] 部署完成：$HEAD_SHA"
