#!/bin/bash
# cron 入口（快照执行）：把 deploy-cron.sh 复制到临时文件后运行，运行中脚本不被
# git reset --hard 原地覆盖——bash 按字节偏移续读脚本，部署中脚本文件被重写会导致
# 后续命令在错误偏移处解析错乱（回滚机制可兜底，但不应依赖）。
# 仓库 scripts/deploy-cron.sh 由此成为唯一的部署脚本源：每次 git reset 后 cron 下一分钟
# 自动运行新版，无需手工同步服务器侧副本。
# 安装（服务器一次性）：install -m 755 scripts/deploy-boot.sh /opt/zhibi-vantage/deploy-boot.sh
# /etc/cron.d/zhibi-deploy 目标指向 /opt/zhibi-vantage/deploy-boot.sh。
set -u
SNAP=$(mktemp /tmp/zhibi-deploy-run.XXXXXX)
trap 'rm -f "$SNAP"' EXIT
cp /opt/zhibi-vantage/scripts/deploy-cron.sh "$SNAP"
bash "$SNAP" "$@"
