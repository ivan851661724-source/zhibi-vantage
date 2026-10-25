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
#   SMOKE_EMAIL=<冒烟账号邮箱> \
#   SMOKE_PASSWORD=<冒烟账号密码> \
#   SMOKE_PROJECT_ID=<测试项目 id（须与冒烟账号同租户；留空则走真实 HTTP 调研流程创建）> \
#   sh scripts/deploy-staging.sh <期望的 commit SHA>
#
# 可选：
#   SKIP_INSTALL=1      跳过依赖安装
#   SKIP_BUILD=1        跳过前端构建
#   SKIP_SMOKE=1        跳过冒烟（仅排障用；正式部署不得跳过）
#   API_BASE / WEB_BASE 健康检查地址（默认 127.0.0.1:3300 / :3000）
#
# 备份纪律（SC-10 r2 §一）：
#   · 服务停止后备份**完整运行时数据**：*.db / *.db-wal / *.db-shm / *.json /
#     盐值与密钥派生文件（.obs-salt / .jwt-secret / .admin-secret）/ research 调研档案；
#   · 生成文件数量、总大小与逐文件 SHA-256 manifest，并当场复核；
#   · 任一文件复制或校验失败 → 立即停止，**绝不进入迁移/构建**；
#   · 部署后续步骤失败 → 至少重新启动服务（不得让测试服静默停机）并明确打印失败步骤。
#
# 密钥纪律：
#   · 只从运行环境（systemd Environment / .env，且 .env 已 gitignore）读取；
#   · 脚本参数、日志、URL 中绝不出现密钥；只打印"已配置/未配置"。
# ============================================================
set -eu

STEP="init"
SNAP=""
STOPPED=0
STARTED=0

# 失败出口：明确打印失败步骤；若服务已被停止且尚未重启，先尽力重启，绝不停机晾着。
on_exit() {
  code=$?
  if [ "$code" != "0" ]; then
    echo "[deploy] ================================================"
    echo "[deploy] 部署失败于步骤：$STEP（退出码 $code）"
    if [ "$STOPPED" = "1" ] && [ "$STARTED" = "0" ]; then
      if [ -n "$START_CMD" ]; then
        echo "[deploy] 尝试重新启动服务（避免测试服静默停机；磁盘代码可能已是新版本，数据已备份）…"
        if sh -c "$START_CMD"; then
          STARTED=1
          echo "[deploy] 服务已重新启动。回滚方法见 docs/deployment/STAGING-RUNBOOK.md §3"
          [ -n "$SNAP" ] && echo "[deploy] 备份位置：$SNAP（其中 COMMIT 记录部署前 commit）"
        else
          echo "[deploy] ⚠️ 服务重启失败，请立即人工处理（测试服可能处于停止状态）！"
        fi
      else
        echo "[deploy] ⚠️ 未提供 START_CMD：服务可能仍处于停止状态，请立即手动启动！"
      fi
    fi
    echo "[deploy] ================================================"
  fi
  exit $code
}
trap on_exit EXIT

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
if [ -n "$STOP_CMD" ]; then sh -c "$STOP_CMD"; echo "[deploy] 服务已停止"; STOPPED=1; else echo "[deploy] 未提供 STOP_CMD：跳过停止（请确认无写入）"; fi

# ---------- 3. 部署前完整备份（停写后；任一失败立即中止，绝不进入迁移/构建） ----------
STEP="3-backup"
TS=$(date +%Y%m%d-%H%M%S)
SNAP="$BACKUP_DIR/$TS"
if [ -d "$DATA_DIR" ]; then
  mkdir -p "$SNAP"
  # 3.1 整树复制（保留相对路径/权限/时间戳；含 dotfile 盐值与 research 子目录）
  if ! cp -a "$DATA_DIR/." "$SNAP/"; then
    echo "[deploy] 备份复制失败：$DATA_DIR → $SNAP（未执行迁移）"
    exit 1
  fi
  # 3.2 剔除运行期瞬时文件（锁/指针/日志），还原时不得带回旧进程状态
  rm -f "$SNAP/.server-lock" "$SNAP/.watchdog.lock" "$SNAP/.zhibi.pid" 2>/dev/null
  rm -rf "$SNAP/logs" 2>/dev/null
  find "$SNAP" -type f -name '*.log' -delete 2>/dev/null
  # 3.3 逐项核验：源树（除运行期瞬时文件）与快照的文件清单必须完全一致
  #     （数量 + 相对路径逐一对应；缺一个/多一个都算备份失败）
  root_list=$(mktemp)
  snap_list=$(mktemp)
  ( cd "$DATA_DIR" && find . -type f ! -name '.server-lock' ! -name '.watchdog.lock' ! -name '.zhibi.pid' ! -name '*.log' ! -path './logs/*' | sort ) > "$root_list"
  ( cd "$SNAP" && find . -type f ! -name 'MANIFEST.txt' ! -name 'MANIFEST.sha256' ! -name 'COMMIT' | sort ) > "$snap_list"
  if ! diff -q "$root_list" "$snap_list" >/dev/null 2>&1; then
    echo "[deploy] 备份校验失败：快照文件清单与源目录不一致（未执行迁移）"
    diff "$root_list" "$snap_list" | head -20
    rm -f "$root_list" "$snap_list"
    exit 1
  fi
  rm -f "$root_list" "$snap_list"
  # 3.4 manifest：commit + 文件数量 + 总字节 + 逐文件 SHA-256
  echo "$HEAD_SHA" > "$SNAP/COMMIT"
  file_count=$(find "$SNAP" -type f ! -name 'MANIFEST.txt' ! -name 'MANIFEST.sha256' | wc -l | tr -d ' ')
  total_bytes=$(find "$SNAP" -type f ! -name 'MANIFEST.txt' ! -name 'MANIFEST.sha256' -exec cat {} + 2>/dev/null | wc -c | tr -d ' ')
  {
    echo "# 知彼测试服部署前备份 manifest"
    echo "# 时间: $(date -Iseconds)"
    echo "# 源目录: $DATA_DIR"
    echo "# commit: $HEAD_SHA"
    echo "# 文件数量: $file_count"
    echo "# 总字节: $total_bytes"
  } > "$SNAP/MANIFEST.txt"
  if ! ( cd "$SNAP" && find . -type f ! -name 'MANIFEST.sha256' -exec sha256sum {} + > MANIFEST.sha256 ); then
    echo "[deploy] 备份校验失败：SHA-256 manifest 生成中断（未执行迁移）"
    exit 1
  fi
  # 3.5 当场复核 manifest（任一文件哈希不符即中止）
  if ! ( cd "$SNAP" && sha256sum -c MANIFEST.sha256 >/dev/null 2>&1 ); then
    echo "[deploy] 备份校验失败：SHA-256 复核不一致（未执行迁移）"
    exit 1
  fi
  echo "[deploy] 数据库备份完成并校验通过：$SNAP"
  echo "[deploy] 备份文件 $file_count 个，共 $total_bytes 字节（manifest: MANIFEST.sha256）"
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
if [ -n "$START_CMD" ]; then sh -c "$START_CMD"; echo "[deploy] 服务已启动"; STARTED=1; else echo "[deploy] 未提供 START_CMD：请手动启动后端与前端后继续"; fi

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

# ---------- 9. 冒烟（正式部署必检；退出码 0=通过 1=失败 2=有未执行项，均判失败） ----------
STEP="9-smoke"
if [ "${SKIP_SMOKE:-0}" != "1" ]; then
  set +e
  if [ -n "${SMOKE_PROJECT_ID:-}" ]; then
    node "$APP_DIR/scripts/staging-smoke.js" --api "$API_BASE" --project "$SMOKE_PROJECT_ID"
  else
    node "$APP_DIR/scripts/staging-smoke.js" --api "$API_BASE"
  fi
  SMOKE_RC=$?
  set -e
  if [ "$SMOKE_RC" != "0" ]; then
    echo "[deploy] 冒烟未通过（退出码 $SMOKE_RC：0=通过 1=失败 2=有未执行项），部署判定失败"
    exit 1
  fi
else
  echo "[deploy] SKIP_SMOKE=1，跳过冒烟（仅排障用；正式部署不得跳过）"
fi

trap - EXIT
echo "[deploy] 部署完成：$HEAD_SHA"
