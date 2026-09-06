# 知彼 Vantage · 零依赖 Node 服务 —— Aliyun ECS Docker 镜像
# 特点：无 npm 依赖，镜像极简；数据全部落在 /app/data（挂载命名卷持久化）

FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3300 \
    TZ=Asia/Shanghai

WORKDIR /app

# 零依赖：无需 package.json 安装，直接拷贝源码
# Phase 5：app/public（旧静态前端）已删除，不再 COPY
COPY app/package.json ./
COPY app/server.js ./
COPY app/lib ./lib
COPY app/services ./services
COPY app/routes ./routes
COPY app/middleware ./middleware
COPY app/scripts ./scripts

# 预置配置种子（含 API 密钥；首次启动由 entrypoint 播种进数据卷，已存在则跳过）
COPY config-seed /app/config-seed
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/data \
    && chown -R node:node /app

# 以非 root 用户运行（更安全）
USER node

EXPOSE 3300

# 健康检查：探活 /healthz，Docker 据此自动重启故障实例
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3300)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
