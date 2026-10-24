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
SMOKE_PROJECT_ID=<测试项目 id> \
sh scripts/deploy-staging.sh <目标 commit SHA>
```

脚本按序执行，**任一步失败立即停止并打印失败步骤**：
`0-env → 1-commit → 2-stop → 3-backup → 4-install → 5-migrate → 6-build → 7-start → 8-health → 9-smoke`。

## 2. 分步执行（排障时）

```bash
# 2.1 数据库备份（部署前必做）
TS=$(date +%Y%m%d-%H%M%S); mkdir -p /srv/zhibi/backups/$TS
sudo systemctl stop zhibi-backend zhibi-web
cp -a /srv/zhibi/data/*.db /srv/zhibi/data/*.json /srv/zhibi/backups/$TS/ 2>/dev/null
git -C /srv/zhibi/app rev-parse HEAD > /srv/zhibi/backups/$TS/COMMIT

# 2.2 加法迁移（只 CREATE/ADD COLUMN，不 DROP、不改历史行，幂等）
ZB_DATA_DIR=/srv/zhibi/data node scripts/migrate-db.js
ZB_DATA_DIR=/srv/zhibi/data node scripts/migrate-db.js --check   # 只核验

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

# 3.2 停服 → 还原数据库（加法迁移向后兼容，通常不必还原；
#     只有当新版本写入了旧版本读不懂的数据时才需要）
sudo systemctl stop zhibi-backend zhibi-web
cp -a /srv/zhibi/backups/<TS>/*.db /srv/zhibi/data/
cp -a /srv/zhibi/backups/<TS>/*.json /srv/zhibi/data/ 2>/dev/null

# 3.3 重建前端并启动
cd /srv/zhibi/app/web && npx next build
sudo systemctl start zhibi-backend zhibi-web
curl -fsS http://127.0.0.1:3300/healthz
```

> ⚠️ 前端 rewrites 的 `BACKEND_URL` 在 **build 时固化**进 `routes-manifest.json`：换后端端口必须重新 `next build`，否则前端仍指向旧端口。

## 4. 冒烟判定

`scripts/staging-smoke.js` 退出码：`0` 全通过 / `1` 有失败 / `2` 有未执行项（打印 `SKIP`，不用"通过"掩盖）。
结果落 `.workbuddy/artifacts/staging-smoke-result.json`。

## 5. 测试项目准备（无 HTTP 建项目接口）

项目由调研流程创建，冒烟需要一个已存在的测试项目：

```bash
ZB_DATA_DIR=/srv/zhibi/data node -e "
const db=require('/srv/zhibi/app/app/services/db.js');
const fs=require('fs');
const {projFile}=require('/srv/zhibi/app/app/core/state-store.js');
const tid='<tenantId>', pid='projSmoke';
db.saveProject({id:pid,tenantId:tid,track:'T',competitors:'[]',createdAt:new Date().toISOString(),discoveredAt:new Date().toISOString()});
const f=projFile(pid,tid); fs.mkdirSync(require('path').dirname(f),{recursive:true});
fs.writeFileSync(f,JSON.stringify({tenantId:tid,projectId:pid,intent:{regions:['us']},excluded:[],competitors:[
 {id:'c-smoke-1',name:'Grovemade',url:'https://grovemade.com/',status:'done',isShopify:false,market:'us'}
],discoverDone:true,progress:{total:1,done:1}},null,2));
console.log('project ready', pid);
"
```

## 6. 密钥纪律

- 只从运行环境或 gitignored 配置读取（`.env` 已在 `.gitignore`）；
- 部署脚本只打印"已配置 / 未配置"，不打印值；
- 日志、URL、报告、截图不得携带密钥（快照落库前经 `app/lib/url-redact.js` 脱敏）。
