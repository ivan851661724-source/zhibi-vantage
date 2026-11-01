# SC-07 · 品牌识别的「运行 / 尝试 / 状态」契约（品牌发现 r2）

**状态**：已实现（随 `review/brand-discovery-llm-resilience-r2` 分支，未合并 main）
**日期**：2026-11-01
**上位依赖**：00 v1.2（工程基线）、01 v1.5.0（产品宪法）、02–07 v0.3、SC-04（核心情报主闭环）
**服从关系**：本变更只补齐「品牌识别运行语义」，不改变发现算法口径、不改报告与事实层；与 SC-04 冲突处以 SC-04 为准。

---

## 1. 目标与边界

### 1.1 目标

把「重新识别」从「复制一个新项目」改为「同一项目内的又一次运行」，并冻结识别状态的对外口径，使三件事同时成立：

1. **项目列表不被污染**：同一租户、同一项目、同一查询条件下重新识别复用原 `projectId`。
2. **结果原子替换**：新结果只有在搜索 → LLM 结构化提取 → 规则交叉核验 → 来源验证全链路成功后才替换旧品牌；失败则旧结果一行不动。
3. **状态不撒谎**：`discoverDone + competitors=[]` 的历史记录不得被读成「这个市场没有品牌」。

### 1.2 不做（本轮硬禁止）

- 不新增业务枚举（赛道/品类/层级等）。运行语义只落在**内部运行字段**上。
- 不改发现算法（枚举/收割/裁判/排名）口径，不调 prompt 质量目标。
- 不新增页面，不重做导航。
- 不为历史记录改写磁盘内容（不做破坏性删除、不伪造历史结果）。
- 不把「模型故障」解释成「没有品牌」，也不允许 mock 结果冒充真实成功。

---

## 2. 运行模型（内部字段，不是用户可见对象）

项目档案新增/更新以下字段（均在 `project.json` 内，属项目档案的一部分，无独立集合）：

| 字段 | 类型 | 语义 |
|---|---|---|
| `discoverRun` | `{runId, attemptNo, status, startedAt, finishedAt?, errorCode?, reuse?}` | **最近一次**运行。`status ∈ running/success/failed`；`attemptNo` 从 1 起，每次执行 +1 |
| `discoverRunHistory` | `[]`（上限 10） | 失败运行的审计留痕（`runId/attemptNo/status/errorCode/finishedAt/brandsBefore`），不通过复制项目保存 |
| `discoverReplace` | `{runId, attemptNo, at, brandsBefore, brandsAfter}` | 原子替换发生时的前后品牌数（审计用） |
| `discovering` | `boolean` | 进行中标记；进程中断后由 20 分钟超时兜底视为未完成，绝不永久显示「正在调研」 |
| `discoverError` | `{errorCode, errorMessage, failedAt, previousProjectId, keptPrevious, attemptNo}` | 失败态。`keptPrevious=true` 表示旧结果仍在（同项目内），`previousProjectId` 仅在新项目失败时指向旧成功项目 |
| `discoverEmpty` | `boolean \| null` | 仅当**完整流程成功且确实没有品牌**时为 `true`；其余情况为 `null`（显式清除，不靠 delete） |

**已知陷阱（写进契约）**：`saveState` 是「磁盘为基底 + 本态覆盖」的合并写，`delete` 字段不会清除磁盘旧值；清除标记必须显式写 `null`。

---

## 3. 状态口径（唯一实现：`app/services/discover-state.js`）

按优先级判定 `phase`：

| phase | 条件 | 用户可读含义 |
|---|---|---|
| `failed` | 存在 `discoverError` | 本次运行失败（可能仍保留上一次成功结果） |
| `running` | `discoverRun.status=running` 或 `discovering`，且 20 分钟内 | 正在识别 / 正在更新 |
| `done` | `discoverDone=true` 且品牌非空 | 识别完成，有已核验品牌 |
| `empty` | `discoverDone=true` + 品牌为空 + `discoverEmpty=true` | 识别完成，未找到通过核验的品牌 |
| `incomplete` | 其余（含 `discoverDone=true` + 品牌为空 + 无 `discoverEmpty` 的**历史伪空**） | 上一次品牌识别未完整完成，请重新识别 |
| `no_track` | 无赛道 | 尚未开始 |

文案纪律：`incomplete` 一律「上一次品牌识别未完整完成，请重新识别。」；只有 `empty` 才允许「未找到通过核验的竞争品牌」。禁止出现供应商名、原始错误正文、内部字段名。

投影位置：`GET /api/state`、`POST /api/projects/switch` 返回体挂 `discoverPhase` + `discoverState`（只读派生，不落盘）；`GET /api/projects` 清单项挂 `phase/incomplete/failed`。

---

## 4. API 契约变化（增量，向后兼容）

### 4.1 `POST /api/discover`

请求新增可选字段：

```json
{ "track": "custom dog tags", "intent": { "...": "..." }, "retryProjectId": "custom-dog-tags-mx1" }
```

判定规则：

- 带 `retryProjectId` 且该档案属本租户，且 `track / intent.regions / intent.goals / intent.platforms / intent.profile` 与档案一致 → **复用原 projectId**，新起一次运行（`attemptNo+1`）。
- 条件不一致、档案不存在或不属于本租户 → 按新项目处理（不报错、不泄露他人项目存在性）。
- 同一项目的进行中运行存在时再次提交 → `reused=true`，复用同一次运行（不重复 spawn、不重复扣额、不产生重复品牌）。

响应新增（均为附加字段）：

```json
{ "projectId": "...", "status": "accepted", "reused": false, "retry": true, "runId": "run-...", "attemptNo": 2 }
```

### 4.2 额度语义

- 新建项目：占用 1 次每日调研额度（沿用 R5.1）。
- 同项目重新识别：**不占用**每日额度（失败恢复不应惩罚用户），但仍受并发闸、单 IP 频率限制与搜索额度约束。

---

## 5. 验收（随分支交付，未合并）

- 同一失败项目重试后项目清单数量不变；`attemptNo` 从 1 → 2。
- 连点两次「重新识别」只创建一个 `runId`，并发闸只释放一次。
- 成功结果后重试失败：旧品牌名集合逐字一致，`discoverError.keptPrevious=true`，`discoverDone` 保持 `true`。
- 重试成功：品牌列表等于新结果（不是并集），`discoverReplace` 记录前后数量。
- 历史伪空档案：`phase=incomplete`，历史页不显示「0 个品牌」，磁盘内容零改写。
- 健康检查：Key/Model/BaseURL 任一变化后旧缓存立即失效；200 非 JSON 或结构不符 → `LLM_INVALID_RESPONSE`。

测试：`app/test/brand-discovery-r2.test.js`（14 项）。
