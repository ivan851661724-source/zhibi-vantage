# Vantage · 02 Data & Algorithm Spec

**版本：v0.3**  
**状态：评审稿**  
**上位依赖：00 v1.2 / 01 v1.3.3**  
**所有权：数据规则、算法规则、业务判定规则**

---

# 0. 文档边界

本文件定义：

- 数据从 Raw 到 Canonical Fact 的处理规则
- Core Product / Product Line 识别
- Primary Price Band
- Competitor Qualification
- 价格、上新、促销信号判定
- Coverage / Confidence / Evidence
- Analysis / Judgment 的结构化生成规则

本文件不定义：

- 具体 Provider 接口参数（归 05）
- 表结构、REST、SSE（归 03）
- UI 展示（归 04）
- 生产运维（归 07）

共享语义不得重新定义 00 中的 Canonical Registry。

---

# 1. 算法总链路

```text
Raw Snapshot
  ↓
Normalize
  ↓
Entity Resolution
  ↓
Validation
  ↓
Tagging
  ↓
Canonical Fact
  ↓
Derived Metric
  ↓
Product Line / Core Product Identification
  ↓
Competitor Qualification
  ↓
Domain Event
  ↓
Competitive Context
  ↓
Judgment
```

核心原则：

1. Fact 与 Judgment 分离。
2. 用户目标价不得参与异常值清洗。
3. 无来源数据不得“补齐”。
4. unavailable ≠ 0。
5. 抓取失败 ≠ 无变化。
6. LLM 不做准入裁决。
7. 所有可回算对象必须带 algorithm_version / config_version。

---

# 2. Data Quality Gate

每条准备进入 Canonical Fact 的数据依次经过：

## 2.1 Schema Gate

检查：

- 字段存在
- 类型正确
- 数值范围合理
- 时间戳存在
- 市场 / 币种上下文足够
- entity key 可定位

失败：
- 不进入 Canonical Fact
- 保留 Raw Snapshot
- 标记 reason_code

## 2.2 Entity Gate

确认：

- 品牌归属
- 商品归属
- variant 归属
- 平台对象映射
- 同商品 / 同规格条件

不确定时：

> unresolved

不得强行合并。

## 2.3 Business Gate

检测：

- 极端价格跳变
- SKU 数量异常骤降
- 货币错位
- 划线价 / 当前价混淆
- 页面模板值
- 促销文案误判
- 商品状态字段异常

异常数据进入：

> verification_required

不直接发业务事件。

## 2.4 Temporal / Cross-source Gate

对可比字段进行：

- 时间新鲜度检查
- 同市场检查
- 同规格检查
- 同币种归一
- 来源间差异解释

只有归一后仍矛盾，才标记：

> conflicted

---

# 3. Evidence Status

沿用 00：

- verified
- derived
- conflicted
- unavailable

unavailable.reason_code 至少支持：

- not_supported
- source_not_integrated
- fetch_failed
- blocked
- rate_limited
- parse_failed
- insufficient_history
- insufficient_sample
- not_applicable

禁止新增语义相同的平行状态。

---

# 4. Product Line Identification

目标：

> 将一个品牌的大量 SKU 聚合为有业务意义的产品线。

建议输入特征：

- category
- title tokens
- product family / collection
- attributes
- size
- material
- form factor
- use case
- price density
- navigation / collection membership

禁止只用“价格间断”定义产品线。

价格间断仅可作为候选断点。

## 4.1 异常 / 非代表性 SKU 分类

目标不是删除这些 SKU，而是避免它们错误地主导 Core Product 与价格带判断。

| SKU 类型 | 识别依据（示例） | Core Line 处理 | 当前价格带处理 | 历史/证据 |
|---|---|---|---|---|
| Accessory / 配件 | category、title、collection、尺寸/用途 | 默认不参与主产品线竞争评分；可作为独立 accessory line | 不进入主产品价格带 | 保留 |
| Gift Card / 礼品卡 | title/category/固定面额结构 | 永不作为 Core Product | 永不进入 | 保留 |
| Replacement / Spare Part | replacement/spare/refill-only 语义 | 默认不参与主产品线评分 | 不进入主产品价格带 | 保留 |
| Bundle / 套装 | bundle/set/pack 与多商品组成 | 作为独立 Product Line；不得与单品直接混算 | 单独计算 bundle band | 保留 |
| Collector / Limited / Mega 高价收藏版 | edition、size、limited、collector、异常价位 + 产品语义 | 作为独立 line；只有 Importance Score 达标时才可成为 core | 不与 standard line 混算 | 保留 |
| Clearance / Liquidation | 明确清仓语义、异常折扣、临近下架 | 不用于稳定 Core Price Band | 可进入 promotion/history，不进入常态 band | 保留 |
| Discontinued / Archived | 下架、归档、长期不可售 | 不参与“当前” Core Line | 不进入当前 band | 历史保留 |
| Service / Warranty / Non-product | 服务、保修、订阅非商品项 | 排除出商品竞争模型 | 不进入 | 保留原始证据 |

规则：

1. **排除出 Core 计算 ≠ 从品牌目录删除。**
2. 每个排除动作必须保存 `exclusion_reason_code + evidence_ids + classifier_version`。
3. 若分类不确定，标记 `classification_unresolved`，不得强行按异常 SKU 排除。
4. Collector / Bundle 可能是某些品牌真正核心业务，因此只允许“分线”，不允许基于高价本身直接删除。
5. POP MART 类案例必须先区分 standard / accessory / collector 等 line，再计算用户相关 Core Price Band。

---

# 5. Core Product Identification

## 5.1 目标

回答：

> 在用户相关品类中，哪些产品线真正代表该品牌当前主要竞争能力？

输出：

- primary_core_line[]
- secondary_core_line[]
- multi_core flag
- importance_score
- evidence_ids
- identification_status

## 5.2 可用信号与 v0 初始权重

v0 使用以下**初始权重**作为校准起点；它们不是永久业务常数，后续必须用 06 Golden Dataset 按行业校准。

| Signal | 初始权重 |
|---|---:|
| Catalog Share | 0.20 |
| Homepage Prominence | 0.15 |
| Collection Prominence | 0.10 |
| Bestseller Signal | 0.10 |
| Demand Proxy | 0.10 |
| Review Volume Proxy | 0.05 |
| Advertising Share | 0.10 |
| Launch Frequency | 0.10 |
| Product Longevity | 0.05 |
| Restock / Availability Continuity | 0.05 |

总权重 = 1.00。

校准路径：

1. 先用跨行业默认权重跑 Golden Dataset；
2. 按行业分别查看 precision / recall 和误判原因；
3. 只有当行业样本量达到 QA 冻结门槛时，才允许引入行业特定 config；
4. 所有权重变化必须提升 `config_version` 并跑回归；
5. 不允许为了命中某个单一品牌手工改权重。

## 5.3 缺失信号处理

禁止：

> 缺失 = 0 分

应使用：

```text
normalized_score =
sum(available_weight_i * signal_i)
/
sum(available_weight_i)
```

并保存：

- available_signal_count
- available_weight_sum
- confidence

**Tier 依赖规则：**

> v0 Core Product Identification 必须能够仅依赖 Tier A / 核心数据能力完成。

Tier B / Tier C 信号只能增强置信度或消歧，不能成为识别成功的硬依赖。若增强信号缺失，按 available-weight normalization 继续计算，并降低 confidence / coverage，而不是直接失败。

## 5.4 多核心产品线

若第一、第二产品线重要度接近，不强行单核。

允许：

- single_core
- dual_core
- multi_core
- unresolved

---

# 6. Core Product Price

## 6.1 商品代表价与观察单位

默认先在**单个 Product 内**聚合 variants：

> `product_representative_price = median(comparable active variant prices)`

同时保留：

- min_variant_price
- median_variant_price
- max_variant_price
- variant_count

之后计算 Product Line / Core Product Price Band 时：

> **每个 Product 默认只贡献 1 个价格观察点。**

禁止直接把所有 variants 平铺后计算品牌价格带，否则 variant 数量多的商品会对分布产生不合理的重复加权。

只有在存在可验证的销量 / demand 权重时，才允许使用：

> `weighted_product_price_distribution`

并必须标记 `derived + weighting_method + evidence_ids`。

若用户明确指定规格，则优先匹配同规格；找不到可比规格时输出 `incomparable`，不强行使用最低 variant。

## 6.2 主力价格带

优先在 Core Product Line 内计算：

- P25
- Median
- P75
- sample_count

默认：

> Primary Price Band = P25–P75

前提：
- 样本满足最低数量
- 数据已标准化
- 异常值清洗不使用用户目标价

## 6.3 小样本

- sample < 3：不裁决价格竞争关系
- sample 3–19：允许描述性统计，谨慎使用极端值处理
- sample >= 20：可使用配置化 robust outlier 方法

禁止在 sample < 20 时使用：

> user_target_price × 0.15 / ×3

之类目标价驱动清洗。

## 6.4 多峰价格

若价格分布明显多峰：

- 不用全店 median 代表品牌
- 回到 Product Line
- 对用户相关 Core Product Line 单独计算

---

# 7. AOV 边界

公开商品价格不能反推出竞品真实 AOV。

允许：

- Typical Product Price
- Core Product Price
- Primary Product Price Band

禁止：

- Competitor AOV

除非未来取得真实订单级、可验证的数据源。

---

# 8. Competitor Qualification

## 8.1 输入

至少考虑：

- Category Fit
- Core Product Price Fit
- Audience Fit
- Market Fit
- Channel Relation

## 8.2 硬规则

### Category
若相关品类无法成立：
> disqualified

### Price
只使用 Core Product Price / Primary Price Band。

不得使用：
> 全店 min / max

### Channel
渠道不同不能直接淘汰。

可标：
> cross_channel

## 8.3 输出

relationship_type 沿用 00：

- direct
- price_overlap
- cross_channel
- watchlist

qualification_status：

- qualified
- unresolved
- disqualified

## 8.4 解释义务

每个 qualified / disqualified 结果必须保存：

- reason_codes
- evidence_ids
- algorithm_version
- config_version

---

# 9. Price Fit

推荐按“区间关系”而非单点差值判断。

输入：

- user reference price
- competitor primary band
- competitor median
- market
- currency

输出：

- overlap ratio
- relative position
- price_relation

示例语义：

- below_core_band
- lower_edge
- within_core_band
- upper_edge
- above_core_band
- incomparable

阈值由 config 管理，不在 Product PRD 中写死。

---

# 10. Signal Detection

---

## 10.1 Price Change

链路：

```text
Price Fact(t-1)
  ↓
Price Fact(t)
  ↓
Normalize / comparable check
  ↓
Diff
  ↓
price_change_observed
  ↓
optional recheck
  ↓
price_change_confirmed
```

不得把：
- currency change
- variant mismatch
- out-of-stock fallback price
- crossed-out MSRP

误判为真实降价。

---

## 10.2 New Product

最低要求：

- 新 product identity
- 可验证当前存在
- 有合理首次观察时间

若平台提供发布时间，可作为增强证据。

抓到新 URL 但 entity 已存在：
> 不算新品

---

## 10.3 Promotion Change

支持语义：

- percent_off
- amount_off
- sitewide_sale
- bogo
- bundle
- free_shipping_threshold
- subscribe_and_save
- coupon
- other_verified_promo

要求：

- 明确 promotion fact
- source evidence
- 有效时间上下文尽可能记录

---

# 11. Observed / Confirmed

产品承诺“当天到”，因此：

> observed 事件可以先进入用户可见面。

后续复查结果：

- confirmed
- reverted
- corrected
- retracted

Observed 与 Confirmed 必须是两个语义，不得混为一个 status。

---

# 12. Coverage

Coverage 是一级业务对象。

最少需要：

```text
expected_targets
attempted_targets
successful_targets
qualified_successful_targets
source_failures
window_start
window_end
```

quiet gate 至少要求：

1. monitoring window 完成
2. coverage 达到配置阈值
3. 无 verified / actionable event

### v0 默认 Quiet Coverage Threshold

为了符合 01 的信任承诺，v0 初始值冻结为：

> **100% 的 active P0 WatchTargets 在该 Daily Window 内完成其 required P0 capability coverage。**

也就是说，只要一个正式监控对象的必需 P0 核心信号因 blocked / timeout / parse failure 等没有完成，就不得生成“全部无变化”的 quiet 声明。

允许发送：

> “已完成 X/Y；已完成部分未发现重要变化，剩余对象覆盖不足。”

后续若要把阈值降低到 <100%，必须同时满足：

- 06 Golden Dataset / production audit 证明不会显著增加 Quiet Integrity 风险；
- Product + Data + Backend 三方评审；
- 提升 `coverage_policy_version`；
- 更新 01 产品承诺文本。

否则只能说：

> 覆盖不足，无法确认无变化。

---

# 13. Freshness

不同事实按 capability 定义 freshness SLA。

原则：

- price / promo：高 freshness
- new product：高 freshness
- review：低频
- profile metadata：更低频

每个关键事实至少保留：

```text
observed_at
source_updated_at?
collected_at
freshness_status
freshness_policy_version
```

`observed_at` 与 `collected_at` 不得混用；缓存返回也不得刷新 source observation time。

freshness_status 沿用 00：

- fresh
- stale
- unknown

超过 capability SLA 的事实可继续展示，但必须进入 stale；不得继续作为“刚发生”事件的唯一证据。

---

# 14. Analysis Pipeline

禁止：

> LLM 直接读取 Raw Snapshot 后自由生成结论。

正式链：

```text
Verified Fact
  ↓
Derived Metric
  ↓
Competitive Context
  ↓
Historical Context
  ↓
Structured Judgment
  ↓
LLM verbalization
```

LLM 只能：

- 重写
- 摘要
- 组织
- 解释已有结构化判断

不得：

- 发明数字
- 补不存在来源
- 自行改变竞争资格
- 自行改变 EvidenceStatus

---

# 15. Judgment

每个 Judgment 至少保存：

- judgment_type
- subject
- time_window
- competitor_set_id
- competitor_ids
- excluded_ids
- metrics
- evidence_ids
- source_snapshot_ids
- algorithm_version
- config_version
- created_at

并生成 JudgmentSnapshot。

---

# 16. 落点判断

允许输出：

- 当前价格处于核心竞品带低 / 中 / 高位置
- 某价位下竞争对象数量
- 某价格区间密度
- 核心对手近期价格带变化
- 可选竞争落点及其竞争含义

禁止：

- 有肉吃
- 一定能赚钱
- 最优价格
- 直接替用户下定价指令

---

# 17. Historical Context

历史至少支持：

- rolling 7d
- 30d
- 60d
- 90d
- 180d

趋势判断必须区分：

- 一次性事件
- 重复行为
- 长期结构变化

90 天回溯必须区分：

> historical correctness

和：

> later market change

---

# 18. 算法版本化

所有重要计算输出必须带：

- algorithm_version
- config_version
- computed_at

算法升级后：

- 可回算
- 可比较
- 不静默覆盖旧 Judgment

---

# 19. P0 验收

1. 同一品牌含极端 SKU 时，不被全店 min/max 误导。
2. Core Product Line 能说明“为什么”。
3. Competitor Qualification 每个结果可追证据。
4. 用户目标价不参与异常值清洗。
5. 无销量权重时，不声称“销量加权价格”。
6. unavailable 不转成 0。
7. observed / confirmed 分离。
8. quiet 必须经过 coverage gate。
9. LLM 不可改变事实。
10. 任何用户数字可追 Evidence。
11. no meaningful change 不进入 LLM Judgment。
12. 已解析 brand identity 可复用，不因 Workspace 不同重复建立同一 Canonical Brand。
13. Observed History 与 Backfilled History 可区分。
14. stale fact 不冒充 fresh。
15. identity unresolved 不强行 merge。

---

# 20. 待专项验证

下一轮算法评审必须重点确认：

- Product Line 聚类方法
- Core Product Importance 权重
- multi-core 阈值
- Price Fit 关系算法
- Promotion detection taxonomy
- false alert gate
- coverage 阈值
- confidence 展示策略

---

# 21. Identity Resolution / Merge-Split

Identity Resolution 是进入 Canonical Brand Intelligence 的前置 P0。

输入可包括：

- canonical / candidate name
- official domain
- marketplace identity
- ASIN / seller / store identity
- social / advertiser identity
- category / market context
- alias / redirect / historical mapping

输出至少：

```text
brand_id
identity_status: resolved | unresolved | conflicted
matched_identifiers[]
reason_codes[]
evidence_ids[]
algorithm_version
computed_at
```

规则：

- 缺信号 ≠ 不同品牌；
- 同名 ≠ 同品牌；
- URL redirect / rebrand / domain migration 必须允许历史 continuity；
- merge / split 是版本化决策，不静默重写旧 Fact/Event 的 subject identity；
- unresolved 不进入强共享 Canonical facts。

---

# 22. Observed History vs Backfilled History

所有历史记录增加 provenance 语义：

```text
history_origin = observed | backfilled
origin_source
observed_at?        # observed 才要求是当时实际观察
source_timestamp?   # backfilled 可用来源历史时间
backfilled_at?
```

Backfill 可以用于趋势分析，但必须让算法知道其来源强度和时间语义。

禁止：

> 把 10 月 1 日才取得的第三方 7 月历史数据，标成“Vantage 7 月 1 日已观察”。

---

# 23. Cost-aware Escalation Algorithm

算法层冻结停止条件：

```text
L0 fingerprint / cheap probe
  ↓ unchanged
STOP

L0 changed / uncertain
  ↓
L1 direct structured collection
  ↓ enough evidence
PERSIST FACT / DIFF

still unresolved / conflicted
  ↓
L2 paid provider / second source
  ↓
L3 structured judgment + optional LLM verbalization
```

要求：

- `no_change` 必须来自成功、可比较的观测，不得来自 failure；
- fingerprint 相同只允许短路该 fingerprint 覆盖的字段，不得推断未覆盖 capability 也无变化；
- paid escalation 的触发原因必须结构化记录；
- 成本预算只影响是否继续 escalation，不改变已有事实值。

---

# 24. Canonical Reuse / Shared Public Facts

当多个 Workspace 关注同一 `brand_id × market × capability` 时：

- 公共网页 / 平台公开事实允许共享 collection result；
- 允许复用仍满足 freshness SLA 的 Canonical Fact / SourceSnapshot；
- Workspace-specific qualification / judgment / priority 仍分别计算；
- 若 Workspace 需要更高 freshness 或不同 market，则不得错误复用不满足 scope 的结果。

复用判定至少考虑：

```text
brand_id
market
capability
entity scope
freshness SLA
collection policy version
```
