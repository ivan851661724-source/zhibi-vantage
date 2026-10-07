# M0-02 Evidence Foundation — Implementation Plan v0.1

日期：2026-10-07 ｜ 分支：`m0-02-evidence-foundation` ｜ 状态：已实现（HEAD `055db05`），终审 PASS，套件 23/23

## 1. Spec References（版本锁定）

| Spec | 节 | 约束 |
|---|---|---|
| 00 v1.2 | §1.5 / §2+§2.1 / §5 / §26 / §37 / §38 / §42 / §56 | Evidence 一级对象；EvidenceStatus 四值冻结 + reason_code 九值；事实链；幂等去重；fetch_failed ≠ no_change；多租户；版本化 |
| 02 v0.3 | §3 | EvidenceStatus 沿用 00，禁平行状态 |
| 03 v0.3 | §16 / §17 | Evidence-bearing 快照 P0 保留档；Multi-tenant |
| 05 v0.3.1 | §10 / §11 / §19.6 | SC-01 Evidence 层必填实际 parser/extractor 版本；SourceStatus ≠ EvidenceStatus；Shopify 禁 AOV/销量/成交价 |
| 06 v0.3 | Evidence Traceability | 100% 可解析到 SourceSnapshot；断链不计入 |

## 2. 现状评估

- M0-01 `source-snapshot.js`：快照层闭环（append-only、租户隔离、partial_scan 冻结术语、collector_version='net-1'、parser_version=null）。
- 现有 `research/evidence.js` = **legacy L5 采信裁决层**（sourceTier/deriveBasis，basis: verified/inferred/unverified）——与一级 Evidence 对象不同物。处置：**不动、不映射、不迁移**（任务书 §4）。
- 接线点：`net.js fetchShopifyProducts` 已旁路落快照并回传 `_prov.recorded + snapshotId`；`enrich.js deepResearchOne(comp, state, config)` 持 `state.tenantId`。

## 3. Evidence Schema（最终）

物理布局：`data/evidence/<tenant_ns>/<evidence_id>.json`（与 snapshots 同风格，租户 ns 隔离）。

```text
evidence_id            'ev_' + idempotency_key 前 20 hex（确定性导出）
schema_version         1
created_at
tenant                 { tenant_id, project_ref, brand_hint }
entity_ref             来源原生标识（product_id/handle/title/variant 明细/brand/domain），不造 Canonical 语义
source / provider      'shopify' / 'shopify_products_json'
source_snapshot_ids    ≥1，逐张同租户可解析
claim                  { field: 'product.price', scope: 'public_price_observation'（冻结，禁 AOV）}
extracted_value        verified: { price_min, price_max, prices:[{variant_id,title,price}] }；unavailable 恒 null
unit / currency / market   显式字段，缺省 null；当前单 products.json 快照路径 currency 恒 null（cart.js 探测币种无快照背书，不得写入 Evidence）
computed_at            本 Evidence 提取/计算产出时刻（00 §8）
evidence_status        verified | derived | conflicted | unavailable（冻结四值）
reason_code            仅 unavailable 非空（00 §2.1 冻结九值；SourceStatus timeout/internal_error → fetch_failed，细节经快照 provenance 保留）
evidence_strength      独立正交字段，不传恒 null，绝不由 status 派生
source_quality         独立正交字段，同上
observed_at            继承快照 observed_at（失败观察如实可为 null）
collector_version      溯源透传（多快照引用时不归属单一 collector → null）
parser_version         必填非空（SC-01），禁复制 collector_version
extractor_version      必填非空（SC-01）
algorithm_version / config_version   M0-02 无算法层，显式 null
provenance             { snapshots: [{ snapshot_id, capability, provider, source_status, partial_scan, observed_at, content_hash, collector_version, raw_payload_ref, raw_resolvable }] }
idempotency_key / note
```

## 4. EvidenceStatus 语义

- 冻结四值；`unavailable` 必带冻结 reason_code，非 unavailable 恒 null。
- reason_code 严格 00 §2.1 冻结九值，**不做枚举扩充**：SourceStatus `timeout` / `internal_error` → Evidence reason_code `fetch_failed`；确切失败细节不丢——经 `provenance.snapshots[].source_status`（原字面量）与 note/error 溯源保留。
- 禁 `basis→EvidenceStatus` 映射：store 不认识 legacy basis（测试 12 实证混入 basis 被忽略且不改写 status）；legacy `deriveBasis` 行为不变。
- 三正交：`evidence_status` ≠ `evidence_strength` ≠ `source_quality`，后两者不传恒 null，绝不由 status 派生；缺失 source_quality 不得变成 unavailable。

## 5. 存储设计

- `evidence-store.js`：`recordEvidence / getEvidenceById / findEvidenceBySnapshot`；append-only（wx 独占创建）；同 id 不同幂等键 = append-only 违例显式抛错。
- **幂等键（00 §37）= sha256(稳定序列化[完整规范语义身份])**，15 元：
  `tenant ‖ source_snapshot_ids(排序) ‖ source ‖ provider ‖ claim.field ‖ claim.scope ‖ entity_key ‖ extracted_value 摘要 ‖ unit ‖ currency ‖ market ‖ evidence_status ‖ reason_code ‖ parser_version ‖ extractor_version`。
  语义不同的 Evidence（币种不同 / scope 不同 / status·reason 不同 / 版本不同）必然 distinct，不会坍缩成 `duplicate:true`。
- **调用方不可改变身份**：`input.idempotency_key` 与 `input.evidence_id` 覆盖通道已移除——`evidence_id` 只由规范键确定性导出（`'ev_' + key 前 20 hex`）。
- 重试同键 → 返回既有记录 `duplicate:true`，零新增文件；新 parser/extractor 版本 → 新键 → 新记录，旧记录逐字节不变。
- 产证前置校验（06 Traceability）：快照存在 + 同租户 + verified/derived 时每张快照 raw 可解析；租户缺失 → `{recorded:false, reason:'no_tenant_context'}`（与快照层同规）。
- **来源身份门（P1-2）**：Shopify 提取前校验快照 `capability === 'product_catalog' && provider === 'shopify_products_json'`，错配 → `{ok:false, reason:'snapshot_source_mismatch'}`（内部提取失败，非新 EvidenceStatus / reason_code），零 Evidence 产出。
- **$0 价格保留（P1-1）**：Evidence 如实保留来源观测到的数值为 0 的变体价格；freebie/促销/排除等业务过滤归后续 Validation / Fact / Core Product 阶段，提取层不做业务筛选。

## 6. Evidence → SourceSnapshot 校验路径

`Snapshot.getById(tenantId, sid)` 按租户 ns 解析 → 跨租户/不存在自然不命中 → 显式抛错；raw 经 `raw_payload_ref` 存在性复核记入 `provenance.snapshots[].raw_resolvable`。

## 7. parser / extractor 版本策略（SC-01）

`parser_version='shopify-products-json-1'`、`extractor_version='evidence-extract-1'` 恒非空；store 拒绝 parser_version===collector_version 与缺失。**OQ（非阻塞）**：parser_version 与 extractor_version 在 05 v0.3.1 以"parser/extractor 版本"合称、00 §56 仅列 parser_version，区分未冻结——本票两字段并存记录实际值，不发明业务语义；是否合并留后续 Spec Change。

## 8. Vertical Slice 接线（additive）

`enrich.js` shopify 块后追加约 20 行：`shopify._prov.recorded` 时调 `evidence-extract.extractShopifyPriceEvidence({ tenantId: state.tenantId, snapshotId, entityRef, projectRef })`；**不传 currency**（cart.js 探测币种无 SourceSnapshot 背书 = Traceability 断链，当前单 products.json 快照路径 Evidence `currency = null`，诚实缺失；未来若快照化 cart.js 可同时引用两张快照 ID 恢复币种溯源）。失败态快照 → unavailable Evidence；任何异常仅 `logAttempt` + error 日志，legacy 契约零改动（修正 9 兼容规则）。结果摘要落 `comp.evidenceExtract`（additive 字段）。

## 9. 变更文件

- 新增 `app/research/evidence-store.js`（存储层）
- 新增 `app/research/evidence-extract.js`（确定性提取层，零 LLM 零网络）
- 修改 `app/research/enrich.js`（additive 接线，不改既有行为）
- 新增 `app/test/evidence-store.test.js`（23 用例，映射任务书 §13 全部 18 项 + 评审修正 3 项）

## 10. 测试计划 → 任务书 §13 映射

23 用例：T1–T20 对应任务书 §13 全部 18 项（1 创建 / 2 双向查 / 3 raw 全链可解析 / 4 租户隔离 / 5 跨租户拒绝 / 6 快照缺失拒绝 / 7 raw 持久化失败不产证 / 8 幂等重试零重复 / 9 新 parser 版本独立记录+旧记录不可变 / 10 冻结四值+reason_code 校验（含对 `timeout`/`internal_error` reason_code 的显式拒绝）/ 11 三正交字段 / 12 禁 basis 映射 / 13 六类失败态→unavailable（含 provenance source_status 保留断言）/ 14 价格+$0 变体保留+currency=null 诚实缺失+禁 AOV / 15 SC-01 版本必填不冒充 / 16 partial_scan 诚实 provenance / 17 legacy 兼容 / 18 零 LLM 零 fetch 静态断言 / 19 多快照+算法版本显式 null / 20 缺租户拒绝+快照缺失诚实报因）；评审新增：

- **T21 语义幂等矩阵（P0-2）**：同语义 → duplicate；USD vs EUR → distinct；不同 claim.scope → distinct；不同 evidence_status/reason_code → distinct；不同 parser/extractor 版本 → distinct；不同 market/source → distinct；传入伪造 `idempotency_key` / `evidence_id` 不改变身份。
- **T22 快照来源身份门（P1-2）**：可解析的 `generic_web_fetch` 快照 → `snapshot_source_mismatch`，零 Evidence 产出。
- **T23 computed_at（P1-3）**：字段存在、ISO 合法；`algorithm_version` / `config_version` 显式 null。

套件结果：**23/23 passed**；全量回归 18 套件功能全绿（唯一失败 static-check.test.js = 沙箱 spawn 本底，干净 main 基线同败已实证）。

## 11. 兼容性影响

Discovery / Enrichment / 公开 API / SSE / state JSON / UI 零改动；新 Evidence 层仅 additive（`comp.evidenceExtract` 摘要字段为唯一新增 state 字段）；无前端 API（Evidence Drawer 归后续票）。

## 12. Spec Conflicts / Open Questions

- 无硬冲突（任务书 §15 可继续条款生效）。
- OQ-1（非阻塞）：parser_version vs extractor_version 区分未冻结（见 §7）。
- ~~OQ-2~~（已按评审裁决收口）：reason_code 不做枚举扩充——SourceStatus `timeout`/`internal_error` → Evidence reason_code `fetch_failed`，失败细节经 `provenance.snapshots[].source_status` + note 保留；如产品侧后续要把两项升级为一等 reason_code，走正式 Spec Change。
- OQ-3（非阻塞，评审 P0-1 引出）：cart.js 币种当前无快照背书，Evidence `currency = null`；未来快照化 cart.js 后可在 `source_snapshot_ids` 同时引用两张快照恢复币种溯源（本票不扩采集能力）。
