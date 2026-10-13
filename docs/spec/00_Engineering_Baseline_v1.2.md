# Vantage v1.2 工程冻结基线

**版本：v1.2（横切治理升级版）**  
**状态：工程上位基线 / Canonical Engineering Baseline**  
**适用范围：01 Product PRD、02 Data & Algorithm、03 Backend & API、04 Frontend、05 Data Source、06 QA、07 Operations**  

---

# 0. 文档作用

本文件是 Vantage 全规格集的工程上位基线。

后续文档不得重新定义以下共享语义：

- 核心领域对象
- 状态枚举
- EvidenceStatus
- relationship_type
- Fact / Metric / DomainEvent / Judgment 分层
- Job / JobEvent 生命周期
- Snapshot 命名
- Correction / Retraction 机制
- Coverage 语义
- SSE / REST 的事实源关系
- 历史回溯与 JudgmentSnapshot
- 数据源依赖分层原则

若 01–07 任一文档与本基线冲突，应先修订本基线或下位文档，不允许并存两套定义。

---

# 1. Canonical Registry

以下对象是全系统唯一共享语义。

## 1.1 Candidate

尚未完成资格核验的竞争候选对象。

Candidate 不等于 Competitor。

---

## 1.2 Competitor

已进入竞争关系管理的品牌 / 实体。

一个 Competitor 可以对应多个：

- domain
- storefront
- marketplace identity
- advertising identity
- platform surface

Competitor 本身不等同于某一个 URL。

---

## 1.3 Fact

由数据源直接观察、经过标准化与验证后形成的事实。

例如：

- 某商品当前价格为 $29
- 某商品当前可售
- 某商品首次被观察到
- 某广告当前 active

Fact 不包含业务判断。

---

## 1.4 Metric

由一个或多个 Fact 派生出的可计算指标。

例如：

- Core Product Price Median
- Primary Price Band
- 30d Price Change Count
- Launch Frequency
- Coverage Ratio

Metric 必须可追溯到：

- source_snapshot_ids
- evidence_ids
- algorithm_version
- config_version
- computed_at

---

## 1.5 Evidence

用于证明 Fact / Metric / DomainEvent / Judgment 的一级对象。

建议至少包含：

```json
{
  "evidence_id": "F-...",
  "source": "shopify",
  "url": "https://...",
  "snapshot_id": "srcsnap_...",
  "observed_at": "2026-10-06T12:00:00Z",
  "field": "variant.price",
  "value": 34,
  "evidence_status": "verified"
}
```

Evidence 必须可被前端直接展开审计。

---

## 1.6 SourceSnapshot

一次对外部数据源的原始观察快照。

用途：

- 审计
- 重放
- 重解析
- 修复 parser 后重新计算
- correction / retraction 取证

SourceSnapshot 不等于 JobStateSnapshot，也不等于 JudgmentSnapshot。

---

## 1.7 DomainEvent

业务事实变化事件。

例如：

- price_change_observed
- price_drop_confirmed
- product_launch_observed
- promotion_started
- correction_issued
- retraction_issued

DomainEvent 必须与 JobEvent 分离。

---

## 1.8 Judgment

在 Fact / Metric / DomainEvent 基础上形成的业务分析与竞争判断。

例如：

> 用户 $29 处于核心竞品主力价格带中段。

Judgment 不是原始事实。

---

## 1.9 JudgmentSnapshot

Judgment 生成时完整保存其输入上下文。

至少包括：

- competitor_set_id
- competitor_ids
- excluded_competitor_ids
- price_scope
- currency
- market
- algorithm_version
- config_version
- source_snapshot_ids
- evidence_ids
- created_at

目的：

> 90 天后可以判断“当时是否判断正确”，而不是用今天的数据重新解释昨天。

---

## 1.10 Job

系统内部异步任务对象。

例如：

- DiscoveryJob
- EnrichmentJob
- MonitoringJob
- AnalysisJob
- NotificationJob

---

## 1.11 JobEvent

用于表达任务执行过程。

例如：

- stage_started
- progress_updated
- source_failed
- job_completed

JobEvent 不得承载业务事实语义。

---

## 1.12 Coverage

描述一个监控窗口内系统实际完成了多少应完成的监控。

Coverage 是一级对象，不是简单的：

> events.length === 0

quiet / “无变化”必须由 Coverage Gate 决定。

---

# 2. EvidenceStatus

系统唯一 EvidenceStatus：

- `verified`
- `derived`
- `conflicted`
- `unavailable`

禁止创建同义平行状态。

---

## 2.1 unavailable.reason_code

至少支持：

- `not_supported`
- `source_not_integrated`
- `fetch_failed`
- `blocked`
- `rate_limited`
- `parse_failed`
- `insufficient_history`
- `insufficient_sample`
- `not_applicable`

后续可以扩展，但不得用一个 generic unavailable 吞掉失败原因。

---

# 3. 正交状态模型

一个 Competitor / WatchTarget 不允许使用单一 `status` 表达所有业务状态。

至少拆成：

## 3.1 qualification_status

- `qualified`
- `unresolved`
- `disqualified`

---

## 3.2 enrichment_status

- `not_started`
- `running`
- `partial`
- `complete`
- `failed`

---

## 3.3 monitoring_status

- `inactive`
- `active`
- `degraded`
- `paused`

---

## 3.4 freshness_status

- `fresh`
- `stale`
- `unknown`

---

## 3.5 judgment_review_status

- `not_due`
- `due`
- `under_review`
- `historically_correct`
- `invalidated_by_market_change`
- `corrected`
- `retracted`

这些状态互相正交，不得压缩成一个 status。

---

# 4. relationship_type

系统统一使用：

- `direct`
- `price_overlap`
- `cross_channel`
- `watchlist`

禁止在下位文档重新创造同义 enum。

---

# 5. 领域事实链

Vantage 的唯一业务事实链：

```text
SourceSnapshot
    ↓
Evidence
    ↓
Fact
    ↓
Metric
    ↓
DomainEvent
    ↓
Judgment
```

并且：

```text
Judgment
   ↓
JudgmentSnapshot
```

---

# 6. Fact / Metric / Event / Judgment 分层

必须严格区分：

## Fact

> A 商品今天价格 $29。

## Metric

> 当前价格较过去 30 天中位数低 17%。

## DomainEvent

> price_change_observed

## Judgment

> 用户当前价格进入核心竞品价格带中段。

禁止把四种语义混在一个 message 字段里。

---

# 7. Snapshot 命名冻结

系统只允许以下三类 Snapshot 名称承担对应语义：

## SourceSnapshot

外部数据源原始观察快照。

## JobStateSnapshot

异步任务状态快照。

## JudgmentSnapshot

判断输入上下文快照。

禁止笼统使用：

> snapshot

而不区分语义。

---

# 8. 算法可回算要求

所有重要可回算对象必须包含：

- `algorithm_version`
- `config_version`
- `computed_at`

并根据对象需要关联：

- `source_snapshot_ids`
- `evidence_ids`

算法升级后不得静默覆盖旧结论。

---

# 9. Discovery 生命周期

Discovery 与 Enrichment 必须拆开。

---

## 9.1 DiscoveryJob

标准状态：

```text
queued
→ candidate_generation
→ identity_resolution
→ qualification
→ ranking
→ discovery_complete
```

异常：

```text
failed
```

Discovery 负责：

> 找谁值得进一步看。

---

## 9.2 EnrichmentJob

Enrichment 负责：

> 把已经识别 / 确认的对象补成可分析竞争档案。

不得把 Discovery 和 Enrichment 混成一个长状态机。

---

# 10. S1–S5 所有权

S1–S5 只属于：

> **02 Data & Algorithm Spec**

01 Product PRD、03 Backend、04 Frontend 不得重新定义另一套 S1–S5。

前端可以显示更易懂的用户阶段，但不能把它们当算法状态本身。

---

# 11. 监控生命周期

标准链：

```text
observe
→ normalize
→ validate
→ diff
→ observed event
→ confirm / recheck
→ confirmed / transient / reverted
→ projection
```

---

# 12. Price Change：Observed vs Confirmed

为了同时满足：

- 当天提醒
- 降低误报

必须拆：

## price_change_observed

首次发现一个可解释变化。

可以进入用户可见面。

## price_drop_confirmed / price_change_confirmed

后续复查确认变化持续或成立。

后续确认不得阻塞首次 observed 提醒。

---

# 13. Scheduler 所有权

算法不得隐含：

> 每 3 天两次确认

之类调度假设。

所有巡检频率、固定时点、targeted recheck 调度统一由：

> **03 Backend & API Contract / Scheduler**

定义。

02 只定义：

> 什么条件构成 observed / confirmed。

---

# 14. v0 Scope 与算法依赖

v0 核心链必须在核心数据能力下成立。

不得要求：

> 某个增强数据源缺失就无法完成 Discovery / 基础监控。

数据源必须按 capability dependency 管理。

禁止简单把：

> Amazon / Keepa / Ads / Trends

一概视为“增强项”或一概视为“核心项”。

正确原则：

> **某个已经写进 v0 产品承诺的 capability，其对应数据能力就是条件性核心依赖。**

例如：

- 如果 v0 正式承诺 Amazon Price Monitoring，则 Amazon Price 数据能力属于该 capability 的核心依赖。
- 如果 Ads 只用于丰富分析，则 Ads 可以是增强依赖。

---

# 15. Tier / Capability Dependency 原则

可以继续使用：

- Core / Tier A
- Enhancement / Tier B
- Optional / Tier C

但只允许表达：

> 该数据源能力对某一产品 capability 的依赖级别。

不得把 Provider 本身永久写死成某个 Tier。

尤其禁止：

> Keepa 永远是 Tier B

这种全局绝对定义。

---

# 16. 价格术语冻结

禁止使用“客单价”表示竞争品牌商品售价。

统一使用：

- Product Price
- Typical Product Price
- Core Product Price
- Primary Product Price Band

AOV 只有真实订单级数据才能使用。

---

# 17. Shopify 数据边界

v0 不得宣称通过公开 Shopify 商品数据得到：

- 真实订单 AOV
- 近 30 天真实到手价
- 真实销量
- 真实 GMV

允许：

- 当前有效商品价格
- variant 价格
- availability
- Vantage 自建历史观察价格

---

# 18. 主力产品线 / 主力价格带

当品牌价格分布多峰时：

> 不允许使用全店 median 直接做竞品价格资格判定。

必须优先：

> 用户相关类目 → Product Line → Core Product Line → Primary Price Band

---

# 19. 目标价不得参与异常值清洗

用户参考价格 / 目标价格是：

> 比较对象

不是：

> 数据清洗规则的一部分。

禁止使用：

```text
user_price × 0.15
user_price × 3
```

等方式决定哪些竞品 SKU 是异常值。

---

# 20. Shopify SKU 完整性

不得默认只抓：

> 前 60 / 前 100 个商品

然后假装代表全店。

必须：

- 完整分页
- 或显式标 `partial_scan`

partial_scan 必须传播到：

- coverage
- analysis
- UI

---

# 21. quiet / “无变化”规则

quiet 绝不能定义为：

```text
events.length === 0
```

正确要求：

```text
monitoring window complete
+
coverage threshold passed
+
no verified/actionable event
```

否则只能说：

> 覆盖不足，无法确认无变化。

---

# 22. Coverage 是一级对象

Coverage 至少要能表达：

- expected targets
- attempted targets
- successful targets
- failed targets
- required capabilities
- missing capabilities
- window_start
- window_end
- policy_version

Daily Digest / Quiet / SLA 统一读取 Coverage。

---

# 23. DomainEvent 必须 immutable

已生成的业务事件不能静默修改。

如果发现错误：

> 追加 correction / retraction。

例如：

```text
price_change_observed
↓
correction_issued
```

而不是：

> 把原 price_change 改成不存在。

---

# 24. Correction / Retraction

必须支持：

- correction
- retraction

并保存：

- original_event_id
- reason_code
- corrected value / state
- evidence_ids
- confirmed_at
- issued_at

---

# 25. Notification Policy 不删除业务事件

通知策略只决定：

> 是否 / 何时 / 通过什么渠道通知。

不能决定：

> DomainEvent 是否存在。

例如邮件发送失败：

> DomainEvent 仍必须保留。

---

# 26. Evidence 是一级对象

关系：

```text
Metric
  ↓
EvidenceRef[]
  ↓
Evidence
  ↓
SourceSnapshot
```

同样：

```text
DomainEvent → evidence_ids
Judgment → evidence_ids
```

前端点 `#F` 必须能展开 Evidence。

---

# 27. F6 / Judgment 边界

Vantage 可以说：

> 当前价格位于核心竞品主力价格带中段。

可以说：

> $19 以下有 3 家直接低价竞争对象。

禁止说：

> $29 有肉吃。

禁止在没有用户成本、物流、CAC、利润目标时判断：

> 一定赚钱 / 最优价格。

---

# 28. JudgmentSnapshot

每个重要判断都必须保存完整输入。

至少：

```text
competitor_set_id
competitor_ids
excluded_competitor_ids
price_scope
currency
market
algorithm_version
config_version
source_snapshot_ids
evidence_ids
created_at
```

目的：

> 历史回溯时知道“当时到底看到了什么”。

---

# 29. 90 天历史回溯

必须区分：

## historically_correct

当时根据当时数据判断正确。

## invalidated_by_market_change

当时判断正确，但市场后来改变。

禁止把：

> 市场后来变化

错误解释成：

> 当时算法判断错了。

---

# 30. REST / SSE 事实源关系

唯一原则：

> **DB / REST = authoritative state**

> **SSE = state-change notification**

SSE 不是事实源。

---

# 31. SSE 生产要求

至少：

- at-least-once delivery
- event_id 去重
- seq gap detection
- reconnect 后通过 REST / state snapshot 重建

不得依赖：

> SSE buffer 永远不丢

保证正确性。

seq 的唯一 API 作用域由：

> 03 Backend & API Contract

定义。

---

# 32. Projection 单一口径

标准链：

```text
SourceSnapshot
→ Evidence
→ Fact
→ Metric
→ DomainEvent
→ Judgment
→ Projection
→ Web / Mobile / Email / Digest
```

最后四端只负责 render。

禁止：

- Email 自己重新算结论
- Frontend 自己重新算价格带
- Mobile 使用另一套判断逻辑

---

# 33. 前端状态与后端状态分离

前端可以存在：

- loading
- warming
- partial
- degraded
- quiet
- corrected
- retracted

但这些是：

> UI Projection State

不能反过来覆盖领域正交状态。

00 中领域状态是事实源。

04 负责做：

> Domain State → UI State Mapping

---

# 34. pending 语义冻结

禁止用一个：

> pending

同时表达：

- 待资格核验
- 待 enrichment
- 待人工复核
- 等待数据源
- 等待判断

资格统一：

- qualified
- unresolved
- disqualified

其他等待状态使用对应 Job / Review / Monitoring 状态。

---

# 35. 错误终态

后端不得只返回：

> failed

统一至少区分：

- partial_success
- source_unavailable
- rate_limited
- blocked
- insufficient_evidence
- timeout
- internal_error

错误语义必须可传播到 UI 和 Coverage。

---

# 36. progress pct 约束

v0 不建议把：

> 42%

作为强承诺。

因为异步数据源任务总工作量经常无法提前精确知道。

优先展示：

- 当前阶段
- 已完成 N/M
- 已确认 N 家
- 已处理 N 个来源

若使用 progress_pct，必须注明其估算性质。

---

# 37. 幂等与去重

以下场景必须支持 dedupe / idempotency：

- SSE reconnect
- worker retry
- monitoring retry
- Notification retry
- DomainEvent projection

目标：

> 同一真实变化不能因为系统重试而变成多个业务事件。

---

# 38. 数据源失败语义

必须满足：

> fetch_failed ≠ no_change

> blocked ≠ no_change

> partial_scan ≠ full coverage

> stale ≠ fresh

任何数据源异常都必须传播到：

- EvidenceStatus
- Coverage
- UI
- Digest

---

# 39. 多源价格冲突

多源价格不能直接比较原始值。

必须先归一：

- market
- currency
- product identity
- variant/spec
- promotion context
- source timestamp

只有可比后仍矛盾，才标：

> conflicted

---

# 40. Amazon 评论语义

Amazon review count 可以作为：

> demand / sales proxy

不能直接叫：

> 销量

任何销量 / GMV 推断必须清楚标：

> derived / proxy

无锚点时只能用于相对判断。

---

# 41. 历史数据与新对象

新 Competitor / WatchTarget 没有足够历史时：

> warming / insufficient_history

不得用：

> “没有变化”

掩盖：

> “我们还没有足够历史判断变化”。

---

# 42. 多租户原则

Brand 事实可以全局复用。

Workspace 竞争关系必须隔离。

禁止跨 Workspace 泄露：

- 用户自有品牌
- 用户价格
- 用户 watchlist
- 用户判断
- 用户 challenge
- 用户偏好

---

# 43. 数据资产分层

推荐逻辑：

```text
Canonical Brand Intelligence
        +
Workspace Relationship
```

不要为每个用户复制一整套相同品牌事实。

同一个品牌：

> 公共事实只有一份。

对不同 Workspace：

> 竞争关系可以不同。

---

# 44. 品牌对象与 URL

品牌 URL 输入只能跳过：

> candidate generation

不能跳过：

- identity resolution
- qualification
- category relevance
- market validation

用户说“这是竞品”可以影响 watchlist / manual override，但系统必须保留：

> 系统资格判断

和：

> 用户人为关注

两种语义。

---

# 45. 品牌跨渠道关系

渠道不同不能直接 disqualify。

允许：

> cross_channel

例如：

- 用户 Shopify DTC
- 对手 Amazon 强势

仍然可能构成真实竞争。

---

# 46. 关系与价格

价格重叠只是竞争关系的一个维度。

不能：

> 只要价格不同就不是竞品。

也不能：

> 只要价格接近就是竞品。

至少还要考虑：

- category
- audience
- market
- channel

---

# 47. 数据源依赖原则

v0 核心能力必须明确 Capability Dependency Matrix。

示例：

| Product Capability | Required Data Capability | Optional Enhancement |
|---|---|---|
| Discovery | Search / Identity / Catalog | Ads / Trends |
| DTC Price Monitoring | DTC Price / Product Identity | Historical external source |
| Amazon Price Monitoring | Amazon Price / ASIN Identity | Ads / Trends |
| Promotion Monitoring | Public Promo Evidence | Ads |
| Core Product Identification | Catalog / Product Line signals | Review / Ads / Demand proxy |

具体矩阵由 05 冻结。

---

# 48. 工程冻结原则

下位文档冻结前必须满足：

1. 不重新定义 Canonical Registry。
2. 不新增同义状态。
3. 不混用 JobEvent / DomainEvent。
4. 不把 UI State 当领域状态。
5. 不把增强数据源写成隐式硬依赖。
6. 不允许没有 Evidence 的用户关键数字。
7. 不允许 correction 静默覆盖历史。
8. 不允许 quiet 绕过 Coverage。
9. 不允许算法把用户目标价用于异常值清洗。
10. 不允许公开商品价格冒充 AOV。
11. 不允许 SSE 成为 authoritative state。
12. 不允许多端重新计算业务结论。

---

# 49. 当前已知必须由下位文档继续冻结的内容

以下内容本基线只定义原则，不写死实现值：

## 02 Data & Algorithm
- Core Product 权重
- Product Line 聚类
- Price Fit 阈值
- Promotion taxonomy
- Confidence 计算
- Coverage 算法

## 03 Backend & API
- REST schema
- SSE seq 唯一作用域
- Scheduler 具体时间
- QualificationResult 持久化
- Retention 生命周期

## 04 Frontend
- Domain State → UI State 映射
- Evidence Drawer
- corrected / retracted UX

## 05 Data Source
- Provider-level capability
- field inventory
- freshness
- quota / cost
- fallback
- GA gate

## 06 QA
- Golden Dataset
- Precision / Recall 阈值
- False Alert Rate
- Quiet Integrity

## 07 Operations
- source outage threshold
- parser regression threshold
- queue lag
- incident severity
- retention execution

---

# 50. 工程事实链总原则

Vantage 的工程正确性必须服从下面这条链：

> **SourceSnapshot → Evidence → Fact → Metric → DomainEvent → Judgment → Projection**

其中：

- 数据源负责“看见什么”
- Evidence 负责“怎么证明”
- Fact 负责“真实发生什么”
- Metric 负责“怎么算”
- DomainEvent 负责“什么变了”
- Judgment 负责“这意味着什么”
- Projection 负责“用户在哪看到”

任何一层都不能越权替代另一层。

这就是 Vantage 的工程冻结基线。

---

# 51. Cost Governance（P0 冻结）

Vantage 是持续运行的数据产品，成本治理属于产品正确性的一部分，而不是上线后的 FinOps 优化。

冻结原则：

1. **Monitoring ≠ Research**。日常监控不得默认重跑完整 Discovery / Enrichment。
2. **Direct-first**。已知目标优先访问直接结构化源 / 官方公开页 / 已解析 provider object，不得先走付费搜索。
3. **No meaningful change → no LLM**。无变化扫描不得触发 Judgment LLM；LLM 只在结构化事实不足、冲突解释或正式 Judgment verbalization 时升级。
4. **Resolved identity must be reused**。已解析的 official domain / ASIN / advertiser id 等必须进入 Canonical Identity，后续监控不得重复执行同一 discovery search。
5. **Paid escalation must be bounded**。retry、fallback、browser/proxy、paid provider 与 LLM 都必须有最大尝试数、最大 fallback 深度或等价 cost ceiling。
6. **每次可计费外部调用必须可归因**到 workspace、watch target（若有）、brand、capability、provider、trigger 与 cost profile。
7. **内部预算不得静默破坏对外承诺**。若预算/配额导致 required P0 capability 未完成，必须进入 degraded / unavailable 并影响 Coverage；不得伪装成 no_change / quiet。
8. Cost 只允许参与 routing / frequency / escalation policy，不得反向篡改已经观测到的事实。

长期核心指标至少包括：

- Variable Intelligence Cost / Active Workspace
- Variable Intelligence Cost / Active WatchTarget
- Paid Escalation Rate
- Canonical Reuse Rate
- Cache/Fingerprint Short-circuit Rate

具体 ledger、budget 与阈值由 03 / 05 / 07 定义。

---

# 52. Canonical Brand Intelligence 持续建库原则

Vantage 必须持续建设 Canonical Brand Intelligence，但默认采用：

> **demand-driven growth，而不是全网品牌普查。**

品牌进入 Canonical 层的主要触发：

- 用户 Discovery / 手动添加
- 已有 Workspace 的 WatchTarget
- 高频类目 / 市场的主动预热
- 已存在 Canonical Brand 的跨渠道 identity 扩展

禁止把“持续建库”实现成：

> 对全球大规模品牌进行无需求、高频、全能力抓取。

公开品牌事实可以跨 Workspace 复用；Workspace 私有关系、用户输入、挑战、备注、优先级与 Judgment Context 不得跨租户共享。

同一公开品牌事实原则上只维护一份 Canonical 版本，再投影给多个 Workspace。

`collection_heat`（hot / warm / cold / archived）只允许作为 05 拥有的**内部采集路由分类**，不是 Canonical business status，不得投影成用户可见品牌生命周期。

---

# 53. Identity Continuity（P0）

长期历史的主键必须是稳定 `brand_id`，不是 name / URL 文本。

Canonical Brand Identity 至少可挂载：

`identity_status` 冻结为：

- `resolved`
- `unresolved`
- `conflicted`

- canonical_name
- aliases
- official_domains
- platform identities
- marketplace identities / ASINs（按市场）
- advertiser/page identities（若接入）
- category / market context

规则：

1. identity unresolved 时不得强行合并。
2. identity merge / split 必须留下可审计映射与版本。
3. URL 变化、域名迁移、平台账号变化不得自动切断历史。
4. 多 Workspace 命中同一 Brand，应优先复用 Canonical Identity，而不是复制品牌实体。

---

# 54. Freshness、Observed History 与 Backfilled History

每个重要事实至少区分：

- `observed_at`：Vantage/Provider 观察该事实的时间
- `source_updated_at?`：来源自身更新时间（若可信可得）
- `collected_at`：采集任务完成时间
- `freshness_status`

不同 capability 使用不同 freshness SLA；不得用全局统一阈值替代字段/能力级 freshness。

历史必须区分，字段名冻结为：

```text
history_origin = observed | backfilled
```

- **Observed History**：Vantage 在当时真实观察并保存的历史
- **Backfilled History**：后来从第三方历史源、旧公开页或其他合法来源补入的历史

Backfilled History 必须保留 provenance，不得在 Timeline 中伪装成“Vantage 当时已观察到”。

---

# 55. Capacity / Backpressure / Provider Degradation

固定扫描时点表达用户语义，不代表所有任务同一分钟同时执行。

实现必须支持：

- bounded queue
- concurrency limit
- provider-specific rate limit
- Workspace fairness
- priority
- jitter / dispatch window
- backpressure

资源不足时优先保障 required P0 capability；P1/P2 enrichment 可延后。

Provider failure 不得无限级联 fallback。达到 retry/fallback/cost ceiling 后，应显式结束为 degraded / unavailable，并进入 Coverage。

---

# 56. Schema / Algorithm / Policy Migration

Vantage 的长期历史要求所有重要模型升级可迁移、可追溯。

至少版本化：

- schema_version
- migration_version
- algorithm_version
- config_version
- parser_version
- coverage_policy_version
- cost_profile_version
- ops_policy_version

Migration 规则：

1. 迁移是正式工程能力，不是临时运维脚本。
2. 迁移不得静默覆盖不可变历史对象。
3. 大规模 backfill / recompute 必须作为可观测 Job 运行。
4. 新旧读模型并存期间必须定义 authoritative source 与 cutover 条件。
5. migration failure 不得产生部分成功但被标记 complete 的状态。

---

# 57. Capability Contract 七维模型

每个正式 Data Capability 至少同时定义：

1. **Accuracy**
2. **Freshness**
3. **Coverage**
4. **Cost**
5. **Failure Mode**
6. **Fallback**
7. **Evidence Strength**

Provider 只是实现 Capability 的路径，不是产品能力本身。

任何 Capability GA 决策不得只看“能不能调通 API”。

---

# 58. 最终工程原则

Vantage 的工程正确性同时受两条链约束：

```text
SourceSnapshot → Evidence → Fact → Metric → DomainEvent → Judgment → Projection
```

以及：

```text
Identity → Canonical Reuse → Freshness/Coverage → Cost-bounded Monitoring → Historical Continuity
```

前者保证“说的是真的”，后者保证“能长期、可持续地一直说真话”。
