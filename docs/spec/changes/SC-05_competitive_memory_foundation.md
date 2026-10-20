# SC-05 · Competitive Memory Foundation（竞品时序数据库地基）

**状态**：已实现（随 `review/competitive-memory-foundation` 分支，未合并 main）
**日期**：2026-10-19
**上位依赖**：00 v1.2（工程基线）、01 v1.5.0（产品宪法）、02–07 v0.3、SC-01（collector/parser 版本分离）、SC-02（Data Surface 采集基础设施）、SC-03（Competitive Data Network）、SC-04（核心情报主闭环）
**服从关系**：与 SC-04 冲突处以 SC-04 与 v1.5 宪法为准；本变更**不把任何未真实成功的链路标记为已接通**。

---

## 1. 目标与边界

### 1.1 目标

把 Vantage 从「展示当前一次调研结果」升级为「持续积累、可按时间回溯、每条事实可打开来源的竞品数据库」。

本阶段建立四件地基：

1. **时序数据模型**：对象（entity）→ 不可变版本（version）→ 原子事实（fact）→ 确定性事件（event）。
2. **历史回补框架**：可恢复的后补任务 + Shopify 公开目录第一条真实回补路径。
3. **时序档案 UI**：品牌档案从「当前卡片」升级为「带覆盖缺口说明的时序档案」。
4. **最小接入**：情报库、机会视图、报告只消费已核验的时序事实与派生事件。

### 1.2 产品边界（冻结）

- Vantage 只记录**公开、可追溯的外部竞争与市场信息**。
- 不接入商家的 ERP、订单、广告账户、支付、CRM、店铺后台或任何私有经营数据。本阶段无任何用户经营数据入口。
- 不替用户做经营决策；机会视图与报告一律声明「待验证线索，非经营建议」。
- 每个展示事实必须能区分：**直接观察 / 历史存档观察 / 授权数据服务返回 / 系统推导事件**（见 §3）。
- 本阶段不把估算伪装为直接事实：无证据即不入已核实历史，无法确认即标「无法确认」。

### 1.3 不做（本轮硬禁止）

- 接入用户经营数据（GMV、订单、ROI、获客成本、广告花费、转化率）。
- 把观察不到的数据填成 0。
- 为广告、社媒、评论、趋势建立第二套孤立时序存储（这些维度仍只有 Data Surface 一层；本阶段时序库只承载商品与目录）。
- 把网页存档或第三方数据服务标成「官方直接数据」。
- 跨租户共享事实读取。
- 全量爬取任意品牌过去两年所有网页。
- 只展示 mock 时间线的页面。
- 大规模视觉重构、新一级导航。

---

## 2. 双时间语义（冻结）

每条时序记录至少四个时间字段：

| 字段 | 定义 | 允许为 null |
|---|---|---|
| `effective_at` | 来源页面/内容发布时间，或存档快照对应的**实际时间** | 是（仅 `captured_only` / `unknown`） |
| `observed_at` | Vantage 实际获取该来源的时间 | 否 |
| `recorded_at` | 写入本地数据库的时间 | 否 |
| `time_precision` | `exact` / `day` / `month` / `captured_only` / `unknown` | 否 |

### 硬规则

1. **今天抓到的历史网页快照，不得写成「今天发生」**。archived 观察的 `effective_at` = 存档快照时间（`day` 精度），`observed_at` = 本次抓取时间。
2. 只有来源明确给出发布时间、快照时间或有效时间时，才可填 `effective_at`；`products.json` 的实时采集不提供「价格何时变动」，故 live 观察一律 `effective_at=null` + `time_precision=captured_only`。
3. 无法判断实际发生时间时，`effective_at=null`，UI 展示为「Vantage 于 {observed_at} 观察到」。
4. **不得为画连续曲线补齐不存在的日期**。任何两点之间没有中间点时，图不插值、不画斜线到不存在的中间日期。
5. `time_precision` 描述的是 `effective_at` 的精度；`effective_at=null` 时不得写 `exact`。

---

## 3. 来源类型与覆盖状态（冻结词表）

### 3.1 来源类型 `source_kind`

| 值 | 用户语言 | 含义 |
|---|---|---|
| `live_observation` | 直接观察 | Vantage 本次直接采集该页面 |
| `archived_observation` | 历史存档观察 | 公开网页存档中的历史版本 |
| `licensed_dataset` | 授权数据服务 | 合规数据服务返回（本阶段未接入时序） |
| `derived_event` | 系统推导事件 | 由多个已验证事实确定性计算的变化 |

### 3.2 覆盖状态 `coverage_state`

按维度 × 时间区间给出，五态：

| 值 | 用户语言 |
|---|---|
| `verified` | 有可核验证据 |
| `partial` | 部分覆盖 |
| `source_unavailable` | 来源不可用 |
| `not_started` | 未开始采集 |
| `unknown` | 无法确认该时间区间 |

**「无记录」绝不等于「没有变化」。** 任何零结果文案不得写成「无变化 / 没有变化 / 0 条变化」。

---

## 4. 数据表（competitive_memory.db，独立库）

独立 SQLite 文件 `competitive_memory.db`，WAL、`busy_timeout=5000`、加法迁移（`PRAGMA user_version`）。
**不触碰** `brands.db`、`data_surface.db`、Evidence、Snapshot、Fact、DomainEvent、Watch 数据。

所有表必须有 `tenant_id` + `project_id` + `competitor_id` 三列，读取一律三列硬过滤。

### 4.1 `memory_entities`

| 列 | 说明 |
|---|---|
| `entity_id` | 主键 |
| `tenant_id` / `project_id` / `competitor_id` | 作用域 |
| `canonical_brand_key` | 品牌级稳定键（已核验官网域名为准），跨项目去重的**预留**字段，本阶段不合并 |
| `entity_type` | `product` / `brand_catalog` |
| `source_platform` | `shopify` 等 |
| `external_id` | 平台侧稳定 ID（Shopify product id） |
| `entity_key` | 作用域内稳定键（域 + 平台 + 稳定 id/handle） |
| `display_name` | 展示名 |
| `first_seen_at` / `last_seen_at` | 首次/最近观察到 |
| `created_at` / `updated_at` | 记录时间 |

唯一键：`UNIQUE(tenant_id, project_id, competitor_id, entity_key)`。
商品键必须由**真实 product id 或 handle + 已核验店铺域名**构成，**不得只用商品标题**。

### 4.2 `entity_versions`（不可修改）

| 列 | 说明 |
|---|---|
| `version_id` / `entity_id` | 主键 / 外键 |
| `tenant_id` / `project_id` / `competitor_id` | 作用域 |
| `source_snapshot_ids` / `evidence_ids` | JSON 数组，真实引用 |
| `source_url` / `final_url` | 来源 |
| `source_kind` | §3.1 |
| `effective_at` / `observed_at` / `recorded_at` / `time_precision` | §2 |
| `normalized_payload` | 该版本的完整可展示状态（JSON） |
| `content_hash` | 归一化载荷哈希 |
| `parser_version` | 解析器版本（≠ collector） |
| `created_at` | |

唯一键：`UNIQUE(tenant_id, project_id, competitor_id, entity_id, content_hash)`。
**相同对象、相同内容不重复写入**：内容未变时只推进 `memory_entities.last_seen_at`，不产生新版本、不产生事件。

### 4.3 `temporal_facts`

事实类型（本阶段）：

- 商品级：`product.price` / `product.currency` / `product.available` / `product.title`
- 目录级：`catalog.product_count` / `catalog.price_min` / `catalog.price_max` / `catalog.price_median`

每行必须回链：`entity_version_id`、`evidence_ids`、`snapshot_ids`、四个时间字段、`value_num`/`value_text`、`unit`、`currency`、`value_hash`、`measurement_method`、`source_status`、`comparable`。
**缺 Evidence 或 SourceSnapshot 的事实不得写入已核实历史**（写入前强校验，缺失即拒绝）。

### 4.4 `derived_timeline_events`

只是**投影**，不是新真值来源。本阶段仅允许三类：

| `event_type` | 条件 |
|---|---|
| `product_price_changed` | 同一 entity、同币种、同规格签名（variant 数）、两次均为可比成功采集 |
| `product_first_observed` | 该 entity 首次进入本作用域 |
| `product_availability_changed` | 连续、可比的成功采集中 available 翻转 |

禁止：目录中位价变化冒充单品价格变化；一次缺失/抓取失败/换页/缺口解释为下架；partial 采集产生可售状态事件。

每行保存 `derived_from_fact_ids`、`algorithm_version`、`evidence_ids`（入口）、`snapshot_ids`、`effective_at`/`observed_at`/`time_precision`。

### 4.5 `history_backfill_jobs`

| 列 | 说明 |
|---|---|
| `job_id` | 主键 |
| `tenant_id` / `project_id` / `competitor_id` / `capability` | 作用域 |
| `requested_from` / `requested_to` | 请求时间范围 |
| `source_route` | `web_archive` 等 |
| `status` | `pending` / `running` / `done` / `partial` / `failed` / `source_unavailable` / `no_archive_record` / `dead` |
| `checkpoint` | 断点（已处理月份游标） |
| `attempts` | 领取次数 |
| `discovered_count` / `fetched_count` / `imported_count` / `skipped_count` | 计数 |
| `coverage_summary` | JSON（覆盖区间、缺口、失败分类） |
| `error_user_text` | 用户文案（无 URL/路径/栈/密钥/内部码） |
| `claim_token` / `claim_expires_at` | 租约（重启恢复） |
| `created_at` / `started_at` / `finished_at` | |

纪律：

- 相同品牌 + 能力 + 时间范围、**运行中**任务幂等复用，不产生第二个任务。
- 终态不可被后续 worker 覆盖。
- 重启后可恢复或如实标 `dead`（不永久 `running`）。
- 上限：每月最多 1 个有效快照、默认最多 24 个历史点。

---

## 5. 第一条真实链路：Shopify 当前积累 + 网页存档回补

### 5.1 当前积累（live）

现有 Shopify catalog 成功/部分采集在 `SourceSnapshot → Evidence → attempt` 落账**之后**追加写入 Memory。**不得为接入 Memory 再抓一次，也不得生成第二份原始快照。**

降级规则（按现有真值链规则，如实降级，不写完整已核实历史）：

| 场景 | 处理 |
|---|---|
| Evidence 创建失败 / Snapshot 不可读 | 不写 Memory（attempt 已按既有规则失败） |
| 采集 `partial` | 写入，但 facts 标 `quality.partial_scan=true`、`comparable=false`，不产生事件 |
| 币种未知 | 写入 price 事实但 `currency=null`、`comparable=false`，不产生价格事件 |
| 对象身份不稳定（无 id 且无 handle） | 跳过该对象并在 coverage 记 `identity_unstable` |

### 5.2 历史回补（web archive MVP）

仅处理已核验 Shopify 店铺的已知目录 URL（`https://<domain>/products.json`）：

1. 用户在品牌档案显式发起「回补历史」；
2. 后端请求公开网页存档索引（CDX）；
3. 按时间分桶（每月 1 点）、内容去重（digest）、严格限速；
4. 抓取历史 `products.json` 原始内容；
5. 复用同一 Shopify 解析器规范化；
6. `effective_at` = 存档快照时间（`day`）；`observed_at` = 本次抓取时间；
7. 原始存档响应落 SourceSnapshot（provider `web_archive`），建立 Evidence 后才写历史事实；
8. 前端标「历史存档观察」，可打开原始来源。

限制：不得绕过 SSRF / FetchGate / 重定向 / 大小限制；不得把存档抓取日期当原始发生时间；无法确认的页面不入已核实事实库；存档无记录或来源不可用时如实落 `no_archive_record` / `source_unavailable`。

---

## 6. API 契约

所有接口：tenant `Authorization` 鉴权 + `projectId` 归属校验 + 品牌必须已关联该项目；跨项目/跨租户统一 `404`，不泄露存在性；响应不含文件路径、密钥、调用栈、内部错误码。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/brands/:brandId/memory` | 时序事实 + 版本 + 引用 + 精度 + 来源 + 覆盖 + 游标。参数 `projectId`（必填）、`from`/`to`、`entityType`、`factTypes`、`cursor`、`limit` |
| GET | `/api/brands/:brandId/timeline` | 已核实直接观察 + 历史存档观察 + 确定性事件 + 覆盖缺口。参数 `projectId`、`from`/`to`、`limit` |
| GET | `/api/brands/:brandId/history-coverage` | 按维度返回最早可用时间、最后成功采集、已覆盖/部分覆盖/无法确认区间、来源与证据数量 |
| POST | `/api/brands/:brandId/history-backfill` | 参数 `projectId`、`capability`、`from`、`to`。仅 `shopify_catalog` 受支持，其余返回 `400 CAPABILITY_NOT_SUPPORTED` |
| GET | `/api/history-backfill/:jobId` | 任务进度、覆盖、失败分类、可展示结果数 |

---

## 7. 前端（不新增一级导航）

### 7.1 共享组件

`TimeRangePicker`（近 30 天 / 近 90 天 / 近一年 / 全部可用历史 / 自定义）、`CoverageTimeline`、`EvidenceDrawer`（复用既有证据抽屉）、`SourceBadge`、`TimePrecisionLabel`、`BackfillProgressCard`（仅用户主动创建任务后出现）。

组件内**不得手写**来源能力、国家数、数据维度或状态词表，全部读取后端投影。

### 7.2 品牌详情

Tab：概览 / 商品与价格 / 历史时间线 / 数据覆盖与来源 / 相关情报 / 相关报告。

- 商品与价格：≥2 个可比已验证价格点才展示变化；<2 点只展示当前观察 + 开始积累时间，**不画伪趋势**；价格点可打开证据；live 与 archived 标签不同；币种不同/规格不明/partial → 不连线、不算涨跌。
- 历史时间线：商品首次观察、价格变化、可售状态变化、历史存档观察；每条显示发生/观察时间、精度、来源类型、证据入口；不显示 attempt/snapshot id/路径/技术状态名；无历史时显示「尚未形成可核验历史记录；系统已从某日开始积累」。
- 数据覆盖与来源：统一覆盖面板（当前采集起点、存档回补覆盖、最后成功时间、时间缺口、回补任务进度）；建设中维度只在此集中呈现一次。

### 7.3 最小接入

- 情报库只读 `derived_timeline_events` 与有证据的时序事实变化，点击定位到品牌详情对应时间范围。
- 机会视图顶部数据基础新增「可用历史跨度」与「本次判断使用的时间范围」；数据不足不生成趋势型结论。
- 报告创建时时间范围进入事实包查询；冻结事实包同时冻结事实 ID、版本 ID、时间范围与 Evidence 引用；报告不得混淆存档时间、观察时间与实际发生时间。

---

## 8. 验收

行为测试至少覆盖：双租户双项目隔离；同内容两次采集不产生重复版本或伪变化；同商品同币种同规格价格变化可追溯；异币种/规格不明/partial/失败不产生伪价格事件；四个时间字段不混淆；存档事实必有 Snapshot 与 Evidence；证据缺失拒绝写入；回补重复点击幂等；重启后任务可恢复或如实终止；真实 Shopify 采集后 API 可查到事实；前端两价格点才画变化、单点不画趋势、历史点可开证据；无历史/部分覆盖/存档失败三种文案不同且无 0 值无伪趋势；任务与接口不泄漏 token/路径/栈；既有监控/情报/机会/报告冻结/SSRF/robots/Evidence/租户隔离测试不回退。

---

## 9. r2 集成状态（2026-10-20，基于 main `d3e8b303`）

本节记录 SC-05 移植到当前 main（，含 Wave 1 数据源 / URL 脱敏 / TikTok 官方契约 / pending_config 运行态 / 证据化建设中维度）之后的**真实实现与限制**，取代第 8 节之前任何「已完成」表述。

### 9.1 已验证（全部真实执行）

- 后端全量测试 53 文件全绿（含 memory-foundation 14/14：隔离 / 去重 / 价格事件 / 伪事件禁止 / 双时间 / 证据必需 / 幂等 / 重启恢复 / 时间线含价格事件）。
- 前端生产构建通过（16 路由）。
- 浏览器验收：memory-cmf 40/40（两点画线 / 单点不画 / 不可比空心点 / 证据抽屉 / 覆盖色带 / 回补真实终态 / 情报库跳转 / 泄漏检查）；core-ui-r2 全部 8 场景（含新断言「广告活动已有真实证据时不再显示建设中」，对齐 d3e8b303）；tiktok-coverage-r5 T1-T6 全过。
- 真实 Shopify 采集入库（allbirds.com）：692 观察 / success / 2768 条事实全 live_observation / 无伪造 effective_at / 每条带 Evidence+Snapshot / 同内容二次采集 deduped 幂等。
- 真实失败诚实登记（grailed.com 拒绝采集 → attempt failed「对方官网拒绝了本次访问」，零 Memory 落账，覆盖面板 not_started）。
- 两租户隔离（全新 ZB_DATA_DIR、API 级）：租户 B 对租户 A 的 memory / timeline / history-coverage / 回补任务一律 404，13/13。
- static-check 全绿；git diff --check 0 问题；自建 secret 扫描对变更文件 0 hit。

### 9.2 限制与合并阻断项（🔴 不得改写为已完成）

1. **历史回补成功路径未验证（合并阻断项）**：本出站环境 archive.org 不可达（DNS 解析到 199.59.148.222 后 TCP 443 超时）。回补任务真实请求后如实终态 `source_unavailable`（failureClass=unreachable）+ 0 导入，失败分类 / 可重试 / 覆盖缺口均正确。但「CDX 候选 → 原始存档字节 → Snapshot → Evidence → 时序事实 → history-coverage 出现该月 archived_observation」的完整成功闭环**未在任何环境跑通**。解除条件：在可访问 archive.org 的环境对任一品牌完成一次真实回补并验证上述链路。
2. 存档观察的币种可确定性存档场景下，是否需要回补 /cart.js 以确认币种（影响可比性判定）——待产品裁决（Open Decision）。
3. 情报库 items 当前仍为采集观察；memory 事件以独立字段（memoryEvents）并列展示——是否把 items 收敛为只读时序事件，待产品裁决。
4. fixture 说明：seed-memory.cjs 的目录观察经真实 Snapshot+Evidence 落盘（摘要由生产 adapter 生成），回补任务真实请求 archive.org；memory-cmf 的价格点数据是受控 fixture，明确标记，不作为存档来源验收。

### 9.3 冲突融合记录（以当前 main 语义为准）

- net.js：保留 main 的 URL 脱敏 / 受控 headers/body / FetchGate；叠加 SC-05 的 safeLookup 双签名（Node 22 {all:true} 数组回调）与 mapShopifyItems handle 字段。
- collect-jobs.js：保留 main 的 provider 链 / fencing / market 回退 / attempt 终态与 Evidence 语义；memoryIngestAfterCollect 只在 commitUsable 终态落账后追加（复用同次 Evidence/Snapshot，不二次抓取），仅 shopify_catalog 触发。
- brand-service.js / core-product.js：保留 main 的按 tenant/project/brand 范围计算的 constructionDimensions（含 BRAND_NOT_IN_PROJECT 校验与 pendingConfig 拆分）；叠加 buildCoverage 的 memStats 只读投影与「无 attempt 但有已核验事实 → ok」语义。
- 前端：DataSurfaceOverview 全部调用点带 projectId；intelligence 响应新增独立字段 memoryEvents（不与采集观察混排）。
