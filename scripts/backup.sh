#!/usr/bin/env bash
# 知彼 Vantage · 备份数据卷（配置/档案/数据库/日志）到 ./backups/
# 用法：bash scripts/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

TS=$(date +%Y%m%d-%H%M%S)
mkdir -p backups

docker run --rm \
  -v zhibi_data:/data:ro \
  -v "$(pwd)/backups":/backup \
  alpine tar czf "/backup/zhibi-data-${TS}.tar.gz" -C /data .

echo "✓ 备份完成：backups/zhibi-data-${TS}.tar.gz"
echo "  建议定期执行（可加入 crontab：0 3 * * * bash $(pwd)/scripts/backup.sh）"
