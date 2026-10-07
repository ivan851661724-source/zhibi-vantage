# Vantage · 03 Backend & API Contract

**版本：v0.3**  
**状态：评审稿**  
**上位依赖：00 v1.2 / 01 v1.3.3 / 02 v0.3 / 05 v0.3**

---

# 0. 架构原则

1. DB / REST 是 authoritative state。
2. SSE 只通知状态变化，不作为事实源。
3. Job Event 与 Domain Event 分离。
4. SourceSnapshot / JobStateSnapshot / JudgmentSnapshot 分离。
5. append-only event + correction/retraction。
6. at-least-once delivery + idempotency。
7. 用户离线不影响 Monitoring。

---

# 1. 核心域对象

沿用 00：

- Brand
- Candidate
- Competitor
- Product
- ProductLine
- Fact
- Metric
- Evidence
- SourceSnapshot
- DomainEvent
- Judgment
- JudgmentSnapshot
- Job
- JobEvent
- Coverage

新增实现对象：

- Workspace
- WatchTarget
- WatchlistEntry
- MonitoringPolicy
- NotificationPreference
- BrandTimelineProjection
- CanonicalBrandIdentity
- ExternalCallLedger
- WorkspaceCostBudget
- MigrationJob

---

# 2. Brand vs Workspace

Canonical Brand：

> 全局事实对象

Workspace Relationship：

> 用户相关竞争关系

禁止为每个 Workspace 复制一整套 Brand Facts。

Canonical 层只允许共享公开事实；以下仍属于 Workspace / tenant private：

- relationship / qualification context
- user reference product / price
- notes / challenges
- notification preference
- user priority
- private judgment context

同一 `brand_id × market × capability` 的公共 monitoring job 应尽可能合并为 Canonical collection，再 fan-out projection；不得仅因 WatchTarget 数量增加就线性重复采集。

---

# 3. WatchTarget

建议主键语义：

```text
workspace_id
brand_id
category_scope
market
```

字段：

- relationship_type
- qualification_status
- monitoring_status
- monitoring_policy_id
- current_qualification_result_id
- created_at
- paused_at
- user_priority

## 3.1 QualificationResult

QualificationResult 是**不可变的资格判定快照**，用于承接 02 的完整算法输出；WatchTarget 只保存当前引用，不重复存放算法明细。

至少包含：

```text
qualification_result_id
workspace_id
brand_id
category_scope
market
qualification_status
relationship_type

category_fit
core_product_price_fit
audience_fit
market_fit
channel_relation
price_relation?

reason_codes[]
evidence_ids[]
source_snapshot_ids[]

algorithm_version
config_version
computed_at
```

规则：

1. 每次重新资格判定生成新的 QualificationResult。
2. 不静默覆盖旧结果。
3. WatchTarget.current_qualification_result_id 指向当前生效版本。
4. 前端“为什么是竞品”只读取 QualificationResult / Projection，不自行重算。
5. `unresolved` 也必须有 reason_codes，例如 `insufficient_core_product_evidence`。

---

# 4. 正交状态

Competitor / WatchTarget 禁止单一 status。

至少拆：

- qualification_status
- enrichment_status
- monitoring_status
- freshness_status

Judgment 另用：

- judgment_review_status

---

# 5. Jobs

至少：

## DiscoveryJob
```text
queued
→ candidate_generation
→ identity_resolution
→ qualification
→ ranking
→ discovery_complete
```

## EnrichmentJob
```text
queued
→ collecting
→ normalizing
→ deriving
→ complete/partial/failed
```

## MonitoringJob
单次巡检任务。

## AnalysisJob
基于现有 Facts / Metrics 生成 Judgment。

## NotificationJob
投递用户外部通知。

---

# 6. Job Event vs Domain Event

JobEvent 示例：

- stage_started
- progress_updated
- source_failed
- job_completed

DomainEvent 示例：

- price_change_observed
- price_change_confirmed
- product_launch_observed
- promotion_started
- correction_issued
- retraction_issued

禁止混用。

---

# 7. REST API 草案

```text
POST /api/workspaces
GET  /api/workspaces/:id

POST /api/discovery-jobs
GET  /api/discovery-jobs/:id
GET  /api/discovery-jobs/:id/results

GET  /api/brands/:id
GET  /api/brands/:id/timeline

POST /api/watch-targets
PATCH /api/watch-targets/:id
GET   /api/watch-targets

GET  /api/events
GET  /api/events/:id

POST /api/judgments
GET  /api/judgments/:id

GET  /api/evidence/:id

POST /api/challenges
GET  /api/challenges/:id

GET /api/digests/daily
GET /api/value-receipts/weekly
```

---

# 8. SSE Contract

SSE 用于：

- discovery progress
- enrichment progress
- monitoring state change
- new event notification
- challenge status update

要求：

- event_id
- seq
- event_type
- resource_type
- resource_id
- occurred_at

### seq 唯一作用域

`seq` 的唯一语义冻结为：

> **对同一 `workspace_id` 的用户可见 SSE stream 单调递增。**

因此：

- seq **不是 per-connection**
- seq **不是 per-job**
- seq **不是 per-resource**
- reconnect 后仍延续同一 Workspace 的 sequence

服务器可内部拥有 job-local offset，但不得把其也命名为 API `seq`。

客户端：

- `event_id` 去重
- 记录 `last_seq`（per workspace）
- 若收到 `seq > last_seq + 1`，判定 gap
- gap 时调用 REST state / relevant collection 重建，再恢复 SSE
- 过滤事件类型时，服务端必须避免让客户端因服务端过滤产生伪 gap；默认用户流应返回该 Workspace 的完整可见事件序列

---

# 9. Idempotency

所有写操作：

- 创建 WatchTarget
- Challenge
- Notification enqueue
- Event projection

必须支持 idempotency key 或等价去重机制。

---

# 10. Domain Event Immutability

原事件不可覆盖修改。

错误通过：

- correction event
- retraction event

原事件保留。

---

# 11. Challenge Lifecycle

```text
challenge_created
→ under_review
→ confirmed_correct
   or
→ confirmed_error
→ correction/retraction
```

SLA：
- challenge 后 1 个工作日内必须产生可见复核响应。

---

# 12. Scheduler

## 12.1 默认巡检时点

03 是默认巡检时点的**唯一实现口径**。

按 Workspace 的 **target market timezone**：

- Morning Scan：**06:00**
- Midday Scan：**14:00**
- Evening Scan：**22:00**

Daily Brief 默认 08:00，可消费 06:00 Morning Scan 的结果。

要求：

- 使用 IANA timezone，不保存固定 UTC offset 代替时区；
- 自动处理 DST；
- 计划任务允许小范围 jitter 以避免同分钟洪峰，但用户语义仍归属上述窗口；
- 若 Scan 因队列延迟跨出容忍窗口，必须记录 schedule_lag。

Scheduler 不在算法层隐含。

变化后：
- enqueue targeted recheck
- targeted recheck 不改变下一次固定窗口

Scheduler 必须经队列派发，不允许“到点直接并发全部执行”。派发至少支持：

- bounded concurrency
- provider-specific concurrency / rate limit
- Workspace fairness
- priority
- jitter
- backpressure
- canonical collection coalescing（相同公开 brand/capability/scope 尽可能合并）

## 12.2 调度窗口容忍

v0 默认：

- normal jitter：±15 分钟
- >30 分钟：schedule lag warning
- >60 分钟：进入 degraded / Ops 告警候选

具体告警阈值由 07 维护，但 03 冻结事件字段与时间语义。

---

# 13. Monitoring Pipeline

```text
schedule
↓
collect
↓
normalize
↓
validate
↓
persist facts
↓
diff
↓
domain events
↓
analysis
↓
projection
↓
notification policy
```

---

# 14. Coverage Persistence

每个 monitoring window 保存 Coverage。

Daily Digest 读取 Coverage，而不是重新猜。

quiet 生成前必须检查：

- window complete
- threshold met
- no actionable event

---

# 15. Projection API

Web / Mobile / Email / Digest 使用同一 Projection。

禁止：

> 邮件自己重新判断一次
> 前端自己重新算价格带

所有端只 render。

---

# 16. Historical Storage

至少持久化：

- raw source snapshot references
- normalized facts
- events
- judgments
- corrections
- coverage
- timelines

### Raw Snapshot 默认保留策略

03 冻结数据生命周期语义，07 负责执行与告警。

v0 默认：

- **P0 / Evidence-bearing Raw Snapshot：90 天 hot + 冷归档至 365 天**
- **P1/P2 非 Evidence-bearing Raw Snapshot：30 天 hot + 冷归档至 90 天**
- 任何被 Judgment / Correction / Retraction / 用户 Challenge 引用的 snapshot：**至少保留 365 天**

变更责任：

> Backend/Data owner 提案，Product + Finance/Infra 成本评审后才能修改。

不得因常规清理删除仍处于 challenge / correction 审计链中的 snapshot。

---

# 17. Multi-tenant

要求：

- Workspace isolation
- authz by workspace
- brand facts 可共享
- user-specific relationship 不可跨租户泄漏

---

# 18. Error Model

统一 error code：

- partial_success
- source_unavailable
- rate_limited
- blocked
- insufficient_evidence
- timeout
- internal_error

禁止一个 generic failed 覆盖所有语义。

---

# 19. P0 验收

1. SSE 断线后可 REST 重建。
2. 重试不产生重复业务事件。
3. 原事件不能被静默覆盖。
4. quiet 只基于 Coverage。
5. Notification failure 不删除 DomainEvent。
6. 用户暂停监控后 scheduler 停止该 WatchTarget。
7. Brand facts 与 Workspace relationship 分层。
8. 任何付费外部调用都有 ledger 归因。
9. internal budget / quota 导致 required capability 缺失时 Coverage 正确降级。
10. canonical public collection 可跨 Workspace 复用且不泄露私有数据。
11. migration/backfill job 可重试且有显式状态。
12. scheduler 高峰可 backpressure，不产生无界并发。

---

# 20. ExternalCallLedger

每次外部可计费 / 有配额成本的调用必须追加 ledger，至少：

```text
call_id
workspace_id?          # canonical shared call 可为空或关联 allocation records
watch_target_id?
brand_id?
capability
provider
operation
trigger                 # discovery / monitor / recheck / backfill / challenge / manual
cost_profile_version
request_units
estimated_cost
cache_hit
canonical_reuse_hit
fallback_depth
attempt_no
started_at
completed_at
outcome
error_code?
```

共享 Canonical collection 若服务多个 Workspace，实际 provider call 只记一次；成本分摊可作为独立 allocation 视图，不得伪造多次 provider spend。

---

# 21. WorkspaceCostBudget

至少支持：

```text
workspace_id
billing_period
soft_limit?
hard_limit?
spent_estimated
search_spent
llm_spent
amazon_spent
ads_spent
policy_version
```

规则：

1. soft limit 用于 routing /降级预警；
2. hard limit 不得把 required P0 scan 静默转成 no_change；
3. 若套餐本身不足以承担已承诺能力，应在 admission / plan policy 阶段限制 WatchTarget 或 capability，而不是运行中偷偷漏扫；
4. optional enhancement 可在预算不足时显式降级。

---

# 22. Canonical Collection Coalescing

建议唯一键/去重维度：

```text
brand_id
market
capability
entity_scope
freshness_bucket
collection_policy_version
```

多个 Workspace 同时需要同一公共事实时：

- 复用 in-flight job 或最新合格结果；
- job 完成后分别更新各 Workspace Coverage / Projection；
- Workspace-private input 不进入共享 collection key；
- 不同 freshness SLA / market / scope 不能错误合并。

---

# 23. Schema / Migration Contract

所有持久化 schema 必须拥有 `schema_version` 或等价可解析版本。

MigrationJob 状态至少：

```text
queued
→ running
→ verifying
→ complete | partial | failed
```

要求：

- 幂等 / checkpoint；
- 可观测 processed / failed counts；
- backfill 与 migration 不得抢占 P0 monitoring 的队列优先级；
- cutover 前定义 authoritative read model；
- migration 完成后做 reconciliation；
- 不允许 silent partial success。

---

# 24. Historical Bootstrap API Semantics

Timeline / Brand API 必须让消费者区分：

```text
history_origin: observed | backfilled
observed_at?
source_timestamp?
backfilled_at?
```

前端不得自行猜测历史来源。
