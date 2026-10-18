## Unreleased · SC-03 竞争数据网络提案（2026-10-18）

状态：提案，等待产品与独立技术审核；不代表 capability 已实现或已上线。

- 产品评审稿升级至 v1.5.0，补充外部竞争数据边界、广告/社媒/KOL/流量受众/平台经营估算和长期品牌时间线。
- 新增 SC-03，冻结候选数据面、来源取得优先级、measurement_method、指标命名与公式准入、Provider POC、许可、迁移和 GA Gate。
- 保持 00 的 SourceSnapshot → Evidence → Fact → Metric → DomainEvent → Judgment、EvidenceStatus、Coverage 与 correction/retraction 语义不变。
- architecture/ 继续只描述现行实现；目标 API 与 UI 在代码合并后再同步。

# Vantage v0.3 Change Log

## 必须改（P0）

- 00：新增 Cost Governance、Canonical Brand Intelligence 持续建库、Identity Continuity、Freshness/Backfill、Capacity/Backpressure、Migration、Capability 七维合同。
- 01：品牌库改为 demand-driven；新增 Monitoring≠Research、单位成本指标、Canonical Reuse、Cold Start/Backfill 产品语义与 A28–A35。
- 02：新增 identity merge/split、observed/backfilled history、cost-aware escalation、canonical reuse 算法语义。
- 03：新增 ExternalCallLedger、WorkspaceCostBudget、Canonical Collection Coalescing、MigrationJob、Historical Bootstrap API。
- 05：新增 direct-first、identity reuse、fingerprint、fallback/cost ceiling、heat-based brand collection、Source Use/Compliance Gate。
- 06：新增成本/新鲜度/复用/迁移 QA 指标与压力场景。
- 07：新增成本异常、backpressure、identity/history incident、migration runbook。

## 重要但不改变当前 M0 顺序

- 不建议为了本轮治理先重写 UI。04 只补 freshness/backfill/degraded 的表达要求。
- 不建议同时扩展 Meta/TikTok/Trends。先完成 Canonical data truth + low-cost monitoring loop。
- 不建议把 WorkspaceCostBudget 作为运行时“偷偷漏扫”的开关；plan admission 应先限制承诺范围。

## v0.3.1 修订（2026-10-07，SC-01，随 M0-01 PR#2 二审裁决生效）

- 05：SC-01 落地——Raw Snapshot 层 `collector_version` 必填、`parser_version` nullable（未解析时 null，不得伪造）；结构化 Adapter/Evidence/Fact 层 parser/extractor 版本必填。影响 05 §4 / §10 / §19.5。提案全文见 `docs/spec/changes/SC-01_collector_version_vs_parser_version.md`。
