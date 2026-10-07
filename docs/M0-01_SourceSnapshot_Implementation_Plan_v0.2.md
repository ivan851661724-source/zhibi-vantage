# M0-01 SourceSnapshot Foundation — Implementation Plan v0.2

状态：**已批准（附 9 条强制修正），v0.2 已全部纳入，本版为实施蓝本**。只做 M0-01，不扩散。
分支基线：远程 main `92539fb`。规格目录：`/spec`（docs-only 分支 `docs/vantage-spec-v0.3`，commit `6c4cd66`，已推送）。
v0.1 → v0.2 变更：全部对应评审修正 1–9，逐条见 §9 对照表；schema、存储布局、缓存语义、租户规则、测试计划均有实质修改。

---

## 1. Exact Spec References（全带版本）

| 依据 | 条款 | 对本任务的作用 |
|---|---|---|
| 00 v1.2 | §1.6 | SourceSnapshot 定义：一次对外部数据源的原始观察快照；用途=审计/重放/重解析/修复 parser 后重算/correction 取证 |
| 00 v1.2 | §5、§7 | 事实链 SourceSnapshot→Evidence→…；Snapshot 命名冻结（只许 SourceSnapshot/JobStateSnapshot/JudgmentSnapshot 三名） |
| 00 v1.2 | §8 | 可回算字段：`algorithm_version`/`config_version`/`computed_at` + `source_snapshot_ids` 关联 |
| 00 v1.2 | §37 | 幂等与去重 |
| 00 v1.2 | §38 | **fetch_failed ≠ no_change**：任何数据源异常必须可传播（快照记录失败观察） |
| 00 v1.2 | §42 | 多租户原则（快照按 workspace 归属） |
| 00 v1.2 | §51 | Cost Governance：可计费调用归因维度——M0-01 落归因字段，Ledger 主体在并行 track |
| 00 v1.2 | §54 | **Freshness 三时间分离**：`observed_at`（观察到来源内容的时间）/ `source_updated_at?`（来源自身更新时间）/ `collected_at`（采集完成时间）——**observed_at 语义的规格锚点** |
| 00 v1.2 | §56 | 迁移版本化：`schema_version` 等；**不可变历史不得静默覆盖** |
| 05 v0.3 | §1 | Capability Map（P0：Product Catalog / Current Price / Historical Snapshot / Evidence URL…）——快照 `capability` 字段取值来源 |
| 05 v0.3 | §4、§5.2 | Generic Web Fetch；products.json 分页完整枚举、不完整必须标 partial_scan |
| 05 v0.3 | §5.3 | Shopify 边界（公开目录数据允许，禁 AOV/销量/GMV 声称） |
| 05 v0.3 | §10 | Adapter Contract（`raw_snapshot_id` 必出）；**契约字段含 `parser_version` 但无 collector 版本字段 → Spec Change 候选 SC-01（见 §8）** |
| 05 v0.3 | §11 | Source Status 八态**冻结字面量**：`success` / `partial` / `unavailable` / `blocked` / `rate_limited` / `parse_failed` / `timeout` / `internal_error`；SourceStatus ≠ EvidenceStatus；**实现逐字使用，不造别名** |
| 05 v0.3 | §12 | Collection Policy + cost-aware path；巡检时点引用 03，Q1 维持 OPEN，M0 不动 scheduler |
| 05 v0.3 | §13 | Cache 三时间分离：source_observed_at / fetched_at / cache_served_at；**缓存命中不得伪造最新观察时间** |
| 03 v0.3 | §16 | Raw Snapshot 保留策略数值（P0/Evidence-bearing 90d hot+365d 冷档；非 Evidence-bearing 30d/90d；被引用者 ≥365d）；物理 resolver 归 03/07 |
| 02 v0.3 | L692 | Evidence.`source_snapshot_ids` —— M0-02 的消费接口 |
| 06 v0.3 | §Evidence Traceability | 「可从用户可见定量声明解析到 Evidence→SourceSnapshot」100% —— 端到端验收锚点 |

---

## 2. Current Collection Entry Points（代码实测，基线 `92539fb`）

| 入口 | 位置 | 现状 | 与快照的关系 |
|---|---|---|---|
| `fetchPage(url, timeoutMs)` | `app/research/net.js:63` | 手动重定向≤3 跳、SSRF 防护；正文截断（text≤9000 / htmlLower≤200000）；Cache 命中直接返回（L65）无任何时间元数据；body 经 `r.text()` 取文本，原始字节被丢弃 | 成功/失败都旁路产快照；改 `r.arrayBuffer()` 截获**原始字节**；缓存命中不产新快照、返回带原始溯源 |
| `fetchShopifyProducts(siteUrl)` | `app/research/net.js:96` | `/products.json?limit=100` 无分页 + `slice(0,60)` 截断（05 §5.2 GAP，M0-04 修）；原始 JSON 被丢弃 | `r.text()`→`Buffer` 截获原始 JSON 字节落快照，再 `JSON.parse`；cart.js 币种探测为辅助请求，不产快照（记录于元数据 note） |
| 消费方 | `app/research/enrich.js:172` | `Promise.all([fetchPage, fetchShopifyProducts])` | **零改动**（返回契约 additive 扩展 `_prov`） |
| Cache | `app/services/cache.js:36,48` | TTL 86400s，payload 为调用方返回对象 | 不改 cache.js；溯源挂在 fetchPage 缓存 payload 的 `_prov` 字段内随存随取 |
| 租户上下文 | `app/core/als.js:23`（`getTenantCtx` 可空）、`app/core/state-store.js:19`（`sanitizeNs`） | requestScope 全链路覆盖；`curTenantId()` 有 `_legacy` 兜底但**本票禁用**（修正 3） | 显式 tenantId 参数 > ALS（可空）> **双双缺失 = 拒绝落盘 + 运营告警**，绝不写共享命名空间 |
| 存储基建 | `core/paths.js:9`、`lib/fs-util.js`（`atomicWrite` tmp+rename） | `ZB_DATA_DIR` 可隔离；原子写 | 直接复用 |

**搜索 provider（Serper/Tavily）不纳入 M0-01**（修正 6 的架构规则已改写 OQ-3，见 §8）。

---

## 3. Storage Design（v0.2：metadata 与 raw payload 分离）

新模块 `app/research/source-snapshot.js`（唯一读写出口）：

```text
data/snapshots/<tenantNs>/<YYYYMMDD>/<snapshot_id>.json   ← 元数据（小，可索引）
data/snapshots/<tenantNs>/<YYYYMMDD>/<snapshot_id>.raw    ← 不可变原始字节 blob
```

- **修正 5**：大 raw 永久驻留元数据 JSON 的设计废除。元数据经 `raw_payload_ref` 指向不可变 blob；blob 是**未经解析/规范化的原始响应字节**（lossless；压缩留待后续，属透明无损才可加）。
- `tenantNs = sanitizeNs(tenant_id)` **仅是文件系统实现细节**（修正 3）；领域身份只存元数据内的显式语义字段 `tenant.tenant_id`（RAW 形态，如 `tenant:8cf0aebaebd1`）/ `tenant.project_ref` / `tenant.brand_hint`。
- `snapshot_id = ss_<capability>_<epochMs>_<rand6>`；文件名即 id，无需索引文件。
- **append-only、不可变（修正 4）**：record 遇同 id 已存在直接拒绝；模块**不提供任何 update/rewrite API**；后续 Evidence 引用导致的保留升级（evidence_bearing / tier / hot/archive）**不得改写历史 Snapshot JSON**，由外部 retention reference/index/policy state 承载（物理 resolver 03/07 落地，M0-01 只在元数据记录**入库时刻的初始保留分类**）。
- 失败观察同样落盘（00 §38），blob 为空/缺失，元数据完整记录异常态。

### 快照元数据 schema（v1，逐字段对规格）

```jsonc
{
  "snapshot_id": "ss_shopify_products_json_1727952000000_a1b2c3",
  "schema_version": 1,                       // 00 §56
  "capability": "product_catalog",           // 05 §1 P0 语义名映射（OQ-2）；fetchPage → "evidence_url"
  "provider": "shopify_products_json",       // 05 §10；fetchPage → "generic_web_fetch"
  "source_url": "https://x/products.json?limit=100",
  "final_url": "...",                        // 重定向后实际 URL
  "redirect_hops": 0,
  "http_status": 200,                        // 无响应（timeout/SSRF 拦截）为 null
  "source_status": "success",                // 05 §11 八态字面量之一，逐字使用
  "error_code": null,                        // success 为 null；如 "SSRF_BLOCKED:host"、"abort:timeout"
  "observed_at": "2026-10-07T00:00:00Z",     // 修正 1：**来源内容被真实观察到的时刻**；仅 success/partial 有值；blocked/timeout/rate_limited/内容前 internal_error → null，**绝不用 fetched_at 冒充**
  "fetched_at": "2026-10-07T00:00:00Z",      // 本次采集尝试时刻（00 §54 collected 语义的 attempt 分解）
  "collected_at": "2026-10-07T00:00:01Z",    // 快照记录完成时刻（00 §54）
  "source_updated_at": null,                 // 来源自带更新时间（HTTP Last-Modified 等），可信才填
  "cache_served_at": null,                   // 快照层恒 null：缓存命中不产新快照（05 §13）；下游经 _prov 携带
  "content_hash": "sha256:<hex>",            // **原始响应字节**的指纹（解析/规范化之前）；无内容时 null
  "content_type": "application/json",
  "raw_payload_ref": {                       // 修正 5：指向不可变 blob
    "kind": "fs_blob",
    "path": "snapshots/<tenantNs>/<YYYYMMDD>/<snapshot_id>.raw",  // 相对 ZB_DATA_DIR
    "byte_size": 123456,                     // blob 实际字节数
    "encoding": "identity"                   // 当前无压缩；透明无损压缩后在此声明
  },
  "raw_size": 123456,                        // **原始响应**字节长度（截断前）
  "raw_truncated": false,                    // 超 operational max 时 true；诚实标记，此时**不得宣称完整可重放**
  "collector_version": "net-1",              // 修正 7：net.js 抓取/采集实现版本；**不叫 parser_version**——快照时 parser 未运行，不伪造 parser_version
  "trigger": "enrich",                       // 00 §51：discover/enrich/lookup/sweep/api
  "tenant": { "tenant_id": "tenant:8cf0aebaebd1", "project_ref": null, "brand_hint": null },  // 修正 3：显式语义字段，ns 非身份
  "call_ledger_id": null,                    // ExternalCallLedger 预留（正交，见 §8 OQ-3）
  "coverage": { "complete": true, "partial_scan": false, "note": null },  // 05 §5.2 预留，M0-04 填充
  "retention": { "tier": "P1", "evidence_bearing": false, "hot_until": "...", "archive_until": "..." }
  // ↑ 入库时刻初始分类（03 §16 非 Evidence-bearing 档：30d hot / 90d archive）。
  //   修正 4：此后任何 Evidence 引用导致的保留升级走外部 retention reference/index，**不改写本 JSON**。
}
```

### 状态映射（实现逐字使用 05 §11 字面量，禁别名）

| 场景 | source_status | observed_at | blob |
|---|---|---|---|
| 2XX 且内容完整可用 | `success` | 响应体接收完成时刻 | 原始字节 |
| 2XX 但内容部分可用（M0-04 起，如目录分页被截） | `partial` | 同上 | 原始字节 |
| HTTP 429 | `rate_limited` | **null** | 无 |
| HTTP 401/403/407 | `blocked` | **null** | 无 |
| HTTP 其他 4xx/5xx（404/500…） | `unavailable` | **null** | 无 |
| AbortError / 超时 | `timeout` | **null** | 无 |
| SSRF_BLOCKED / 拒访 | `blocked` | **null** | 无 |
| 2XX 但 body 解析失败（JSON.parse 抛错） | `parse_failed` | **null**（内容未有效观察；原始字节仍落 blob 供重放） | 原始字节 |
| 其余内部错误 | `internal_error` | **null** | 无 |

### 缓存命中语义（修正 2）

- 命中 → **不产新快照**；返回值携带缓存 payload 内封存的原始溯源并只推进 `cache_served_at`：
  `_prov = { source_snapshot_id, observed_at, source_status, content_hash, fetched_at, cache_served_at }`（前五项来自当初网络观察，原样透传；`cache_served_at = 本次命中时刻`）。
- **`cache_served_at != observed_at` 恒成立**（不同字段、不同含义）；缓存命中永不刷新来源新鲜度（05 §13）。
- M0-01 之前写入的存量缓存条目（72h TTL 内）无 `_prov`：如实返回 `_prov = null` 并 debug 日志标注 `provenance_missing`，不伪造 id/时间；72h 内自然排空。

### 租户规则（修正 3）

```text
显式参数 tenantId  >  als.getTenantCtx()（可空，不落 _legacy）  >  两者皆缺 → 拒绝落盘
```

- 拒绝落盘 = 不写任何文件 + `logger.warn('source_snapshot_skip', { reason: 'no_tenant_context', url })` 运营可见告警 + 返回 `{ recorded: false, reason: 'no_tenant_context' }`；业务返回值不受影响。
- **不存在 `_legacy` 快照命名空间**；未来 Canonical Brand 的全局/公共作用域必须随 Canonical Identity 工作显式引入，不借 `_legacy` 表达。

### raw 体积上限（修正 5 / OQ-1）

- 环境变量 `ZB_SNAPSHOT_MAX_BYTES`，默认 `2097152`（2MB）。**这是可配置的运营默认值，不是冻结的产品规则**；OQ-1 维持 OPEN，等 Spec Change 冻结进 03 §16。
- 超限：先对**完整原始字节**计算 `content_hash` 与 `raw_size`，再截断存储 blob（`raw_truncated: true`、`raw_payload_ref.byte_size` = 截断后长度）；截断时**不宣称完整可重放**（用途降级为审计样本）。

---

## 4. Migration Strategy

- **纯增量旁路**：net.js 两入口在「拿到响应体之后、现有截断/提取之前」调用快照记录；返回契约只增不改（新增可选字段 `_prov` / `snapshotId`），下游 enrich.js **零改动零感知**。
- `fetchPage` 改 `r.arrayBuffer()` 取原始字节再解码——返回值 `text`/`htmlLower` 内容不变（同一字节的 utf8 解码），既有语义不受影响。
- 无 DB schema 变更；`server.js` 启动完整性校验清单**不加**快照目录（量大且可再生，属 03 §16 的 07 执行域）。
- 旧数据**不回填**：历史观察无原始字节，无法补快照——按 00 v1.2 §54 语义属 backfilled 历史，由 Freshness 工作统一标注，不在本票伪造。
- **可见性（修正 9 / 兼容规则）**：快照落盘失败**不得破坏 legacy Enrichment 路径**，但必须产生**可见运营错误**（`logger.error('source_snapshot_error', {...})`，非静默吞掉）；M0-02/M0-03 起「无成功落盘的 SourceSnapshot → 不得声明 evidence-grade provenance」——该转换在 M0-02 显式实现，本票只在 `_prov` 里如实反映 `recorded: false`。

---

## 5. Changed Files

| 文件 | 动作 | 内容 | 量级 |
|---|---|---|---|
| `app/research/source-snapshot.js` | **新增** | record（append-only 校验 + tenant 规则 + 状态映射 + blob 写）/ getById / readRawPayload / decorateCacheHit / mapHttpStatus | ~180 行 |
| `app/research/net.js` | 修改 | 两入口旁路记录（成功/失败/缓存命中三分支）；`r.text()`→`r.arrayBuffer()` 原始字节截获；`_prov` additive 字段；`COLLECTOR_VERSION` 常量 | ~45 行 |
| `app/test/source-snapshot.test.js` | **新增** | §6 用例 | ~300 行 |
| 其余（enrich.js/server.js/web/db/schema） | **不动** | — | 0 |

---

## 6. Test Plan（修正 9 增补后共 15 用例 + 回归全量）

1. **success 快照字段完整性**：stub HTTP 返回固定 JSON/HTML → 元数据含 id / observed_at / fetched_at / collected_at / http_status / content_hash / collector_version（**非 parser_version**）/ schema_version / trigger / tenant 全字段
2. **content_hash 稳定且基于原始字节**：同 body 两次抓取 hash 一致；`sha256(blob 实际字节) == content_hash`（未截断时）
3. **raw 完整性**：>9000 字符 HTML → blob 存完整原始字节、`raw_truncated=false`，而 fetchPage 返回值 text 仍截断（向后兼容实证）
4. **失败观察时间语义（修正 1）**：404→`unavailable` / timeout→`timeout` / SSRF→`blocked`，三者 `observed_at = null` 且 `fetched_at` 有值；fetch_failed ≠ no_change（00 §38）
5. **缓存命中不产快照**：同 url 二次调用 → 快照数不变
6. **缓存命中保留原始溯源（修正 2）**：返回 `_prov.source_snapshot_id` == 首次快照 id
7. **缓存命中保留原 observed_at（修正 2）**：`_prov.observed_at` == 首次快照 observed_at，不变
8. **缓存命中只推进 cache_served_at（修正 2）**：`_prov.cache_served_at` ≥ 首次 observed_at 且字段独立
9. **租户规则（修正 3）**：双 tenant 各自目录互不可见；ALS 缺失时显式 tenantId 仍生效；**两者皆缺 → 不写文件、无 `_legacy` 目录、返回 recorded:false**（告警日志）
10. **不可变（修正 4）**：同 id 二次 record → 拒绝且文件字节不变；模块无任何 update/mutate 导出
11. **getById + readRawPayload roundtrip（修正 5）**：元数据读回一致；经 `raw_payload_ref.path` 可读回 blob 字节
12. **parse_failed**：2XX 但 body 非合法 JSON（Shopify 入口）→ `source_status=parse_failed`、blob 仍落原始字节
13. **截断诚实（修正 5）**：`ZB_SNAPSHOT_MAX_BYTES` 调小 → `raw_truncated=true`、`content_hash` 仍为**原始完整字节**指纹、`raw_size` 为原始长度、ref.byte_size 为截断后长度
14. **enrich 集成零改动**：stub 服务跑真实 enrichOne 链路 → 快照自然产生、hash 与实际响应一致、enrich 返回结构不变
15. **落盘失败不破坏业务（修正 9）**：注入存储故障 → fetchPage/fetchShopifyProducts 照常返回业务结果，且有 error 级运营日志

回归：全量既有 16 套测试 + `scripts/static-check.js` 全绿（沙箱 EBUSY 时用 `static-check-async.js` 降级执行器）。

---

## 7. Backward Compatibility Impact

- **API 契约**：无端点变更；无 SSE 变更；无前端变更。
- **函数契约**：`fetchPage`/`fetchShopifyProducts` 返回对象仅增可选字段（`_prov`、`snapshotId`），现有消费方（enrich.js:172、测试 stub）零改动。
- **运行时风险**：每次抓取多一元数据写 + 一 blob 写；落盘失败静默于业务、显式于运营日志（修正 9）；磁盘占用由 retention 元数据可见，清理 Job TODO 已登记（07 执行域）。
- **测试基线**：既有 stub 不经真实网络层者不受影响；经 net.js 的用例在 `ZB_DATA_DIR` 隔离下多产快照文件，互不污染。

---

## 8. Spec Conflict 判定与 Open Questions

**结论：无硬 CONFLICT。** Open Questions 更新如下：

- **OQ-1（raw 体积上限）**：维持 OPEN。实现取环境变量 `ZB_SNAPSHOT_MAX_BYTES`（默认 2MB）为**运营配置**，不冻结为产品规则；候选项：Spec Change 把上限语义冻结进 03 §16。
- **OQ-2（capability slug 粒度）**：不变。slug 取 `product_catalog` / `evidence_url`（05 §1 P0 语义名映射）；若要求 `current_price` 独立，属 Spec Change。
- **OQ-3（重写，修正 6）**：ExternalCallLedger 与 SourceSnapshot **正交**——Ledger 答「谁调用/哪个 provider/为何/成本几何/重试回退/结果」，Snapshot 答「外部来源实际返回了什么/何时观察到/什么原始素材支撑下游情报」。**搜索 provider 响应并非天然 "Ledger only"**：M0-01 暂不纳入（范围控制），但架构规则冻结为——**凡搜索/provider 响应将来成为证据或喂给业务 Fact，必须补齐相应 SourceSnapshot/provenance 覆盖**。
- **SC-01（Spec Change 候选，修正 7）**：05 §10 Adapter Contract 缺 collector/adapter 版本字段（现有 `parser_version` 在快照层无解析发生、不可如实填写）。提案：§10 增补 `collector_version` 必出字段；Evidence/Fact 抽取层继续携带真正产出结构化结果的 `parser_version`。登记后不阻塞 M0-01（实现先用 `collector_version`，不伪造 `parser_version`）。

**遵守的上级既有修正**：①规格只认 `/spec`；②不做 legacy basis → EvidenceStatus 映射；③Q1 维持 OPEN；④合规政策（robots 非唯一授权）在 M0-04 adapter 落地；⑤垂直窄：**包含**——Direct 公网/Shopify 采集边界 → SourceSnapshot 落盘 → 不可变 raw 溯源 → 缓存溯源 → 失败观察 → 租户隔离；**不包含**——Evidence 迁移、Fact、Diff、DomainEvent、Canonical Brand 全量层、搜索 provider 快照接入、ExternalCallLedger 实现、scheduler 改动、Coverage、前端、新 provider。

---

## 9. 评审修正 1–9 对照表

| # | 修正 | 落点 |
|---|---|---|
| 1 | observed_at ≠ fetched_at；失败观察 observed_at=null | §3 schema 字段注释 + §3 状态映射表；00 §54 锚点 |
| 2 | 缓存命中保留原始 source_snapshot_id/observed_at/status，只加 cache_served_at | §3 缓存命中语义；测试 5–8 |
| 3 | 禁 `_legacy` 共享兜底；显式语义字段；ns 仅实现细节 | §3 租户规则；tenant.tenant_id/project_ref/brand_hint；测试 9 |
| 4 | Snapshot 不可变，保留升级走外部 reference | §3 append-only 规则 + retention 字段注释；测试 10 |
| 5 | metadata→raw_payload_ref→blob；hash 基于原始字节；2MB 降级为可配置运营值 | §3 存储布局 + raw 体积上限；测试 2/3/11/13 |
| 6 | Ledger ⊥ Snapshot 正交；搜索响应非自动 "Ledger only" | §8 OQ-3 重写 |
| 7 | collector_version ≠ parser_version；缺字段走 Spec Change | §3 schema `collector_version`；§8 SC-01；测试 1 |
| 8 | SourceStatus 逐字用 05 §11 字面量 | §3 状态映射表（八态无别名）；测试 4/12 |
| 9 | 范围清单 + 兼容规则（落盘失败可见错误；M0-02 起证据级强制） | §4 可见性段 + §8 范围清单；测试 14/15 |

---

## 执行序

1. `app/research/source-snapshot.js`（模块 + 单测先行）
2. `net.js` 旁路接线（成功/失败/缓存命中三分支 + arrayBuffer 原始字节）
3. 15 用例 + 全量回归 + static-check
4. PR：`feat(m0-01): SourceSnapshot foundation — evidence-grade raw capture`（Spec/Acceptance/Tests/DoD 四段式），**不含 M0-02**

---

## §11 PR#2 评审修正附录（2026-10-07，评审结论 PARTIAL → 修正后待复审）

评审 5 项问题逐条落点（全部实现并有测试锁定）：

| # | 评审问题 | 修正落点 | 测试 |
|---|---|---|---|
| P0-1 | Shopify 首页扫描（limit=100/slice 60）不得记 success+完整目录 | `net.js` fetchShopifyProducts：`products.length < 100` 才算完整观察（success）；≥100 → `source_status=partial`（05 §11 冻结字面量）+ `scan={complete:false, reason, observed_first_page}`；业务 items/total 契约不变 | #16（满额→partial）、#13 对照（不满额→success+complete） |
| P0-2 | 跨租户缓存命中不得把 A 的快照溯源交给 B | `net.js`：fetch-page 缓存键租户隔离（`t:<tenant>|<url>`，显式>ALS）；B 永不命中 A 条目、永不收 A 的 snapshot id；Canonical 跨工作区复用归 Canonical track（00 §52），不得借公共缓存模拟；OQ-4 就此关闭 | #9 重写（同 URL 双租户各自落盘、id 不同、互不可见） |
| P0-3 | `coverage.complete=!raw_truncated` 语义无效 | `source-snapshot.js`：删除 coverage 字段；快照只描述 raw 存储属性（raw_truncated/raw_size/raw_payload_ref）+ 采集扫描描述 scan；一等 Coverage 对象归后续 Coverage 票 | #12/#16/#17（失败/截断/满额三种形态均断言无 coverage 字段） |
| P1-1 | 2XX body 已接收但 parse 失败 → observed_at 不得为 null | `net.js`：body 接收时刻即 observedAt（arrayBuffer 之后），parse_failed 与 success 路径共用；observed_at=null 仅保留给 retrieval 前失败（pre-body timeout/SSRF/blocked/404 等内容未送达） | #11 改断言（非空 + ≤ collected_at） |
| P1-2 | raw 写入须防静默覆盖 | `source-snapshot.js`：blob 与 meta 均改独占创建（`flag:'wx'`）；冲突显式抛错（可见运营错误），不落半截快照（blob 失败则无 meta） | #18（预置 sentinel 文件→record 抛错→字节不变→无 meta） |

测试增补后共 18 用例（15 原有全保持 + 3 新增），18/18 绿。全量回归 17 套件 16 绿（static-check.test.js 为沙箱 spawn EBUSY 本底，干净 main 同败，实证记录在案）。
