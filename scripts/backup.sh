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

# 保留策略：只留最近 KEEP_BACKUPS 份，超出按时间删旧（数据卷约数百 MB/份，
# 无保留上限的话每日 crontab 会无限吃磁盘）
KEEP_BACKUPS=14
ls -1t backups/zhibi-data-*.tar.gz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f || true
echo "  已保留最近 ${KEEP_BACKUPS} 份备份（共 $(du -sh backups 2>/dev/null | cut -f1)）"
echo "  建议定期执行（可加入 crontab：0 3 * * * bash $(pwd)/scripts/backup.sh）"
