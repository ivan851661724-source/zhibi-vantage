# SC-02 Spec Change：多数据维度骨架（Data Surface Foundation）

**状态：整改轮完成（随 `review/data-surface-foundation` 分支提交，待独立复审裁决）**
**影响规格：05 Data Source & Collection Spec v0.3.1 → v0.4.0（新增 §25）；03 §7 REST 草案新增五端点；04 §12.1 新增 Data Surface UI 映射行；01 新增附录（五维产品语义）；CHANGELOG 同步**
**上位依赖：00 v1.2 / 02 v0.3（不受影响——SourceSnapshot → Evidence → Fact → Metric → DomainEvent → Judgment 真值链零修改）**

---

## 1. 问题

Vantage 当前真实采集能力只有 Shopify 公开目录直抓（`Net.fetchShopifyProducts`），但能力的定义散落在实现里（watch-monitor 的 signals 词表、net.js 的 capability 参数、前端 watch-control 的硬编码文案），没有一处"平台目前支持什么"的唯一事实源。后续接入社媒/广告/评论/搜索热度等来源时，每一个都会重新发明：能力声明、身份解析、采集留痕、失败传播、刷新入口和 UI 状态。本提案在接入第二家数据源**之前**，先把共用骨架固化，并用现有 Shopify 采集完成第一个端到端纵向切片。

**整改轮（2026-10-18，独立审核 CHANGES REQUIRED）**：第一批落地后独立审核提出真值链/状态语义/扩展契约三类硬伤，本轮修订：多页快照与币种快照可追溯、Adapter Contract 五方法化 + 运行时 validator、维度→能力→适配器三层聚合、摘要判别联合、状态三拆与持久任务恢复、前端币种/竞态/时区、admin 端点 401/403 语义、capability 级刷新 cooldown 与额度策略、13 项回归测试。

## 2. 五个数据维度（产品层分组）

维度是产品层的数据面分组，不是新领域枚举。维度 → 05 §1 Capability Map 能力的映射冻结如下：

| 维度 code | 用户可见名 | 映射能力（05 §1） | 当前状态 |
|---|---|---|---|
| `website_products` | 官网与商品 | Product Catalog / Current Price / New Product Detection / Promotion Detection（Shopify 直抓）+ Collections（店铺集合清单） | **已接入（双能力）** |
| `social_content` | 社媒内容 | （05 §1 无对应能力——占位） | not_integrated |
| `ad_campaigns` | 广告活动 | Ad Activity（P1） | not_integrated |
| `reviews_reputation` | 口碑与评论 | Review / Rating（P1） | not_integrated |
| `search_interest` | 搜索与热度 | Search Interest（P2） | not_integrated |

规则：not_integrated 维度**不构造任何数据**（无假数量/假时间/假来源），UI 只显示能力状态；05 §8 的门槛（provider 规格未完成前不得宣称持续监控）继续适用于后续每一批接入。

## 3. Capability Registry（唯一能力事实源）

实现：`app/services/capability-registry.js`。前后端一切"目前支持什么"的判断只读本 Registry；前端禁止自建能力清单。

每个 capability 至少含：

```text
code                    # 能力码（如 shopify_catalog）
display_name            # 用户可见名称
dimension               # 所属维度（§2 五值之一）
adapter / adapters[]    # 执行体（未接入为 null/[]）；adapters[] 为能力级适配器清单
provider                # provider（未接入为 null）
supported_objects       # 支持对象类型（如 official_domain）与市场范围
access                  # 获取方式（public_storefront_json / …）
requires_server_credential  # 是否需要服务端凭据（用户永不配置 provider key）
manual_refresh          # 是否允许手动刷新
auto_inspect            # 是否参与自动巡检（当前由 WatchMonitor 承担）
freshness_sla_hours     # 新鲜度 SLA（字段级，00 §54：不用全局阈值）
maturity                # ga / not_integrated（GA Gate 状态，05 §17）
limitations             # 成熟度与边界（如 Shopify 禁 AOV/销量/GMV，00 §17）
cost_attribution_key    # 成本归因键（00 §51 / 03 §20）
collector_version / parser_version  # 当前实现版本
refresh_policy          # 刷新策略：{ cooldown_minutes, daily_quota? }（§6.3）
```

**当前条目（6）**：`shopify_catalog`（ga，website_products，adapter=shopify）、`shopify_collections`（ga，website_products，adapter=shopify_collections，第二能力示例——同维度双能力聚合）、`social_content` / `ad_activity` / `review_rating` / `search_interest`（not_integrated 占位）。结构约束：**`dimension → capabilities[] → adapters[]`** 三层，投影层遍历维度下全部 capability 聚合，禁止只读 `caps[0]`。

## 4. Source Adapter Contract

实现：`app/services/source-adapter.js`。每个 adapter 实现**五方法**：

- `supports(brandCtx)` — 该品牌对象是否可采集（含不支持原因）；
- `resolveIdentity(brandCtx)` — 产出最小 BrandSourceIdentity（§5），**默认 unresolved**；
- `collect(ctx)` — 执行一次采集，**委托既有采集实现，禁止第二套采集逻辑**；
- `normalize(raw, ctx)` — 原始采集结果 → 标准输出（判别联合摘要 + 快照引用集）；
- `health()` — 供管理员矩阵的健康探针。

`validateAdapter()` 结构自检（启动 + 测试锁定）：五方法/版本/summaryKinds 白名单映射，缺一即失败；`assertAdaptersIntegrity()` 对全量注册 adapter 执行。

统一输出（对齐 05 v0.4.0 §10 Adapter Record 冻结字段，不删不并）：

```text
source_id / capability / entity_keys / raw_snapshot_id（snapshotIds[]）/ observed_at /
source_timestamp? / market / currency? / fields（observations）/ source_status /
freshness / collector_version / parser_version? / error_code?
```

并补充：evidence_refs（Evidence 引用）、pagination（分页状态：complete/partial_scan）、retryable、cache_hit、cost_attribution、attempt_id。

### 4.1 摘要判别联合（可扩展摘要协议）

`summary.kind` 为判别键，当前冻结两值，均映射注册表白名单：

| kind | served_by | 字段 |
|---|---|---|
| `storefront_catalog` | shopify_catalog | count / onSaleCount / soldOutCount / priceMin / priceMax / priceMedian / currency / currencyStatus / partialScan |
| `storefront_collections` | shopify_collections | collectionCount / collections[] |

商品、社媒、广告、评价、搜索热度**不得共用固定「款、在售、价格区间」模板**；未来新维度 = 新 kind + 白名单登记。前端对未知 kind 走通用键值渲染（诚实降级，不假装看得懂）。

### 4.2 运行时 validator（禁止静默接受）

`validateOutput(out, ctx)` 对 normalize 输出逐项校验，任一不满足即抛错并由 collect 落 `failed/internal_error`：

- 字段缺失（observations 非数组、summary 非判别联合、title/price/available 类型错）；
- 能力/维度不匹配（output.capability 不在 Registry；output.dimension ≠ capability.dimension；summary.kind 非该能力白名单映射）；
- Evidence 引用不完整（success/partial 必须引用 ≥1 快照；evidence 引用的快照必须 ∈ snapshotIds）；
- 币种可追溯（`currency != null` ⟺ `currencySnapshotId ∈ evidenceSnapshotIds`）；
- identityStatus 必须 ∈ 00 §53 冻结三值（candidate 等第四值一律拒绝）。

## 5. 最小 BrandSourceIdentity

实现：`app/services/surface-store.js`（SQLite `data_surface.db`，加法迁移）。只解决"当前项目中该平台身份是否属于这个品牌"，**不是**跨租户 Canonical Brand Memory（00 §52/§53 的 Canonical 层不落）。

```text
identity_id / tenant_id / project_id / competitor_id   # 租户私有（00 §42）
official_domain / platform / platform_account_id / account_key   # 平台身份
identity_status / evidence_ids / snapshot_ids          # 溯源
resolver_version / resolved_at / updated_at
```

**状态门控（整改 §一.5）**：identity_status 沿用 00 §53 冻结三值 `resolved / unresolved / conflicted`，**不新增 candidate 枚举**。创建时默认 `unresolved`；仅当**成功确认来源且关联 ≥1 Evidence + ≥1 Snapshot** 后才转 `resolved`（recordIdentity 门控）；失败/空目录不满足门控保持 unresolved；已有 resolved 身份不因单次失败降级（身份连续性）。候选来源语义 = unresolved（运维备注走 origin_note，非状态位）。

**多账号共存（整改 §二.7）**：唯一键 `(tenant_id, project_id, competitor_id, platform, account_key)`——同一平台允许多个地区账号/主页/广告主体。`account_key = COALESCE(platform_account_id, '')`。schema v1→v2 非破坏性迁移：旧行按 platform_account_id 回填 account_key（旧唯一键已保证不重复，回填不引入冲突），`PRAGMA user_version=2`；迁移随首次 getDb() 自动完成。

## 6. CollectionAttempt

实现：同 `surface-store.js`（表 `collection_attempts`）。一次"对某品牌某能力的一次采集尝试"：

```text
attempt_id / idempotency_key（UNIQUE）/ tenant_id / project_id / competitor_id /
capability / dimension / trigger（manual|schedule，沿用 03 §20 trigger 词表）/
status（running→success|partial|failed，终态不可变）/ source_status（05 §11 八值）/
error_class / observation_count / snapshot_ids / evidence_ids / observations（≤1000 条摘要）/
cost_attribution_key / collector_version / parser_version / started_at / ended_at
```

幂等规则（03 §9 / 00 §37）：同 `tenant×project×competitor×capability` 存在 running attempt → 复用；同 idempotency_key（含 120s 时间桶）→ 返回既有 attempt（`deduped:true`）。手动刷新因此**不可能产生双任务或重复费用**。

### 6.3 刷新冷却与额度（整改 §五.5）

capability 级 `refresh_policy`：`cooldown_minutes`（两次成功采集间最小间隔；ga 能力必须 >0，assertRegistryIntegrity 锁定）+ `daily_quota`（自然日采集上限，null=不限；付费来源接入必须显式设值）。仅对自动生成的时间桶键（手动刷新）生效；显式 idempotencyKey（巡检/测试）由调用方自管。超额返回 `429 REFRESH_QUOTA_EXCEEDED`；cooldown 内返回 `200 deduped(cooldown)` 并附带 policy（剩余冷却秒数、当日剩余额度）——**后续付费来源不能被无限刷新**。

## 7. Data Surface Projection 与七状态语义

实现：`app/services/data-surface.js`（投影只读拼装，不重算业务结论——00 §32：所有端只 render）。**维度 → capabilities[] → adapters[] 聚合**：每个维度返回全部 ga 能力块（`aggregations[]`）+ 主投影态；未接入维度零构造。每维返回：

```text
code / display_name / capability_view / surface_state / last_success_at / last_attempt_at /
freshness（status: fresh|stale|unknown + sla_hours）/ summary（判别联合）/ coverage /
is_refreshing / latest_attempt / latest_usable(隐含于 summary+evidence_refs) /
gaps[] / actions[] / evidence_refs[] / aggregations[] / pagination
```

**状态三拆（整改 §三.1）**：

| 字段 | 语义 |
|---|---|
| `latestAttempt` | 最近一次执行结果（含 running/失败与失败文案） |
| `latestUsable` | 最近一次可展示数据（success/partial 的摘要/观察/Evidence） |
| `isRefreshing` | 是否有活跃 running（刷新中） |

**状态派生规则**（同 hit 多态时按优先级，与 04 §12.2 对齐）：

| surface_state | 派生条件 |
|---|---|
| `unsupported` | Registry maturity=not_integrated，或 adapter.supports=false（含原因） |
| `loading` | 存在活跃 running **且无可用旧数据**（首采中）；有旧数据时刷新不降级展示（三拆） |
| `failed` | 无任何成功数据，且最近 attempt 终态 failed（source_status 为失败类，不吞错误） |
| `empty` | 能力受支持、从未成功采集（≠ failed ≠ 确认没数据） |
| `partial` | latestUsable 为 partial_scan（partial_scan 传播，00 §20） |
| `stale` | 有成功数据但超出 freshness_sla_hours（04 §12.2：stale > partial） |
| `ok` | 有成功数据且在 SLA 内 |

**缺口不互吞（整改 §三.3）**：stale 与 partial 可同时产生 gap；主徽章按优先级取一，其余 gap 全量保留。缺口码：`partial_scan` / `insufficient_freshness` / `latest_failure`（最近失败但保留旧数据，文案「最近更新失败，当前展示上次成功数据」）/ `interrupted`（过期 running 经 reconcile 转 failed 后的诚实提示）/ `identity_unresolved` / `source_not_integrated`。

**租约恢复（整改 §三.4/§三.6）**：running 超崩溃宽限（30min 投影层标记 / 10min reconcile 兜底）且无活跃 job 指向 → `reconcileAbandoned()` 落 `failed/internal_error`，**绝不显示为「尚未采集」**。采集执行禁进程内 fire-and-forget：`collection_jobs` 持久队列（claimToken 租约 60s + heartbeat 25s + reclaim 回收 + retry 3 次耗尽转 dead），常驻 worker（`collect-jobs.startWorker`）消费；「任务执行中重启服务」由进程级测试证明可恢复或诚实终止。

## 8. Data Surface API 与刷新约束

按现有路由风格（registry + handlers）新增**五端点**：

```text
GET  /api/data-surface/overview?projectId?&competitorId     # 五维总览（tenant）
GET  /api/data-surface/dimension?projectId?&competitorId&dimension&offset&limit  # 单维详情（按 capability 分组分页）
POST /api/data-surface/refresh { projectId?, competitorId, capability? }          # 手动刷新（幂等：running 复用 + cooldown + 日额度；202+持久任务入队）
GET  /api/data-surface/refresh-policy?projectId?&competitorId&capability         # 刷新策略与剩余冷却/额度（tenant）
GET  /api/admin/data-surface/capabilities       # 能力矩阵 + adapter 健康 + contract 自检 + 活跃任务（admin only）
```

约束：总览必须返回品牌身份摘要（含多账号 identities[]）、五维能力状态、最近成功/最近尝试/三拆状态、新鲜度、最新数据摘要（判别联合）、Coverage 与缺口、可用操作、Evidence 引用、分页信息；普通用户响应中剔除 provider/内部字段（admin 端点才含）。租户硬隔离（跨租户 404，不泄露存在性）。**admin 端点鉴权语义（整改 §五.2）**：未认证/签名无效 → 401（统一鉴权门）；已认证普通租户 → 403（handler isAdmin 判定）；超管 → 200。

## 9. Shopify Reference Adapter（05 §19.6 落地）

- 委托 `Net.fetchShopifyProducts` / `Net.fetchShopifyCollections`（唯一采集实现，零第二套采集逻辑）；
- **多页快照真值链（整改 §一.1/§一.2）**：products.json 每个参与汇总的页面各自落 SourceSnapshot（source_url 唯一化到 `?page=N`），汇总快照（无 page 参数）携带扫描级 partial_scan 元数据；Evidence 引用**全部**快照——禁止用首页快照证明全部页的总数/最低/最高/中位；汇总可由全部引用页快照的原始 blob 合并复算；
- **币种可追溯（整改 §一.3）**：`/cart.js` 店铺结账币种为独立 SourceSnapshot（capability `storefront_currency`）；`currency` 非 null ⟺ 币种快照可解析；无快照 → currency 一律 null（含 Evidence.currency 与 extracted_value.currency），前端显示「币种待确认」；
- 真实调用进统一 SourceSnapshot（既有行为，零改动）；Evidence 由 adapter 层按 SC-01 规则记录（parser_version='shopify-adapter-1' ≠ collector 'net-1'）；
- WatchTarget / MonitoringWindow / Coverage / 三态日报 / 单品价格语义（lib/watch-price.js）**零回归**——监控链路不经过本 adapter，二者共用同一采集函数；
- 目录中位数只作为目录级摘要/独立 Metric 展示，**不冒充同商品价格变化**；
- 失败分类（05 §11）：abort/超时独立归类 `timeout`（不吞进 unavailable），429→rate_limited、401/403/407→blocked、5xx→unavailable、parse_failed→parse_failed；失败快照反查优先于消息形态判定。

## 10. 实现对应与验收

文件清单见分支提交。验收 = 任务书 §六 13 项回归测试（social_content 零 Shopify / 失败保留旧数据 / stale+partial 双 gap / 过期 running 不 empty / 采集中重启恢复 / 多页快照复算 / 无币种快照无币种 / identity 无证据不可 resolved / 同维度双能力聚合 / 同平台两账号共存 / timeout 分类 / 前端币种与刷新态 / 两租户隔离）+ 后端全量测试 + 前端构建 + secret scan + `git diff --check` + 全新数据目录冒烟 + 真实 HTTP 鉴权测试（401/403/200）+ 进程级采集中重启测试；未全过则报告 PARTIAL。

## 11. 治理记录

- 提出：2026-10-18，Data Surface Foundation 第一批任务书（用户下达）。
- 整改：2026-10-18，独立审核 CHANGES REQUIRED → 本文件修订（真值链/Adapter Contract/状态三拆/持久任务/前端/鉴权/cooldown/13 项回归）。
- 复审整改（第二轮，2026-10-18）：见 §12。
- 裁决记录：C1 candidate 语义**按独立审核要求落地**——不新增第四值，默认 unresolved + 证据齐备才 resolved（00 §53 冻结不动）；C2 failed/empty/unsupported 投影态口径保留（面板级 UI Projection State，非领域枚举）；C3 社媒维度占位保留（05 §1 外产品层分组）。三项均随整改轮落实，无待决冲突。

## 12. 复审整改轮（CHANGES REQUIRED #2，2026-10-18）

### 12.1 SSRF 抓取（net.js safeRequest）

- 全部请求（products.json 分页 / cart.js / collections.json）走 `safeRequest()`：assertPublicUrl 先行（任何连接建立前完成协议/主机/DNS/IP/私网校验）→ manual redirect（不自动跟随，逐跳解析 Location 并重新校验）→ 受控 lookup（连接阶段 DNS 结果再过私网黑名单，防 rebinding）；≤3 跳。
- 「真实零请求」回归：localhost / 127.0.0.1 / 169.254.169.254 / 100.100.100.200 注入 fetch 计数证明零请求；公网 302 到私网、多跳中途入私网逐跳拒绝。

### 12.2 partial 结构化语义

`fetchShopifyProducts()` 返回 `partialScan / partialScanReason / successfullyFetchedPages / failedPage`；分页预算耗尽、后续页 HTTP 失败、后续页解析失败、后续页超时/网络错误**全部 partial**。adapter 传播完整语义至 attempt / summary / coverage / gap / Evidence（含 reason）。回归：「第一页 250 成功 + 第二页 500」必须 partial。

### 12.3 Collections 真值链

- `fetchShopifyCollections()` 网络层保存服务器**原始响应字节**快照（adapter 不得重新序列化冒充）；Evidence 引用真实原始快照。
- 存储预算（50）截断诚实标记：`sourceObservedCount / storedCount / partialScan / partialScanReason`；回归：原始 60 条/预算 50 → partial。
- source_url 与真实请求一致（含 `?limit=250` 查询参数）。

### 12.4 Evidence 失败不 success

`finalizeOutput()` 删除吞证据异常路径：Evidence 抛错/未落账 → attempt `failed/internal_error`、identity 不 resolved、overview 显示失败、不展示该批数据为已核实结果；用户文案不含路径/栈/内部异常。回归：快照 meta 在但 raw blob 缺失。

### 12.5 任务恢复幂等与 fencing

- worker 执行前读 attempt：已终态 → 幂等完成，零外部请求。
- `completeAttempt` fence 参数：校验 job `claimToken` + 租约；旧 worker 失租约后不得写 attempt/Evidence/Identity/finish。
- 四个崩溃窗口回归（来源调用前 / Evidence 前 / attempt 完成后 finish 前 / 超租约恢复）断言外部调用次数、attempt 数量、Evidence 数量与费用归因不重复。
- 确定性跨进程 kill/reclaim 测试（worker 子进程 ready 屏障 + SIGKILL + 租约过期 + worker2 续跑同一 attempt）：retry/attempts 增加、claimToken 更换、零 running、单 attempt 单结果；真实 provider 连通性与队列恢复分开。

### 12.6 Adapter Contract 与策略

- `validateOutput()` 对**任意畸形输入**返回 `{ok:false, errors}`（不抛 TypeError）；新增校验：snapshotIds/evidenceSnapshotIds 必数组、outcome 冻结词表（success|partial|empty_success）、currencyStatus↔currency 一致、summary.kind 必填字段、快照存在+本租户+raw 可解析。
- `adapterStrategy`（single / fallback / fanout）进 Registry；`resolveAdapterChain()` 策略解析；handler / worker / 投影层按策略执行，禁止硬编码 adapters[0]。fanout 本批语义：全链执行、首个成功为 attempt 结果、其余记 skipped（同能力多 attempt 拆分为后续批——已知限制）。

### 12.7 分页契约与前端

- 分页契约定为**每 capability 独立分页状态**（capabilities[].pagination）；顶层 observations = 当前 activeCapability 当前页（≤ limit），禁止 offset×N 拼接。
- EvidenceDrawer 稳定 active key（`evidenceId || snapshotId`）、refs 变更重置 + 取消旧请求、多 snapshot-only 标签可分别选择。
- `latest_failure` / `interrupted` 仅在专门提示区渲染，gaps 列表去重；顶层 isRefreshing 聚合 capability 真实值。

## 13. 复审整改轮 3（CHANGES REQUIRED #3，2026-10-18，随 review/data-surface-foundation-r2 分支）

### 13.1 SSRF：连接层受控 DNS（safeLookup 单 IP 修复）

- 修复 `safeLookup()` 把地址数组交给 Node 连接层的缺陷（真实连接层要求单个 address + family，最小复现 `ERR_INVALID_IP_ADDRESS`）：受控 lookup 回调现在交出**单个已验证公网 IP 与正确地址族**；DNS 解析、私网过滤、实际连接三者使用同一份受控结果。
- `fetchPage()` 不再经全局 `fetch()` 绕过连接阶段 DNS 校验：内层改走 `safeRequestOnce()`（assertPublicUrl 先行 + `lookup: safeLookup` 连接）+ 逐跳 FetchGate/robots/公网校验，redirect 仍由调用层手动逐跳处理。
- 回归（D30）：safeLookup 返回单值字符串+family（非数组）；mock DNS 公网域名完成请求；fetchPage 连接阶段 rebinding（校验层公网/连接层私网）拒绝且零响应；302→私网、多跳中途入私网仅前序跳发起请求，私网跳零连接。

### 13.2 fallback/fanout 终态语义（provider-run 执行器模型）

- **终态写入权唯一归属策略执行器**：provider 运行（`suppressTerminal`）只产出结构化结果（validate 后的 out/raw/ident），不写 attempt 终态、不升级 identity；首个 provider 的普通失败/抛异常**不再固化父 attempt**，链上后续 provider 可在同一次用户刷新中接管。
- 执行器统一落账：`runProviderOutput()`（validate + Evidence，失败=该 provider 失败，链继续）→ `commitProviderTerminal()`（attempt 终态 + identity 升级，fence 贯穿）/ `commitProviderEmpty()`（零观察终态，identity 保持 unresolved）。
- 链耗尽 → **唯一最终失败**（fence 贯穿；错误分类取首个失败；用户文案无内部细节）；不抛出裸异常。
- fanout 与文档一致：全链**真实执行**（外部请求都发生），首个可用 provider 胜出，其余结果记 `discarded`（fanout_first_usable_wins）；同能力多 attempt 拆分仍为后续批（已知限制，见 §12.6）。
- 回归（D31）：首 adapter 抛异常→第二接管；首 adapter 正常 failed→第二接管；全败→单 attempt 单最终失败；fanout 三 provider 全执行、首个可用者胜出、discarded/failed 如实记录。

### 13.3 fencing 全覆盖与原子 CAS

- adapter 失败路径 `completeAttempt()` 一律传 fence；`upsertIdentity()` 对 **resolved 升级**强制 fence（job running + claimToken 匹配 + 租约未过期），失租/伪造 worker 不得升级来源身份。
- `completeAttempt()` UPDATE 携带 `status='running'` 条件（**原子 CAS**）——跨进程竞态下「先读到 running、后覆盖终态」被条件写消除；changes=0 时重读区分已终态（immutable）与不存在。
- 回归（D32）：旧 worker 失租约写 failed → FENCED 且 attempt 保持原态；失租 identity resolved 升级 → FENCED；双 worker 竞争完成同一 attempt → 仅有效 fence 落库，终态后直调也被拒（immutable）。

### 13.4 raw 快照真值链（禁聚合伪装）

- **删除聚合伪装快照**：products.json 不再把 page=1 的原始 body 标成无查询参数的聚合 URL；原始字节只以页级快照存在（source_url 与真实请求逐页对应，含 `?limit=&page=N`）；聚合统计只进 attempt summary。
- Evidence 级快照校验升级：存在 + 当前租户 + raw 可读 + **按已知 content type 可解析**（JSON 型快照解析失败 = 断链，不得产生 success evidence）。
- 回归（D33）：损坏 JSON → attempt failed/identity 不升级/无 success evidence/overview 失败且 summary 为 null；每页快照 byte_size=raw 长度、content_hash=sha256(raw)、source_url 与页对应；attempt summary 可由引用页快照复算，且不存在无查询参数的 product_catalog 快照。

## 14. 与 SC-03 Competitive Data Network 的边界（v1.5 宪法下）

- 本变更只交付**已批准的采集基础设施**：Capability Registry / Adapter Contract / BrandSourceIdentity / CollectionAttempt / 持久任务队列 / Data Surface 投影与端点。**不宣称任何未接入数据源具备真实覆盖能力**——social_content / ad_activity / review_rating / search_interest 四维保持 `not_integrated`，UI 明示「未接入」，零构造数据。
- 服从关系：v1.5 宪法与已批准 SC-03 优先；SC-02 与 SC-03 冲突处（术语、状态词表、端点归属）以 SC-03 为准，差异随本分支审核（如 `/api/data-surface/refresh-policy` 为本分支新增端点，合并时需经 SC-03 契约吸收或以 SC-02 修订 03）。
- 本分支基于 main `64b4ee6cc575f095b0a000342b38f34d0bf63e5d`（v1.5 宪法 + SC-03）创建；`docs/spec/01_Product_PRD_v1.5.0.md`、SC-03 及配套 v1.5 文档零改动。已废弃的 `01_Product_PRD_v1.3.3.md` 不恢复、不改写。
