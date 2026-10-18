# Vantage Product Specification Set · v0.4

本目录保存现行引用的领域规格与已批准条款，不表示所有模块均已冻结或实现完成。全仓阅读顺序见[文档中心](../README.md)，当前运行结构见[整体架构规范](../architecture/00_整体架构规范.md)。

## 规格阅读顺序与状态

| 顺序 | 文档 | 状态与作用 |
|---|---|---|
| 00 | [工程基线](00_Engineering_Baseline_v1.2.md) | 现行上位基线，控制领域语义和边界 |
| 01 | [产品宪法 v1.5.0](01_Product_PRD_v1.5.0.md) | 已批准并替代 v1.3.3；新增 capability 的实现状态另行验证 |
| 02 | [数据与算法](02_Data_Algorithm_Spec_v0.3.md) | v0.4 受控规格；含 measurement_method、指标准入与历史语义 |
| 03 | [后端与接口](03_Backend_API_Contract_v0.3.md) | v0.4 目标合同；当前已实现接口另见架构目录 |
| 04 | [前端交互](04_Frontend_Interaction_Spec_v0.3.md) | v0.4 数据面、状态、来源与时间线交互合同 |
| 05 | [数据来源与采集](05_Data_Source_Collection_Spec_v0.3.md) | v0.4；SC-01 与 SC-03 已批准，provider 仍须 POC |
| 06 | [质量与验收](06_QA_Golden_Dataset_Acceptance_Spec_v0.3.md) | v0.4；20 品牌 POC 与 capability GA Gate |
| 07 | [监控与运维](07_Monitoring_Operations_Runbook_v0.3.md) | v0.4；provider、schema、许可、素材与回填事故处置 |

已批准变更见[SC-01](changes/SC-01_collector_version_vs_parser_version.md)与[SC-03](changes/SC-03_competitive_data_network.md)。SC-03 批准产品和工程方向，不代表候选 provider 或 capability 已实现、采购或 GA。版本变更见[变更记录](CHANGELOG_v0.3.md)。

本轮在可信、可扩展和可控成本的基础上，正式加入竞争数据网络与长期品牌记忆。实施继续采用可验收的纵向切片，不一次并行铺开全部 provider。

## 版本基准

02–07 文件名保持稳定以避免破坏既有链接，文件头与本索引记录当前生效版本。


- 00 Engineering Baseline：v1.2
- 01 Product PRD：v1.5.0（正式生效）
- 02 Data & Algorithm：v0.4.0（SC-03）
- 03 Backend & API：v0.4.0（SC-03）
- 04 Frontend Interaction：v0.4.0（SC-03）
- 05 Data Source & Collection：v0.4.0（SC-01 + SC-03）
- 06 QA / Golden Dataset：v0.4.0（SC-03）
- 07 Operations Runbook：v0.4.0（SC-03）

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

后续按官网/DTC、流量受众、广告、社媒/KOL、Amazon、TikTok Shop、评论、历史回填的纵向切片推进。每批必须同时交付真实 adapter、证据/指标、API、前端、失败路径和 QA，禁止只铺空 UI 或 mock。

## 仍需实施裁决的事项

1. “警报当天到”与 06:00 / 14:00 / 22:00 三次离散扫描之间的字面冲突仍未关闭。需要明确为 detection latency SLA、增加 late/adaptive scan，或修改承诺。
2. Core Product v0 初始权重仍需 Golden Dataset 校准。
3. Provider 真实成本/额度必须从采购账号/provider dashboard 进入版本化 cost profile，不在规格中长期写死。
4. 各 plan 的 soft/hard internal cost budget 需要在真实 unit economics 数据后冻结。
