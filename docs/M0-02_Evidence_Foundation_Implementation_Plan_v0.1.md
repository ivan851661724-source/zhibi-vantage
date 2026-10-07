# M0-02 Evidence Foundation — Implementation Plan v0.1

日期：2026-10-07 ｜ 分支：`m0-02-evidence-foundation` ｜ 状态：已实现，待评审

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
unit / currency / market   显式字段，缺省 null
evidence_status        verified | derived | conflicted | unavailable（冻结四值）
reason_code            仅 unavailable 非空（§2.1 九值 + 显式扩展 internal_error/timeout）
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
- reason_code 显式扩展两项（00 §2.1 允许扩展、禁止吞失败原因）：`internal_error`、`timeout` ← 对应 SourceStatus 字面量，保留失败原因而非归并 fetch_failed。
- 禁 `basis→EvidenceStatus` 映射：store 不认识 legacy basis（测试 12 实证混入 basis 被忽略且不改写 status）；legacy `deriveBasis` 行为不变。

## 5. 存储设计

- `evidence-store.js`：`recordEvidence / getEvidenceById / findEvidenceBySnapshot`；append-only（wx 独占创建）；同 id 不同幂等键 = append-only 违例显式抛错。
- 幂等键 = sha256(稳定序列化[tenant ‖ snapshot_ids 排序 ‖ claim.field ‖ entity_key ‖ extracted_value 摘要 ‖ parser_version ‖ extractor_version])；重试同键 → 返回既有记录 `duplicate:true`，零新增文件；新 parser 版本 → 新键 → 新记录，旧记录逐字节不变。
- 产证前置校验（06 Traceability）：快照存在 + 同租户 + verified/derived 时每张快照 raw 可解析；租户缺失 → `{recorded:false, reason:'no_tenant_context'}`（与快照层同规）。

## 6. Evidence → SourceSnapshot 校验路径

`Snapshot.getById(tenantId, sid)` 按租户 ns 解析 → 跨租户/不存在自然不命中 → 显式抛错；raw 经 `raw_payload_ref` 存在性复核记入 `provenance.snapshots[].raw_resolvable`。

## 7. parser / extractor 版本策略（SC-01）

`parser_version='shopify-products-json-1'`、`extractor_version='evidence-extract-1'` 恒非空；store 拒绝 parser_version===collector_version 与缺失。**OQ（非阻塞）**：parser_version 与 extractor_version 在 05 v0.3.1 以"parser/extractor 版本"合称、00 §56 仅列 parser_version，区分未冻结——本票两字段并存记录实际值，不发明业务语义；是否合并留后续 Spec Change。

## 8. Vertical Slice 接线（additive）

`enrich.js` shopify 块后追加约 20 行：`shopify._prov.recorded` 时调 `evidence-extract.extractShopifyPriceEvidence({ tenantId: state.tenantId, snapshotId, currency: shopify.currency, entityRef, projectRef })`；失败态快照 → unavailable Evidence；任何异常仅 `logAttempt` + error 日志，legacy 契约零改动（修正 9 兼容规则）。结果摘要落 `comp.evidenceExtract`（additive 字段）。

## 9. 变更文件

- 新增 `app/research/evidence-store.js`（存储层）
- 新增 `app/research/evidence-extract.js`（确定性提取层，零 LLM 零网络）
- 修改 `app/research/enrich.js`（additive 接线，不改既有行为）
- 新增 `app/test/evidence-store.test.js`（20 用例，映射任务书 §13 全部 18 项）

## 10. 测试计划 → 任务书 §13 映射

20 用例一一对应：1 创建 / 2 双向查 / 3 raw 全链可解析 / 4 租户隔离 / 5 跨租户拒绝 / 6 快照缺失拒绝 / 7 raw 持久化失败不产证 / 8 幂等重试零重复 / 9 新 parser 版本独立记录+旧记录不可变 / 10 冻结四值+reason_code 校验 / 11 三正交字段 / 12 禁 basis 映射 / 13 五类失败态→unavailable / 14 价格+币种+禁 AOV / 15 SC-01 版本必填不冒充 / 16 partial_scan 诚实 provenance / 17 legacy 兼容 / 18 零 LLM 零 fetch 静态断言 / 19 多快照+算法版本显式 null / 20 缺租户拒绝+快照缺失诚实报因。

## 11. 兼容性影响

Discovery / Enrichment / 公开 API / SSE / state JSON / UI 零改动；新 Evidence 层仅 additive（`comp.evidenceExtract` 摘要字段为唯一新增 state 字段）；无前端 API（Evidence Drawer 归后续票）。

## 12. Spec Conflicts / Open Questions

- 无硬冲突（任务书 §15 可继续条款生效）。
- OQ-1（非阻塞）：parser_version vs extractor_version 区分未冻结（见 §7）。
- OQ-2（非阻塞）：`timeout`/`internal_error` reason_code 为 00 §2.1 允许的显式扩展，建议后续 Spec Change 把两项正式登记入 00 §2.1 清单。
