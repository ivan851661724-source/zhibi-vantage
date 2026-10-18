# M3 Coverage、quiet 与通知主链执行计划

状态：有明确依据的工程子范围已实现，A/B/C及集成修复D独立复审通过；2026-10-18拉取origin/main并合并watch-*基础闭环（冲突解决与测试适配见"合并轮"），合并轮独立复审与新执行验证见交付记录。完整M3验收PARTIAL。

目标：在已有 M2 定向采集与 M1 事实主链上，保存可追溯的检查结果，通过同一持久 Coverage 对象驱动静默门禁及展示，并为真实 observed 事件建立持久、幂等的站内通知投影。未知业务前提必须显示为缺口。

## 规格与范围

- [工程基线](../00_Engineering_Baseline_v1.2.md)：§1.12、21–25、37–38、51、54。
- [冻结 PRD](../../history/2026-10-18_Product_PRD_v1.3.3_retired.md)：§17–19、24–25，A09/A12/A13/A22/A28。
- [数据规范](../02_Data_Algorithm_Spec_v0.3.md)：§10–13、23；[后端规范](../03_Backend_API_Contract_v0.3.md)：§0、9、12、14–15；[交互规范](../04_Frontend_Interaction_Spec_v0.3.md)：§16–17。
- [采集规范](../05_Data_Source_Collection_Spec_v0.3.md)：required P0、direct-first；[运行规范](../07_Monitoring_Operations_Runbook_v0.3.md)：§3、9。
- [现行架构](../../architecture/00_整体架构规范.md)、[现行 API](../../architecture/02_现行API契约.md)、[M2](2026-10-17_M2_监控主链.md)、[总计划](2026-10-17_PRD补全计划.md)。
- [产品评审](../../history/2026-10-18_Product_PRD_v1.5.0_review.md)的决策08/10/11及覆盖、通知、摘要相关条款为未决输入，不是批准政策。

冻结阈值已经明确：quiet 必须达到 required P0 100% 覆盖，且窗口完成、无 verified/actionable 事件。actionable 不等于 confirmed，也不等于已取得外部推送资格；缺少判定依据时不能声称没有 actionable 事件。以下仍未批准：P0 能力机器映射；窗口中加入/暂停的成员归属；Daily Window 边界；数值 freshness SLA；外部通知资格、聚合与偏好默认值；周回执“有效巡检”和时间范围政策。

## 工程设计与全局约束

复用当前 `codex/m1-fact-metric` 检出及其既有脏树；M3 起点另存逐文件基线，不以 HEAD 差异冒充本轮范围。不提交、不推送、不部署，不读取运行配置、密钥或运行数据库。

1. 同一 `monitoring.db` 增量加表；保留核心 schema version 1，扩展独立版本表记录 M3 schema 版本，事务安装并拒绝未知未来版本。不删旧表/旧数据。所有新增领域读写核对原始 tenant/workspace/project/competitor/target/revision，不以安全化目录名作为身份。
2. 持久记录实际已提交 job attempt 的 Coverage 观察对象，它只是 03 §14 窗口 Coverage 的输入层，未完成窗口期望集合、漏窗口及完整汇总生产者，也不是完整 Daily Window 或全部外部尝试账本。job window_key 仅作调度关联；window_start/end、expected_targets、required_capabilities、qualified_successful_targets、policy_version 等缺证明时为 null。attempted_targets 可为已知实际目标数；source success、done、Metric 或空 event_ids 均不能补造成功覆盖。历史分母不从当前 active 或分页列表重建。
3. 生产 quiet 判定只读取该 Coverage 对象，返回 allowed 与缺口 reasons；当前无批准政策生产者，正式运行必须保持 false。固定 100% 守卫不能由请求参数、页面或 provider success 调低。测试中的完整对象只验证门禁不变量，不构成生产政策入口。
4. M1 增量保留本批每 Fact 的既有 Diff 检测结果及明确拒绝原因，保留原有新 Fact 检测与 Event 语义。duplicate、缺基线、不可比、阶段失败和跨 scope 均不能声称无变化；不为绕过缺口全租户扫描补“成功”。
5. 在 job finish 与当前结果提交的同一 SQLite 事务保存 Coverage 和 observed 事件站内投影；重复提交与重启不得重复插入。事件/事实/证据/快照及 raw 引用均须核对，投影只保留安全的公开字段和追溯 ID，不泄漏 raw 路径。站内可见不自动获得外部推送资格。
6. 外部资格、偏好、Daily Window 尚缺批准输入：不创建外部发送意图，不接旧 webhook、邮件或新 provider，不增加调度器。返回明确 external_delivery_blocked 原因；不把 accepted 说成 delivered。完整 outbox 投递及重试暂不冒充实现。
7. 只读状态增加 Coverage 与事件通知投影，前端渲染服务端结果。后续摘要必须使用同一服务端投影；本轮只提供逐任务观察及独立记录总数，不实现显式时间范围汇总或正式日报/周回执，不定义默认周期、有效巡检、恢复或更正为零。保留旧 alerts/digest API 和默认调度行为。完整摘要/回执继续列为缺口，不能将分页计数包装成已交付周回执。
8. 不新增业务枚举、状态、资格/比较/事件政策、付费升级或提供商。direct-first 和无变化不调用 LLM 沿用已有正式路径；不能据此宣称完整 P0 或升级策略完成。

## 任务 A：持久 Coverage 与 quiet 门禁

预期文件：新增 `app/services/monitoring-coverage.js`、`app/test/monitoring-coverage.test.js`；仅在必要时增量修改 `monitoring-store.js`。

提供 `createCoverageService({store})`，接口 `recordObservation({job,target,result,now})`、`get(tenantId,id)`、`list(tenantId,{workspaceId,projectId,competitorId,offset,limit})`，以及纯 `evaluateQuiet(coverage)`。观察 ID 绑定 raw tenant、job、attempt；同键内容冲突拒绝，不覆盖旧观察。关联来自数据库真实已完成 job 与 target scope，不信任调用方自报 tenant/project。分页在 scope 过滤后进行，返回 total。

持久对象至少包含 coverage_id、schema_version、job_id、attempt、watch_target_id/revision 与完整 scope、真实 source_results/snapshot_ids/fact_ids/diff_ids/event_ids 引用、窗口与 policy 字段、各计数、source_failures、missing_capabilities、issues、quiet 判定。当前缺失 expected/required/freshness/window/actionability 证明必须逐项说明；不得用数组空值表示已证明无缺口。

先红后绿：旧 v1 数据保留、扩展事务安装/重开/未来版本拒绝；原始 tenant 碰撞与跨 workspace/项目隔离；幂等与冲突；99%、0/0、未知分母、缺能力、partial/blocked/stale/缺基线/空事件不允许 quiet；范围过滤后分页不改变覆盖口径。测试使用自建临时 ZB_DATA_DIR。

## 任务 B：真实运行提交、比较结果与站内通知投影

依赖 A 独立审查通过。预期文件：`app/research/enrich.js`、`app/research/monitoring.js`；新增 `app/services/monitoring-projection.js`、`app/test/monitoring-projection.test.js`，扩充 runtime/API 回归。

集成细化：允许 `monitoring-coverage.js` 仅增量导出既有内部引用验证器供 B 复用，生成新投影前重新核验真实 store 目录及 DB 自有结果，避免复制算法和沿用保存 Coverage 后已损坏的 raw/Event。该导出不是 HTTP 或政策写入口，A 的规则、DTO 和 schema 保持。

`factExtract` 增量包含 comparisons：每项 fact_id、原 detector 返回的 status/diff_id/event_id/reason，拒绝与异常显式留因。结果 `diff_ids/comparisons` 只暴露核对通过的本 scope 关联；不改变首次或 duplicate 行为。源失败留真实失败，不构造 no_change。

`createMonitoringProjection({store})` 在事务中由已完成且 fenced 的真实 job/result 读取事件与完整证据链生成 immutable observed 投影；站内通知稳定 key 绑定 raw tenant/workspace/target/event，记录生产时的 revision/投影版本；技术版本或 revision 不得让同一事件重放成第二条通知。不得接受客户端正文或 eligible 参数。显示真实价格区间、变化边界、时间、事件/证据详情引用和 observed 未确认含义；未知市场与重要性明确保留。来源链异常只留下可审查 issue，不生成成功通知。没有 LLM、搜索、webhook 或邮件调用。

runtime 成功提交时完成 queue.finish → Coverage → projection → current result，任一步 SQLite 失败整体回滚；保留文件 append-only 不属于 SQLite 回滚的既有限制。过期 lease/暂停/停止/租户失效不得写当前有效投影；真实失败的当前提交也形成不足 Coverage。discarded 不成为成功覆盖。

状态 DTO 增量返回 scoped Coverage、event_projections、明确局限；已有 GET tenant 权限和 project+competitor 成对过滤不放松。增加 `summary` 只读方法时必须显式 from/to，按实际账本计数并保留不支持项为 null，不定义日报/周报边界。

先红后绿：真实 mocked Net→Fact→Diff→Event→Coverage→投影；首次/相同/变化/partial/失败区分；重放/重开/多连接幂等；事务故障回滚；跨租户/项目/旧 revision/坏 raw 拒绝；通知失败不改 Event；未知资格零外部调用；direct-only 无 LLM/search。保留既有 runtime/价格语义测试。

## 任务 C：Coverage 与站内变化展示

依赖 B 独立审查通过。预期文件：`web/src/types/state.ts`、`web/src/components/monitoring-controls.tsx`（按现有实际路径调整）、`web/scripts/check-monitoring.cjs` 或新增 `check-monitoring-intelligence.cjs`；必要的 API helper。

在已有显式打开的监控面板显示 Coverage 的未知/不足原因、实际尝试和源失败、quiet 未允许原因，以及服务端 observed 通知内容和追溯入口。不得显示“无变化”替代缺口，不将 observed 标为 confirmed，不由前端算覆盖或静默。保留账号/项目/竞品/workspace/生命周期及读写代次所有权；旧请求晚到不得串账号/项目或回滚新状态。无需新增写动作或通知偏好默认值。

行为测试使用真实组件/API/Provider 代码及已有模拟 hook/transport harness，明确其不是浏览器 E2E。覆盖缺 Coverage、partial、unknown、重复刷新、账号/项目切换与晚到响应；运行类型检查及构建。

## 集成修复 D：复用事件详情的原始身份边界

C独立审查复现：既有`/api/demo/event-detail`及按ID读取函数仅按安全化目录定位；原始tenant不同但目录名碰撞时可返回其他tenant的事件及子对象，拥有事件的Fact文件被替换成foreign tenant/project时也会被返回。新站内投影列表的严格隔离不能替代被复用详情入口的服务端隔离。这是现有租户/范围合同的实现缺陷，不是新的业务规则。

预期文件：`app/routes/handlers/demo.js`，新增实际handler回归`app/test/monitoring-event-detail-scope.test.js`；必要文档同步。先用实际模块、临时目录与ALS写RED，再在详情投影边界核对根Event原始tenant与请求ID；子Diff/Fact/Evidence/Snapshot核对原始tenant、Event项目范围和引用ID，矛盾子对象诚实返回null或省略，根事件无权时404。嵌套provenance不得绕过边界泄漏其他对象。保留有效同tenant链、同tenant空项目历史、缺失子对象的旧响应形状；不改价格算法、事件语义或存储，不迁移/删除数据，不扩大到所有旧端点重构。

回归覆盖目录碰撞、foreign子对象、同tenant错误项目/ID、完整正向和缺环正向、递归raw路径净化；所有数据合成且禁止外呼。完成后由C reviewer限定复验C-I1与诱发兼容，再进入新的整轮独立终审。详情仍是元数据追溯，不声称该接口已提供实时raw健康核验。

## 合并轮（2026-10-18）：与 origin/main watch-* 基础闭环合流

拉取origin/main新增两笔提交（46ffc4f/19829ed，review/watch-coverage-foundation的"正式监控基础闭环"：watch-store/watch-monitor/watch路由/watch-price/digest-store/watch-control，及对sweep.js的整改§3收缩——正式监控信号唯一边界=用户明确加入的WatchTarget）。当前分支无独有提交，故以备份patch+stash、快进到19829ed、stash pop恢复M1–M3脏树、逐文件解决冲突的方式合流；全程不提交、不推送、不部署。

- 内容冲突5个文件：`sweep.js`采纳上游收缩版（R1价格/R2断货上新直抓按整改§3移除，ALS租户归属检查保留），`startScheduler`取并集：SCHEDULER_ENABLED=0全关→FORMAL_MONITORING_ENABLED=1时monitoring运行时整体接管（不叠加watch/digest tick）→默认不调度旧sweep（ZB_SWEEP_ENABLED=1逃生门，启用的也只是收缩版）+watch tick+每租户当地08:00 digest tick；`price-stats.js`头部取本地版（商品价格不称客单价）、basis两边一致；`run-tests.js`保留本地按套件时限表；`digest.test.js`取本地串行async版并补关watch-store/digest-store两个SQLite句柄（Windows下rmSync EPERM）；`price-stats.test.js`单用例取本地超集版。
- 自动合并抽查：`net.js`上游variantCount与本地代表价语义共存；`routes/index.js`monitoring/watch/intelligence路由并存；`registry.js`新增:param段匹配（精确优先）；`web/src/lib/api.ts`上游apiPatch/apiDelete与会话所有权保护并存；前端两个监控组件挂载点不同（雷达页watch-control、情报档案monitoring-controls）。
- 测试适配（合并后语义与旧断言不兼容，非放松）：`sweep-context.test.js`按整改§3将llm断言4→2、collect断言2→0并改为钉"sweep零直抓"；`monitoring-api.test.js`第二用例改为合并后调度并集语义（默认[0,1,1,0]/逃生门[1,1,1,0]/FORMAL[0,0,0,1]/总关[0,0,0,0]），路由tenant-only断言保留。两处均与上游W18断言一致。
- 语义取舍依据：正式监控信号不得来自未准入扫描是冻结PRD §16与两条线计划的共同原则；origin/main已过两轮独立评审并合入主干，本地未提交WIP适配主干。由此旧sweep默认不再产生任何价格/断货/上新提醒——这是合并带来的默认调度行为变化，已记入现行API契约2.8.1/2.8.2。
- 规格核对（只读subagent逐条核对计划引用章节、产品评审决策08/10/11、SCP-02/SC-01）：本地M3实现与冻结口径逐条一致、六项未决声明属实；watch-*线的quiet生产口径、observed/verified语义、摘要自动外发等与冻结基线或未决决策相抵且无批准变更依据，已按AGENTS.md以[SCP-03](../changes/SCP-03_双监控线coverage_quiet冲突上报.md)上报6项冲突，两线并存维持现状，不静默裁决。
- 合并轮独立复审（新subagent，只读+临时目录实测）：冲突解决7文件与声明语义逐项相符（三方比对8ae4700/19829ed/工作区）；两线零交叉import、alerts单一生产者分线、前端无口径混用，未发现quiet/无变化互相污染；M3本体quiet守卫/外发阻断/limitations保持未知即缺口。结论PASS-with-notes：2项Minor——digest.test.js暂存区曾缺closeDb两行（已补add一致）、sweep.js:96 `state.tenantId || proj.tenantId`死分支（不阻塞，留后续清理，身份实际单一来源）。

## 审查与验证

A/B/C 各由新实现 subagent 顺序推进；每项完成后由独立 reviewer 检查规格符合性与代码质量，阻塞项修复并定向复审后才进入下一项。最终由新的独立 reviewer 复审整个 M3 增量。

重点失效类别：规格/未决规则偷渡；范围/身份/原始证据造假；重试/并发/事务/幂等失效；失败/partial/历史/分页冒充完整 coverage；UI 异步串 scope 与错误确认/送达声明。

新执行后端全套测试（临时 ZB_DATA_DIR，清除继承 MT_STORE_PATH/OBS_DB_PATH）、前端行为脚本/价格一致性、tsc 与 build。代码冻结后再执行 secret-scan（含新增文件）、空白、本地文档链接与产品评审标题序列检查。禁止读取真实配置或测试外部发送。

## 验收与开放问题

- [x] 已知依据的实际检查账本、100% quiet 守卫、比较原因、持久站内事件投影与只读展示完成。
- [x] 各任务及最终独立复审无未修复阻塞项；新执行验证证据齐全（2026-10-18合并轮独立复审PASS-with-notes、2项Minor不阻塞，其中死分支留后续清理）。
- [x] 当前路径未知分母/能力/窗口/鲜度/重要性时禁止 quiet，未知外发资格时零外部调用。
- [x] 旧 schema 数据、API、alerts/digest 兼容；调度默认随origin/main整改§3变化并已在2.8.1/2.8.2与本计划记录；原有脏树及 output 保留。

完整 M3 仍为 PARTIAL：缺批准 Coverage/window/membership/freshness/外发/周回执政策、完整 P0 采集能力、Canonical/Qualification 上游、confirmation/correction 链与独立 Golden/生产 SLA。完整 outbox、自动日报/周报和有界付费升级须在批准输入齐备后另行接线。本计划不批准这些业务规则。

## 交付记录

以下按M3逐文件起点记录本轮增量，不将既有M1/M2脏树差异算入M3。分项早期失败日志保留用于追溯，以修复后的新执行结果为准。

A：新增 Coverage 观察存储与 100% quiet 守卫，核心 schema v1 保留。首轮独立复审发现引用存在但内容矛盾仍被接受；修复后以既有 `price-diff.judge` 核对层间内容，原算法文件未修改。最新独立 44 项回归与原 11 种矛盾复现及有效/失败控制通过，规格、质量限定复审通过后进入 B。早期 15 项测试不作为修复后的验证结果。完整窗口生产者与政策缺口仍保留。

B：接入实际逐Fact比较诊断、fenced任务提交、Coverage和持久站内observed投影；不扫描租户事件历史补成功。独立审查发现旧parser v1合法价格事实缺available字段被误拒，修复按真实Evidence/Fact版本只读兼容；同次投影按快照缓存解析、跨调用重新核验；时间字段按07规范使用enqueue_at/failed_at。最新独立32项runtime/projection/API、69个相关Node runner项及原兼容/解析计数复现通过，三项发现关闭后进入C。未更改旧parser、价格算法、事件和调度语义；原Event文件可能在SQL失败后遗留且不能保证补投，完整outbox仍开放。

C：新增Coverage不足原因、服务端quiet与observed通知展示，使用真实组件/Provider/API的模拟hook与transport行为测试保护分页、稳定ID、身份及异步所有权。分项前端规格/质量复审通过；复用详情入口的既有原始tenant隔离缺陷C-I1由D处理后关闭。该harness不是浏览器E2E。

D：仅修复复用eventDetail响应边界的原始tenant、项目、ID及关系核验，重建授权provenance并递归清除raw路径；合法完整/空项目/缺环历史兼容。新增实际require+ALS、临时文件及禁外呼的30项回归，RED为4通过26失败，修复后30通过。独立复验原目录碰撞与foreign Fact复现及正向控制通过，C-I1关闭；不声称其他旧端点已全面加固或该详情具备实时raw健康检查。

### 规格引用

适用依据见本文“规格与范围”；D另受00 §42租户隔离、03 §17权限与项目范围约束。SC-01仅批准其声明的collector/parser分离范围；SCP-02及产品评审决策08/10/11仍是提案/未决输入。本轮未改变冻结业务基线。

### 变更文件

相对逐文件M3起点共23个文件；其中6个新增、17个修改。既有M1/M2文件即使尚未入Git，也仅计算本轮内容增量。

| 范围 | 文件 |
|---|---|
| Coverage与投影（新增） | `app/services/monitoring-coverage.js`、`app/services/monitoring-projection.js` |
| 实际主链接入 | `app/research/enrich.js`、`app/research/monitoring.js` |
| 事件详情边界 | `app/routes/handlers/demo.js` |
| 新增回归 | `app/test/monitoring-coverage.test.js`、`app/test/monitoring-projection.test.js`、`app/test/monitoring-event-detail-scope.test.js` |
| 扩充回归 | `app/test/monitoring-runtime.test.js`、`app/test/monitoring-api.test.js`、`app/test/shopify-pagination-evidence.test.js` |
| 前端 | `web/src/types/state.ts`、`web/src/components/monitoring-controls.tsx`、`web/scripts/check-monitoring.cjs` |
| 文档 | `docs/README.md`、`docs/architecture/00_整体架构规范.md`、`docs/architecture/01_前端架构规范.md`、`docs/architecture/02_现行API契约.md`、`docs/01_Product_PRD_v1.4.0_review.md`、`docs/spec/changes/SCP-02_runtime_PRD_conflicts.md`、`docs/spec/plans/2026-10-17_PRD补全计划.md`、本文件（新增） |
| 本地缓存卫生 | `.gitignore`增加`.pnpm-store/`，避免包含指向检出的junction缓存进入源码清单 |

### Schema与迁移

保留`monitoring.db`核心`user_version=1`及旧表/数据。增量安装独立扩展版本登记`monitoring_extension_schema`、`coverage:1`与`event_projections:1`，新增`monitoring_coverage`和`monitoring_event_projections`；安装在事务中，未知未来扩展版本拒绝。无生产迁移、旧存储删除、数据库引擎更换或数据回填。文件Fact/Event与SQLite的跨存储恢复仍有缺口。

### API变化

正式monitoring.status增量返回`coverage/total_coverage/event_projections/total_event_projections`，各自先scope过滤再分页；当前结果增加`diff_ids/comparisons/coverage_id/event_projection_ids/projection_issues`。只读站内投影含真实链引用、价格区间、服务端view及`enqueue_at`，重要性和外部投递时间未知，明确外发阻断原因。旧字段及alerts/digest保留。复用event-detail保留响应形状、增加原始身份和关系边界。精确字段及限制见[现行API契约](../../architecture/02_现行API契约.md)；无新业务写入口、外发、摘要/回执端点或默认政策。

### 新增与扩充测试

新增三组后端回归：Coverage持久/门禁/层间内容及隔离；站内投影版本兼容、原始取证核验、幂等/重开/事务与逐调用缓存；实际eventDetail模块的30项原始身份/项目/引用/缺环/provenance测试。扩充实际runtime/API及分页Evidence回归，覆盖首次、重复、真实变化、partial、失败、篡改、过期任务及零外呼。前端扩充真实组件/Provider/API的所有权、列表与鉴权详情行为harness，未添加依赖或放宽检查。

### 合并轮新执行测试结果

2026-10-18合并后全新临时ZB_DATA_DIR、清除继承MT_STORE_PATH/OBS_DB_PATH重跑：后端`run-tests`共62套，首轮仅`monitoring-api.test.js`1套失败（其旧断言钉住合并前的默认调度语义），按合并后并集语义适配后，最终收口全套62套、0失败、exit0。前端7个行为脚本（价格一致性、雷达价格、partial档案、Metric、操作所有权、状态刷新、监控）全部exit 0；`tsc --noEmit --incremental false`通过；`pnpm build`exit 0、15个静态页面，既有7条lint警告保留。`node scripts/secret-scan.js` PASS（12项已知豁免、0未豁免真实命中）；`git diff --check`通过；8份相关文档92条本地链接全部存在。冲突解决期间曾以备份patch+stash双重备份，stash条目在pop冲突后保留未删。

### 新执行测试结果

最终全量后端回归：2026-10-18合并收口时在全新临时ZB_DATA_DIR、清除继承MT_STORE_PATH/OBS_DB_PATH后`run-tests`共62套、0失败、exit0（含20k有界队列、static/observability嵌套门禁与上游watch-foundation全套）。恢复后的七个前端脚本（价格一致性、雷达价格、partial档案、Metric、操作所有权、状态刷新、监控）均exit 0；`tsc --noEmit --incremental false`通过；`pnpm build` exit 0，15个静态页面，保留7条既有lint警告。没有禁用检查、安装依赖或修改package/两个锁文件。First Load JS不是gzip测量，不据此宣称性能预算或零警告目标通过。

验证期间整理pnpm生成缓存发生一次本地操作失误：缓存junction关联当前检出，移动导致Next暂时不可加载。已停止整理，从完整保留副本以只复制方式恢复原路径并保留缓存；三个前端交付文件匹配冻结哈希，package与两个锁文件匹配M3起点。上述前端行为、类型和构建均为恢复后新执行结果，不沿用故障前的构建冒充验证。缓存加入忽略规则，不再移动或删除；未进行依赖重装、生产操作或数据清理。

### 验收核对

| 场景 | 结论与限制 |
|---|---|
| 实际提交→链引用核验→Coverage→站内observed投影→状态→页面→鉴权详情 | 已实现，分项独立复审通过；仅有据目录价格观察子范围 |
| 未知分母/能力/窗口/鲜度/actionability；失败/partial/stale/空事件 | 明确保留不足，实际quiet=false；完整对象的100%测试只验证守卫，不是生产政策入口 |
| 重放、重开、revision及多连接 | 同一原始tenant/workspace/target/event不重复通知；历史保留原revision，不替代当前覆盖 |
| 外部资格与偏好未知 | 无发送意图或外呼，站内observed不升级为confirmed或delivered |
| 完整窗口Coverage、Daily/weekly、完整outbox、Golden/SLA | 未满足，完整M3为PARTIAL |

### 兼容核对

保留核心schema、旧数据、旧alerts/digest、默认正式开关；scheduler语义在合并轮后按origin/main整改§3为新默认（旧sweep不默认调度、watch tick+digest tick接线、ZB_SWEEP_ENABLED逃生门、FORMAL显式接管，见合并轮与现行API契约2.8.1/2.8.2）；未改变qualification、价格比较、Evidence/Fact/Event语义或引入provider。旧parser v1/v2只读兼容，未知版本拒绝。详情合法空项目/缺环与原响应形状保留。既有M1/M2脏树及output保留，无提交、推送或部署。完整回归和文档检查收口结果见测试记录，不用历史M1/M2结果替代本轮验证。

### 开放问题

1. P0能力机器映射、完整促销/上新等能力及Canonical/Qualification真实生产者未接；真实来源market-null不能通过严格同市场复查，不以Workspace市场填充。
2. 历史窗口成员分母、加入/暂停归属、Daily Window与08:00摘要边界、数值鲜度SLA、actionability/重要性及外发资格/聚合/偏好尚未批准。
3. 周回执有效巡检/恢复/更正规则、显式时间范围汇总与完整outbox外部重试/恢复尚未实现。
4. 文件Event可能先于SQL提交遗留，后续仅新Fact检测不保证原通知自动补投；不承诺跨存储at-least-once或零丢失。
5. 完整attempt成本账本、跨Workspace采集合并、confirmation/correction传播、独立Golden、真实浏览器E2E及生产SLA/全目录性能仍待后续范围。
6. 详情隔离修复仅覆盖本次复用入口；其他旧getter/端点未全面加固，该元数据详情也不是raw实时回放健康验收。
7. 2026-10-18合并后双监控线并存（monitoring线与watch线）的Coverage/quiet/摘要外发口径冲突已上报[SCP-03](../changes/SCP-03_双监控线coverage_quiet冲突上报.md)（Proposed，6项：双Coverage存储、双quiet生产者、observed/verified语义混用、静默摘要自动外发vs DTO声明相反、双调度实现、"整改§N"文档不可追溯）；裁决前两线维持现状，任何取舍/统一/降级均须产品批准，不得由工程轮代决。
