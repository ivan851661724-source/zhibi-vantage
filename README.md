# 知彼 Vantage

竞品情报与市场调研平台 —— 多租户、零后端依赖、Docker 一键部署。

> 知彼 Vantage 聚合多源搜索与 LLM 能力，自动扇出发现竞品、逐家深研、抽取价格/渠道/品类/口碑等结构化字段，并推理行业空白机会，输出可落地的调研报告。

---

## ✨ 核心能力

- **发现引擎**：扇出搜索 → 两阶段 harvest → 后台逐家深研 → 空白推理 → 行业调研报告
- **字段裁决树**：价格 / 渠道 / 品类 / 口碑 / 标量字段的统一值级裁决与交叉验证
- **多租户**：账号 / 租户 / 额度 / 数据隔离 / 敏感字段脱敏
- **成本归因**：每次 LLM 与搜索调用按租户计量，配额可展示可拦截
- **搜索源容灾**：Serper → Brave → Bocha → Tavily 多源 failover 自动切换
- **LLM 网关**：超时 / 重试×2 / 熔断 / 字段级降级，三层缓存
- **密钥加密落盘**：`MT_MASTER_KEY` 主密钥保护配置中的 API 密钥（at rest 加密）
- **每日雷达**：定时扫描竞品动态，自动归档历史快照
- **实时前端**：SSE 推送研究进度，签名比对做增量状态更新

---

## 🏗️ 架构

```
┌──────────────┐   /api/* (rewrite)   ┌──────────────────┐
│  zhibi-web   │ ───────────────────▶ │  zhibi-vantage   │
│  Next.js 15  │                      │  零依赖 Node API │
│  :3000       │ ◀── SSE 实时进度 ──  │  :3300           │
└──────────────┘                      └────────┬─────────┘
                                               │
                              ┌────────────────┼────────────────┐
                              ▼                ▼                ▼
                         /app/data       多源搜索 API        LLM 提供商
                      (配置/档案/DB/日志)  (Serper/Brave/…)  (OpenAI/…)
```

- **后端**（`app/`）：纯 Node.js 内置模块，**零 npm 依赖**，无需 `npm install`
- **前端**（`web/`）：Next.js 15 + React 19 + TypeScript，运行时仅 `react` + `next`
- **部署**：Docker Compose 两个服务，数据通过命名卷 `zhibi_data` 持久化
- **前端 → 后端**：Next.js `rewrites` 把 `/api/*` 反代到后端，规避浏览器 CORS

---

## 🧱 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Node.js 22（零依赖，仅用内置模块） |
| 前端 | Next.js 15 · React 19 · TypeScript（strict） |
| 实时通信 | SSE（Server-Sent Events） |
| 状态管理 | 无第三方库，签名比对 + SSE 增量 |
| 部署 | Docker / Docker Compose |
| 数据持久化 | SQLite（`multitenant.db`、`research_tasks.db`）+ 文件档案 |

---

## 📁 项目结构

```
.
├── app/                      # 后端（零依赖 Node 服务）
│   ├── server.js             # 入口：HTTP 服务 + 路由分发
│   ├── routes/               # 声明式路由注册表 + handlers
│   │   ├── registry.js       # 路由注册/匹配/分发机制
│   │   └── handlers/         # 各端点处理（auth/read/correction/feedback/...）
│   ├── services/             # 业务服务
│   │   ├── auth.js           # 平台鉴权（JWT + 超管 token）
│   │   ├── api-tenant.js     # 租户 API
│   │   ├── api-admin.js      # 管理后台 API
│   │   ├── llm-gateway.js    # LLM 统一网关（重试/熔断/降级/缓存）
│   │   ├── providers/        # 搜索源封装（serper/tavily/brave/bocha）
│   │   ├── metering.js       # 成本计量
│   │   ├── scheduler.js      # 定时雷达扫描
│   │   ├── db.js             # SQLite 持久化
│   │   └── cache.js          # 缓存层
│   ├── lib/                  # 纯函数领域模块（可单测）
│   │   ├── pricefield.js     # 价格字段裁决树
│   │   ├── channelfield.js   # 渠道字段裁决树
│   │   ├── categoryfield.js  # 品类字段裁决树
│   │   ├── reviewfield.js    # 口碑字段裁决树
│   │   ├── secret.js         # 密钥加解密
│   │   ├── ipguard.js        # IP 封禁/白名单
│   │   └── ...               # 机会/空白/雷达/溯源等领域逻辑
│   ├── middleware/           # 租户上下文、输入消毒
│   └── data/                 # 运行时数据（不入库，见 .gitignore）
│
├── web/                      # 前端（Next.js 15）
│   ├── src/app/              # App Router 路由
│   │   ├── (panel)/          # 登录后面板组
│   │   │   ├── page.tsx      # 工作台（发现进度 + 材料流）
│   │   │   ├── assets/       # 竞品档案
│   │   │   ├── intel/        # 情报详情
│   │   │   ├── opportunity/  # 机会雷达
│   │   │   ├── radar/        # 动态雷达
│   │   │   ├── sector/       # 行业全景
│   │   │   ├── history/      # 历史快照
│   │   │   └── settings/     # 设置
│   │   └── login/            # 登录页
│   ├── src/components/       # 组件
│   ├── src/hooks/            # 自定义 Hook（use-zhibi-state / use-discover）
│   ├── src/lib/              # api.ts / sse.ts / wb.ts 等
│   └── public/               # 静态资源
│
├── config-seed/              # 首次启动播种的配置种子
├── docs/                     # 项目规范文档（唯一规范来源）
├── scripts/                  # 运维脚本（backup/deploy/logs）
├── docker-compose.yml        # 双服务编排
├── Dockerfile                # 后端镜像
├── web/Dockerfile            # 前端镜像
├── docker-entrypoint.sh      # 容器入口（播种配置 + 启动）
└── .env.example              # 环境变量模板
```

---

## 🚀 快速开始

### 方式一：Docker Compose（推荐）

```bash
# 1. 复制环境变量模板
cp .env.example .env

# 2.（强烈建议）生成主密钥用于加密 API 密钥
# openssl rand -hex 32  →  填入 .env 的 MT_MASTER_KEY

# 3. 构建并启动
docker compose up -d --build

# 4. 访问
# 前端：http://<服务器IP>:3000
# 健康检查：http://<服务器IP>:3000/login
```

首次启动会把 `config-seed/config.json` 播种到数据卷；后续重启不覆盖已有配置。

### 方式二：本地开发

**后端**（零依赖，直接跑）：

```bash
cd app
node server.js          # 监听 3300
```

**前端**：

```bash
cd web
pnpm install            # 或 npm install
pnpm dev                # http://localhost:3000
```

> 本地开发时前端通过 `next.config.ts` 的 `rewrites` 把 `/api/*` 代理到 `http://localhost:3300`，需确保后端已启动。

---

## ⚙️ 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MT_MASTER_KEY` | _(空)_ | API 密钥加密主密钥（`openssl rand -hex 32`）。设置后密钥以加密形式落盘，**丢失则无法解密** |
| `SCHEDULER_ENABLED` | `1` | 每日定时雷达扫描：`1` 开启 / `0` 关闭 |
| `ZB_QUOTA_ENABLED` | `0` | 配额硬拦截：`0` 仅展示不拦截 / `1` 超额拦截 |
| `PORT` | `3300` | 后端端口 |
| `WEB_PORT` | `3000` | 前端端口（Next.js） |
| `BACKEND_URL` | `http://zhibi-vantage:3300` | 前端反代后端地址（容器内网络） |

---

## 📚 文档

项目遵循 **先文档后实现** 原则，`docs/` 是唯一规范来源：

| 文档 | 作用 |
|---|---|
| [docs/01-前端架构规范.md](./docs/01-前端架构规范.md) | Next.js 前端技术选型、目录结构、编码约定 |
| [docs/02-API契约.md](./docs/02-API契约.md) | 前后端接口契约（端点、鉴权、SSE、错误模型） |
| [docs/03-迁移实施方案.md](./docs/03-迁移实施方案.md) | 原生 JS → Next.js 分阶段迁移与上线切换计划 |
| [README-阿里云部署.md](./README-阿里云部署.md) | 阿里云 ECS 部署实操说明 |

---

## 🔒 安全说明

- **密钥加密**：配置中的搜索源 / LLM 密钥由 `MT_MASTER_KEY` 加密存储，落盘不可见
- **多租户隔离**：请求级租户上下文（AsyncLocalStorage）+ 数据按租户隔离
- **IP 管控**：支持封禁与白名单
- **非 root 运行**：容器以 `node` 用户启动
- **不入库的敏感数据**：`.gitignore` 已排除 `app/data/`（含密钥、数据库、日志）

---

## 📄 License

Private.
