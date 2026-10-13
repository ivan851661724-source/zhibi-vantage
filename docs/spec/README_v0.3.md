# Vantage Product Specification Set · v0.3

本轮是一次横切治理升级，目标不是增加更多功能，而是让 Vantage 在“持续监控 + 持续建库”的前提下仍然可信、可扩展、可控成本。

## 版本基准

- 00 Engineering Baseline：v1.2
- 01 Product PRD：v1.3.3
- 02 Data & Algorithm：v0.3
- 03 Backend & API：v0.3
- 04 Frontend Interaction：v0.3
- 05 Data Source & Collection：v0.3.1（SC-01：collector_version 必填 / parser_version nullable，2026-10-07）
- 06 QA / Golden Dataset：v0.3
- 07 Operations Runbook：v0.3

## 本轮新增冻结主题

1. **Cost Governance（P0）**：Monitoring ≠ Research、Direct-first、No-change→no LLM、paid escalation 有界。
2. **Canonical Brand Intelligence 持续建库**：demand-driven，不做全网品牌普查。
3. **Canonical public monitoring reuse**：同一公开品牌事实尽可能跨 Workspace 复用，私有关系继续隔离。
4. **Identity Continuity**：稳定 brand_id、merge/split/versioned mapping。
5. **Freshness**：observed_at/source_updated_at/collected_at 分离，能力级 freshness SLA。
6. **Historical Continuity**：Observed History 与 Backfilled History 强制区分。
7. **Capacity / Backpressure**：固定窗口不是无界同时执行；引入 fairness/concurrency/jitter/coalescing。
8. **Provider Degradation**：retry/fallback/cost ceiling，达到上限后显式 degraded/unavailable。
9. **Schema / Migration**：迁移成为正式可观测 Job，禁止 silent partial success。
10. **Capability Contract**：Accuracy/Freshness/Coverage/Cost/Failure/Fallback/Evidence Strength 七维。
11. **Source Use / Compliance Gate**：技术可抓不等于可进入 GA。

## 开发优先级影响

M0 Data Truth Vertical Slice 不变，但应把以下内容一起纳入基础设施：

```text
SourceSnapshot / Evidence / Fact
+ Canonical Brand Identity
+ ExternalCallLedger
+ fingerprint / direct-first path
+ observed/backfilled provenance
```

不要在 M0 同时接 Meta/TikTok/Trends 等宽数据面；先把低成本可信主链做好。

## 仍未解决的产品决策

1. “警报当天到”与 06:00 / 14:00 / 22:00 三次离散扫描之间的字面冲突仍未关闭。需要明确为 detection latency SLA、增加 late/adaptive scan，或修改承诺。
2. Core Product v0 初始权重仍需 Golden Dataset 校准。
3. Provider 真实成本/额度必须从采购账号/provider dashboard 进入版本化 cost profile，不在规格中长期写死。
4. 各 plan 的 soft/hard internal cost budget 需要在真实 unit economics 数据后冻结。
