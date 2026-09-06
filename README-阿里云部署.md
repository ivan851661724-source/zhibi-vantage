# 知彼 Vantage · 阿里云 ECS Docker 部署包

零依赖 Node 后端 + Next.js 前端双容器编排，一条命令起服务，数据自动持久化，崩溃自动重启。

**入口**：`http://<ip>:3000`（Next.js 前端，`/api/*` 反代到后端容器；唯一 Web 入口——Phase 5 后旧静态前端已删除，3300 不再对外暴露）。

---

## 一、包内容

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 后端镜像定义（node:22-alpine，零 npm 依赖，极小） |
| `web/Dockerfile` | 前端镜像定义（multi-stage + `output: 'standalone'`，运行态仅 standalone 产物） |
| `docker-compose.yml` | 编排：双服务（zhibi-vantage 后端 + zhibi-web 前端）/ 端口映射 / 数据卷 / 健康检查 / 自动重启 |
| `docker-entrypoint.sh` | 首次启动自动把配置（含 API 密钥）写入数据卷 |
| `config-seed/config.json` | 部署配置种子（内含你的 DeepSeek / Serper 密钥） |
| `app/` | 后端源码（server.js + lib/services/routes/middleware/public） |
| `web/` | 前端源码（Next.js 15 + TypeScript，规范见 docs/） |
| `.env.example` | 环境变量模板（复制为 `.env` 使用） |
| `scripts/deploy.sh` | 一键部署（构建 + 启动 + 双服务健康检查） |
| `scripts/backup.sh` | 备份数据卷到 `backups/` |
| `scripts/logs.sh` | 滚动查看日志 |

---

## 二、前置条件

- **一台阿里云 ECS**：建议 2 核 2G 起（本服务极轻）；操作系统 CentOS/Ubuntu/Alibaba Cloud Linux 均可。
- **安装 Docker**（如未安装）：
  ```bash
  curl -fsSL https://get.docker.com | bash -s docker
  sudo systemctl enable --now docker
  ```

---

## 三、快速部署（推荐：ECS 上直接构建）

1. **上传包到 ECS**（任选）：
   - 控制台：把整个 `zhibi-vantage-docker` 目录压缩上传，`unzip` 解压；
   - 或本机执行：`scp -r zhibi-vantage-docker root@<ECS公网IP>:/opt/`

2. **进入目录并部署**：
   ```bash
   cd /opt/zhibi-vantage-docker
   cp .env.example .env     # 建议在 .env 里设置 MT_MASTER_KEY（见第五节）
   bash scripts/deploy.sh
   ```

3. **放行安全组端口**（必做，否则外网打不开）：
   - 阿里云控制台 → ECS → 安全组 → 配置规则 → 入方向：
     - 协议 TCP，端口 `3000`，源 `0.0.0.0/0`（或你的办公网 IP，更安全）

4. **访问**：浏览器打开 `http://<ECS公网IP>:3000`

> 首次启动会自动把 `config-seed/config.json`（含你的密钥）写进数据卷，之后修改密钥请在页面"设置"里操作，容器重启不会覆盖。

---

## 四、备选：本机构建后导入（无网/慢网 ECS 场景）

1. 本机（已装 Docker）在包目录执行：
   ```bash
   docker compose build
   docker save zhibi-vantage:1.4.0 zhibi-web:0.1.0 | gzip > zhibi-vantage-images.tar.gz
   ```
2. 上传 tar 到 ECS，执行：
   ```bash
   docker load < zhibi-vantage-images.tar.gz
   cd /opt/zhibi-vantage-docker && bash scripts/deploy.sh
   ```
   （`deploy.sh` 里 `up -d --build` 会直接复用已加载的镜像。）

---

## 五、环境变量说明（`.env`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `MT_MASTER_KEY` | 空 | **强烈建议设置**。设置后 API 密钥以加密形式落盘。生成：`openssl rand -hex 32`。⚠️ 一旦使用，请妥善保存——丢失将无法解密已加密的密钥 |
| `PORT` | 3300 | 服务端口（一般不用改） |
| `SCHEDULER_ENABLED` | 1 | 每日定时雷达扫描（0 关闭） |
| `ZB_QUOTA_ENABLED` | 0 | 配额硬拦截（默认仅展示不拦截） |

---

## 六、数据持久化与备份

- **数据都在 Docker 命名卷 `zhibi_data`**（映射容器内 `/app/data`）：档案、配置、数据库、日志。
- **容器删除/重建不丢数据**；只有显式 `docker volume rm zhibi_data` 才会清空。
- **定期备份**（建议每日，可加 crontab）：
  ```bash
  bash scripts/backup.sh          # 生成 backups/zhibi-data-<时间戳>.tar.gz
  ```
- 恢复：
  ```bash
  docker run --rm -v zhibi_data:/data -v $(pwd)/backups:/backup \
    alpine tar xzf /backup/zhibi-data-<时间戳>.tar.gz -C /data
  ```

---

## 七、升级与运维

```bash
# 看日志
bash scripts/logs.sh

# 升级（拉新代码后重新构建）
docker compose up -d --build

# 重启 / 停止
docker compose restart
docker compose down            # 停止并删除容器（数据卷保留）

# 查看状态
docker compose ps
docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Health}}"
```

---

## 八、常见问题（FAQ）

**Q1：外网打不开？**
先确认：① 安全组已放行 3000；② `curl http://127.0.0.1:3000/login` 返回 200；③ `curl http://127.0.0.1:3000/healthz` 返回 200（后端经代理）；④ ECS 用的是按量公网 IP/已绑定弹性 IP。

**Q2：容器起来了但 health 一直 starting/unhealthy？**
`bash scripts/logs.sh`（后端）或 `docker compose logs zhibi-web`（前端）看报错。后端常见：`MT_MASTER_KEY` 与已加密配置不匹配（改回原密钥或清空数据卷中的 config.json 重新播种）。前端常见：构建期网络问题导致 `pnpm install` 失败——重跑 `docker compose build zhibi-web`。

**Q3：换 API 密钥怎么改？**
页面「设置」里直接改（推荐）；或停止容器后编辑数据卷中的 `data/config.json` 再启动。

**Q4：怎么设域名 + HTTPS？**
ECS 装 Nginx 反代：`80/443 → 127.0.0.1:3000`，用 certbot 签免费证书；安全组放行 80/443 即可，3000 可仅对内。

---

## 九、安全提醒

- **包内含真实 API 密钥**（`config-seed/config.json`），请勿公开分享或提交到公开仓库。
- 生产环境建议：设 `MT_MASTER_KEY` 加密密钥、安全组限制来源 IP、定期备份 `zhibi_data`。
- 镜像以非 root 用户（`node`）运行，唯一对外端口 3000（后端 3300 仅容器网络内可达）。
