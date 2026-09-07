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
│   ├── server.js             # 薄入口：HTTP 服务 + 边界闸（ipguard→限流→鉴权门）+ 路由组装
│   ├── core/                 # 基础设施层
│   │   ├── paths.js          # 数据目录唯一来源（ZB_DATA_DIR 可覆盖，隔离测试用）
│   │   ├── als.js            # 请求级租户上下文（AsyncLocalStorage）
│   │   ├── sse-hub.js        # SSE 枢纽：按租户分通道 + 回放 + 连接上限
│   │   ├── http-gate.js      # 身份解析（含 SSE ?token=）/客户端 IP/限流/研究并发闸
│   │   ├── config.js         # 配置加载/保存 + 密钥加密落盘
│   │   ├── state-store.js    # 研究档案持久化（租户命名空间 + 原子写 + 迁移）
│   │   └── version.js        # 版本锚定
│   ├── research/             # 研究链路（按功能拆分，可单测）
│   │   ├── search.js         # 搜索编排：多源 failover + 融合 + 缓存 + 计量
│   │   ├── llm.js            # LLM 封装（经 llm-gateway）
│   │   ├── net.js            # 抓取层（SSRF 防护：私网/元数据地址黑名单）
│   │   ├── evidence.js       # 来源分级 / 置信推导 / 归属裁决
│   │   ├── vocab.js          # 维度词表 + 平台集解析
│   │   ├── candidates.js     # 候选合并/交叉验证/排名/反馈规则
│   │   ├── discover.js       # 发现引擎（扇出 + 两阶段 harvest）
│   │   ├── enrich.js         # 深研队列 + 全字段抽取（tasks 心跳续租）
│   │   ├── deepdive.js       # L2 单字段深挖
│   │   ├── whitespace.js     # 空白推理引擎
│   │   ├── fields.js         # 字段契约（价格/渠道/品类/节奏/口碑）+ 对比表
│   │   ├── report.js         # 行业调研报告装配 + 机器校验
│   │   ├── sweep.js          # 定时增量雷达
│   │   └── decorate/...      # 派生视图 / 纠错 / attempt 日志
│   ├── routes/               # 声明式路由注册表 + handlers（ctx 依赖注入）
│   ├── services/             # 业务服务（auth/tenant/db/llm-gateway/metering/...）
│   ├── lib/                  # 纯函数领域模块（裁决树/算子，可单测）
│   ├── middleware/           # 租户身份解析、输出消毒
│   └── data/                 # 运行时数据（不入库，见 .gitignore）
│
├── web/                      # 前端（Next.js 15）
│   ├── src/app/              # App Router 路由（(panel)/ 面板组 + login）
│   ├── src/components/       # 组件
│   ├── src/hooks/            # use-zhibi-state（SSE + 签名比对 + 并发去重）
│   ├── src/lib/              # api.ts 契约层 / sse.ts（令牌经查询串）/ wb.ts
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
| `LLM_BASE_URL` | DeepSeek 官方 | LLM 接入点（OpenAI 兼容 `/v1` 基地址或完整 `/chat/completions` 端点均可，自动归一化）。例：阿里云百炼 Token Plan `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`（专属 key 必须配专属基地址，dashscope 通用地址不抵扣套餐额度） |
| `LLM_MODEL` | `deepseek-v4-flash` | 默认模型名（须为所选接入点支持的模型） |
| `LLM_API_KEY` | _(空)_ | LLM key 兜底（平台「设置」页配置的 key 优先于此处） |
| `MT_ADMIN_SECRET` | _(自动生成)_ | 平台超管密钥；不设则首次启动生成 `data/.admin-secret` |
| `SCHEDULER_ENABLED` | `1` | 每日定时雷达扫描：`1` 开启 / `0` 关闭 |
| `ZB_QUOTA_ENABLED` | `0` | 配额硬拦截：`0` 仅展示不拦截 / `1` 超额拦截 |
| `ZB_DEMO_ALLOWED` | `0` | 演示模式闸门：`1` 时允许 `?demo=1` 直进工作台（生产勿开） |
| `ZB_TRUSTED_PROXIES` | `1` | 后端前置可信代理层数（XFF 从右往左解析；直连部署设 `0`） |
| `PORT` | `3300` | 后端端口 |
| `WEB_PORT` | `3000` | 前端端口（宿主机映射；容器内固定 3000） |
| `BACKEND_URL` | `http://zhibi-vantage:3300` | 前端反代后端地址（**构建期固化**进 rewrites，运行时改无效） |
| `ZB_FREE_DAILY_DISCOVERS` | `3` | R5：每租户每日全景调研次数（免费档防滥用上限） |
| `ZB_DAILY_QUOTA_ENABLED` | `1` | R5：每日调研配额总开关（`0` 关闭） |
| `ZB_MAIL_API_URL` 等 | _(空)_ | R4：邮件 HTTP API（URL/KEY/FROM 三个变量）；未配置则每日摘要静默跳过 |
| `DIGEST_HOUR` | `8` | R4：每日摘要发送时刻（0-23） |
| `ZB_LOG_RETENTION_DAYS` | `14` | 日志保留天数（自动清理过期日志文件） |

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
- **鉴权 fail-closed**：密钥文件不可读写时拒绝签发/验签（绝不回退可预测密钥）
- **多租户隔离**：请求级租户上下文（AsyncLocalStorage）+ 数据按租户隔离 + **SSE 事件按租户分通道**（`/api/stream?token=` 查询串鉴权）
- **边界闸次序**：ipguard → 限流（登录端点独立 10 次/分）→ 鉴权门，登录/注册不再绕过限流
- **SSRF 防护**：对外抓取逐跳校验目标 IP（私网/环回/链路本地/云元数据段全拒）
- **外部调用有界**：全部搜索/LLM/抓取调用带超时；LLM 熔断按 key 分桶，单失效 key 不拖垮全租户
- **IP 管控**：支持封禁与白名单；`ZB_TRUSTED_PROXIES` 控制 XFF 可信解析（防伪造绕过限流）
- **非 root 运行**：两个容器均以 `node` 用户启动
- **不入库的敏感数据**：`.gitignore` 已排除 `app/data/`（含密钥、数据库、日志）
- **前端安全头**：CSP / XFO / nosniff / Referrer-Policy 全站注入

---

## 📄 License

Private.
