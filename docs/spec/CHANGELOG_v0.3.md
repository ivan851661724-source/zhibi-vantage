# Vantage Specification Change Log

## v1.5.0 / v0.4.0 · 产品宪法与 SC-03 生效（2026-10-18）

- 01：v1.5.0 正式生效并替代 v1.3.3；冻结外部竞争情报边界，不要求或依赖用户订单、ERP、CRM、广告账户和客户数据。
- SC-03：批准竞争数据网络与长期品牌记忆的产品和工程方向；候选 provider、质量阈值和 capability GA 仍须真实 POC。
- 02：加入 measurement_method、经营指标准入、来源冲突、历史语义与 LLM 定量边界。
- 03：加入 Canonical Brand 扩展、ProviderRecord、MediaAsset、BrandMetric、目标 API、任务和迁移合同。
- 04：加入广告、社媒、KOL、评论、流量受众、平台经营估算和时间线交互合同。
- 05：加入九类 capability、Provider Registry、Adapter Contract、许可、频率与 GA Gate。
- 06：加入 20 品牌真实样本、数据面质量、公式、失败、租户与发布结论验收。
- 07：加入 provider health、schema drift、素材失效、许可到期、历史回填与事故处置。
- architecture/ 与 operations/ 仍只描述当前实现；相关代码合并后再逐项更新。

## 历史：Vantage v0.3 Change Log

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

## v0.4.0-R3 修订（2026-10-18，SC-02 复审整改轮 3，未合并——随 review/data-surface-foundation-r2 分支）

- net.js：safeLookup 单 IP+family 修复（ERR_INVALID_IP_ADDRESS 根因）；fetchPage 内层改走 safeRequestOnce（连接阶段受控 DNS，弃全局 fetch 旁路）；删除聚合伪装快照（页级快照 source_url 带 page=N）；失败快照 source_url 携带真实页 URL。
- source-adapter.js：provider-run 执行器模型（runProviderOutput / commitProviderTerminal / commitProviderEmpty）——provider 运行不写终态，fallback 首 provider 失败不再固化父 attempt；fanout 全链真执行、首个可用者胜出；validateOutput 增 JSON 可解析校验。
- surface-store.js：completeAttempt 原子 CAS（status='running' 条件更新）；upsertIdentity resolved 升级 fence 门控。
- collect-jobs.js：executeJob 统一策略循环（single/fallback/fanout），链耗尽唯一最终失败（fence 贯穿）。
- 测试：D30 SSRF（单 IP lookup/mock DNS 公网/rebinding/重定向私网零连接）、D31 fallback 终态语义（四场景）、D32 fencing（三场景）、D33 raw 快照真值链（三场景）；source-snapshot.test 适配 node http/https stub 层（#13/#16 对齐页级快照契约）。
- 文档：SC-02 §13/§14（R3 整改 + SC-03 边界）；05 §25.7。v1.5 宪法与 SC-03 零改动。
