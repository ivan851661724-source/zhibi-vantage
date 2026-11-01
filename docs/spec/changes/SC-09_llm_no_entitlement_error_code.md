# SC-09 · LLM 错误码细分：`LLM_NO_ENTITLEMENT`（品牌发现 r4）

**状态**：已实现（随 `review/brand-discovery-llm-resilience-r4` 分支，未合并 main）
**日期**：2026-11-01
**上位依赖**：03 v0.3（后端 API 契约）、05（数据与错误口径）、SC-07（运行/尝试/状态口径）、SC-08（读态投影）
**服从关系**：本变更只**新增一个错误码**并调整归类条件，不改任何事实、证据、事件、判断语义，不改接口形状。

---

## 1. 问题

RL-01 把供应商中性错误码收敛为六类，其中：

```
LLM_AUTH_REJECTED   401/403 —— key 无效 / 未获模型授权
```

实测（2026-11-01，阿里云百炼 Token Plan）：

| 场景 | HTTP | 供应商错误体 |
|---|---|---|
| Key 本身失效 | 401 | `invalid_api_key` |
| Key 有效但账号未购买模型 | **403** | `AccessDenied.Unpurchased`（"not eligible for using the model"） |

两者被折叠成同一码，导致运维与用户都无法判断该做什么：换 Key，还是去控制台开通额度。实测中这一折叠直接造成两轮误判（先归因到"模型名写错"，再归因到"Key 失效"）。

## 2. 变更内容

### 2.1 新增错误码

```
LLM_NO_ENTITLEMENT   403 且错误体明确表达未购买/无资格（AccessDenied.Unpurchased 等）
```

用户文案：`品牌识别服务未开通：当前账号没有可用的模型额度`

### 2.2 归类条件（保守原则）

仅当 **HTTP 403** 且 **错误体**命中以下语义时归 `LLM_NO_ENTITLEMENT`：

```
/Unpurchased|not\s+eligible\s+for\s+using|未开通|未购买/i
```

其余情况一律保持既有归类，**不得放宽**：

| 输入 | 归类 |
|---|---|
| 401（任意错误体） | `LLM_AUTH_REJECTED`（保持） |
| 403 + 无未购买语义 / 空错误体 | `LLM_AUTH_REJECTED`（保持，宁可保守也不把越权误报成未购买） |
| 404，或 400 + 错误体指向模型名 | `LLM_MODEL_UNAVAILABLE`（保持） |
| 429 / 408 / 5xx | `LLM_RATE_LIMITED` / `LLM_TIMEOUT` / `LLM_PROVIDER_UNAVAILABLE`（保持） |

### 2.3 重试语义

`LLM_NO_ENTITLEMENT` 属确定性失败，**不重试、不进熔断计数**（与 `LLM_AUTH_REJECTED` 一致）。

### 2.4 载荷纪律（不变）

错误体仅用于归类，归类后立即丢弃；`LLMError` 的 `message`/`userMessage`/`status` 不得携带 Key、Authorization、供应商原始正文或带敏感参数的 URL。

### 2.5 受影响契约

| 位置 | 变化 |
|---|---|
| `app/services/llm-gateway.js` | 新增码 + 归类条件；`LLM_ERROR_MESSAGES` 增一条 |
| `app/research/discover.js` | `discoverUserMessage` 增文案分支；`discoverError.errorCode` 可能出现新值 |
| `web/src/hooks/use-discover.ts` | 前端兜底文案表增一条 |
| `app/services/llm-health.js` | 无需改代码（复用 `classifyLlmStatus`），`errorClass` 可能出现新值 |
| `GET /api/llm-health`、`POST /api/discover`（202/SSE）、`/api/discover/status` | **响应形状不变**；仅 `errorClass` / `errorCode` 的取值域扩大一项 |

## 3. 兼容性

- 既有调用方按 `code` 做 switch 且有 `default` 分支：落到默认文案，不崩。
- 既有测试桩的 403 返回体为 `{"error":"forbidden"}`，不命中未购买语义 → 仍归 `LLM_AUTH_REJECTED`，旧断言全部保持。
- 不回填历史档案中的旧错误码：历史记录保持原值，仅对新生效的运行使用新码（不做破坏性改写）。

## 4. 测试

`app/test/llm-entitlement.test.js`（12 项）：归类矩阵、保守不误判、不可重试、只发一次请求、零密钥泄漏、零供应商正文泄漏、三处文案表一致性。

## 5. 未覆盖 / 后续

- 供应商若用其它措辞表达「未购买」（如 `quota_exhausted`、`billing_required`），需按实测补充正则；当前只覆盖已观测到的措辞。
- 错误码仍不区分「账户级额度用尽」与「模型级未开通」，两者都归 `LLM_NO_ENTITLEMENT`；如需细分另开变更。
