# 02 · API 契约（前端 ↔ 后端）

> 真相来源：`app/routes/index.js`（注册表）+ `app/services/api-tenant.js` / `api-admin.js`（独立挂载）。
> 本文档是前端 `web/src/lib/api.ts` 的实现依据。后端新增/修改端点必须同步更新本文档。

---

## 1. 通用约定

### 1.1 基础信息
- Base URL：同源 `/api/*`（Next.js rewrites 代理到后端 3300，见 01 §3）。
- Content-Type：`application/json`（除 SSE）。
- 字符编码：UTF-8；时间戳：毫秒 Unix epoch。

### 1.2 鉴权
| 方式 | 头 | 获取途径 | 适用 |
|---|---|---|---|
| 租户 JWT | `Authorization: Bearer <jwt>` | `POST /api/login` / `POST /api/register` | 绝大多数端点 |
| 平台超管 token | `Authorization: Bearer <adminToken>` | 管理员登录（api-admin） | 管理端点 |

- token 存储：`localStorage.zhibi_token`（兼容旧键 `ci_token`）。
- 401 处理：仅 `AUTH_REQUIRED` / `ADMIN_AUTH_REQUIRED` 清 token 跳登录（见 §1.3）。
- suspended 租户：入口层 `resolveIdentity` 统一拒绝（server.js L57-62）。

### 1.3 错误模型
```json
{ "error": "MACHINE_READABLE_CODE", "message": "人类可读说明" }
```
- HTTP 4xx/5xx 均返回此结构（如 `{"error":"EMPTY","message":"请填写 brand"}`）。
- **401 语义分两种**：`AUTH_REQUIRED` / `ADMIN_AUTH_REQUIRED` 为鉴权失败（前端清 token 跳登录）；其余 401（如 discover 的 `NO_KEYS`——密钥未配置）是**业务错误**，前端不得误杀会话。
- 前端约定：`Error.status` 携带 HTTP 状态码（对齐现有 `api()` 封装）。

### 1.4 访问级别
注册表三级：`public`（免鉴权）/ `tenant`（租户 JWT）/ `admin`（超管）。

---

## 2. 端点清单

### 2.1 账号（public）
| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/login` | 登录，返回 JWT |
| POST | `/api/register` | 注册（品牌/工作区名 + 邮箱 + 密码），创建租户 |

### 2.2 系统（public）
| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/healthz` | 容器健康检查 |
| GET | `/metrics` | Prometheus 文本格式指标 |
| GET | `/api/version` | 服务版本号 |

### 2.3 只读/派生（tenant）
| 方法 | 路径 | 用途 | 备注 |
|---|---|---|---|
| GET | `/api/state` | **核心**：整个调研档案（competitors/materials/opportunity/…） | 前端全局 state 唯一来源 |
| GET | `/api/domains` | 领域列表 | |
| GET | `/api/materials` | 材料流 | 支持 status/type 筛选 |
| GET | `/api/heroes` | 明星产品 | |
| GET | `/api/radar-changes` | 雷达变化事件 | |
| POST | `/api/quadrant` | 四象限计算 | |
| POST | `/api/compare` | 品牌对比 | |

### 2.4 采集/研究（tenant）—— 重操作，注意超时与配额
| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/stream` | **SSE** 变化推送（见 §3） |
| POST | `/api/discover` | 竞品发现（扇出搜索 + 两阶段 harvest，后台异步跑） |
| POST | `/api/enrich` | 单家深研 |
| POST | `/api/lookup` | 品牌探测 |
| POST | `/api/timeline` | 时间线回溯 |
| POST | `/api/brief` | 简报生成 |
| POST | `/api/deepdive` | 深度下钻 |
| POST | `/api/voice` | 社媒/评论采集（brand 必填；失败源静默） |
| POST | `/api/sector` | 赛道分析（聚合 + 空白 + 趋势） |

### 2.5 纠错/反馈（tenant）
| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/field-correct` | 字段纠错（进待复核队列） |
| POST | `/api/field-review` | 字段复核 |
| POST | `/api/field-correct/revoke` | 撤销纠错 |
| POST | `/api/intent` | 意图修正 |
| POST | `/api/exclude` | 排除竞品 |
| POST | `/api/feedback` | 通用反馈 |
| GET | `/api/feedback-report` | 反馈报表 |
| POST | `/api/rule-review` | 规则复核 |
| ALL | `/api/user-notes` | 私有笔记 CRUD |

### 2.6 度量层（tenant）
| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/snapshot` | 快照上报 |
| POST | `/api/consume` | 消耗记账 |
| POST | `/api/calibration` | 校准提交 |
| GET | `/api/calibration/summary` | 校准汇总 |
| POST | `/api/calibration/computation` | 校准计算 |
| POST | `/api/accuracy/sample` | 准确率抽样 |
| GET | `/api/accuracy/summary` | 准确率汇总（含字段门禁） |
| GET | `/api/north-star` | 北极星指标 |

### 2.7 配置/档案/报告（tenant）
| 方法 | 路径 | 用途 |
|---|---|---|
| GET / POST | `/api/config` | 读/写租户配置（密钥等） |
| POST | `/api/searchtest` | 搜索源连通测试 |
| POST | `/api/reset` | 重置当前档案 |
| GET | `/api/projects` | 调研档案列表 |
| POST | `/api/projects/switch` | 切换当前档案 |
| POST | `/api/projects/delete` | 删除档案 |
| POST | `/api/report` | 生成调研报告 |

### 2.8 数据自动化（tenant）
| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/tasks` | 后台任务状态 |
| GET | `/api/cost/summary` | 成本汇总（LLM/搜索归因） |
| GET | `/api/scheduler/status` | 定时雷达调度状态 |

### 2.9 租户/管理（api-tenant.js / api-admin.js 独立挂载）
账号、额度、租户管理、超管操作等，前缀同为 `/api/*`。**Next.js 迁移一期只搬用户侧面板，管理后台端点待三期对接**（清单在实施时从源码补录到本节）。

---

## 3. SSE 协议（`GET /api/stream`）

```
Content-Type: text/event-stream
retry: 3000          # 客户端断线重连间隔（ms）
: connected          # 注释行（心跳/连接确认）
: ping               # 每 25s 服务端心跳
data: {"type":"<事件类型>", ...payload}
```

前端行为契约（对齐现有 `startPolling`/`onSSEEvent`，app.js L639-656）：
1. 收到任意业务事件 → 触发 `onPush()`：拉 `/api/state` → 与本地 `state.sig` 签名比对 → 不同才替换并重渲染。
2. `discover_error` 等事件有**回放缓冲**（服务端缓存最近事件，晚连客户端补收，handlers/collect.js L22-29）。
3. 客户端断线由 EventSource 自动重连（`retry: 3000`）；重连成功后回放 + 签名比对保证不丢状态。

## 4. 已声明未实现的端点（迁移风险点）

`app/public/js/api.js`（ZB_API 契约层）声明了以下端点，**后端注册表中不存在**（经全文检索确认）：

| 端点 | 说明 |
|---|---|
| GET `/api/rivals`、`/api/rivals/:id` | 竞品雷达/情报库档案 |
| GET `/api/opportunities` | 机会视图 |
| POST `/api/materials/:id/action` | 三动作（kept/later/dropped） |
| POST `/api/corrections` | 纠错提交 |

这些数据目前实际由 `GET /api/state` 聚合下发（app.js 主链路），ZB_API 是 MOCK 模式下的设计稿契约。**Next.js 一期一律走 `/api/state`，不实现上述端点**；若二期要拆细粒度端点，先在本节登记再开发。

## 5. 契约变更流程

1. 后端改 `routes/index.js` → 同步更新本文档对应表格。
2. 前端 `web/src/types/` 中的 TS 类型随之调整，二者在同一 PR 内交付。
3. 破坏性变更（字段删除/语义变化）须在文档中追加"变更记录"小节，注明日期与影响面。
