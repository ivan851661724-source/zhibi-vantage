# SCP-03：origin/main watch-* 基础闭环与冻结 Coverage/quiet/通知口径的并存冲突

状态：Proposed（2026-10-18），不是已批准规格变更。本提案只上报冲突、影响与选项，不修改冻结基线，不批准任何一方口径，也不授权立即改删任一实现。发现途径：M3 合并 origin/main（46ffc4f/19829ed，review/watch-coverage-foundation）后的规格核对（[M3计划](../plans/2026-10-17_M3_Coverage_quiet_通知.md)）。

背景：合并后仓库同时存在两套正式监控实现，经调度开关互斥但 API、存储与通知路径并存：

- **monitoring 线**（M1–M3 专项，本地未提交增量）：`monitoring.db` 的 `monitoring_coverage`（job-attempt 观察，缺证明字段恒 null）+ `monitoring_event_projections`（站内 observed 投影，`external_delivery_blocked=true`）；`FORMAL_MONITORING_ENABLED=1` 时由 `research/monitoring.js` 运行时接管调度入口；quiet 为纯校验器（00 §21/02 §12 冻结口径），生产恒 false。
- **watch 线**（origin/main 已合并）：`watch_targets.db`（WatchTarget + `monitoring_windows` 窗口落账）+ `digest_state.db`（每租户当地 08:00 日报幂等）；默认调度路径激活（watch tick + digest tick，旧 sweep 需 `ZB_SWEEP_ENABLED=1` 逃生门）；API `/api/watch-targets`、`/api/digests/daily`、`/api/watch-targets/coverage`。

| # | 规格引用 | 现状实现（watch 线） | 冲突与影响 | 选项（待裁决，不代选） |
|---|---|---|---|---|
| 1 | 00 §22、02 §12（Coverage 最低字段清单：required/missing capabilities、qualified_successful_targets、policy_version 等） | `monitoring_windows` 字段不含上述清单，coverage 为 `full/gap/incomplete` 只读派生，分母=该目标用户自选 enabled signals | 同一"Coverage"语义两套存储、两种 schema、两种分母；Daily Digest/quiet/SLA"统一读取 Coverage"（00 §22）无法成立 | a) watch 窗口落账补齐冻结字段后并入唯一 Coverage 口径；b) 将 watch 窗口重命名/降级为非 Coverage 的技术巡检账本并改其消费者文案；c) 批准双口径并定义各自适用边界 |
| 2 | 02 §12（quiet 阈值冻结为 100% active P0 WatchTargets 完成其 required P0 capability coverage）；07 §3（<100% 只能发 coverage-gap 文案）；01 §18（P0=价格/上新/促销，库存为 P1） | `digest.js` 真实生产 `quiet_with_full_coverage`：分母为当日已到点窗口（enabled signals 含 stock-P1、不含 promo-P0），未消费 freshness/actionability 证明 | quiet 生产口径低于冻结 100% required-P0 门槛且 P0 机器映射未决（SCP-02 行1），可能向用户发出不成立的"无变化"承诺；与 monitoring 线恒 false 的保守守卫并存使同一产品出现两种静默资格 | a) watch 简报改为 coverage_incomplete 单态直至批准政策齐备；b) 按冻结字段补全证明后接 02 §12 口径；c) 产品裁决豁免（须走 02 §12 降门槛四条件） |
| 3 | 02 §11（observed 与 confirmed/verified 必须可区分）；00 §23–24 | `watch-monitor.js` 首窗价格比较即标 `basis:'verified'` 并以此过滤 quiet 事件面 | 同一业务事件在两线确认等级不同（watch=verified，monitoring=`price_change_observed`+`observed_unconfirmed`），跨线展示会升级确认程度 | a) watch 侧改为 observed 语义；b) 明确 verified 判据政策后再统一；两向都属事件语义裁决，须产品确认 |
| 4 | 决策10/11（外发资格、摘要窗口均未决）；SCP-02 行2（外部资格/偏好待明确）；monitoring 线 DTO `scheduled_digest_not_implemented` | `runDigestTick` 经 `mailer.sendMail` 默认自动外发含静默摘要的邮件（配置通道后） | 未决的外发资格/摘要边界被落成默认行为，且与 monitoring 线"调度摘要未实现"的现状声明相反 | a) digest tick 默认只落站内、外发待决策10/11；b) 维持现状并改 DTO 声明为"限 watch 线既有范围"；均须产品拍板 |
| 5 | 03 §12（调度实现口径唯一归属）；03 §15（所有端 render 同一 Projection） | 双调度实现（monitoring queue/lease vs watch claimWindow）+ 双通知路径（站内投影 vs alerts→digest→邮件），同一 Shopify URL 可被两线各自采集 | 无 canonical collection coalescing 时重复采集/重复提醒成本；两线互斥仅靠调度开关，API 层可同时写入两套库 | a) 明确一线为正、另一线冻结只读；b) 接 M4 canonical 合并后统一采集；c) 批准双线边界（各自 API/入口/人群） |
| 6 | AGENTS.md 文档治理（approved spec changes 仅 `docs/spec/changes/`） | watch 线代码口径引用"整改 §1–§10"，该文档不在仓库、不在 changes/，仅存在于 review 分支提交说明 | 关键口径选择（degraded 继续巡检、paused 不计分母、08:00 语义等）无批准依据可追溯，后续维护无法区分"已裁决"与"临时实现" | 将确有据的整改结论补录为 SCP/规格条文或注明出处；其余按未决处理 |

执行约束（本提案不改变）：合并轮保持两线并存、调度互斥现状；未裁决前不以任一线口径改写另一线代码、文档或测试；watch 线缺陷修复仅限与冻结规则直接相抵且双方计划一致的最小范围（如失败不得当无变化），不借修复偷渡上表任一选项。
