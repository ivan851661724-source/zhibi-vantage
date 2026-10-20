# SC-06 评审整改 r2：评论事实链接入机会计算 · 官网能力成熟度分离 · 官网资料自动采集

状态：整改完成，推送到审核分支 `review/competitive-database-foundation-r2`（parent = SC-06 r1 `d4b5f9e8`，main 仍为 `c099dd35`，未修改/未合并 main）。本文只记录**已真实执行**的验证与如实结论。

## 0. 本轮要解决的三件事（评审发现，均为功能问题而非文案）

1. 「用户声音与公开评论」统一事实链**没有真正进入机会计算**：`voice-unified.js` 有 `toOpportunityInput()`，但 `report-service.buildOpportunities()` 没调用它，机会图仍读旧 `reviews / painPoints / voiceItems`。
2. `public_site_products` 被标成 GA，但**没有一次真实商品观察闭环**——代码与 fixture 存在不等于生产验证通过。
3. `official_site_profile`（无需凭据、已真实验证）**只能靠用户手动刷新**才出现，不在正常调研链路里；且 worker 超时只是 `Promise.race` 返回，底层请求仍在挂。

## 1. 评论事实链 → 机会算法（一致口径，单点装配）

### 1.1 情绪/主题契约（未来能力先定死，未实现即不产出）

`app/services/voice-unified.js`（`voice-unified-2`）定义并强制：

- 每条分类必须有 `polarity ∈ {pos, neg}`。`neu`/未分类**既不是正面也不是负面**，不进任何分子或分母。
- 每条分类必须有 `sentimentBasis ∈ {source_field, deterministic_rule, model_extraction}`，且带可读依据说明（`sentimentBasisNote`）；依据不可解释 → 该条不进机会算法。
- 必须同时保留 `Evidence / Snapshot / 来源 URL / 观察时间 / 品牌归属`，缺一不可（`isOpportunityEligible` 守门）。
- 当前 `public_reviews` 采集只产出「来源页面公开的评分/评价数/片段」，**不产出情绪分类**——因此合格输入恒为 0，机会视图必须如实说明「用户声音已采集，但尚不足以形成满意度机会判断」。

### 1.2 唯一装配点

- `buildOpportunityInput(unified)`：返回 `{ eligible, reason, reasonText, items, collected, qualified, sample }`；四种结局 `ok / no_public_reviews / no_evidence_backed_polarity / insufficient_sample`。
- `buildOpportunityInputForComps({ tenantId, projectId, comps, brandIdOf })`：多品牌聚合，`decorate` / `report.js` / `quadrant`(read handler) / `report-service` 共用，禁止各自拼第二套分母。
- `toOpportunityInput()` 保留为兼容名，只返回**合格**条目（不合格恒空，不补 `neu` 占位）。

### 1.3 机会算法不再读旧字段

`app/lib/opportunity.js`：

- `collectVoiceItems(comps)`（读 `c.reviews / c.painPoints / c.voiceItems`）与 `hasVoice` **已删除**，替换为 `collectUnifiedItems(opts)`——只接受 `opts.voiceItems`（统一事实链已过闸的条目），并在本层再做一次守门（polarity / sentimentBasis / 依据说明 / 来源 URL / 观察时间 / 品牌归属）。
- 满意度 `satisfaction = pos / (pos + neg)`，分母只含已分类提及；`neu` 与未分类永不进入。
- 无合格输入 → `hidden: true, reason: 'no_evidence_backed_polarity'`，`preliminaryThemes: []`（**不再拿旧主题撑「初步机会」**），并给出 `voiceBasis: { collected, qualified, brandsWithVoice, gate, note }`。
- 品牌广度分母按「条目 competitorId ∩ 本项目已就绪竞争品牌」计算。品牌库主键 brandId 仅用于关联档案，不能替代项目内竞品归属；跨项目、未知或缺失 competitorId 的条目不计入。展示端只使用竞争品牌名称，不泄漏内部 ID。

### 1.4 调用方改造

| 位置 | 改造 |
| --- | --- |
| `services/report-service.js` `buildOpportunities()` | 统一装配 → `computeOpportunityMap(最小投影 comps, { voiceItems, voiceCollected })`；`compsForOpp` 只保留 `{id,name,status}`，旧字段**结构性不可达**；新增 `status: 'insufficient_voice'` + `voiceBasis` + `nextSteps` |
| 同上 `buildFactPack()` `voiceOpp` | 同上口径，冻结时点写入 `voiceBasis`（报告冻结语义不变） |
| `research/decorate.js` | `s.opportunity` 改统一口径，新增 `s.opportunityVoiceBasis` |
| `research/report.js` | brief 的用户声音机会层改统一口径；新增 `voiceOppLine()`，区分「没采到评论」「采到但无带依据分类」「样本不足」三种说法 |
| `lib/quadrant.js` + `routes/handlers/read.js` | 机会轴输入由 handler 用统一装配后透传（`voiceItems` / `voiceCollected`），返回体带 `opportunity.voiceBasis` |
| `research/domain-verdicts.js` | voice verdict 的 note 按 `voiceBasis.gate` 分支，不再把「未分类」写成「有用户声音 0 家」 |

**顺带修复 r1 遗留隐患**：`buildOpportunities` 的成功分支原本遍历 `map.zones`（分区计数对象，不可迭代），一旦有合格输入就抛 `TypeError`——此前只因恒走 `hidden` 分支而未被触发。现改为按 `themes[]` 投影，并带 O/I/S 与置信度、时间范围取主题内真实观察时间。

### 1.5 前端

- `/opportunity`：新增「口碑机会 · 尚不足以形成满意度判断」分支——不渲染色散点、不按相对百分位标「重点机会」，改为显示「已采集 N 条 / 合格输入 M 条」、为什么不画、以及下一步；数据基础与卖点空缺保留。`UnifiedOpportunityBasis` 支持 `status: insufficient_voice` 与「待验证维度」。
- 品牌档案「用户声音与公开评论」：采到评论但无带依据分类时，显示「机会判断资格：尚未形成」并说明中性评论不进分母。
- 情报库 `voiceChanges`：每个品牌增加 `opportunityEligible / opportunityReason / opportunityReasonText`，条目若带 polarity + basis 则显示极性与依据。

## 2. 官网能力：成熟度与真实验证分开

### 2.1 `maturity` 新增 `pending_verification`

`capability-registry.js` 的四值词表（不是把未验证能力塞进现有三态）：

| maturity | 含义 |
| --- | --- |
| `ga` | 已通过真实成功采集验证，可进入用户可见结论 |
| `pending_verification` | 能力代码/适配器就绪（无凭据公开来源），**尚无一次真实成功采集** |
| `pending_config` | 结构就绪但缺系统凭据（需要配置） |
| `not_integrated` | 未接入 |

- `official_site_profile`：`ga`（r1 已完成 VEJA 真实成功采集）。
- `public_site_products`：**改为 `pending_verification`**（本轮仍未取得真实商品观察闭环，见 §4）。
- `assertRegistryIntegrity()` 增加 `pending_verification` 契约：必须有 adapter/provider/adapters[]/adapterStrategy/measurementMethod/freshnessSlaHours/cooldown>0，且 `requiresServerCredential === false`。

### 2.2 运行态（source-readiness）不再「无凭据 = 已接通」

`getReadiness()` 原逻辑：`configKeys` 为空（公开来源）→ 恒返回 `operational`。这是「已接通」谎报的根因，已修正为：

- 有真实成功验证记录且无更新失败 → `operational`（带 `lastVerifiedAt`）；
- 最近一次真实尝试失败 → 按失败分类（`auth_rejected / quota_exhausted / unavailable`）；
- 都没有 → `ready_to_verify`（复用既有运行态语义），用户文案 `该数据来源尚未完成真实采集验证，暂不展示数据。`

四层区分（评审 §二.2 要求）：

| 层次 | 载体 |
| --- | --- |
| 能力代码存在 | `Registry.getCapability` |
| 来源已配置 | `Readiness.getReadiness().state !== 'not_configured'`（公开来源无凭据，恒已配置） |
| 来源已发生真实成功采集 | `provider_verifications` success → `operational` |
| 当前品牌已有可展示证据 | `BrandSvc.buildPublicProductsStatus`（本品牌本项目 attempt + 真实观察行） |

### 2.3 用户侧不再显示「已采集」

- `data-surface.renderableCaps`：`pending_verification` 与 `pending_config` 同规则——只有**真的采到过数据**才渲染；否则维度视图给 `surfaceState: 'pending_verification'`、文案「该数据来源尚未完成真实采集验证，暂不展示数据。」
- 维度视图新增 `pendingVerification[]`（本维度内「已实现待验证」的能力单列），不混进已采集块、不显示观察数/0 值。
- 能力卡新增 `◌ 待验证` 徽章（中性灰，不复用「正常」绿色语义）。
- 品牌档案「官网与商品」新增独立区块：`verified`（已采集到公开商品页观察）/ `unavailable`（最近一次未成功，说明不代表官网不支持）/ `not_collected`（**待验证**，附「尚无一次真实成功采集验证」）。
- **判定收紧**：`success/partial` 但 0 条观察（如商品页全被限流）**不算已采集**。

## 3. 官网资料进入正常调研链路 + 真正的取消传播

### 3.1 采集请求收口

新增 `app/services/collect-request.js`：`requestCollection()` 把「能力校验 → 运行态门控 → adapter 链解析 → 品牌支持预检 → `createAttempt`（幂等/冷却/日额度）→ `enqueue`（同 scope 去重）→ 可选 tick」收成一处；HTTP `POST /api/data-surface/refresh` 改为调用它（响应码/文案不变），自动采集走**同一函数**。

### 3.2 调研后自动采集

`research/enrich.js` 的 `deepResearchOne()` 在 `comp.status = 'done'` 之后：

```
saveState(state) → CollectReq.autoCollectAfterResearch({ tenantId, projectId, comp })
```

- 只自动采集 `official_site_profile`（`maturity` 必须为 `ga`，即真实验证过）；
- `public_site_products` **不自动采集**（未验证，不得因代码存在而大规模抓取）；
- 无官网 URL → 不入队；失败只记日志，不影响调研结果；
- 触发值用 `schedule`（03 §20 冻结枚举内，系统发起；不新增规格外触发值）。

### 3.3 超时真正取消底层请求

- `collect-jobs` 的 attempt 超时（`ZB_COLLECT_TIMEOUT_MS`，默认 10 分钟）：先 `AbortController.abort()`，再落终态；分类为 `timeout`（不再冒充 `unavailable`）。
- `ctx.signal` 贯穿 `adapter.collect → Net.fetchPage → safeRequestOnce(req.destroy)`；`Net.fetchPage` 新增外部 signal 级联（此前只用自己的超时控制器，「超时」只是不再等待，socket 仍在读）。
- 回归 `G7` 实测：provider 收到 `ctx.signal`、abort 时真正 reject、attempt 落 `failed/timeout`、**后续任务照常执行**（队列不被饿死）。

### 3.4 顺带修复的真实缺陷：商品发现链在真实站点上恒为 0

真实站点验证时发现 `public_site_products` 的 `urlCandidatesFound` 恒为 0，根因三条（均已修）：

1. `fetchPage` 返回的 `text` 被 `stripHtml` 压成单行，robots 的 `Sitemap:` 行首锚点必然失配 → `parseSitemapsFromRobots` 增加单行兜底匹配；
2. robots 抓取未取原始 HTML（行结构丢失）→ 改为 `includeHtml: true` 并从 `rb.html` 解析；
3. `<loc>` 里的 `&amp;` 未解码、且分片 sitemap URL 带查询串（`sitemap_products_1.xml?from=…&to=…`）不满足 `/\.xml$/` → 新增 `decodeXmlEntities()` 与 `isSitemapUrl()`（按 pathname 判定，允许查询串）。

修复后实测（Allbirds / tentree / fellowproducts）：robots → sitemap index → 商品分片 → **60 个商品 URL 可发现**（修复前 0）。

另修一条诚实性缺陷：候选商品页存在但**一页都读不到**（429/拒访/超时）时，原实现落成「成功且 0 商品」，等于把来源的访问限制伪装成「官网没有商品」。现在如实 `failed` + `rate_limited` 分类 + 「对方官网限制了本次公开商品页访问频率，稍后可重试。」（`G10` 回归）。

## 4. 真实采集验证结果（如实）

| 站点 | official_site_profile | public_site_products |
| --- | --- | --- |
| VEJA `veja-store.com`（r1） | 成功（canonical + Snapshot + Evidence） | 诚实空（无 sitemap / 无 JSON-LD Product） |
| VAUDE `vaude.com`（本轮） | **真实成功**（6s，canonical/Evidence 落账） | 修复 discovery 后 sitemap 只有 10 条非商品 URL → 诚实空（该站商品不在 `/products/` 形式路径下） |
| Patagonia `patagonia.com`（本轮） | 成功但拿到反爬中间页（无 canonical）→ 不标「官网已确认」 | 诚实空 |
| Allbirds（本轮） | 成功 | **发现 60 个商品 URL，但商品页返回 429** → 按新规则如实 `failed/rate_limited`（不伪装空） |
| tentree / fellowproducts（本轮） | — | 商品页同样 429 |

**结论：本轮仍未完成「真实公开商品观察」闭环**（Snapshot → Evidence → Attempt → 前端商品展示）。因此 `public_site_products` 保持 `pending_verification`，用户侧显示「待验证」。环境侧限制：本机出口 IP 对 Shopify 系 CDN 的商品页请求被持续 429，非代码缺陷；discovery 路径已修复并可用 60 个真实商品 URL 复现。

## 5. 新增/修改的回归测试

新增 `app/test/sc06-r2.test.js`（10 项，全部真实执行）：

| 用例 | 验证点 |
| --- | --- |
| G1 | `buildOpportunities()` 只读统一事实链；旧 `reviews/painPoints/voiceItems` 不进分母（`insufficient_voice` + `items=[]` + `qualified=0`） |
| G2 | 中性/未分类评论不进分子分母 → 不出散点、无初步主题 |
| G3 | 四组反例（无 basis／无依据说明／无 Evidence／合格）逐一守门；合格三条才 `eligible`，满意度分母=已分类提及 |
| G4 | 旧字段直接喂机会算法 → 隐藏、分母 0；缺 basis 的条目被丢弃 |
| G5 | `public_site_products`：maturity≠ga、readiness=ready_to_verify（文案不含「已采集/已接通」）、数据面归入 `pendingVerification`；真实成功验证后才是 operational |
| G6 | `official_site_profile` 调研后自动入队（pending/schedule/幂等），`public_site_products` 零自动入队，无 URL 不入队 |
| G7 | 超时 abort 穿透到 provider（`ctx.signal` 收到 abort）、attempt `failed/timeout`、后续任务照常执行 |
| G8 | 统一事实链按租户 + 项目隔离 |
| G9 | robots 单行 / XML 实体 / 带查询串 sitemap URL 解析（真实缺陷回归） |
| G10 | 商品页全 429 → `failed/rate_limited` + 限流文案，品牌级不得显示已采集 |

同步调整（语义变更，非遗漏）：

- `sc06-official-site.test.js` A1：official=`ga` / products=`pending_verification`。
- `user-copy.test.js` B2：机会输入改为合格事实条目（术语与评分公式断言不变）。
- `core-product.test.js` C8：新增 `pending_verification` 契约分支。
- `data-surface.test.js` D10：`website_products` 聚合块 4→3，`public_site_products` 出现在 `pendingVerification`。

## 6. 未接通 / 限制清单（如实）

1. **情绪/主题提取未实现**：契约已定义（polarity + sentimentBasis + 证据链），代码不产出。因此机会图当前**没有资格展示**「满意度 × 重要性」散点——这是正确状态，不是缺陷。
2. **`public_site_products` 无真实闭环**：discovery 已修复（60 个真实商品 URL），但目标站点商品页 429；保持 `pending_verification`。升级 ga 的前置条件（真实 Snapshot→Evidence→Attempt→前端展示）已写入 Registry 注释与本文。
3. VAUDE 商品 URL 形式（非 `/products/`）当前不在发现规则内——属能力边界，未扩展（避免误判非商品页）。
4. archive.org 历史回补仍为 SC-05 §9.2 合并阻断项（本批未改变）。
5. YouTube / TikTok / DataForSEO 仍为 `pending_config`（未升 GA，未让客户配 key）。
