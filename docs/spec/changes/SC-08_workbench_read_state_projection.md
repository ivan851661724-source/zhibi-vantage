# SC-08 · 工作台读态契约：首屏摘要 / 轻量识别状态 / 单品牌按需详情（品牌发现 r3）

**状态**：已实现（随 `review/brand-discovery-llm-resilience-r3` 分支，未合并 main）
**日期**：2026-11-01
**上位依赖**：00 v1.2、01 v1.5.0、02–07 v0.3、SC-04（核心情报主闭环）、SC-07（运行/尝试/状态口径）
**服从关系**：本变更只新增**读态投影**，不改变任何事实、证据、事件、判断语义；与 SC-04/SC-07 冲突处以它们为准。

---

## 1. 问题与目标

### 1.1 实测问题（2026-11-01 测试服）

| 指标 | 实测值 |
|---|---|
| `GET /api/state` 响应体 | 1,137,527 字节（20 个品牌） |
| 服务端生成耗时 | 150–262 ms |
| 公网下载耗时 | 9.6 / 12.9 / 20.6 / 30.2 s（多次采样） |
| 持久失败横幅出现 | ≈ 24 s（必须等完整 state 到齐才渲染） |
| 单品牌体积 | 51 KB，其中 `attempts` 20.4 KB / `evidenceList` 8.9 KB / `fieldSources` 7.9 KB = 73% |

### 1.2 目标

1. 识别状态横幅 P95 < 2 s。
2. 工作台主要内容 P95 < 3 s。
3. 首屏摘要 < 150 KB；状态接口 < 10 KB。
4. 品牌详情与证据仍可查，改为按需加载。
5. 不改任何事实/证据/状态/租户边界语义。

---

## 2. 新增/扩展的读态契约

### 2.1 `GET /api/discover/status?projectId=<id>`

| 项 | 约定 |
|---|---|
| 鉴权 | tenant（同 `/api/state`） |
| 租户边界 | 只在本租户命名空间读；跨租户与不存在**都返回 404 且响应体一致**，不泄漏存在性 |
| 缓存 | `Cache-Control: no-store`；前端另带 `_t=` 破缓存 |
| 体积 | < 10 KB |
| 返回 | `projectId / track / runId / attemptNo / running / discoverDone / discoverEmpty / discoverError{errorCode,errorMessage,failedAt,previousProjectId,keptPrevious} / keptPrevious / phase / incomplete / message / competitorCount / updatedAt` |
| 禁止返回 | 品牌详情、attempts、Evidence、Snapshot、fieldSources、Key、供应商原始错误正文 |

`phase` 取值与 SC-07 完全一致：`failed / running / done / empty / incomplete / no_track`，由 `services/discover-state.js` 单一实现产出。

### 2.2 `GET /api/state` 增加 `scope` 与 `projectId`

| 参数 | 语义 |
|---|---|
| 不带 `scope` | **保持原行为**（全量，兼容所有旧调用） |
| `scope=summary` | 工作台首屏摘要，`Cache-Control: no-store` |
| `projectId=<id>` | 按 id 读本租户档案；跨租户/不存在都 404（不区分两者） |

摘要白名单（`services/state-summary.js`）：

- 品牌级：`competitorId / brandName / officialUrl / relationship / currentStatus / latestVerifiedChange / coverageSummary / monitoringSummary / updatedAt`，**外加** `evidenceCount`（§四.6 要求 summary 与 full 的「已核验变化数量」一致，缺此标量无法校验）。
- 顶层：`projectId / track / intent / competitors / materials / progress / evidenceDist / marketCurrency / discoverState / discoverPhase / discoverRun / discoverError / discoverDone / discoverEmpty / discovering / decisions / excluded / excludedReasons / suppressed / hasBrief / briefStatus / briefStartedAt`。
- **禁止**：`attempts`、`evidenceList`、`fieldSources`、原始观察全集、Snapshot 正文、报告正文、大时间线、`whiteSpace/blueOcean/radar/opportunity/trendView/domainVerdicts` 等重聚合。

**投影纪律（硬）**：只读投影，返回全新对象；**禁止对完整 state 或任何缓存对象原地删除字段**（历史事故：`trimEvidenceRefs` 原地裁剪污染 `OPP_CACHE`，导致 scope=full 失效）。

### 2.3 `GET /api/competitor-detail?projectId=<id>&competitorId=<id>`

| 项 | 约定 |
|---|---|
| 用途 | 用户点开某个品牌时才取这**一个**品牌的完整对象（含 attempts / fieldSources / evidenceList） |
| 派生 | 与 `/api/state` 走同一条 decorate 链路（不另算口径） |
| 边界 | 缺 `competitorId` → 400；跨租户/项目不存在/品牌不存在 → 404 |
| 缓存 | `Cache-Control: no-store` |

现有 `/api/evidence-detail` 与 `/api/brands/{id}` 保持不变，证据→Snapshot 的溯源关系不动。

---

## 3. 前端加载顺序（工作台）

1. 立即请求 `/api/discover/status`（URL 无 `projectId` 时按当前项目指针返回）。
2. 同时请求 `/api/state?private_view=1&scope=summary`。
3. 状态接口先返回 → 立刻渲染运行中 / 失败 / 成功 / 合法空结果 / 历史未完整完成。
4. 摘要返回 → 渲染材料流与品牌卡片。
5. 点开品牌 → `/api/brands/{id}` 或 `/api/competitor-detail`，一次只取当前品牌；关闭即停；切品牌/切项目 abort 旧请求，迟到响应按代数丢弃。

轮询：运行中 4 s 一次，终态立刻停止；上限 10 分钟。

SSE：事件必须同时携带并校验 `projectId` 与 `runId`，其他项目或其他运行的事件不得改写当前页面。

重聚合页面（算法资产 / 市场机会 / 象限）不参与首屏，自行按需取完整 state。

---

## 4. 兼容与回滚

- 旧调用（不带 `scope`）行为逐字节不变，可直接回滚前端。
- 全部改动只涉及读路径与投影，数据层零写入（除既有 decorate 派生）。
- 回滚方式：前端把 Provider 的 `scope=summary` 去掉即可恢复旧行为；后端新增端点独立，留着不影响旧链路。

## 5. 测试

`app/test/brand-discovery-r3.test.js`（18 项）：摘要不含三大字段、full 完整、summary 后 full 不被污染、集合/状态/错误/数量一致、体积门槛、状态接口字段与体积与 no-store、租户与项目隔离、详情按需、路由注册、前端契约（摘要读取/横幅不依赖完整 state/轮询与 abort/SSE runId/重聚合按需/r2 行为保留）。
