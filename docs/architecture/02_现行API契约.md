# 知彼 Vantage 现行API契约

> 真相来源：`app/routes/index.js`（注册表）+ `app/services/api-tenant.js` / `api-admin.js`（独立挂载）。
> 本文档是前端 `web/src/lib/api.ts` 的实现依据。后端新增/修改端点必须同步更新本文档。

> 状态：现行接口兼容说明，清单按已记录接口范围维护，不宣称全部领域目标均已实现。领域对象与正式合同见[后端与接口规格](../spec/03_Backend_API_Contract_v0.3.md)，整体边界见[整体架构规范](00_整体架构规范.md)。实现中的失败静默、错误高可信等问题不得因出现在本清单中而被视为批准。

---

## 1. 通用约定

### 1.1 基础信息
- Base URL：同源 `/api/*`（Next.js rewrites 代理到后端 3300，见 01 §3）。
- Content-Type：`application/json`（除 SSE）。
- 字符编码：UTF-8；时间戳：毫秒 Unix epoch。

### 1.2 鉴权
| 方式 | 头 | 获取途径 | 适用 |
|---|---|---|---|
| 租户 JWT | `Authorization: Bearer <jwt>` | `POST /api/login` / `POST /api/register` | 绝大多数端点 |
| 平台超管 token | `Authorization: Bearer <adminToken>` | 管理员登录（api-admin） | 管理端点 |

- token 存储：`localStorage.zhibi_token`（兼容旧键 `ci_token`）。
- 401 处理：仅 `AUTH_REQUIRED` / `ADMIN_AUTH_REQUIRED` 清 token 跳登录（见 §1.3）。
- suspended 租户：入口层 `resolveIdentity` 统一拒绝（server.js L57-62）。

### 1.3 错误模型
```json
{ "error": "MACHINE_READABLE_CODE", "message": "人类可读说明" }
```
- HTTP 4xx/5xx 均返回此结构（如 `{"error":"EMPTY","message":"请填写 brand"}`）。
- **401 语义分两种**：`AUTH_REQUIRED` / `ADMIN_AUTH_REQUIRED` 为鉴权失败（前端清 token 跳登录）；其余 401（如 discover 的 `NO_KEYS`——密钥未配置）是**业务错误**，前端不得误杀会话。
- 前端约定：`Error.status` 携带 HTTP 状态码（对齐现有 `api()` 封装）。

### 1.4 访问级别
注册表三级：`public`（免鉴权）/ `tenant`（租户 JWT）/ `admin`（超管）。

---

## 2. 端点清单

### 2.1 账号（public）
| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/login` | 登录，返回 JWT |
| POST | `/api/register` | 注册（品牌/工作区名 + 邮箱 + 密码），创建租户 |

### 2.2 系统（public）
| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/healthz` | 容器健康检查 |
| GET | `/metrics` | Prometheus 文本格式指标 |
| GET | `/api/version` | 服务版本号 |

### 2.3 只读/派生（tenant）
| 方法 | 路径 | 用途 | 备注 |
|---|---|---|---|
| GET | `/api/state` | **核心**：整个调研档案（competitors/materials/opportunity/…） | 可选`private_view=1`；前端全局 state 唯一来源 |
| GET | `/api/domains` | 领域列表 | |
| GET | `/api/materials` | 材料流 | 支持 status/type 筛选 |
| GET | `/api/heroes` | 明星产品 | |
| GET | `/api/radar-changes` | 雷达变化事件 | |
| GET | `/api/price-metric?id=...&offset=0&limit=20` | 本次目录可售样本指标及分页证明链 | 只读、tenant隔离，固定Fact ID排序 |
| GET | `/api/evidence-detail?id=...` | 证据及当前可回放快照详情 | 与既有`/api/demo/evidence-detail`共享实现 |
| POST | `/api/quadrant` | 四象限计算 | |
| POST | `/api/compare` | 品牌对比 | |

`/api/state`竞品档案可附`shopifyPartialScan: boolean`、`shopifyPartialScanReason: string | null`，表示本次目录枚举未完成及实际原因；重研会刷新这两个字段。既有`shopifyTruncated`继续表示分页预算截断。它们描述已观察目录范围，不代表正式Coverage已完成，也不改变资格规则。前端不得把未完成扫描显示成全店覆盖。

仅`private_view=1`启用当前用户的私有字段投影。后端从已验证身份读取tenant/user，不接受查询参数指定他人身份；无法解析、ghost或缺少tenant/user时返回`403 PRIVATE_VIEW_UNAVAILABLE`。投影在独立响应副本上读取该用户既有纠错，调用现有字段算法重算价格、上新、口碑、渠道和品类字段；每次以最新来源为基础，不重放纠错时的旧整包字段。不保存投影，不改变公共事实、聚合、资格或现有纠错裁决规则；默认GET保持原行为。待复核价格在已存字段快捷路径下的隔离仍有既有缺口，不能据此接口宣称全面修复。

`competitors[].priceMetric`为增量可选投影，旧档案可以缺失，重研开始及失败路径会清除旧引用。它来自本批明确Fact集合的持久指标，不与旧`priceStats/priceVerdict/priceField`等价，不为旧资格结果提供新引用。字段如下：

| 字段 | 语义 |
|---|---|
| `metric_id / metric_type / evidence_status` | 指标标识；当前类型`catalog_active_product_price`，计算结果为`derived` |
| `algorithm_version / config_version / computed_at` | 实际计算/配置版本与计算时间；不得冒充来源观察时间 |
| `observed_from / observed_to` | 数值来源的真实观察时间范围，按实际时间排序 |
| `currency / market / unit` | 继承有证明的事实上下文；未知保留null，不借用户或品牌假定值 |
| `value.p25 / value.median / value.p75` | 已观察且明确可售正价样本的分布；每商品一个变体中位价，四分位沿用`floor(p*(n-1))`，不作销量加权；样本小于3均为null |
| `sample_product_count` | 真正贡献数值的商品数量 |
| `product_counts / variant_counts` | 商品数与商品内唯一原生变体数，不能混加。商品分类表示“含对应变体的商品”，可重叠；只有`active_paid`进入数值样本 |
| `partial_scan / limitations` | 分页及数据限制；可能包括样本不足、币种/市场/单位未知、可售性未知、无效或缺失报价、扫描未完成 |

此指标是目录样本描述，未识别Core Product Line，不等于品牌核心价格带、成交价或AOV，不改变S2/S3资格。私有纠错不改写原始观察指标，公共更正传播仍属后续主链。产品/变体身份或支持观察时间缺失、重复商品观察冲突、跨租户/批次/域/项目、引用断链时不生成有效指标；失败页不变成零或无变化。

`GET /api/price-metric`返回`{ metric, facts, evidences, snapshots, issues, collectionIssues, offset, limit, total, nextOffset, hasMore }`。`metric`含完整输入ID、配置及collection引用；后端保存于当前DATA下`metrics/<tenant namespace>/`，append-only，无数据库迁移。`offset`须为非负安全整数，`limit`须为1–50整数，默认20；非法400，越界返回空页。仅展开本页Fact的支持对象，完整采集中的失败/空页通过`collectionIssues`保留。`issues`用`{ kind, id, reason }`说明当前缺链或损坏，不能将历史计算结果解释为证明链当前完好。

`GET /api/evidence-detail`返回`{ evidence, snapshots, issues }`，保留demo旧入口和来源字段。未登录401、缺ID或非法ID400、同租户不存在或无权对象404；命名空间之外再次核对原始tenant ID。公共响应递归去除`raw_payload_ref`，原始服务器路径不出网；快照`raw_resolvable`依当前字节是否存在、完整且哈希一致返回，失败如实列入issues。原始数据仍只留存于服务端，不因展示接口删除。

### 2.4 采集/研究（tenant）—— 重操作，注意超时与配额
| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/stream` | **SSE** 变化推送（见 §3） |
| POST | `/api/discover` | 竞品发现（扇出搜索 + 两阶段 harvest，后台异步跑） |
| POST | `/api/enrich` | 单家深研 |
| POST | `/api/lookup` | 品牌探测 |
| POST | `/api/timeline` | 时间线回溯 |
| POST | `/api/brief` | 简报生成 |
| POST | `/api/deepdive` | 深度下钻 |
| POST | `/api/voice` | 社媒/评论采集（brand 必填；失败源静默） |
| POST | `/api/sector` | 赛道分析（聚合 + 空白 + 趋势） |

### 2.5 纠错/反馈（tenant）
| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/field-correct` | 字段纠错（进待复核队列） |
| POST | `/api/field-review` | 字段复核 |
| POST | `/api/field-correct/revoke` | 撤销纠错 |
| POST | `/api/intent` | 意图修正 |
| POST | `/api/exclude` | 排除竞品 |
| POST | `/api/feedback` | 通用反馈 |
| GET | `/api/feedback-report` | 反馈报表 |
| POST | `/api/rule-review` | 规则复核 |
| POST | `/api/material-action` | 材料三动作：`{ id, action, projectId? }`，action为keep/ignore/later，空值撤销；返回当前档案decisions及projectId |
| ALL | `/api/user-notes` | 私有笔记 CRUD |

`material-action`传入`projectId`时执行当前档案前置校验；错配返回`409 PROJECT_CHANGED`，在修改、持久化和行为记录之前退出。空值或非字符串projectId为`400 BAD_INPUT`。未传projectId的旧客户端保留原行为；成功响应新增`projectId`（旧档案缺失时为null），其余字段兼容。当前前端按项目串行提交并携带该前置条件，防止切换后的旧排队动作写入另一个档案。

### 2.6 度量层（tenant）
| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/snapshot` | 快照上报 |
| POST | `/api/consume` | 消耗记账 |
| POST | `/api/calibration` | 校准提交 |
| GET | `/api/calibration/summary` | 校准汇总 |
| POST | `/api/calibration/computation` | 校准计算 |
| POST | `/api/accuracy/sample` | 准确率抽样 |
| GET | `/api/accuracy/summary` | 准确率汇总（含字段门禁） |
| GET | `/api/north-star` | 北极星指标 |

### 2.7 配置/档案/报告（tenant）
| 方法 | 路径 | 用途 |
|---|---|---|
| GET / POST | `/api/config` | 读/写租户配置（密钥等） |
| POST | `/api/searchtest` | 搜索源连通测试 |
| POST | `/api/reset` | 重置当前档案 |
| GET | `/api/projects` | 调研档案列表 |
| POST | `/api/projects/switch` | 切换当前档案 |
| POST | `/api/projects/delete` | 删除档案 |
| POST | `/api/report` | 生成调研报告 |

### 2.8 数据自动化（tenant）
| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/tasks` | 后台任务状态 |
| GET | `/api/cost/summary` | 成本汇总（LLM/搜索归因） |
| GET | `/api/scheduler/status` | 定时雷达调度状态 |
| GET | `/api/alerts?limit=50` | 当前租户站内提醒；limit为1–100，返回`{ alerts, unread }` |
| POST | `/api/alerts/read` | `{ ids: string[] }`批量已读，返回`{ marked }`；空ids为400 |
| GET / POST | `/api/alerts/settings` | 读写当前租户摘要收件人mailTo；空串恢复账号邮箱；GET另返回digestEnabled |

站内提醒至少包含`id/type/at/read`。监控类型`price-change`、`price-discovered`、`product-launch`、`stockout`使用`competitorName/text/projectId/competitorId`，按现有来源可能附`old/new/deltaPct/currency/sourceUrl/basis/count`；`competitor-move`使用`moves`。前端呈现服务端正文，不自行重算价格变化或升级确认程度。提醒列表不是Coverage，也不能替代完整DomainEvent详情或证明静默日报已完成。

#### 2.8.1 正式监控增量（tenant，M2整体PARTIAL）

| 方法 | 路径 | 输入及响应 |
|---|---|---|
| GET | `/api/monitoring/workspaces` | `workspaceId? / offset / limit`；`{workspaces,offset,limit}` |
| POST | 同上 | `{name,market,timeZone,idempotencyKey}`；201 `{workspace}` |
| PUT | 同上 | `{workspaceId,market,timeZone}`；`{workspace,scope_changed,targets,total_targets,message}`；变更暂停关联旧目标、增加revision，不自动改市场或恢复 |
| GET | `/api/monitoring/targets` | `workspaceId? / projectId? / competitorId? / offset / limit`；`{targets,total,offset,limit,enabled,issues,limitations}` |
| POST | 同上 | `{workspaceId,projectId,competitorId,brandId,qualificationResultId,categoryScope,idempotencyKey}`；201 `{target}`；当前档案前置校验 |
| POST | `/api/monitoring/pause`、`/api/monitoring/resume` | `{watchTargetId}`；`{target}`；恢复重新准入，不靠当前研究页授权 |
| POST | `/api/monitoring/recheck` | `{watchTargetId,eventId}`；202 `{accepted,duplicate,job:{job_id,watch_target_id,status,trigger,event_id,scheduled_at}}` |
| GET | `/api/monitoring/status` | 与targets相同过滤/分页；返回下述状态 |

所有写入拒绝未登记字段，不能传入tenant、qualified、source或priority自证状态。`offset`须为非负安全整数，`limit`为1–100整数、默认50；`projectId/competitorId`过滤必须成对，先按当前对象及Workspace过滤再分页，不能从前50个无关目标推断未加入。projectId沿用现有中文、字母、数字及连字符规则。归属核对原始tenant，不只检查文件namespace。

Workspace字段为`schema_version/workspace_id/tenant_id/name/market/target_market_timezone/revision/created_at/updated_at`；时区须显式IANA，无浏览器或市场默认值。目标为`watch_target_id/workspace_id/project_id/competitor_id/brand_id/category_scope/market/target_market_timezone/current_qualification_result_id/monitoring_status/monitoring_policy_id/user_priority/revision/created_at/paused_at/effective/next_slot/latest_result`。`user_priority`当前为null；保存的active不代表此刻可执行，`effective:{executable,issues}`另行报告开关、租户、上游及scope问题。`next_slot:{window_key,scheduled_at}`是计划，不能称最近成功检查或SLA。变更revision后不把旧结果投影为本轮结果，旧历史保留。

`latest_result`可为null；完整结果含`schema_version/job_id/revision/completed_at/source_status/source_results/snapshot_ids/currency_snapshot_id/fact_ids/event_ids/price_metric/evidence_extract/fact_extract/partial_scan/issues`。M3增量增加`diff_ids/comparisons`，每项比较为`{fact_id,status,diff_id,event_id,reason}`：status来自实际Diff或null，首次、重复不重放、不可比、异常与局部无变化分开保留；正式引用核验scope及内容，不更改旧检测语义。当前结果另有`coverage_id/event_projection_ids/projection_issues`，job.result在Coverage生成后不原地修改。`source_results`保留provider、真实source_status、HTTP状态、观察时间与collector版本；`price_metric`使用M1服务端摘要，可为null，不补算或猜市场。失败job.result可以只有`source_status/reason/event_ids/snapshot_ids/issues`，客户端不能将其当完整Metric结果。任务done不等于成功覆盖、无变化或quiet。

status返回`enabled/running/issues/limitations/workspaces/targets/jobs/counts/gaps/backpressure/offset/limit/total_targets/total_jobs`。`enabled`表示配置开关，`running`表示当前进程runtime已启动，均不表示真实准入已就绪。jobs包含实际技术任务状态pending/running/done/error/dead、trigger、窗口或event、原scheduled_at、领取lag、warning/degraded候选、来源结果与discarded诊断；counts含待办、在途、各终态、oldest_age_ms及config_version。gap是未确认完成窗口的诊断，不是Coverage。HTTP投影去除内部lease/token、原始服务器路径及raw_payload_ref。

M3为status增量返回`coverage/total_coverage/event_projections/total_event_projections`，均按相同原始tenant、workspace及成对project/competitor先过滤再独立分页；total是各自历史记录总数，不能作为覆盖分母。历史记录保留生产时的目标revision，不因暂停/范围变更冒充当前检查。旧alerts与digest契约保持。

`coverage`是已提交job-attempt的不可变观察输入，含`coverage_id/job_id/attempt/watch_target_id/revision`、scope、来源状态及失败、经核验的snapshot/fact/diff/event引用与comparisons、记录/完成时间、各Coverage字段和`quiet:{allowed,reasons}`。`attempted_targets=1`仅证明本次尝试；已核验来源失败/partial或聚合明确失败时`failed_targets=1`，否则未知。`expected_targets/successful_targets/qualified_successful_targets/required_capabilities/missing_capabilities/window_start/window_end/policy_version/freshness_status`等缺证明时为null，不能补0、空集合或100%。当前无完整窗口/成员/P0/鲜度/actionability生产者，生产quiet保持false。单个调度window_key不是Daily Window，不以空事件推quiet。

`event_projections`是持久站内observed历史，稳定`notification_id`绑定原始tenant/workspace/target/event；revision或技术投影版本变化不得增加重复通知。字段包含生产时的job/attempt/coverage/revision、Event/Diff/Fact/Evidence/Snapshot引用、前后价格区间及可用标量、direction/delta/pct/currency/实际来源market、observed_at_old/new、occurred_at、enqueue_at，和服务端`view:{from,to,changed_boundary,change_label}`。`importance/accepted_at/delivered_at/failed_at`目前为null，`external_delivery_blocked=true`并列明资格/偏好/策略缺口。limitations明确未确认、只支持目录商品价、品类相关性及重要性未知；partial和市场未知另行显示。已有完整取证的partial子集变化可显示，不提高覆盖程度。`event_detail_api`为既有`/api/demo/event-detail?id=...`，须使用统一鉴权API客户端读取；普通href不携带Bearer凭证。投影不含raw路径或客户端任意正文，不自动写旧webhook/邮件。

复用的`GET /api/demo/event-detail?id=...`在响应边界核对根Event的原始tenant与请求ID，无权或身份矛盾返回404。子Diff/Fact/Evidence/Snapshot必须符合原始tenant、Event项目、引用ID及已知关系，异常标量返回null、异常数组项省略；历史null/missing项目互相兼容。嵌套provenance从核对后的记录重新投影，整个响应递归去除raw路径。保留`event/diff/facts/evidences/snapshots`形状和合法缺环显示；不修改保存对象、价格算法或事件语义。该接口仍是元数据详情，不新增实时raw健康的`issues/raw_resolvable`保证，也不代表其他旧端点已全面加固。

同一SQLite事务保存完成标记、Coverage、站内投影和当前结果；文件Fact/Event不在SQLite回滚范围。文件先落盘而SQL失败/进程中断可能遗留未投影Event，后续采集不保证自动补投，不能宣称完整outbox、跨存储at-least-once或零丢失。没有新建正式日报/周报端点、默认周期或外发策略，完整范围见[M3计划](../spec/plans/2026-10-17_M3_Coverage_quiet_通知.md)。

正式路径未选择或总开关关闭时，加入/恢复/复查409明确拒绝；配置、读取和暂停仍可用。缺身份或不可变资格来源时`409 ADMISSION_REJECTED`并给issues；当前档案切换`409 PROJECT_CHANGED`；非同tenant对象404；非法ID/分页/过滤400；队满`503 MONITORING_QUEUE_FULL`带retryable。复查必须有当前目标revision已完成job中的实际event关联，并通过完整Fact/Evidence/raw同scope及时序核验；未知来源市场的真实M1事件会被拒绝。同event幂等可能返回已done/error/dead旧任务，`accepted:true`不能被解释为新入队，不改变固定窗口或Event状态。

`GET /api/scheduler/status`保留旧`enabled/hours/nextAt/lastSweepAt`并追加`formal`上述状态；旧hours不是正式Workspace时区。2026-10-18合并origin/main正式监控基础闭环（见2.8.2）后，默认调度为：旧sweep不再默认调度（`ZB_SWEEP_ENABLED=1`为运维显式逃生门，启用的也只是仅recentMoves研究维护的收缩版），同时启动watch tick与每租户当地08:00的digest tick；`FORMAL_MONITORING_ENABLED=1`显式选择本节M2/M3正式技术路径时由monitoring运行时整体接管调度入口，此时watch tick与digest tick不再由startScheduler启动。旧摘要不能附会新Coverage/当天承诺。Canonical/Qualification可信生产者、来源市场证明及跨Workspace采集合并仍未接，M2边界见[M2计划](../spec/plans/2026-10-17_M2_监控主链.md)；M3只增量接检查观察和站内投影，不代表外部通知或完整窗口已验收。

#### 2.8.2 正式监控基础闭环（tenant，origin/main 已合并的并行技术线）

origin/main（review/watch-coverage-foundation，提交46ffc4f/19829ed）合入了另一条WatchTarget基础实现：存储为`ZB_DATA_DIR/watch_targets.db`（WatchTarget+监控窗口Coverage，v0落到tenant×project×competitor）与`digest_state.db`（每租户当地日期至多一次的日报幂等行）。它与2.8.1的monitoring线并存，当前没有合并为一套，也未获任何批准将其裁决为唯一口径；两套的字段、分母与quiet/覆盖语义不同，前端分别经`watch-control`（雷达页）与`monitoring-controls`（情报档案）入口访问，不互通互换。

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/watch-targets` | `{competitorId, projectId?...}`加入监控；同tenant×project×competitor幂等原样返回 |
| GET | `/api/watch-targets` | 当前租户对象列表，每项附`lastWindow`（最近窗口key/slot/结束时间/coverage/partialScan/failureReasons/attempted/succeeded） |
| PATCH | `/api/watch-targets/:id` | 局部更新（状态/信号等，以handler实现为准） |
| DELETE | `/api/watch-targets/:id` | 软停用：`monitoring_status='inactive'`，对象、窗口、事件与历史保留，可再次加入恢复 |
| GET | `/api/digests/daily` | 三态日报简报`changed / quiet_with_full_coverage / coverage_incomplete`，读窗口Coverage持久层 |
| GET | `/api/watch-targets/coverage` | 同一简报（调试/前端提示用），不把分页计数包装成已送达回执 |

该线的窗口coverage为`full/gap/incomplete`只读派生：任何失败/partial/未完成即gap，不把失败当无变化；quiet口径为窗口complete+coverage达标+无verified/actionable事件，与2.8.1 M3的保守quiet守卫（缺批准政策/分母/鲜度/actionability证明一律不允许）是两套口径，不能互相引用或抵扣。日报tick为每租户Workspace当地08:00（整改§10），`digest_state.db`幂等防止重启重发。本节为已合并实现的事实性描述，不构成对两线取舍或新业务规则的批准；统一/迁移方向须另行提案。
### 2.9 租户/管理（api-tenant.js / api-admin.js 独立挂载）
账号、额度、租户管理、超管操作等，前缀同为 `/api/*`。管理页面与接口以当前`web/src/app/admin/`及后端挂载实现为准；本节尚未完整列举管理端点，新增调用前检查源码并补录，不沿用已结束的迁移阶段作为权限或可用性结论。

---

## 3. SSE 协议（`GET /api/stream`）

**鉴权**：与其它 `/api/*` 端点一致要求身份令牌。因 `EventSource` API 无法自定义请求头，
`/api/stream` 额外接受 **查询串令牌**：`GET /api/stream?token=<JWT>`（或 `access_token=`）。
令牌仅此端点接受查询串通道；服务端日志只记 pathname，不落 query。事件**按租户分通道投递**
（各租户只能收到自己的 discover/brand 事件与回放；通用 `change` 信号为全局广播，不含业务数据）。

```
Content-Type: text/event-stream
retry: 3000          # 客户端断线重连间隔（ms）
: connected          # 注释行（心跳/连接确认）
: ping               # 每 25s 服务端心跳
data: {"type":"<事件类型>", ...payload}
```

前端行为契约以`web/src/lib/sse.ts`与`web/src/hooks/use-zhibi-state.tsx`为当前实现入口：
1. 收到业务事件 → 拉 `/api/state?private_view=1`，按完整REST响应比较后更新。只把事件当作失效通知；请求期间再次收到变更时，合并为后续读取，避免遗漏新状态。
2. `discover_error` 等事件有**回放缓冲**（服务端按 (租户, 项目) 缓存最近事件，晚连客户端补收）。
3. 客户端断线由EventSource自动重连（`retry: 3000`）；每次连接成功立即重新读取REST，避免依赖回放缓存完整。后端尚未提供完整的event_id/seq合同，本次恢复修复不代表已验收基线全部去重/缺口检测要求。
4. 每租户连接数上限 5；超限服务端先推 `stream_rejected` 事件后关闭（前端退回 15s 轮询兜底）。

浏览器提醒缓存按JWT中稳定的`tid + sub`隔离，材料决策再按现行`projectId`隔离；JWT解码仅用于本地缓存选键，服务端鉴权继续验证令牌。无归属旧全局缓存停止自动读取，不自动迁给当前账号；未知身份不回退全局缓存。请求返回时会检查捕获会话，旧账号401不得清除新账号令牌。`GET /api/alerts`在挂载、打开提醒面板、页面恢复可见及有界轮询时读取；失败保留已显示内容并提示暂时未更新，不宣称无变化。

## 4. 旧设计中未接入的端点

已删除的旧静态前端设计曾声明以下端点，历史清单不构成当前可调用接口。新增调用前重新核对当前注册表；未注册端点不能依据旧设计直接使用：

| 端点 | 说明 |
|---|---|
| GET `/api/rivals`、`/api/rivals/:id` | 竞品雷达/情报库档案 |
| GET `/api/opportunities` | 机会视图 |
| POST `/api/materials/:id/action` | 三动作（kept/later/dropped） |
| POST `/api/corrections` | 纠错提交 |

现行相关面板主要读取`GET /api/state`聚合数据。拆分细粒度端点时，先登记其范围、权限与兼容影响，再同步前后端实现和验收；旧静态设计不能代替新的接口合同。

## 5. 契约变更流程

1. 后端改 `routes/index.js` → 同步更新本文档对应表格。
2. 前端 `web/src/types/` 中的 TS 类型随之调整，二者在同一 PR 内交付。
3. 破坏性变更（字段删除/语义变化）须在文档中追加"变更记录"小节，注明日期与影响面。

## 6. SC-05 Competitive Memory 端点（2026-10-19，新增，纯增量）

时序数据库（`competitive_memory.db`）的读取与回补入口。全部 `tenant` 鉴权 + `projectId` 归属校验 +
品牌必须已关联该项目；跨项目/跨租户统一 `404`；响应不含文件路径、密钥、调用栈或内部错误码。
语义与字段定义见 `docs/spec/changes/SC-05_competitive_memory_foundation.md`。

| 方法 | 路径 | 参数 | 返回要点 |
|---|---|---|---|
| GET | `/api/brands/:brandId/memory` | `projectId`（必填）、`from`/`to`、`entityType`、`factTypes`、`cursor`、`limit` | `facts[]`（含 `value`/`unit`/`currency`/`sourceKind`/`timePrecision`/`evidenceIds`/`snapshotIds`/`versionId`）、`versions[]`、`coverage`、`nextCursor` |
| GET | `/api/brands/:brandId/timeline` | `projectId`、`from`/`to`、`limit` | `items[]`（`live_observation` / `archived_observation` / `derived_event` / `coverage_gap`）、`firstRecordedAt`、`note` |
| GET | `/api/brands/:brandId/history-coverage` | `projectId` | `dimensions[]`（`earliestAvailableAt`/`lastSuccessAt`/`coveredRanges`/`partialRanges`/`unknownRanges`/`evidenceCount`/`snapshotCount`）、`backfill`（最近任务） |
| POST | `/api/brands/:brandId/history-backfill` | body `projectId`、`capability`、`from`、`to` | `202 {jobId, deduped}`；不支持的能力 `400 CAPABILITY_NOT_SUPPORTED`（不排队） |
| GET | `/api/history-backfill/:jobId` | — | `status`/`progress`/`counts`/`coverageSummary`/`failureClass`/`errorUserText` |

约束（与 §5 契约变更流程一致）：

- `factTypes` 白名单：`product.price`、`product.currency`、`product.available`、`product.title`、`catalog.product_count`、`catalog.price_min`、`catalog.price_max`、`catalog.price_median`；未知类型返回 `400 INVALID_FACT_TYPE`。
- 第一阶段 `capability` 仅接受 `shopify_catalog`。
- 分页为游标式（`cursor` 不透明串），不提供 offset 分页。
