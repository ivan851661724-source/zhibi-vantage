#!/usr/bin/env bash
# 知彼 Vantage · 查看服务日志（滚动）
# 用法：bash scripts/logs.sh [行数]
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose logs -f --tail="${1:-100}"
