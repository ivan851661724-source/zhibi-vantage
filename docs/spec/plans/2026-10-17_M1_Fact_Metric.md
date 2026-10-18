# M1 Fact→Metric 实施计划

> 执行方式：subagent-driven-development，逐任务实现、独立规格与代码审查，最后跨任务复审。用户已明确授权按M1执行；未决业务规则不作裁决。

**目标：** 打通本轮Shopify目录的SourceSnapshot→Evidence→Fact→价格Metric持久化→主业务读取与证据展开。

**架构：** 沿用现有文件存储、租户上下文和只读REST；新增append-only Metric文件与当前档案引用。描述本次已观察目录中明确可售商品的价格分布，不把全店统计称为Core Product Line，不改变旧S2/S3资格链、Fact价格含义或Diff/Event比较规则。

**技术：** Node内置模块、现有Next.js/React/TypeScript；零新增依赖、零新增外部调用。

**规格：** [00基线](../00_Engineering_Baseline_v1.2.md)§1.3–1.6/§8/§17–20/§26/§38/§42/§56；[01 PRD](../../history/2026-10-18_Product_PRD_v1.3.3_retired.md)§5.4/§7.2/§20；[02算法](../02_Data_Algorithm_Spec_v0.3.md)§2/§6.1–6.4；[03接口](../03_Backend_API_Contract_v0.3.md)§17；[05采集](../05_Data_Source_Collection_Spec_v0.3.md)§5.3/§10/§19.6及[SC-01](../changes/SC-01_collector_version_vs_parser_version.md)；[06验收](../06_QA_Golden_Dataset_Acceptance_Spec_v0.3.md)Traceability。总入口：[PRD补全计划](2026-10-17_PRD补全计划.md)。

## 约束与选择

- 先前所有未提交改动保留；本轮基于当前工作副本，在`codex/m1-fact-metric`增量工作，不提交、不推送、不部署，不处理原`output/`。
- availability是00§17和05§19.6明确允许的来源字段；只增加真实布尔/未知null，版本升级且旧文件不重写。原Fact类型、claim、min/max原始价格、Diff/Event规则保持。
- 仅为已存在的cart.js请求留真实字节，不新增请求或供应商。只有同租户、同域、同fetched_at批次及同project_ref的成功币种快照可作为第二来源；失败不补币种，市场及币种不从用户输入或comp.currency猜测。
- 只消费显式本批Fact集合，校验全链和来源范围；不扫描租户历史挑latest。跨店同product ID不得合并；跨页同商品相同观察去重，冲突则拒绝生成有效Metric，不任选一页。
- 本轮Metric要求可定位的原生variant ID；缺失/null/空白拒绝生成有效指标，不用数组序号或title虚构身份。有效数值Fact、支持产品快照及成功币种证明必须有可解析observed_at；不借fetched_at/computed_at补齐。时间范围按实际时间排序，失败collection页保留null。
- 重复商品按价格/availability/币种/市场/单位等语义值比较，不比较自然不同的Fact ID、Evidence ID和观察时间；完全相同仍保留全部出处，availability不同也算冲突。collection快照集合单独保留失败/空页，不能仅从有效Fact引用反推完整采集范围。
- 每Product一个观察点；当前可售只用available=true且有效正价变体，未知、缺货、免费和无效值分别计数，原Fact不删除。沿用既有免费品不入价格样本的兼容规则。
- 只做商品内中位数及产品间秩P25/Median/P75；不作销量加权、产品线选择或新增异常阈值。最低样本3；不足时保留真实计数、数值为null，不裁决。配置和算法均有实际版本，target价不进入Metric身份或计算。
- 新对象标derived，保存fact/evidence/snapshot引用、计算时间和观察时间范围、partial及缺失限制。旧priceStats/priceVerdict/priceField继续兼容，不给它们贴新Metric引用；新展示明确目录样本范围。
- null→有币种按既有Diff规则为不可比；不回填旧事实，不把availability变化改成价格事件。
- 全链除命名空间外还核对记录原始tenant_id；从事实及快照推导一致project_ref/domain/fetched_at。币种null与实值不能静默合并。产品计数与variant计数分开，含未知正价的混合商品不能仅凭一个明确可售零价变体变成有效付费样本。
- 重研开始和所有失败路径清除旧priceMetric引用；旧priceStats、S3排除、priceBand.mid、priceField及decorate路径不接新Metric数值。
- 公共目录Metric与既有当前用户价格字段分开呈现；不能把个人纠错叠到公共Metric，也不能因新指标隐藏个人纠错值、待复核隔离提示或纠错来源。新旧聚合区分不等于删除个人字段视图。

## 重点验收

1. 缺货/未知可售性、免费/缺价不冒充有效样本；variant多的商品不重复加权。
2. 同域同批同项目，双快照证明币种；失败、跨租户、跨期、跨店及断链拒绝或保留诚实缺失。
3. 重放含duplicate Fact仍得到相同Metric；新观察新对象，旧文件不变；用户目标价不影响结果或身份。
4. 多页重复不重复计数；partial与失败页在指标和UI保留，不宣称全店/核心线覆盖。
5. 主业务真正展示新Metric的服务端数字，并可展开Fact→Evidence→SourceSnapshot；旧档案可读，旧接口兼容，内部文件路径不出网，离开项目后的旧响应不写新页面。

## A：来源事实补齐（先红后绿）

预计文件：`app/research/net.js`、`evidence-extract.js`、`fact-store.js`；相关`net-shopify`、`evidence`、`fact`、`price-diff`、`domain-event`测试及新增`app/test/price-fact-context.test.js`。

产出接口：`fetchShopifyProducts()`保留既有返回，新增`currencySnapshotId`；`extractShopifyPriceEvidence({tenantId,snapshotId,currencySnapshotId?,...})`保留原返回；`prices[]`增量保存`available:boolean|null`；Fact逐字继承。提升实际parser/extractor/derivation版本，旧记录保持可读。

- [x] 用临时数据根和真实store复现availability丢失、cart币种无raw的失败；所有网络mock，不读运行配置。
- [x] 实现同域/批次/项目/租户配对与币种失败降级，保留原数值、快照和单snapshotId兼容。
- [x] 证明缺字段保持null、旧Fact可读、币种变化不伪造价格事件，定向回归通过后独立审查。

## B：Metric存储与主链API（A通过后）

预计文件：新增`app/research/price-metric.js`、`app/routes/handlers/intelligence.js`及必要的共享安全provenance投影；修改`enrich.js`、`routes/index.js`、现有demo证据详情兼容别名；新增`app/test/price-metric.test.js`、`price-metric-api.test.js`并扩充分页集成回归。

产出接口：`recordPriceMetric({tenantId,factIds,snapshotIds,currencySnapshotId?})`返回`{recorded,meta,duplicate?}`或明确内部失败原因；`getMetricById(tenantId,id)`只读同租户。`persistShopifyPriceEvidence`收集所有有效Fact（含duplicate）供Metric，新Fact列表仍单独供Diff/Event。档案增量`priceMetric`为精简展示投影，完整输入引用留存store；无有效输入不生成零指标并清除本轮旧引用。

REST：新增tenant `GET /api/price-metric?id=...&offset=0&limit=20`（详情逐批最多50个Fact），`GET /api/evidence-detail?id=...`；保留demo原证据端点。响应使用安全公共投影，不暴露raw_payload_ref内部路径；缺失链条如实报告。版本、输入集合、范围、配置决定幂等身份，不接受调用方价格或目标价。

详情按固定Fact ID排序；offset必须为非负整数，limit为1–50整数，默认20，非法输入400。返回total/nextOffset/hasMore；越界返回空页。仅返回本页Fact关联的Evidence/Snapshot对象，Metric自身可保留完整引用ID；collection失败/空页快照另列为范围说明。公共投影同时覆盖顶层及Fact/Evidence嵌套provenance，复用demo净化实现，不能只删顶层路径。

B/C展示接口：summary含`metric_id/metric_type/evidence_status/algorithm_version/config_version/computed_at/observed_from/observed_to/currency/market/unit/value:{p25,median,p75}/sample_product_count/product_counts/variant_counts/partial_scan/limitations`。详情响应`{metric,facts,evidences,snapshots,issues,collectionIssues,offset,limit,total,nextOffset,hasMore}`；证据详情`{evidence,snapshots,issues}`。计数单位在API文档明确，不能把有某类变体的商品计数误当互斥分类。观察时间与计算时间分别显示，不用新computed_at冒充新来源。

- [x] 新测试先红：真实快照→证据→Fact→Metric、幂等/不可变、单Product权重、缺字段、引用/范围拒绝、重复冲突、失败/partial和目标价无关。
- [x] 实现存储与enrich接线；传真实tenant/project，不引入历史全扫或旧item回退冒充Metric。
- [x] API验证400/401/404、非法ID、跨租户、分页与路径净化；旧demo/Fact/Diff/Event回归通过后独立审查。

## C：主业务展示与证据展开（B通过后）

预计文件：`web/src/types/state.ts`、`components/intel-profile.tsx`、新增共享`components/price-metric-detail.tsx`及`web/scripts/check-price-metric.cjs`；必要时修正原行为脚本的模块fixture，不放宽验收。

- [x] 真实组件回归先红，覆盖读取服务端数值、币种未知不借用comp.currency、partial/小样本/未知可售提示、证据展开失败/分页及会话/项目/卸载时旧响应。
- [x] 详情、翻页和证据请求分别有请求序号，复用现有项目generation/session/卸载所有权保护；A→B→A仍拒绝旧回包。metricId改变及关闭详情清除旧内容与错误。
- [x] 新目录统计消费priceMetric；不在前端重算。旧priceStats作为明确旧版兼容展示，不附新证据ID；不修改主资格状态或价格关系。
- [x] 独立审查后执行行为脚本、价格一致性、类型与构建；保留并记录既有警告。

## 集成与报告

- [x] 独立跨任务复审，逐条修复阻塞发现并复审。
- [x] 最新tree全量后端测试（临时数据根，去除继承存储覆盖）、前端回归/typecheck/build；密钥扫描含未跟踪源码、diff检查与本地文档链接核对。
- [x] 更新当前架构/API、总计划及评审核查；报告规格、文件、schema/API、测试、验收、兼容及开放问题。M1受约束目录主链与整个G10/Core资格分别报告，不宣称全PRD完成。

## 状态与决策记录

- 2026-10-17：两路只读审计完成；现有Fact缺availability且币种无快照，禁止给旧priceStats机械贴引用。选择版本化补齐原始字段与既有请求快照，再增量派生目录Metric；不替换旧资格链。产品线、真实需求权重、资格/价格关系阈值、公共更正传播等未决项继续开放。
- A首轮138项定向断言通过；独立复审复现实际product final_url路径未验证：同域重定向到限定collection目录仍可配对币种。已退回补对称路径校验及query变化兼容回归。另修正测试标题超出currency断言范围的问题；不改变既有market输入语义。B须待A复审通过再启动。
- A修复复审：Spec compliance/Code quality均PASS；两项发现addressed，无诱发Important。最终上下文套件17/17，主控独立重跑17/17、exit0。A首轮其他8套123项通过，路径修复后Evidence23/Fact18/Diff22/Event12再次通过；余下集成验证在最终tree重跑。B已按上述接口启动。
- B实现报告：Metric初始9红→9绿、API5红→5绿、分页集成5失败→10绿；后续覆盖重复身份、旧引用清理与IO失败不中断原事件。主控指出偶数中位数取低秩错误，已补4/6商品及偶数变体回归，median取中间均值、四分位复用既有floor口径。另关闭无Evidence双引用借用cart币种、demo旧raw_resolvable兼容及当前raw哈希损坏未提示问题。最新Metric11/API6、分页11及13文件相关回归通过，独立B审查进行中。
- 主控独立重跑B新增两套及分页集成：18个node runner用例0失败（分页脚本内11项），两条探针告警来自mock失败场景，不是实际外部采集。B独立审查发现匿名variant重复可改变数值却声称唯一变体；主控另以临时真实store复现缺observed_at仍生成指标且未提示。B修复轮1按02§2.1/§2.2 Schema/Entity Gate拒绝缺原生variant身份、缺失/无效支持观察时间；不发明替代身份或时间，不改原Fact/Event/资格，失败collection页仍允许空观察时间。待复审通过再启动C。
- B修复轮1新增4项先红后绿（匿名ID、产品/Fact时间、币种证明时间、合法跨时区时间范围）。最新Metric15/API6/A上下文17/分页11通过；观察范围按Date.parse排序而不按ISO字符串字典序猜测。两文件已停改，scoped复审进行中。
- B修复复审Spec/quality均PASS，无诱发Important；主控独立重跑Metric/API共21项、0失败、exit0。C已依实际summary与详情接口启动；架构/API资料已同步，整体M1仍待前端、跨任务复审和最终验证。
- 后端最新全量在独立临时DATA且移除继承MT/OBS存储覆盖后执行：51套0失败、exit0，覆盖M1 A/B最终代码。C首轮6个前端脚本、tsc和构建通过（15页、7存量警告）；其后独立C审查复现新Metric提前返回隐藏私有priceField/隔离/来源，已退回共存回归与最小修复。首轮构建不冒充修复后验证，待重跑。
- C修复轮1：真实IntelProfile组合用例先红后绿，公共Metric与当前用户价格字段并列；私有值、隔离说明及单次来源保留，公共指标不混入旧价格点或私有纠错。限定复审Spec/quality均PASS，无新增Critical/Important；主控独立重跑六个前端脚本及tsc全部exit0，修复后构建和跨任务总审查进行中。
- C修复后最新构建exit0，15页，首页First Load JS122kB、情报页125kB（Next报告口径），仍有7条既有lint警告。额外离线测首页HTML引用的9个外部JS文件，gzip level6合计167071字节（163.16KiB）；该范围不含内联脚本、HTTP开销或运行期按需块，不作为完整生产性能验收。
- 跨任务最终独立复审Spec compliance/Code quality均PASS，无Critical/Important或新增Minor。reviewer以真实store定向重现：同批两页5个Fact（跨页重复商品）加第3页blocked与USD币种快照，经Enrich得到4个商品样本P25=20/Median=50/P75=60；API limit2返回total5/nextOffset2，保留失败页范围、递归隐藏raw路径、当前raw可回放；异租户404、重放ID不变、无新快照清旧引用均通过；另独立运行真实前端Metric脚本exit0。未改代码或替代主控全量验证。
- 旧价格pending隔离快捷路径、正式SSE序号、M2–M6及上一批7条构建警告不在本轮自动认定已解决。
- 旧S3全目录统计用于资格与00§18/02§6冲突，已补入[SCP-02](../changes/SCP-02_runtime_PRD_conflicts.md)。本轮保留兼容不表示批准旧缺陷；用户相关核心线、资格接线和迁移仍需对应专项实施及未决规则处理。
- 核对仓库未发现独立标注Golden数据或可执行Golden回归入口，只有合成demo fixture。06§6要求parser/adapter变更运行Golden Regression；本轮会执行真实store合成回归及兼容测试，但不得冒充独立Golden或生产质量验收。这项验收缺口须在最终报告保留，功能链通过不等于质量终验PASS。

## M1交付核对

状态：A/B/C受约束目录主链实现、逐任务与跨任务独立复审及工程验证通过。质量终验与完整G10/Core资格验收保持PARTIAL。

| 项目 | 本轮范围与证据 |
|---|---|
| Spec References | 本文首段列明00/01/02/03/05/06及SC-01；04交互规格的证据可达性与缺失可见要求。评审稿与SCP-02不视作新规则批准 |
| Changed Files | 来源/事实：`app/research/net.js`、`evidence-extract.js`、`fact-store.js`；Metric/接线：新增`app/research/price-metric.js`，修改`app/research/enrich.js`、`app/routes/index.js`、`app/routes/handlers/demo.js`，新增`intelligence.js`、`intelligence-projection.js`；前端：`web/src/types/state.ts`、`web/src/components/intel-profile.tsx`，新增`price-metric-detail.tsx`；测试见下一行。文档同步索引、三个架构/API文档、评审附录、总计划、本计划及SCP-02。其余上一批未提交修改不算本轮新增 |
| Schema / Migration Changes | 文件存储加法：`DATA/metrics/<tenant namespace>/metric_<hash>.json`，schema_version=1；Evidence/Fact价格项增量available，真实cart快照与currencySnapshotId，实际parser/extractor/derivation升级，旧记录不重写。无数据库DDL、迁移、旧数据删除或新增依赖 |
| API Changes | 新增tenant只读`GET /api/price-metric`、`GET /api/evidence-detail`；详情Fact分页默认20/最大50，非法参数400、未登录401、其他租户/不存在404。档案新增精简priceMetric；demo证据接口兼容别名。递归移除内部raw路径，保留当前可回放标志及真实缺失原因 |
| Tests Added | 新增后端`app/test/price-fact-context.test.js`、`price-metric.test.js`、`price-metric-api.test.js`三套；扩展`evidence-store.test.js`、`fact-store.test.js`、`shopify-pagination-evidence.test.js`。新增前端`web/scripts/check-price-metric.cjs`，真实组件/Provider网络回调测试；不替换独立Golden |
| Test Results | 最新A/B后端全量`npm test`51套0失败、exit0，临时DATA并去除继承存储路径；C最终六脚本全部通过，独立`pnpm exec tsc --noEmit`及`pnpm build`exit0；15页、7条存量警告。六脚本为check-price-metric、check-live-state、check-operation-ownership、check-partial-profile、check-price-parity、check-radar-price。密钥扫描覆盖跟踪及未跟踪源码，零真实命中；8份文档本地文件链接均存在，diff空白检查通过 |
| Acceptance Verification | A/B/C及跨任务独立规格/质量复审均通过，无遗留Critical/Important；真实store合成链覆盖原始字节、双来源币种、范围/身份/时间拒绝、跨页重复/冲突、partial/失败、样本与计数、幂等/不可变、API损坏/权限、UI公共私有共存及乱序。缺独立Golden，06质量终验PARTIAL；不得宣称G10/Core或全PRD通过 |
| Compatibility Verification | 保留单snapshotId、旧快照/Fact、原始价格、原Diff/Event含义、旧priceStats/priceField/priceBand和S2/S3链、demo证据端点。重研清除旧Metric；新指标失败不伪造0或阻断既有Fact/Event。无新增外部请求/供应商，无生产调度、资格、通知或更正传播变更；未提交、推送或部署，原output保留 |
| Open Issues | 独立Golden缺失；Core Product Line、真实需求权重、旧全目录资格冲突及对应接线/迁移仍待专项，见SCP-02；未知币种/市场/单位保留null，partial及不足样本明确限制。完整大目录性能、SSE正式seq、旧价格pending隔离快捷路径、M2–M6及7条存量警告继续开放，无生产质量/SLA验收 |
