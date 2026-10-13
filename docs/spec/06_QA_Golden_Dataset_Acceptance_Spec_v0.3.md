# Vantage · 06 QA / Golden Dataset / Acceptance Spec

**版本：v0.3**  
**状态：评审稿**  
**上位依赖：00 v1.2 / 01 v1.3.3 / 02 v0.3 / 03 v0.3 / 04 v0.3 / 05 v0.3**  

---

# 1. 目标

Vantage 不是“页面能打开”就算通过。

必须验证：

- 数据准不准
- 核心产品识别准不准
- 竞品资格准不准
- 事件误报率是否可接受
- quiet 是否可靠
- Evidence 是否完整

---

# 2. Golden Dataset

建议首批三个行业：

- 潮玩 / 收藏品
- 美妆
- 宠物营养

每类：

> 20–30 个品牌

至少总计 60 个品牌。

---

# 3. 人工标注内容

每品牌至少标：

- brand identity
- domain
- target categories
- product lines
- core product line
- primary price band
- representative products
- outlier SKUs
- competitor relationship for sample workspaces
- current price
- known launches
- known promotions

---

# 4. Workspace Test Cases

不能只做“品牌真值”。

还要构建多个用户上下文：

```text
Workspace A:
category = collectibles
price = $50
market = US

Workspace B:
category = premium collectibles
price = $300
market = US
```

同品牌在不同 Workspace 下可能不同 qualification。

---

# 5. 核心指标

## Core Product Precision
系统识别的核心产品线中，人工认可比例。

## Core Product Recall
人工认可核心线中，系统找出的比例。

## Competitor Qualification Precision
系统判 qualified 的品牌中，人工认可比例。

## Competitor Qualification Recall
人工认可竞品中，系统找出的比例。

## Price Accuracy
对当前价格和主力价格带的偏差。

## Product Matching Accuracy
跨渠道 / variant 匹配正确率。

## New Product Precision
系统新品事件中真实新品比例。

## Promotion Precision
系统促销事件中真实促销比例。

## False Alert Rate
错误业务警报 / 全部警报。

## Evidence Completeness
用户可见关键事实中拥有有效 evidence 的比例。

## Quiet Integrity
系统声称 quiet 的窗口中，事后发现重大漏报的比例。

## 5.1 01 §31 信任护栏 → 测量口径

| 护栏指标 | 分子 | 分母 | 测量方式 | v0 目标 |
|---|---|---|---|---:|
| Evidence Traceability | 可从用户可见定量声明一路解析到有效 Evidence → SourceSnapshot 的声明数 | 全部用户可见定量声明数 | 事件/判断生成时全量自动校验；每日审计 | 100% |
| Evidence Completeness | 按规格要求应带 evidence 且实际带有 ≥1 有效 evidence 的事实/判断数 | 所有按规格要求必须带 evidence 的事实/判断数 | 自动全量 | 100% |
| Correction ≤24h Rate | `error_confirmed_at` 后 24h 内已发 correction/retraction 的错误数 | 统计期内所有已确认错误且已到 24h deadline 的错误数 | 自动全量 | 100% |
| Challenge Review SLA | challenge 创建后 1 个工作日内得到确认/否定/初步结论的 challenge 数 | 已到 SLA deadline 的 challenge 数 | 自动全量 | 100% |
| Quiet Coverage Compliance | 生成 quiet 时满足 coverage_policy_version 对应 gate 的 digest 数 | 全部 quiet digest 数 | 自动全量 | 100% |
| Failure Transparency Rate | 影响用户可见 coverage/capability 的 source failure 被正确投影为 partial/degraded/unavailable 的次数 | 所有影响用户可见结果的 source failure 次数 | 自动日志 + 每周抽样 | 100% |
| Correction Completeness | correction/retraction 同时包含 original_event_id、reason_code、new/corrected state、timestamps、evidence chain 的记录数 | 全部 correction/retraction 数 | 自动 schema check | 100% |
| False Alert Rate | 人工/后续复核确认错误的业务警报数 | 全部业务警报数 | 全量纠错 + 抽样复核 | 首轮 Golden 后冻结 |
| Core Product Accuracy | 符合 Golden 标注的 core-line 预测 | Golden core-line cases | Golden regression | 首轮 Golden 后冻结 |
| Qualification Precision | 人工认可的 qualified 结果 | 系统所有 qualified 结果 | Golden + production sample | 首轮 Golden 后冻结 |
| Freshness SLA Compliance | 在 capability SLA 内的用户可见关键事实数 | 所有需要 freshness SLA 的用户可见关键事实数 | 自动全量 | 首轮生产 baseline 后冻结 |
| Cost Attribution Completeness | 有完整 workspace/brand/capability/provider/trigger/cost_profile 归因的 paid calls | 全部 paid external calls | ledger 自动审计 | 100% |
| No-change No-LLM Compliance | 未检测 meaningful change 且未触发 LLM 的 monitoring executions | 全部确认 no-change 的 monitoring executions | trace/ledger 自动审计 | 100% |
| Backfill Provenance Completeness | 正确标记 history_origin/source_timestamp/backfilled_at 的 backfilled records | 全部 backfilled records | schema + UI audit | 100% |
| Canonical Reuse Correctness | 被复用且 scope/freshness/identity 全部匹配的 shared collections | 全部 canonical reuse executions | 自动 + 抽样 | 100% |
| Fallback Cost Bound Compliance | 未超过 retry/fallback/cost ceiling 的 executions | 全部触发 fallback 的 executions | ledger 自动审计 | 100% |

**Traceability 与 Completeness 不同：**

- Completeness：有没有挂 evidence。
- Traceability：这条 evidence 能不能真正解析到来源事实和 snapshot。

只做到“有 evidence_id 但打不开/断链”不得计入 Traceability。

---

# 6. 回归集

任何以下变化必须跑 Golden Regression：

- parser 更新
- source adapter 更新
- Core Product 算法更新
- qualification 配置更新
- promotion taxonomy 更新
- price normalization 更新

---

# 7. 版本比较

每次算法升级输出：

- old precision / recall
- new precision / recall
- regression count
- category-level breakdown

禁止只看总平均。

---

# 8. 人工复核抽样

生产中持续抽样：

- 新发现竞品
- 高影响价格变化
- 高影响促销
- correction / retraction
- conflicted data

形成真实线上质量集。

---

# 9. 承诺 ↔ 测量口径映射

| 产品/工程承诺 | 主要规格来源 | QA 测量 |
|---|---|---|
| 数字带来源 | 01 / 02 / 04 | Evidence Traceability + Completeness |
| 空报认账 | 01 / 03 / 07 | Challenge Review SLA + Correction ≤24h + Correction Completeness |
| 没动静也说一声 | 01 / 02 / 03 | Quiet Coverage Compliance + Quiet Integrity |
| 警报当天到 | 01 / 03 / 07 | scan schedule lag + event projection latency + notification enqueue latency |
| Core Product 不能被极端 SKU 误导 | 01 / 02 | Core Product Precision/Recall + abnormal-SKU cases |
| 竞品资格可解释 | 02 / 03 / 04 | Qualification Precision + QualificationResult evidence completeness |
| Source failure 不得冒充无变化 | 02 / 05 / 07 | failure injection + Failure Transparency Rate |
| Monitoring ≠ Research / No-change no LLM | 00 / 01 / 02 / 05 | No-change No-LLM Compliance |
| Freshness 对用户可见 | 00 / 02 / 04 | Freshness SLA Compliance + stale UI tests |
| Backfill 不冒充 observed history | 00 / 01 / 02 / 04 | Backfill Provenance Completeness |
| 成本可归因且 fallback 有界 | 00 / 03 / 05 / 07 | Cost Attribution + Fallback Cost Bound |
| Canonical 公共事实复用不泄露私有数据 | 00 / 03 / 05 | reuse correctness + tenant isolation tests |

## 9.1 P0 场景 ↔ 规格验收映射

| QA 场景 | 02 | 03 | 04 | 05/07 |
|---|---|---|---|---|
| 极端 SKU $1–$500 | §4.1/§5/§6 | QualificationResult 持久化 | 核心价格带展示 | Golden fixture |
| 多核心产品线 | §5.4 | Result snapshot | Profile 展示 | Golden fixture |
| sample <3 | §6.3 | insufficient_evidence | partial/unavailable | — |
| Shopify partial scan | Data quality/coverage | Coverage | partial | 05 Shopify |
| Amazon stale offer | freshness | Fact metadata | stale | 05 Keepa |
| 页面抓取失败 | unavailable | Coverage/Error | degraded | 07 source incident |
| currency change | normalization | Fact versions | evidence | 05 source context |
| variant mismatch | entity gate | Evidence/Fact | conflicted | provider fixture |
| 瞬时促销消失 | observed/confirmed | DomainEvent | corrected/reverted | recheck |
| observed → reverted | §11 | immutable events | event history | 07 |
| coverage 不完整 | §12 | Coverage | no quiet | 07 |
| correction/retraction | §11/§15 | append-only | corrected/retracted | 07 SLA |

---

# 10. Release Gate

P0 Release 前至少要求：

- Evidence Traceability = 100%
- correction workflow tested
- quiet coverage gate tested
- duplicate event = 0 in retry tests
- source failure ≠ no-change
- paid call cost attribution = 100%
- no-change no-LLM compliance = 100%
- backfilled history provenance = 100%
- canonical reuse tenant isolation tested
- retry/fallback cost ceiling tested
- schema migration rollback/retry path tested
- Core Product / Qualification 达到内部冻结阈值
- false alert rate 达到内部冻结阈值

具体数值在首轮 Golden Dataset 完成后冻结，不能凭空设定。

---

# 11. Challenge Feedback Loop

用户 challenge 应进入 QA 数据。

分类：

- true system error
- ambiguous
- user preference mismatch
- stale data
- unsupported capability

用于：

- algorithm tuning
- source quality tuning
- UX clarification

---

# 12. P0 测试场景

必须覆盖：

1. 品牌有 $1–$500 极端 SKU。
2. 品牌多核心产品线。
3. 样本 < 3。
4. Shopify partial scan。
5. Amazon stale offer。
6. 页面抓取失败。
7. currency change。
8. variant mismatch。
9. 促销瞬时消失。
10. observed 后 reverted。
11. coverage 不完整。
12. correction/retraction。
13. no-change scan 不调用 LLM。
14. identity 已解析后 recurring monitoring 不重复 discovery search。
15. 同一 brand 被 20 个 Workspace watch，只产生合格的 canonical shared public collection。
16. Backfilled Amazon/第三方历史与 observed history UI/算法区分。
17. stale fact 超 SLA。
18. primary provider 失败导致 fallback storm，必须在 ceiling 停止。
19. 06:00 高峰 10× 基线任务量，队列 backpressure + Workspace fairness。
20. migration 中断后幂等重试与 reconciliation。
21. canonical identity merge/split 后历史 continuity。

---

# 13. Cost / Scale Test Matrix

必须至少有三类负载测试：

1. **normal monitoring**：绝大多数 no-change，验证 direct/fingerprint short-circuit；
2. **provider incident**：验证 retry/fallback 不产生费用风暴；
3. **schedule burst**：固定窗口同时到期，验证 bounded concurrency / fairness / lag。

成本 QA 不用永久写死美元阈值，但必须验证：

- ledger 完整；
- cost profile 版本正确；
- optional escalation 可降级；
- promised P0 coverage 不被内部预算静默跳过。

---

# 14. Migration / Historical Continuity Acceptance

每次 schema / algorithm / identity migration 至少验证：

- row/object counts reconciliation；
- old → new identifier mapping；
- SourceSnapshot/Evidence 引用不丢；
- DomainEvent/Judgment immutable history 不被覆盖；
- observed/backfilled provenance 保留；
- partial/failed migration 可重试；
- cutover 后 authoritative read model 唯一。
