#!/bin/sh
# 知彼 Vantage 容器入口：首次启动把预置配置（含 API 密钥）播种进数据卷。
# 数据卷为空（首次）→ 复制种子配置；数据卷已有配置 → 保持不动（不覆盖用户修改）。
set -e

if [ ! -f /app/data/config.json ]; then
  cp /app/config-seed/config.json /app/data/config.json
  echo "[entrypoint] seeded config.json into /app/data (first boot)"
else
  echo "[entrypoint] /app/data/config.json exists, skip seeding"
fi

exec "$@"
