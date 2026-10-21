# SC-06 竞品数据库与公开官网数据基础（r1 实现记录）

状态：已实现并推送审核分支 `review/competitive-database-foundation`（commit `2df64c92`，parent=main `c099dd35`）。本文记录真实实现与限制，不做任何未验证声明。

## 1. 范围与裁决

本批把产品收敛为围绕「竞品数据库 → 单品牌时序档案 → 情报动态 → 机会视图 → 调研报告」运行：

1. 信息架构收敛：竞品库并入竞品数据库（不新建重复一级页面）；
2. 非 Shopify 官网采集基础：`official_site_profile` / `public_site_products` 两能力，与 `shopify_catalog` 分离；
3. 统一「用户声音与公开评论」事实链：一套读模型、一套统计口径。

明确不做（维持）：不升 YouTube/TikTok/DataForSEO；不让客户配 key；不接经营数据；不重做机会算法；不把 archive.org 回补失败伪装为完成；不改价格/证据/隔离/脱敏既有安全语义。

## 2. 信息架构（一）

- 主导航：`/brands` 标签「竞品库」→「竞品数据库」；「赛道档案」从一级导航移除（`/sector` 路由与页面保留，深链接不 404，浏览器实测 200）。
- 竞品数据库首页 = 原 `/brands` 列表增强：官网确认状态徽章、数据覆盖、最近可核验变化、时间积累起点（`firstObservedAt`）。
- 品牌详情六区块 Tab：概览 / 时间线 / 官网与商品 / 用户声音与公开评论 / 内容与广告 / 数据覆盖与来源（另保留「相关报告」附加入口）。
- 情报库：评论变化改读统一读模型（独立字段 `voiceChanges`，不与采集观察混排）；「时序变化（系统推导）」保持独立。
- 项目切换重置语义不回退（r3 机制保留，浏览器回归覆盖）。

## 3. 非 Shopify 官网采集（二）

- 新能力（capability-registry，均 `maturity: ga`、`requiresServerCredential: false`、无 configKeys）：
  - `official_site_profile`「官网资料（公开页面）」：canonical / 站点标题 / 品牌简介 / OpenGraph / JSON-LD Organization（含 OnlineStore/WebSite/Store/LocalBusiness）。
  - `public_site_products`「官网公开商品（非目录接口）」：JSON-LD Product/Offer/AggregateRating 公开字段 + robots sitemap 商品 URL 发现（index 一层、最多 8 个子文件并发、12 个商品页抽样，样本明示）。
- 解析器 `app/research/site-profile.js`：零 IO；HTML 实体解码；单块 JSON-LD 损坏不影响其他块；大小上限（JSON-LD 512KB/商品 200/sitemap 2000 loc）。
- 安全链不变：全部网络经 `Net.fetchPage`（SSRF/DNS rebinding/safeLookup/FetchGate/robots/逐跳重定向校验/快照落账/URL 脱敏）；失败如实登记，不伪装。
- `Net.fetchPage` 两处增强：`includeHtml` 选项（原始 HTML 供解析，缓存键区分）；`AbortController` signal 贯穿到 `safeRequestOnce`（修复：对方慢速滴漏字节时 socket timeout 永不触发、请求永久挂死——VAUDE 实测复现并修复）。
- `collect-jobs`：新增 attempt 级超时护栏（默认 10 分钟，`ZB_COLLECT_TIMEOUT_MS` 可调）——此前任何 adapter 挂死会永久占用 worker。
- Shopify 语义修正：`shopify_catalog`/`shopify_collections` 对非 Shopify 站的 reasonText 改为「Shopify 公开商品目录不可用」（原「该官网暂未识别出…此维度暂不支持」不符合产品语义）；官网资料成功后品牌页显示「官网已确认」（canonical + 采集时间 + 确认依据）。
- **真实采集验证**（`web/e2e/live-site-verify.cjs`，真实 HTTP → 持久任务 → worker → 真实来源）：
  - VEJA（`veja-store.com`，非 Shopify，products.json 404）：`official_site_profile` 真实成功——attempt success、canonical `https://www.veja-store.com/fr_fr/`、标题/简介（HTML 实体正确解码）/OnlineStore 组织识别、Snapshot+Evidence 落账；`public_site_products` 诚实空（该站无 sitemap 声明、首页无 JSON-LD Product）。**11/11 断言通过**。
  - VAUDE（`vaude.com`，非 Shopify，robots 声明 sitemap，26 个商品 URL 可发现）：官网资料曾在同环境真实成功（canonical 解析、Evidence 落账、16s）；随后该站对本环境限流（请求挂起），修复 abort 链后如实 `failed`（不伪装）。限流解除后重跑可得商品发现结果。
- 不从页面结构/文案/价格推断销量、GMV、转化率、ROI、广告花费或用户画像（00 §17 冻结）。

## 4. 用户声音与公开评论（三）

- 统一读模型 `app/services/voice-unified.js`：
  - 来源层：`public_reviews`（Data Surface 真值链）——每条带来源 URL、Snapshot/Evidence 引用、观察时间、品牌归属、样本限制；情绪字段当前不产出（不从片段/评分猜情绪，UI 不显示情绪标签）。
  - `voiceItems`（discover 期旧链路）只作迁移投影：折叠展示、注明「未挂 Snapshot/Evidence 引用，不计入公开评论统计」，不生成第二套统计或第二套机会分母。
  - 样本不足（评论观察 <5 条且来源页 <3）：`status: insufficient`，显示「资料不足，暂不形成群体结论」；绝不写「没有差评/用户满意/无口碑」（浏览器走查显式断言）。
- 消费方同一口径：品牌档案「用户声音与公开评论」tab（证据抽屉可达）、情报库 `voiceChanges` 区块、`toOpportunityInput()`（机会层只吃已核实评论；insufficient 返回空）。

## 5. 测试与验收结果（r1 全部真实执行）

- 后端全量 73/73（新增 `sc06-official-site.test.js` 13 项：能力语义/解析器 fixture/读模型/隔离/官网确认三态；`data-surface.test.js` 同步能力数 6→8、维度 2→4）。
- 前端生产构建通过（16 路由）。
- 浏览器：`sc06-walkthrough.cjs` 19/19（导航收敛/首页徽章/六区块/官网已确认/诚实样本不足/内容与广告/情报库一次性提示//sector 200）；memory-cmf 40/40；core-ui-r2 8 场景 ALL PASS（导航文案同步 SC-06）；tiktok-coverage-r5 T1-T6 ALL PASS。
- 两租户隔离 13/13（全新 ZB_DATA_DIR）；static-check 全绿；secret scan 变更文件 0 hit；`git diff --check` 0。
- 全新 `ZB_DATA_DIR`（zbsc06final）完成全部闭环（真实采集/走查/回归/隔离）。

## 6. 限制与未接通清单（如实）

1. `public_site_products` 对 VEJA 诚实空（来源无 sitemap、无 JSON-LD Product）——能力正确、来源缺公开结构化数据；对 VAUDE 因限流未取回（解除后可重跑）。
2. 情绪/主题提取未实现：统一读模型不产出情绪（无依据不展示）；后续接入时必须带提取依据。
3. archive.org 历史回补仍为 SC-05 §9.2 的合并阻断项（本批未改变）。
4. VAUDE 限流期间的采集失败为真实来源行为，不构成代码缺陷（abort 挂死缺陷已修复并加 worker 超时护栏）。
