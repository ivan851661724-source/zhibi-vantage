#!/bin/sh
# 知彼 Vantage 容器入口：首次启动把预置配置/分类种子播种进数据卷。
# 数据卷为空（首次）→ 复制种子；数据卷已有 → 保持不动（不覆盖用户修改）。
set -e

mkdir -p /app/data

for f in config.json categories.json; do
  if [ ! -f "/app/data/$f" ] && [ -f "/app/config-seed/$f" ]; then
    cp "/app/config-seed/$f" "/app/data/$f"
    echo "[entrypoint] seeded /app/data/$f (first boot)"
  else
    echo "[entrypoint] /app/data/$f exists, skip seeding"
  fi
done

exec "$@"
