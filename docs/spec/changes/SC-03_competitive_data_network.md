# SC-03 Spec Change：竞争数据网络与品牌长期记忆

**状态：提案，待产品与独立技术审核；不得据此宣称能力已实现或已上线**  
**日期：2026-10-18**  
**提案基线：review/data-surface-foundation @ 35a6061100b05784220fc694daf2682d75aeee0f**  
**上位依赖：00 v1.2、01 v1.3.3、02–07 v0.3、SC-01、SC-02**  
**影响范围：产品评审稿、02 数据与算法、03 后端、04 前端、05 数据源、06 QA、07 运维；00 的事实链与 EvidenceStatus 不变**

---

## 0. 提案目的

Vantage 已冻结并部分实现以下基础：

- SourceSnapshot → Evidence → Fact → Metric → DomainEvent → Judgment；
- Canonical Brand Intelligence 与 Workspace × Brand Relationship 分离；
- Monitoring ≠ Research、Direct-first、No-change 不调用 LLM；
- WatchTarget、MonitoringWindow、Coverage 与三态日报；
- SC-02 的 Capability Registry、Source Adapter、CollectionAttempt、Data Surface 和持久任务。

下一阶段需要把广告、社媒、KOL、评论、流量受众和平台经营估算接入同一品牌档案。当前规格虽列出 Ads、Review、Sales Proxy 和 GMV Proxy，但没有冻结完整的数据面、来源性质、指标计算条件、用户表达和发布门槛。

本提案只建立统一合同和实施顺序。供应商接口未完成样本验收和展示许可确认前，相关 capability 保持 not_integrated 或 benchmark，不得向用户承诺已覆盖。

---

## 1. 产品边界

### 1.1 数据范围

Vantage 采集和处理：

- 竞争品牌官网、公开商品页、公开落地页和公开评论；
- 平台官方透明接口允许取得的数据；
- 获得授权的数据服务；
- 允许使用和保存的网页历史档案；
- 上述资料形成的确定性计算和有原文支持的语义提取。

### 1.2 用户输入

用户只需提供：

- 品牌、品类、市场；
- 可选官网、商品或平台账号；
- 关注对象和监控范围；
- 用于 Workspace 判断的参考商品、价格和备注。

产品不要求用户接入自己的订单、广告账户、CRM、ERP、客户名单或支付资料。用户私有上下文不得进入公共品牌事实或外部查询。

### 1.3 非目标

Vantage 不：

- 自动定价、投放、发布内容、联系达人或执行经营决策；
- 绕过登录、验证码、访问控制或其他技术限制取得数据；
- 把数据商估算称为竞争品牌内部真实账目；
- 使用 LLM 生成花费、销量、转化率、收入、GMV、CAC、AOV、ROI 或 ROAS 数字；
- 因缺少数据而用 0 填充；
- 将搜索摘要作为最终业务事实。

---

## 2. 数据面与 Capability Map

SC-02 的 dimension 是产品层分组，不是领域状态。本提案扩展为以下目标数据面；尚未接入的维度保持明确占位。

| dimension | 用户可见内容 | 目标 capability | 首批来源方向 |
|---|---|---|---|
| website_products | 官网、商品、价格、促销、可售状态 | catalog、offer、price、promotion、availability | 自建公开网页/Shopify adapter、DTC 数据服务 |
| ad_intelligence | 广告素材、文案、CTA、落地页、投放时间、地区、受众、花费估算 | ad_creative、ad_delivery、ad_audience、ad_spend_estimate | 官方透明接口、授权广告情报服务 |
| social_content | 官方账号、帖子、视频、直播、公开互动 | social_account、social_post、social_engagement | 官方接口、授权社媒/电商数据服务 |
| creator_kol | 达人身份、主题、受众、品牌合作、公开带货表现 | creator_profile、creator_audience、brand_collaboration、creator_commerce | 授权 KOL 数据服务、平台电商数据 |
| reviews_reputation | 评论、评分、主题、问题和卖点 | review_record、rating、review_topic | 平台接口、公开品牌站、授权评论数据 |
| traffic_audience | 流量、渠道、地区、设备、年龄性别、兴趣 | web_traffic、channel_mix、audience_demographics | 授权网站情报服务 |
| marketplace_commerce | 商品、销量/订单/收入/GMV/转化估算 | marketplace_catalog、sales_estimate、revenue_estimate、gmv_estimate、conversion_estimate | Amazon、TikTok Shop 等授权数据服务 |
| search_interest | 搜索词、热度、趋势 | keyword_demand、search_interest | 搜索数据服务、趋势数据 |
| brand_timeline | 跨数据面的连续变化与缺口 | canonical_event_timeline、history_backfill | Vantage 自建观察、供应商历史、网页档案 |

新增 dimension 和 capability 必须通过 Registry 登记。前端禁止维护另一份能力清单。

---

## 3. 数据取得优先级

同一字段按以下顺序路由：

1. 已确认的直接公开来源；
2. 平台官方透明接口；
3. 获得授权的结构化数据服务；
4. 允许使用的网页历史档案；
5. 使用已取得输入的确定性计算；
6. 有原文证据的语义提取。

“优先级”不等于可信度总分。直接来源可能过期，数据服务可能覆盖更完整；最终结果仍须通过时间、市场、对象、字段和方法检查。

搜索服务只用于 discovery、identity routing 和 evidence candidate。身份已确认后，周期监控默认复用已知来源，不重复搜索。

---

## 4. 首批数据源候选矩阵

以下为候选接入方向，不代表采购完成、GA 或永久绑定。接入前须以真实账号调用、样本覆盖和合同为准。

| 来源 | 目标能力 | 主要字段 | 数据性质 | 角色 |
|---|---|---|---|---|
| Vantage 公开网页采集 | 官网商品、价格、促销、落地页、评论 | URL、HTML/JSON、商品、规格、价格、可售、文案、时间 | direct_observation | 核心直接源 |
| Similarweb API | 流量、渠道、受众、转化、网站收入估算、Amazon 零售数据 | visits、channels、demographics、conversion、revenue 等 | licensed_estimate | 站点与 Amazon 经营估算 |
| Sensor Tower Pathmatics / Connect | 广告素材、展示、投放时间、花费和受众估算 | creative、copy、landing、first/last seen、spend、impressions、audience | licensed_estimate | 跨平台广告主源 |
| TikTok Commercial Content API | 广告、广告主、素材、时间、触达和部分受众 | ad id、creative、reach、targeting、advertiser | official_disclosure | 官方核验与支持地区主源 |
| Meta Ad Library / Google Transparency | 广告主、素材和透明字段 | advertiser/page、creative、dates、regions | official_disclosure | 核验与补充；字段和地区依官方范围 |
| Modash API | KOL 发现、内容、受众和品牌合作 | creator、audience、engagement、sponsored content | licensed_estimate / direct_public | KOL 主源 |
| YouTube Data API | 频道、视频、播放互动和评论 | channel/video/comment、statistics、publishedAt | official_disclosure | YouTube 公开内容 |
| FastMoss 或 Kalodata | TikTok Shop 商品、店铺、达人、视频、直播和 GMV/销量趋势 | shop/product/creator/video/live、sales、revenue/GMV | licensed_estimate | TikTok Shop 主源；主备需 POC 裁决 |
| Keepa | Amazon 商品、价格历史、offer、BSR | ASIN、price history、offer、rank | licensed_provider_record | Amazon 价格历史 |
| Jungle Scout | Amazon 销量和收入估算 | sales、revenue、keyword、share of voice | licensed_estimate | Amazon 经营估算 |
| DataForSEO | Amazon 商品、搜索与评论 | product、rank、rating、review text | licensed_provider_record | Amazon 评论与搜索补充 |
| Particl | DTC 商品、价格、促销、库存与收入估算 | product、price、promotion、inventory、revenue | licensed_estimate | 独立站增强；覆盖需 POC |
| Serper / Tavily / Brave / Bocha | 域名、账号、商品和落地页发现 | URL、title、snippet、rank | discovery_only | 不进入最终定量事实 |
| Wayback / Common Crawl | 历史网页补全 | archived URL、timestamp、raw content | archive_backfill | 冷启动历史；不得冒充当时观察 |

每个 provider 进入 Registry 前必须登记 supported_objects、markets、fields、history、refresh、freshness、rate_limit、failure、fallback、retention、cost attribution、license_scope、collector/parser 版本和 maturity。

---

## 5. Canonical Brand 与平台身份

现有 Canonical Brand Intelligence 保持公共事实复用方向。SC-02 的项目级 BrandSourceIdentity 是当前实现切片，不自动等于全局 Canonical Identity。

目标模型：

~~~text
CanonicalBrand
├─ brand_id
├─ names / aliases
├─ categories / markets
├─ official domains
├─ platform identities[]
│  ├─ platform
│  ├─ account_type
│  ├─ platform_account_id
│  ├─ market
│  ├─ identity_status
│  ├─ evidence_ids
│  └─ valid_from / valid_to
└─ merge / split history

WorkspaceBrandRelationship
├─ workspace_id
├─ brand_id
├─ category_scope
├─ market
├─ relationship_type
├─ watch scope
└─ private notes / reference context
~~~

约束：

- identity_status 继续使用 resolved / unresolved / conflicted，不新增 candidate；
- 同平台允许多个地区账号、店铺、广告主体和经销商身份；
- 身份合并与拆分必须版本化并保留历史；
- Canonical 公共事实与 Workspace 私有关系分库存储或具备等价硬隔离；
- 供应商许可不允许跨租户复用时，即使对象相同也不得共享受限数据。

迁移前，SC-02 的项目级 identity 保持有效；不得破坏性删除或静默提升为全局身份。

---

## 6. Adapter Contract 扩展

沿用 SC-02 五方法：supports、resolveIdentity、collect、normalize、health。

新增能力要求：

- adapterStrategy：single、fallback 或 fanout；
- providerRecordIds：保留供应商记录标识；
- sourceTimestamp 与 periodStart/periodEnd 分离；
- measurementMethod；
- methodologyVersion；
- licenseScope；
- retentionClass；
- fieldCoverage；
- pagination / partialScan；
- estimateRange 或 providerConfidence（仅供应商实际提供时保存）；
- raw asset reference、content hash 与 snapshot ids；
- ExternalCallLedger 成本归因。

normalize 不得把供应商估算改写为 direct Fact。Adapter 输出先进入 Raw/Provider Record，再根据字段性质生成 Evidence、Fact 或 Metric。

---

## 7. 来源与计算元数据

EvidenceStatus 继续只有 verified、derived、conflicted、unavailable。以下是正交元数据，不是新可信状态：

| measurement_method | 含义 | 可进入对象 |
|---|---|---|
| direct_observation | Vantage 从直接公开来源观察到 | Fact |
| official_disclosure | 平台官方透明接口披露 | Fact 或 Metric，取决于字段 |
| licensed_provider_record | 数据服务返回的记录型字段 | Fact 或 Metric，按供应商语义 |
| licensed_estimate | 数据服务模型估算 | Metric |
| deterministic_derivation | 使用可追溯输入和公式计算 | Metric |
| semantic_extraction | 从原文提取主题、卖点或标签 | Fact candidate / Metric，不得产生定量经营值 |
| archive_backfill | 后来从历史档案补入 | Fact/Metric，同时 history_origin=backfilled |
| discovery_only | 只用于发现和路由 | 不进入最终 Fact/Metric |

每条 Metric 至少保存：

- metric_code、brand_id、platform、market；
- value / value_min / value_max 与 currency/unit；
- period_start / period_end、observed_at、source_timestamp、computed_at；
- measurement_method、methodology_version、algorithm_version、config_version；
- source_snapshot_ids、evidence_ids、provider_record_ids；
- coverage、freshness、sample_size；
- input_metric_ids（派生指标）；
- limitations。

---

## 8. 指标命名与计算准入

### 8.1 广告花费

estimated_ad_spend 只接受官方披露或授权数据服务估算。输出必须包含平台、市场、周期、币种、来源和估算标签。多个来源方法或范围不同，保留多值，不直接平均。

### 8.2 获客成本

只有获得可比的广告花费与新增转化人数时，才计算：

~~~text
estimated_customer_acquisition_cost
= estimated_ad_spend / estimated_new_converted_customers
~~~

如果分母只是 converted visits、orders 或 transactions，指标分别命名为 acquisition_cost_proxy、cost_per_converted_visit 或 cost_per_order，不称真实 CAC。

### 8.3 客单价与平均售价

~~~text
estimated_aov = estimated_revenue / estimated_order_count
average_selling_price = estimated_revenue / estimated_units_sold
~~~

缺少 order_count 时不得用 units_sold 冒充订单数。单位、退货、税费、地区和周期必须一致。

### 8.4 转化率

优先采用供应商直接给出的 conversion estimate；自行计算时必须确认 numerator 与 denominator 属于同一平台、市场、时间和流量范围：

~~~text
estimated_conversion_rate
= estimated_converted_visits / estimated_visits
~~~

无法确认口径时保留供应商原始值，不二次计算。

### 8.5 ROAS 与 ROI

~~~text
estimated_roas
= estimated_attributed_revenue / estimated_ad_spend
~~~

没有可归因收入不得计算 ROAS。没有成本、利润、退货等完整输入不得计算或展示竞争品牌真实 ROI。任何供应商名为 ROI 的字段必须先核对方法，映射时保留原始定义。

### 8.6 GMV 与收入

estimated_gmv / estimated_revenue 按平台、市场、周期和来源分别保存。不同供应商、独立站和 marketplace 之间不得无条件相加。跨来源综合值需要单独批准的融合方法、误差评估和版本。

### 8.7 价格定位

价格定位使用同品类、同市场、同币种、同购买条件的可比商品，通过确定性分位、价格带或距离计算。用户参考价格不参与竞品原始样本清洗。

### 8.8 用户画像

只保存聚合人群分布和兴趣标签，不构建可识别个人档案。来源可包括网站受众、广告公开受众、KOL 受众与评论主题；不同类型分别展示，不强行合成“唯一真实用户”。

---

## 9. 原始素材、页面与历史

广告图片、视频、落地页、社媒内容和商品页面必须优先保存稳定标识、来源 URL、观察时间、内容哈希和允许的快照引用。

素材 URL 可能过期时：

- 在许可允许范围内保存归档或派生缩略图；
- 记录原始 URL 与资产哈希；
- 记录下载失败和过期；
- 不把外部 URL 失效当成广告不存在。

历史来源分为：

- observed：Vantage 当时观察；
- provider_history：供应商提供的历史记录或估算；
- archive_backfill：后来从网页档案补入；
- recomputed：从已有 Snapshot 使用新算法重算。

四类历史不得合并为无法区分的一条时间线。DomainEvent 使用当时可用事实；后续补采如需改变旧结论，通过 correction/retraction 处理。

---

## 10. 多来源归一与冲突

来源融合依次检查：

1. 是否同一品牌和平台身份；
2. 是否同一商品、广告、账号或达人；
3. 市场、币种、规格和购买条件；
4. 统计周期与时间粒度；
5. 数据性质和供应商方法；
6. 字段定义、范围和单位；
7. 来源独立性。

只有可比字段仍矛盾时才标 conflicted。两个搜索服务找到同一网页不算两份独立证据；两个转载页面也不能自动提高可信度。

默认交付：

- 直接观测与供应商估算分别保留；
- 方法不同的供应商估算分别保留；
- 用户可查看来源、周期、适用范围和限制；
- 未批准融合算法前不强选或平均成唯一值。

---

## 11. 目标 API 与投影

本节为目标合同，未实现前不得写入 architecture/02_现行API契约.md。

~~~text
GET /api/brands/:brandId/data-surfaces
GET /api/brands/:brandId/products
GET /api/brands/:brandId/ads
GET /api/brands/:brandId/social-content
GET /api/brands/:brandId/creators
GET /api/brands/:brandId/reviews
GET /api/brands/:brandId/metrics
GET /api/brands/:brandId/timeline
GET /api/metrics/:metricId/provenance
POST /api/data-surface/refresh
GET /api/admin/data-sources/capabilities
GET /api/admin/data-sources/health
~~~

所有端点必须：

- 租户身份和 Workspace 关系校验；
- 公共事实复用时不泄露其他 Workspace；
- 支持 platform、market、period、measurement_method 筛选；
- 分页、稳定排序和幂等刷新；
- 失败、缺口、stale、partial 和 conflict 不被空数组吞掉；
- 普通用户响应不包含 provider secret、服务器路径和内部堆栈。

---

## 12. 前端目标

不新增一级导航。现有情报档案中的品牌详情逐步扩展以下数据面：

- 总览；
- 商品与价格；
- 广告素材；
- 社媒内容；
- KOL 与品牌合作；
- 评论与卖点；
- 流量与受众；
- 平台经营估算；
- 历史时间线；
- 来源与计算说明。

所有定量卡片显示平台、市场、周期、更新时间和数据性质。估算值不得与直接观测使用相同视觉标签；范围值不得擅自压成单点。

未接入、无覆盖、失败、样本不足、过期和来源冲突分别展示。未知 summary.kind 继续走诚实的通用渲染，不由前端推断业务含义。

---

## 13. 采集频率与任务

频率按 capability、provider 更新周期和监控等级配置，不在产品文案写死为全局值。初始验证方向：

- 官网商品、价格、促销与可售：重点对象每日多次；
- 广告素材与投放状态：每日一至两次或按供应商更新周期；
- 社媒与 KOL：每日一次，重点对象可提高；
- 评论：每日一次或增量；
- marketplace 销量、收入和 GMV 估算：每日或按供应商周期；
- 网站流量、转化与受众：按数据服务的周/月更新周期；
- 历史回填：低优先级独立队列。

每次采集继续使用 CollectionAttempt、持久任务、租约、fencing、幂等键、cooldown、quota 和 cost attribution。Provider 更新慢于刷新请求时，复用有效数据并明确更新时间，不制造“新鲜”时间戳。

---

## 14. 许可、合规与保留

技术可获取不等于允许进入产品。每个 provider 和 collection path 必须登记：

- 允许的用途；
- 是否允许向终端用户展示；
- 是否允许保存原始素材或响应；
- 保留期限；
- 是否允许跨 Workspace 复用；
- 地区限制；
- 删除或到期处理；
- 审核证据与合同版本。

公开网页采集遵守现有 SSRF、robots、限速、并发、内容大小和安全闸门。封闭平台优先使用官方或授权数据服务；不实现绕过登录、验证码或访问控制的采集路径。

---

## 15. POC 与 GA Gate

接入前建立真实品牌样本，至少覆盖：

- 20 个目标品牌；
- 独立站、Amazon 和 TikTok Shop；
- 至少两个目标市场；
- 大、中、小不同数据量品牌；
- 广告活跃和不活跃品牌；
- 多地区站点、同名品牌和经销商案例。

每个 capability 的 POC 报告必须包含：

- identity 成功率和误配案例；
- 品牌/市场/字段覆盖率；
- 历史跨度和更新延迟；
- 原始字段示例；
- 缺失、空值、错误和限流；
- 数据性质与方法说明；
- 与独立来源对照的偏差；
- 展示和保存许可；
- 单次与周期调用成本归因；
- 是否达到 benchmark / ga。

GA 至少要求：

- 用户可见定量声明 100% 可追溯；
- 不支持、失败、partial、stale 与 conflict 正确传播；
- 公式输入和版本可回算；
- 两租户隔离与 Canonical 复用正确；
- LLM 无定量经营值生成路径；
- 供应商许可确认；
- Golden Dataset 与生产抽样达批准阈值。

---

## 16. 迁移与实施顺序

### Phase A：规格与 POC

- SC-02 独立审核并裁决；
- 本 SC-03 产品、数据、工程、设计评审；
- 20 品牌真实数据 POC；
- 冻结首批 provider 与 capability；
- 确认展示和保留许可。

### Phase B：数据地基

- Canonical Brand 与项目级 identity 迁移映射；
- Provider Registry 与 field-level capability；
- Provider Record / Metric provenance；
- 原始素材与快照引用；
- 历史来源和方法元数据；
- 非破坏性 migration 与 reconciliation。

### Phase C：真实纵向切片

按独立分支逐批接入：

1. 官网与 DTC；
2. 网站流量与受众；
3. 广告；
4. 社媒与 KOL；
5. Amazon；
6. TikTok Shop；
7. 评论；
8. 历史回填。

每批至少包含 adapter、真实样本、Evidence/Metric、API projection、前端、两租户隔离、失败路径和 QA。

### Phase D：派生指标与报告

原始和供应商指标稳定后，再实现价格定位、AOV/ASP、获客成本代理值、ROAS、GMV 对照、用户画像和跨数据面报告。任何公式先进入 02 和 06，再进入产品展示。

---

## 17. 受影响规格

审核通过后按职责更新：

- 01：产品范围、用户表达、页面和验收；
- 02：来源性质、指标公式、冲突和 LLM 边界；
- 03：Canonical Brand、Provider Record、Metric、API、任务和迁移；
- 04：品牌档案数据面、指标标签、来源抽屉和缺口状态；
- 05：provider 矩阵、adapter、字段、市场、频率、失败、fallback、许可和 maturity；
- 06：20 品牌 POC、估算误差、身份、素材、公式与证据验收；
- 07：provider health、schema drift、素材过期、许可到期、回填队列和事故处置。

00 的事实链、EvidenceStatus、正交状态、价格术语、Coverage 和 correction/retraction 继续生效。本提案不新增与其同义的领域状态。

现行 architecture/ 文档只描述已经运行的系统。相关代码合并后再更新，不得提前把目标设计写成当前事实。

---

## 18. 待裁决事项

| 编号 | 事项 | 推荐方向 |
|---|---|---|
| D-01 | 首批网站情报供应商 | Similarweb 进入真实 POC；未确认合同前保持 benchmark |
| D-02 | 首批广告主源 | Pathmatics 类授权数据服务为主，官方透明接口核验 |
| D-03 | TikTok Shop 主备 | FastMoss 与 Kalodata 用同一品牌样本对照后只选一个主源 |
| D-04 | Amazon 组合 | Keepa 负责价格历史，Jungle Scout/Similarweb Ecommerce 负责经营估算，DataForSEO 负责评论补充 |
| D-05 | DTC 经营估算 | Particl 先做覆盖 POC，不把官网抓取冒充销量或收入 |
| D-06 | 公共数据复用 | 只有身份、范围、新鲜度与许可一致时复用 |
| D-07 | 估算融合 | 首期保留多值，不建立未经验证的综合真值 |
| D-08 | ROI 命名 | 不展示竞争品牌真实 ROI；满足输入时展示预估 ROAS |
| D-09 | 用户自有数据 | 不要求、不依赖、不接入，保持外部竞争情报边界 |
| D-10 | 新一级页面 | 不新增；先扩展现有情报档案 |

---

## 19. 验收结论规则

- 规格、许可、POC 或关键质量门槛未完成：PROPOSED / PARTIAL，不得写 PASS；
- 接口能返回数据但字段语义、身份或展示权未确认：不可 GA；
- 只有 mock 或固定 fixture：不可宣称真实数据源已接入；
- 任何定量结果无法回到供应商记录、SourceSnapshot/Evidence 或公式输入：不可展示；
- 仍有 P0 数据污染、跨租户或密钥泄漏风险：不可上线该 capability。
