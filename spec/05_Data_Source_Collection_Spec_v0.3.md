# Vantage · 05 Data Source & Collection Spec

**版本：v0.3**  
**状态：评审稿**  
**上位依赖：00 v1.2 / 01 v1.3.3 / 02 v0.3 / 03 v0.3**  
**所有权：Provider、采集能力、字段、频率、失败、fallback、成本与上线状态**

---

# 0. 核心原则

本文件按：

> **数据能力（Capability）**

组织，而不是按：

> 接了多少 API

组织。

核心链不得依赖增强源才能成立。

同时冻结：

> **Monitoring ≠ Research；Direct-first；No-change → no paid escalation / no LLM。**

---

# 1. Capability Map

P0：

- Brand Discovery
- Brand Identity
- Product Catalog
- Current Price
- Product Line Inputs
- New Product Detection
- Promotion Detection
- Historical Snapshot
- Evidence URL

P1：

- Amazon Historical Price
- Review / Rating
- Ad Activity
- Inventory / Stock

P2：

- Search Interest
- Sales Proxy
- GMV Proxy

---

# 2. Provider Dependency Class

继承 00：

## Core / Tier A
v0 Discovery / 基础监控成立所必需。

## Enhancement / Tier B
提升覆盖、历史或准确性。

## Optional / Tier C
丰富分析，不得阻塞核心链。

若 Tier B/C 失败：

> 降级能力，而不是让整个任务失败。

---

# 3. Search / Discovery Sources

当前已有：

- Serper
- Tavily
- Brave Search
- Bocha
- generic fetchPage

用途：

- 候选品牌发现
- 官网识别
- 品牌实体解析
- 搜索补充证据

禁止：

> 把搜索结果 snippet 当成最终业务事实。

搜索结果只用于：
- discovery
- routing
- evidence candidate

已解析出稳定 Identity（official domain / ASIN / advertiser id 等）后，Recurring Monitoring 默认禁止重复执行同一 identity discovery search；只有 identity conflict / stale mapping / source failure 需要重新解析时才允许升级。

---

# 4. Generic Web Fetch

要求：

- public URL only
- redirect <= 3
- 每跳 DNS / IP 安全校验
- SSRF 防护
- timeout
- cache
- parser version
- content limits

Raw Snapshot 至少记录：

- requested_url
- final_url
- status_code
- fetched_at
- content_hash
- parser_version
- source_status

---

# 5. Shopify / DTC

## 5.1 目标能力

- Product Catalog
- Variant
- Current Price
- Availability
- Collection
- Product family signal
- New product observation
- Promotion context
- Homepage / bestseller / collection prominence

## 5.2 products.json

允许作为公开目录数据源之一。

要求：

- 分页完整枚举
- 若无法完整枚举，必须标 partial_scan
- 不再使用“只取前 60 个 SKU”作为默认
- limit / pagination 由 05 具体 adapter 实现

## 5.3 Shopify 边界

不得声称从公开商品接口获得：

- 真实订单 AOV
- 近 30 日真实成交价
- 真实销量
- 真实 GMV

允许：

- 当前公开商品价格
- variant 价格
- availability
- Vantage 自建历史观察价格

## 5.4 DTC HTML

作为补充能力：

- homepage
- collection
- promo banner
- shipping threshold
- bundle
- sale page
- bestseller label

HTML 事实必须保留 selector / extraction context。

---

# 6. Amazon

正式监控 Amazon 某信号时，该信号对应数据能力为条件性核心依赖。

候选 Provider：

- Keepa
- 其他未来 provider

能力目标：

- ASIN identity
- current price
- price history
- review count
- rating
- BSR
- offer freshness
- product title / category

Amazon 数据必须记录：

- marketplace
- ASIN
- observed_at / source timestamp
- freshness
- seller / offer scope（若相关）

禁止：

> 把评论数直接叫销量。

允许：

> sales_proxy

---

# 7. Meta Ads

能力目标：

- brand / page identity
- active ads
- first_seen
- last_seen
- creative references
- country
- query context

采集架构应允许：

- browser bootstrap
- direct HTTP / structured endpoint
- browser fallback

不在产品规格里写死：

> 必须住宅代理
> 必须 Playwright

代理与浏览器策略以 benchmark 决定。

---

# 8. TikTok / Google Ads

作为 P1/P2 增强源。

每接入一个 provider，必须先写：

```text
capability
fields
market coverage
freshness
rate limit
cost
known failures
fallback
GA status
```

未达到生产验收前：

> 不得在产品层承诺持续监控。

---

# 9. Google Trends

定位：

> 搜索兴趣信号

不是：

- 销量
- GMV
- 绝对搜索量

记录：

- geo
- keyword/topic
- time range
- normalized interest
- observed_at

---

# 10. Source Adapter Contract

每个 Adapter 必须统一输出：

```text
source_id
capability
entity_keys
raw_snapshot_id
observed_at
source_timestamp?
market
currency?
fields
source_status
freshness
parser_version
error_code?
```

---

# 11. Source Status

建议统一：

- success
- partial
- unavailable
- blocked
- rate_limited
- parse_failed
- timeout
- internal_error

SourceStatus 不等于 EvidenceStatus。

---

# 12. Collection Policy

核心监控默认：

- price：3 次 / 天
- promotion：3 次 / 天
- new product：2–3 次 / 天
- review / rating：1 次 / 天或更低

三次核心巡检的默认时点**不在 05 重复定义**，统一引用 03：

> Workspace target market timezone：06:00 / 14:00 / 22:00

变化后：

> 对该对象定向复查

而不是全局提频。

日常 monitoring 默认执行 cost-aware path：

```text
L0 fingerprint / cheap probe
L1 direct structured collection
L2 paid recheck / second source
L3 structured judgment + optional LLM
```

只有前一级无法确认 meaningful change / conflict 时才升级。

---

# 13. Cache

缓存必须按 capability 设置。

原则：

- 高 freshness 信号短缓存
- profile / identity 长缓存
- Raw Snapshot 保留窗口由 03/07 联合冻结

缓存命中不得伪造：

> 最新观察时间

必须区分：

- source_observed_at
- fetched_at
- cache_served_at

另外必须维护：

- Identity cache：长 TTL，事件/冲突可主动失效
- Fingerprint cache：用于 no-change 短路，但只覆盖其声明的 capability/fields
- Canonical collection cache：允许多个 Workspace 复用同一公开事实

---

# 14. Fallback

每个 capability 至少定义：

- primary source
- fallback source
- no-fallback behavior

示例：

```text
Brand Discovery:
Search A → Search B → Search C

DTC Product Catalog:
Shopify JSON → sitemap/collection → HTML partial

Price:
structured product source → verified HTML
```

fallback 不得改变事实语义。

每个 capability 还必须定义：

- `max_attempts`
- `max_fallback_depth`
- `max_cost_per_execution` 或等价预算

达到 ceiling 后必须结束为 unavailable/degraded，不得无限继续尝试。

---

# 15. Source Quality Score

Source Quality 不直接决定用户结论，但用于：

- routing
- verification priority
- conflict resolution

建议考虑：

- directness
- freshness
- structure
- historical reliability
- market specificity
- entity specificity

---

# 16. 成本模型 / Cost-aware Routing

每个 Provider / Operation 必须记录：

- request unit / token model
- quota / rate limit
- cost profile version
- expected retry factor
- expected fallback factor
- cost per monitored brand/day
- cost per active WatchTarget
- cost per paying Workspace

所有 paid operation 必须可映射到 03 `ExternalCallLedger`。

商业套餐定价前必须跑：

> Unit Economics Simulation

默认路由原则：

1. free/owned direct source 优先；
2. 已知 identity 直接访问对象，不重复搜索；
3. no-change 在最低可确认层停止；
4. paid search / external history / browser/proxy / LLM 只按 trigger 升级；
5. optional P1/P2 能力可按 plan/cost budget 降级；
6. required P0 能力若因 budget/provider 不可用，必须影响 Coverage。

---

# 17. GA Gate

一个数据源能力进入正式产品承诺前必须满足：

- coverage 达标
- accuracy 达标
- latency 达标
- failure transparency
- fallback 明确
- cost 可承受
- 生产监控已接

---

# 18. Source Matrix 模板

| Capability | Provider | Tier | Accuracy | Freshness | Coverage | Cost | Evidence Strength | Failure/Fallback | GA |
|---|---|---:|---|---|---|---|---|---|---|
| Brand discovery | Serper/Tavily/Brave/Bocha | A | provider-index dependent | near-real-time routing only | market/query dependent | configured | routing-only | quota/sparse → fallback | partial |
| DTC catalog | Shopify/public web | A | high when complete | high | domain-dependent | low infra | strong/direct | partial/blocked → HTML | target |
| DTC price | Shopify/public web | A | high when entity/currency valid | high | domain-dependent | low infra | strong/direct | blocked/parse → verified HTML | target |
| Amazon history | Keepa | B/conditional A | provider-specific | provider-specific | marketplace/ASIN dependent | configured | structured external history | quota/stale → explicit degrade | target |
| Ads | Meta | C/P1 | benchmark required | medium | supported markets | configured | platform evidence | anti-bot/schema → approved fallback | TBD |
| Search interest | Trends | C | normalized signal | low/medium | geo/topic dependent | low/configured | contextual only | sparse/unavailable → none | TBD |

具体状态由上线评审更新。

---


# 19. Provider 实例规格

以下是 v0.3 必须维护的 provider-level 实例表。价格/额度类字段易变化，**禁止在本规格写死未经采购确认的数字**；成本以 provider dashboard / contract 为运行时事实源，并由 `cost_profile_version` 管理。

## 19.1 Serper

| 项 | 定义 |
|---|---|
| capability | Brand discovery / web search / official-domain candidate |
| key fields | organic.title, organic.link, organic.snippet, rank |
| market | 由 gl/hl 等查询参数约束 |
| freshness | search-engine dependent；不作为业务事实 freshness |
| rate limit | provider-plan dependent |
| cost | procurement/runtime config |
| known failures | 401/403 credential, 402 quota/billing, 429 rate limit, sparse results |
| fallback | Tavily → Brave → Bocha（路由可配置） |
| GA | Discovery 可用；不可直接作为最终业务事实 |

## 19.2 Tavily

| 项 | 定义 |
|---|---|
| capability | Discovery / search enrichment |
| key fields | results.url/title/content/score, optional answer |
| market | query-driven；地理精度需额外验证 |
| freshness | search-index dependent |
| rate limit | provider-plan dependent |
| cost | procurement/runtime config |
| known failures | quota/rate limit, answer summarization not evidence-grade |
| fallback | Serper / Brave / Bocha |
| GA | Discovery enhancement；summary 不进入 Canonical Fact |

## 19.3 Brave Search

| 项 | 定义 |
|---|---|
| capability | Discovery / fallback search |
| key fields | result URL/title/description |
| market | query + locale dependent |
| freshness | search-index dependent |
| rate limit | provider-plan dependent |
| cost | procurement/runtime config |
| known failures | quota/rate limit, low recall for niche brands |
| fallback | Serper / Tavily / Bocha |
| GA | Discovery fallback |

## 19.4 Bocha

| 项 | 定义 |
|---|---|
| capability | Discovery / Chinese-query enrichment |
| key fields | web results / summary candidates |
| market | query dependent |
| freshness | provider-index dependent |
| rate limit | provider-plan dependent |
| cost | procurement/runtime config |
| known failures | quota/rate limit, summary不可作为最终事实 |
| fallback | Serper / Tavily / Brave |
| GA | Discovery enhancement |

## 19.5 Generic fetchPage

| 项 | 定义 |
|---|---|
| capability | Public-web raw fetch |
| key fields | final_url, status, headers subset, html/text, content_hash |
| market | target URL |
| freshness | fetch-time |
| rate limit | per-domain policy |
| cost | infra + proxy if used |
| known failures | blocked, timeout, redirect loop, JS-only content, parser mismatch |
| fallback | structured adapter / browser adapter where approved |
| GA | Core collection primitive |

安全要求：

- redirect <= 3
- 每跳 DNS/IP 检查
- SSRF 防护
- public URL only
- parser_version 必填

## 19.6 Shopify Public Catalog Adapter

| 项 | 定义 |
|---|---|
| capability | Product catalog / variants / public price / availability inputs |
| key fields | product id/handle/title/vendor/product_type/tags/variants price/availability 等可公开字段 |
| market | storefront/domain context |
| freshness | scan-time |
| rate limit | domain-specific / adaptive |
| cost | infra |
| known failures | 403, 429, products.json 不可用, pagination incomplete, storefront customization |
| fallback | sitemap/collection crawl → verified HTML partial |
| GA | Core/Tier A，前提是 completeness 标记正确 |

规则：

- 必须分页或标 `partial_scan`
- 不读取/声称真实订单 AOV、真实销量、近30天真实成交价

## 19.7 Keepa Adapter

| 项 | 定义 |
|---|---|
| capability | Amazon identity / price history / BSR / review proxy / offer context |
| key fields | ASIN, marketplace, price/history series, review/rating/BSR 等 provider 可用字段 |
| market | Amazon marketplace-specific |
| freshness | 字段级；必须保存 provider/source timestamp |
| rate limit | token/quota model，运行时配置 |
| cost | procurement/runtime config |
| known failures | token exhaustion, stale offer, missing history, ASIN mismatch |
| fallback | no equivalent v0 full-history fallback；可降级为当前公开页面事实（若允许） |
| GA | Conditional core only for已承诺的 Amazon signal |

规则：

- current offer 必须检查 freshness / last-seen 类时间信息
- 评论数只可作为 demand/sales proxy，不叫销量

## 19.8 Meta Ads Adapter

| 项 | 定义 |
|---|---|
| capability | Ad activity / page identity / active creative evidence |
| key fields | page/brand identity, active status, first_seen/last_seen, creative ref, country/query |
| market | platform-supported |
| freshness | scan/provider dependent |
| rate limit | provider/browser path dependent |
| cost | infra/provider dependent |
| known failures | login/bootstrap changes, anti-bot, endpoint/schema changes, incomplete coverage |
| fallback | browser path / alternate approved collection path |
| GA | P1 enhancement until production benchmark passes |

## 19.9 Google Trends Adapter

| 项 | 定义 |
|---|---|
| capability | Search-interest context |
| key fields | geo, query/topic, time range, normalized interest |
| market | geo-specific |
| freshness | lower-frequency |
| rate limit | implementation dependent |
| cost | infra/provider dependent |
| known failures | normalization ambiguity, sparse data, unsupported geo/topic |
| fallback | none; mark unavailable |
| GA | P2 context only |

规则：

> Search interest ≠ sales ≠ GMV ≠ absolute search volume.

## 19.10 TikTok / Google Ads Transparency

v0.3 先维护 capability placeholder：

- provider/collection path
- field inventory
- market coverage
- freshness benchmark
- rate limit
- cost
- failure modes
- fallback
- GA gate

在以上九项未完成前：

> 不得在 01/04 宣称正式持续监控。

---

# 20. P0 验收

1. 任何 source failure 不可转成“无变化”。
2. Shopify partial scan 必须显式。
3. Amazon source 必须记录 marketplace。
4. Search snippet 不可直接成为最终业务事实。
5. 增强源不可阻塞 v0 核心链。
6. cache 不覆盖真实 observed_at。
7. 每个正式 capability 都有 fallback 或明确无 fallback 行为。
8. 已解析 Identity 的 recurring monitoring 不重复做默认 discovery search。
9. no-change 路径不触发 LLM。
10. retry/fallback 达 ceiling 后停止并显式降级。
11. paid provider call 可追到 ExternalCallLedger。
12. canonical public collection 能被多个 Workspace 合法复用。
13. fingerprint 相同不得错误覆盖未包含字段。
14. Provider/Source policy 未通过不得进入 GA。

---

# 21. Capability Contract（强制模板）

任何正式 capability 都必须维护以下七维：

```text
Accuracy
Freshness
Coverage
Cost
Failure Mode
Fallback
Evidence Strength
```

建议扩展字段：

```text
required_identifiers
cache_policy
fingerprint_policy
retry_policy
cost_ceiling
GA_status
owner
```

未填齐不得进入正式产品承诺。

---

# 22. Fingerprint / Differential Collection

对于 Shopify catalog、homepage promotion、公开产品页等允许：

1. 规范化目标字段；
2. 去除已知 volatile noise；
3. 计算 capability-scoped fingerprint；
4. 与上一成功 observation 比较；
5. 相同则短路后续解析/LLM；
6. 不同才进入 field-level diff / verification。

必须保存：

- fingerprint_version
- covered_fields
- previous_snapshot_id
- current_snapshot_id

禁止：

> “页面 hash 相同” ⇒ 所有 capability 都 no_change。

---

# 23. Canonical Brand Collection Policy

Canonical Brand Intelligence 采用 demand-driven + heat-based collection。

05 可使用 00 已允许的内部 `collection_heat` 路由分类：

```text
hot
warm
cold
archived
```

它不是用户可见业务状态。

heat 可参考：

- active watcher count
- recent user interest
- recent events
- capability cost
- strategic preload policy

原则：

- hot brand 可共享高频 public collection；
- warm brand 按标准 policy；
- cold brand 不因曾经被发现就永久高频抓；
- 新 Workspace 关注 cold brand 时可重新激活。

---

# 24. Source Use / Compliance Gate

每个 Adapter 上线前必须确认：

- 数据是否为公开可访问或经授权访问；
- Provider/平台条款是否允许对应用途；
- 合理 rate limit / robots / access policy（适用时）；
- 允许保存哪些原始内容、保存多久；
- 是否包含不必要的个人数据；
- 是否允许跨 Workspace 复用；
- 是否需要 attribution / deletion / audit 能力。

不满足合规要求的采集路径不得仅因为“技术上能抓到”就进入 GA。
