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
