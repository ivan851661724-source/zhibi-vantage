# 测试服部署与回滚手册（SC-10）

> 本文是**运维执行清单**，不含任何密钥。密钥只存在于测试服运行环境（systemd `Environment=` 或 gitignored 的 `.env`），禁止写进仓库、脚本参数、日志与 URL。

## 0. 前置条件

| 项 | 要求 | 核验 |
|---|---|---|
| Node | ≥ 22（依赖 `node:sqlite`） | `node -v` |
| 应用目录 | `$APP_DIR`（默认 `/srv/zhibi/app`） | `git -C $APP_DIR rev-parse HEAD` |
| 数据目录 | `$DATA_DIR`（默认 `/srv/zhibi/data`） | `ls $DATA_DIR/*.db` |
| 服务管理 | systemd（或等价）提供 stop/start | `systemctl status zhibi-backend` |
| 网络 | 后端 `:3300`、前端 `:3000` | `curl -fsS http://127.0.0.1:3300/healthz` |

密钥（缺失时对应来源会**如实显示 not_configured**，不得手工改成"暂无数据"）：
`SERPER_API_KEY`、`YOUTUBE_API_KEY`、`DATAFORSEO_LOGIN`、`DATAFORSEO_PASSWORD`、`TIKTOK_CLIENT_KEY`、`TIKTOK_CLIENT_SECRET`、`LLM_API_KEY`、`MT_MASTER_KEY`。

## 1. 部署（一步到位）

```bash
cd /srv/zhibi/app
git fetch origin
git checkout <目标 commit SHA>          # 例如 1c459cba2dc0ab1aaf04e743f7b03977a18ef4a6

APP_DIR=/srv/zhibi/app \
DATA_DIR=/srv/zhibi/data \
BACKUP_DIR=/srv/zhibi/backups \
STOP_CMD="sudo systemctl stop zhibi-backend zhibi-web" \
START_CMD="sudo systemctl start zhibi-backend zhibi-web" \
SMOKE_EMAIL=<冒烟账号邮箱> \
SMOKE_PASSWORD=<冒烟账号密码> \
SMOKE_PROJECT_ID=<测试项目 id（须与冒烟账号同租户；留空则走真实 HTTP 调研流程创建）> \
sh scripts/deploy-staging.sh <目标 commit SHA>
```

脚本按序执行，**任一步失败立即停止并打印失败步骤**；服务已停止而部署未完成时，会自动尽力重新启动服务（测试服不会静默停机）：
`0-env → 1-commit → 2-stop → 3-backup → 4-install → 5-migrate → 6-build → 7-start → 8-health → 9-smoke`。

其中 `3-backup` 为整树备份（`*.db` / `*.db-wal` / `*.db-shm` / `*.json` / 盐值 / `research/` 调研档案），
生成文件数量、总大小与逐文件 SHA-256 manifest 并当场复核——**任一文件复制或校验失败即中止，绝不进入迁移与构建**。

## 2. 分步执行（排障时）

```bash
# 2.1 数据库备份（部署前必做；整树 + manifest + SHA-256 复核）
TS=$(date +%Y%m%d-%H%M%S); mkdir -p /srv/zhibi/backups/$TS
sudo systemctl stop zhibi-backend zhibi-web
cp -a /srv/zhibi/data/. /srv/zhibi/backups/$TS/
rm -f /srv/zhibi/backups/$TS/.server-lock /srv/zhibi/backups/$TS/.watchdog.lock /srv/zhibi/backups/$TS/.zhibi.pid
git -C /srv/zhibi/app rev-parse HEAD > /srv/zhibi/backups/$TS/COMMIT
( cd /srv/zhibi/backups/$TS && find . -type f ! -name MANIFEST.sha256 -print | sort | xargs sha256sum > MANIFEST.sha256 )
( cd /srv/zhibi/backups/$TS && sha256sum -c MANIFEST.sha256 )   # 任一失败都不得继续部署

# 2.2 加法迁移（只 CREATE/ADD COLUMN，不 DROP、不改历史行，幂等）
ZB_DATA_DIR=/srv/zhibi/data node scripts/migrate-db.js
# 只读核验：不 mkdir、不 require 业务模块、不调写入入口、不改任何 DB/WAL/SHM；
# 前后对数据目录全部文件做 清单/大小/mtime/SHA-256 比对，任一变化即失败
ZB_DATA_DIR=/srv/zhibi/data node scripts/migrate-db.js --check

# 2.3 前端构建
cd /srv/zhibi/app/web && npm ci --no-audit --no-fund && npx next build

# 2.4 启动与健康检查
sudo systemctl start zhibi-backend zhibi-web
curl -fsS http://127.0.0.1:3300/healthz

# 2.5 冒烟
RESTART_CMD="sudo systemctl restart zhibi-backend zhibi-web" \
  node scripts/staging-smoke.js --api http://127.0.0.1:3300 --project <测试项目 id>
```

## 3. 回滚

```bash
# 3.1 回滚代码到备份时记录的 commit
TARGET=$(cat /srv/zhibi/backups/<TS>/COMMIT)
cd /srv/zhibi/app && git checkout $TARGET

# 3.2 停服 → 还原数据（整树还原：*.db / *.db-wal / *.db-shm / *.json / 盐值 / research 档案；
#     加法迁移向后兼容，通常不必还原；只有新版本写入了旧版本读不懂的数据时才需要）
sudo systemctl stop zhibi-backend zhibi-web
cp -a /srv/zhibi/backups/<TS>/. /srv/zhibi/data/
# 还原后核对：文件数量与 SHA-256 应与备份 manifest 一致
( cd /srv/zhibi/backups/<TS> && sha256sum -c MANIFEST.sha256 )

# 3.3 重建前端并启动
cd /srv/zhibi/app/web && npx next build
sudo systemctl start zhibi-backend zhibi-web
curl -fsS http://127.0.0.1:3300/healthz
```

> ⚠️ 前端 rewrites 的 `BACKEND_URL` 在 **build 时固化**进 `routes-manifest.json`：换后端端口必须重新 `next build`，否则前端仍指向旧端口。

## 4. 冒烟判定

`scripts/staging-smoke.js` 退出码：`0` 全通过 / `1` 有失败 / `2` 有未执行项（打印 `SKIP`，不用"通过"掩盖）。
正式部署验收下**没有任何允许 SKIP 的项**：账号与项目不同租户、未提供 `RESTART_CMD`、Evidence ID 无法从真实 API 解析，一律判失败。
结果落 `.workbuddy/artifacts/staging-smoke-result.json`。

## 5. 冒烟账号与测试项目准备（只走真实 HTTP）

冒烟脚本 `scripts/staging-smoke.js` **只走 HTTP，不碰数据库**。账号与项目必须属于**同一租户**：

```bash
# 方式 A（推荐）：显式指定已存在的测试项目
SMOKE_EMAIL=smoke@example.com \
SMOKE_PASSWORD='<密码>' \
SMOKE_PROJECT_ID=<测试项目 id> \
RESTART_CMD="sudo systemctl restart zhibi-backend zhibi-web" \
  node scripts/staging-smoke.js --api http://127.0.0.1:3300 --project <测试项目 id>

# 方式 B：不指定项目 —— 冒烟脚本必须通过真实调研流程（POST /api/discover）创建项目。
# 前置：服务端已配置 SERPER_API_KEY 与 LLM_API_KEY（未配置时创建失败即冒烟失败，
# 绝不用"直接写库造一个项目"来伪装用户链路通过）。
RESTART_CMD="sudo systemctl restart zhibi-backend zhibi-web" \
  node scripts/staging-smoke.js --api http://127.0.0.1:3300
```

判定规则（正式部署验收，全部必检，**不得 SKIP**）：

| 项 | 通过条件 | 失败条件（示例） |
|---|---|---|
| 账号与项目同租户 | `GET /api/brands?projectId=…` 返回 200 | 403 / 404 / 其他 → 立即失败 |
| 项目创建（未指定时） | `POST /api/discover` 返回 202 且在超时内产出竞品 | 401 NO_KEYS / 超时无竞品 → 失败 |
| 跨租户隔离 | B 租户访问 A 项目返回 **403 或 404** | **200（含空列表）= 隔离失效，必须失败** |
| 证据入口 | Evidence ID 从品牌详情 API 的 `evidenceRefs` 真实解析，`/api/evidence-detail` 返回 200 | 解析不到 / 打不开 → 失败（不得人工传入 Evidence ID） |
| 服务重启 | 提供 `RESTART_CMD`，重启后 `/healthz` 200 且品牌数不变 | 未提供 RESTART_CMD → 失败（部署验收必检项） |

> ⚠️ 历史版本手册曾给出「给某租户直接写项目、再用随机新租户冒烟」的流程——该流程**已作废**：
> 它既伪造了用户链路（项目不是用户旅程创建的），又让「账号与项目不同租户」的隔离缺口被空列表蒙混过关。
> 测试环境准备项目请走方式 A 的负责人口径（由该租户 owner 在 UI/HTTP 调研流程创建），冒烟脚本本身严禁写库。

## 6. 密钥纪律

- 只从运行环境或 gitignored 配置读取（`.env` 已在 `.gitignore`）；
- 部署脚本只打印"已配置 / 未配置"，不打印值；
- 日志、URL、报告、截图不得携带密钥（快照落库前经 `app/lib/url-redact.js` 脱敏）。
