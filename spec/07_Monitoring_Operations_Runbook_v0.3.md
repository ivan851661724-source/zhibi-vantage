# Vantage · 07 Monitoring & Operations Runbook

**版本：v0.3**  
**状态：评审稿**  
**上位依赖：00 v1.2 / 03 v0.3 / 05 v0.3 / 06 v0.3**  

---

# 1. 运维目标

生产运行优先保证：

1. 不把失败当事实。
2. 不静默丢事件。
3. 不错误宣称 quiet。
4. 用户能看到降级。
5. 系统能主动认账。

---

# 2. 核心 SLI

至少监控：

- source success rate
- source latency
- parser success rate
- monitoring job success
- coverage rate
- event generation rate
- false alert proxy
- correction rate
- notification enqueue latency
- notification provider acceptance
- SSE disconnect rate
- queue lag
- variable intelligence cost / active workspace
- variable intelligence cost / active watch target
- paid escalation rate
- fallback depth / retry amplification
- canonical reuse rate
- cache/fingerprint short-circuit rate
- freshness SLA compliance
- migration/backfill lag

---

# 3. v0 初始运维阈值

以下值用于首发可执行性，**上线后前 2 周必须按真实 baseline 校准**。改变阈值必须记录 `ops_policy_version`。

| 指标 | Warning | Critical / Action |
|---|---:|---:|
| Source success rate（15m rolling） | <95% | <90% 或连续 2 个窗口 <95% |
| HTTP 403/blocked rate（单 provider, 15m） | >5% 且明显高于基线 | >15% 或 3× baseline |
| Parser success rate（P0 parser, 15m） | <99% | <95% 或关键字段异常分布触发 |
| Workspace Daily Coverage | <100% | 任何 <100% 都禁止 quiet；<90% 进入 degraded |
| Monitoring schedule lag | >30 min | >60 min |
| P0 event projection lag | >10 min | >30 min |
| Notification enqueue lag | >10 min | >30 min |
| Queue oldest age（P0） | >15 min | >30 min |
| Correction SLA remaining | <4h 且未完成 | 超过 24h deadline |
| Challenge review SLA remaining | <4 business hours 且无人处理 | 超过 1 business day deadline |
| Correction rate spike | >2× 7d baseline | >5× baseline 或伴随同源异常 |
| Challenge rate spike | >2× 7d baseline | >5× baseline |
| Paid external call volume / workspace | >2× 7d baseline | >5× baseline 或无业务量增长解释 |
| Estimated variable cost / workspace | >2× plan baseline | >3× baseline 或逼近内部 hard limit |
| Fallback depth | >1 层显著高于基线 | 达配置 max_fallback_depth / cost ceiling |
| Retry amplification | >1.5× baseline | >3× baseline |
| Canonical reuse rate | 连续下降且重复抓取上升 | 同 brand 大规模按 Workspace 线性重复采集 |
| Freshness SLA compliance | <99% P0 facts | <95% 或关键品牌连续 stale |
| Migration/backfill queue lag | >4h | >24h（P0 monitoring 不受影响前提） |

Quiet 特别规则：

> v0 的 quiet coverage gate = 100% required P0 capability coverage。

因此“coverage warning”不是说 99% 仍可发 quiet；任何 <100% 都只能发 coverage-gap 文案。

---

# 4. 数据源异常

## 3.1 403 / Blocked 暴增

动作：

1. adapter 标 degraded
2. 降低频率或切 fallback
3. 不生成 quiet
4. 对受影响 Workspace 标 coverage gap
5. 达阈值后工程告警

---

## 3.2 Rate Limit / Quota

动作：

- respect retry-after
- backoff
- priority queue
- paying / P0 signal 优先
- fallback
- coverage 标记

不得：
> 无限重试

---

# 5. Parser Regression

症状：

- price 大量变 0
- SKU 数骤降
- promotion 事件暴涨
- parse success 降低

动作：

1. 自动停止该 parser 生成用户业务事件
2. 保留 Raw Snapshot
3. 标 degraded
4. 回滚 parser
5. 重放 snapshot 验证

---

# 6. False Alert Spike

触发依据：

- challenge rate
- correction rate
- anomaly detector
- manual QA

动作：

- 暂停相关 signal projection
- 不暂停 Raw Collection
- 定位 source / parser / algorithm
- correction/retraction

---

# 7. Coverage Degradation

若 coverage 低于 quiet threshold：

- 禁止 quiet
- Digest 显示 coverage gap
- 若持续多窗口，触发工程告警

---

# 8. Queue Lag

若 Monitoring / Notification queue lag：

优先级：

1. Price / Promo P0
2. New Product
3. Daily Digest
4. Review / P1
5. P2 enrichment
6. historical backfill / migration recompute（除非正在执行 release-critical migration）

---

# 9. Notification Failure

DomainEvent 已存在时：

> Notification failure 不得删除事件。

重试：

- provider transient error
- rate limit
- temporary rejection

记录：

- enqueue_at
- accepted_at
- delivered_at if available
- failed_at

---

# 10. Challenge SLA

用户 challenge：

- 进入 review queue
- 1 个工作日内必须有用户可见响应
- 超时前自动 escalation

---

# 11. Correction SLA

一旦 error_confirmed：

> 24 小时内 correction / retraction

若超时：
- P1 incident
- product owner + engineering alert

---

# 12. Provider Outage

分级：

## Single Provider
走 fallback，但必须受 05 的 max_attempts / max_fallback_depth / cost ceiling 约束。

## Capability-wide
标 unavailable / degraded。

## Multi-capability
触发 incident。

不得隐藏：

> “数据暂时不可用”

不得为了维持表面 coverage 而无限增加 paid fallback / browser / LLM。达到 ceiling 后以 unavailable/degraded 结束。

---

# 13. Incident Severity

建议：

## SEV0
全局数据污染 / 大规模错误警报。

## SEV1
核心 source 大范围不可用、当天监控 SLA 大面积失守。

## SEV2
单 capability / 单市场严重降级。

## SEV3
局部品牌 / 非核心增强源问题。

---

# 14. Data Replay

必须支持从 Raw Snapshot：

- 重新 parse
- 重新 normalize
- 重新 derive

但 replay 不得静默重写旧用户事件。

若旧事件需要纠正：
> 发 correction/retraction

---

# 15. Raw Snapshot Retention

执行 03 的默认生命周期：

- P0 / Evidence-bearing：90 天 hot + 冷归档至 365 天
- P1/P2 非 Evidence-bearing：30 天 hot + 冷归档至 90 天
- 被 Judgment / Challenge / Correction / Retraction 引用：至少 365 天

责任：

- **Owner：Backend/Data**
- Product 负责审计需求
- Finance/Infra 参与成本变更评审

删除前必须检查：

- 是否仍被 active challenge 引用
- 是否进入 correction/retraction 链
- 是否属于未过审计期的 JudgmentSnapshot

任何 retention policy 修改必须提升 `retention_policy_version`。


# 16. Daily Ops Dashboard

至少：

- scans scheduled / completed
- coverage
- source error
- block rate
- parser error
- event rate
- correction rate
- notification lag
- estimated variable cost by workspace/provider/capability
- paid escalation rate
- retry/fallback amplification
- canonical reuse rate
- freshness SLA compliance
- migration/backfill queue

---

# 17. 上线 Checklist

- [ ] Source adapters 有监控
- [ ] Parser 有版本
- [ ] Golden Dataset 回归通过
- [ ] quiet gate 测试通过
- [ ] correction/retraction 测试通过
- [ ] notification retry 测试通过
- [ ] SSE gap recovery 测试通过
- [ ] coverage dashboard 可用
- [ ] incident owner 明确
- [ ] paid external calls 100% 进入 cost ledger
- [ ] retry/fallback cost ceiling 生效
- [ ] no-change path 无 LLM
- [ ] canonical collection reuse + tenant isolation 测试通过
- [ ] freshness/stale dashboard 可用
- [ ] migration/backfill 可中断重试

---

# 18. Cost Incident Runbook

出现以下任一情况进入成本异常调查：

- provider call volume 与活跃 WatchTarget 不成比例增长；
- retry/fallback amplification 急升；
- LLM calls 在 no-change monitoring 中出现；
- canonical reuse 下降导致重复 collection；
- 单 Workspace 成本远高于 plan baseline；
- provider outage 触发 paid fallback storm。

处置顺序：

1. 确认业务量是否真实增长；
2. 按 capability/provider/trigger 分解 ExternalCallLedger；
3. 检查 cache/fingerprint/identity reuse 是否失效；
4. 检查 retry/fallback policy；
5. 优先关闭 optional escalation；
6. required P0 若无法完成，显式 degraded + coverage gap；
7. 禁止通过把 failure 写成 no_change 来“止损”。

---

# 19. Capacity / Backpressure Runbook

固定扫描窗口前后重点监控：

- queued jobs
- oldest age
- provider concurrency
- per-workspace lag
- P0/P1/P2 queue share

原则：

- Workspace fairness；
- P0 优先；
- canonical coalescing；
- backfill/migration 默认低优先级；
- 超过 lag 阈值进入 degraded，而不是无界扩容 paid provider。

---

# 20. Identity / Historical Continuity Incident

若出现：

- 同一品牌被拆成多个 Canonical Brand；
- 不同品牌被错误 merge；
- domain / ASIN reassignment 导致历史串线；
- backfilled history 被误标 observed；

必须暂停相关自动 Judgment / notification（受影响 scope），保留原始 SourceSnapshot，并通过版本化 merge/split/correction 修复，不直接改写历史事件。

---

# 21. Migration Runbook

正式 migration 必须有：

- preflight count / backup / version check；
- checkpoint；
- idempotent retry；
- reconciliation；
- cutover；
- rollback 或 forward-fix plan；
- metrics / logs。

迁移任务不得抢占 P0 monitoring 的主要容量。
