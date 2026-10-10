# Vantage 比赛 Demo：录屏就绪

**PASS — 本地验收，2026-10-08，Asia/Shanghai。** Chrome 已登录本地演示工作区并停在首页，可直接录屏。尚未部署到比赛线上环境。

工作区：Demo / Sample Data；tenant：`tenant:cd86140446f1`。

页面：`http://localhost:3000/demo`。首页、Event Detail、Evidence Detail 使用现有页面及弹窗，没有新路由。使用当前真实登录会话；`?demo=1` 是旧 mock 入口，不用于本场景。新账号可点击「载入演示数据」播种同一场景，但 ID 属于新租户。

## 场景与 ID 链

Demo Brand / Demo Product：**39 → 29，下降 25.64%**，只有一个 `price_change_observed` 事件。

| 层 | A：39 | B：29 |
|---|---|---|
| SourceSnapshot | ss_product_catalog_1791426631915_73ecde | ss_product_catalog_1791426631922_11a91f |
| Evidence | ev_44fcaa0b7460a5b02fd9 | ev_53a49a72fde6fc4b6388 |
| Fact | fact_c72b4cc2aaa3832904fb | fact_5dc7d807fab044c797f8 |

两次 Fact → `diff_ebfddfe850c7f2ae6de0` → `evt_630bbe37e9266c8f9e1b` → AI Interpretation。

Fact 类型为 `public_product_price`。Diff 保持现有 `status: changed` 和价格区间格式：`old_value: {price_min:39, price_max:39}`，`new_value: {price_min:29, price_max:29}`；不新增 change_type 字段。Event 包含 entity、old/new fact、evidence、snapshot 引用和观察时间。

## 时间与演示标识

- 固定 A：2026-10-07T09:00:00.000Z，北京时间 17:00。
- 固定 B：2026-10-07T11:00:00.000Z，北京时间 19:00。
- 沿用既有固定时间，A < B < 2026-10-08。采集/写入/计算时间由既有存储层记录实际执行时间，与观察时间分别展示。
- Source URL：`https://demo-brand.example.com/products.json?limit=100`，保留示例域名，非真实竞品网页；raw 来自固定 fixture，无外部抓取。
- provider：`shopify_products_json`；capability：`product_catalog`，复用现有解析器。
- 所有对象通过 note 或 entity_ref.fixture_tag 保留 Demo / Sample Data；UI 和 AI 均说明演示数据。
- 原始输入没有证明币种，UI 保留「币种信息暂不可用」，AI 不添加货币符号。
- 没有销量、GMV、市场份额或用户流失变化数据。

## 文件位置

固定输入：`app/research/demo-fixture.js`；seed：`app/scripts/demo-scenario.js`（均未修改）。

运行数据位于已有 `app/data/`，全部 Git 忽略：

| 数据 | 位置 |
|---|---|
| Snapshot metadata/raw | app/data/snapshots/tenant_cd86140446f1/20261008/（2 JSON + 2 raw） |
| Evidence | app/data/evidence/tenant_cd86140446f1/ |
| Fact | app/data/facts/tenant_cd86140446f1/ |
| Diff | app/data/diffs/tenant_cd86140446f1/ |
| Event | app/data/events/tenant_cd86140446f1/ |
| 真实 AI 缓存 | app/data/ai-insights/tenant_cd86140446f1/evt_630bbe37e9266c8f9e1b.json |
| 自动核验报告 | app/data/demo-recording-report.json |
| 核验截图 | app/data/demo-recording/home.png、event-detail.png、evidence-detail.png |

## 3 分钟录屏步骤

1. 0:00–0:40：首页「今日竞争情报」，保留 Demo 标识，展示品牌、商品、39 → 29、25.64%。
2. 0:40–1:20：「查看详情」，展示价格与 AI 竞争影响分析。点击生成会读取真实生成的缓存，不依赖录屏时的新网络调用。
3. 1:20–2:20：展开「技术溯源」并向下滚动，展示 Event → Diff → Fact → Evidence → SourceSnapshot，包含 Fact 类型与旧/新原值。
4. 2:20–2:45：依次打开 39、29 两条「完整数据依据」，展开技术溯源，展示 URL、观察时间、Snapshot ID、content_hash 和 raw 路径。无需打开示例外部网站。
5. 2:45–3:00：关闭弹窗回首页：「Vantage 可以发现竞争变化，并且每个判断都有证据。」

## 自动核验与结果

仓库根目录运行，凭据沿用既有环境/安全配置，不写入命令或产物：

```powershell
node app/scripts/demo-scenario.js --tenant tenant:cd86140446f1
node --env-file=.env app/scripts/verify-demo-scenario.js --tenant tenant:cd86140446f1 --ai
```

`--ai` 默认使用已真实生成的缓存；需重新真实调用时加 `--refresh-ai`，沿用现有 refresh 行为。脚本不新增数据库，校验 raw/hash、价格、引用、固定时间、二次 seed 文件不变、详情 handler、AI 演示标识和币种纪律。

验收：seed、刷新持久化、Event Detail、Evidence Detail、真实 AI、刷新后的 AI 缓存、重复 seed 均 PASS。两次重跑全部链路文件路径与 SHA-256 不变，事件数仍为 1。

测试：Demo fixture 11、DomainEvent 12、Price Diff 15、Fact Store 18、Evidence Store 23、SourceSnapshot 20，合计 **99 passed / 0 failed**。TypeScript `tsc --noEmit -p web/tsconfig.json`、`node scripts/secret-scan.js`、`git diff --check` 均通过。

AI 当前真实缓存（deepseek-v4-flash）：

> 这是演示数据，并非真实线上实时事件。Demo Brand 的 Demo Product 价格从 39 降至 29（降幅 25.64%），可能意在抢占市场份额或清理库存。建议卖家关注同类目价格弹性，评估是否需调整自身定价或强化产品差异化以应对竞争。

策略意图明确为可能性，不声称发生了市场份额变化或其他未观察事实。

## 规格、改动与兼容性

规格：00 v1.2 §5/12/23/26；01 v1.3.3 A09/A17/A26；02 v0.3 §10.1/11；03 v0.3 §6/17；04 v0.3 §11；05 v0.3 §10；06 v0.3 §5.1。

规格偏差：00 §12 / 02 §11 区分 observed 与 confirmed，原 Demo 把 observed 写成「已确认」，暗示完成复查。可选按规格修正文案，或提出 Spec Change Proposal 改冻结语义。本任务按规格显示「已观察变化」，不改变事件语义，无需改规格。

| 改动文件 | 原因 |
|---|---|
| web/src/app/(panel)/demo/page.tsx | 两位小数、observed 文案、既有折叠区显示 Fact/Diff 值、证据 Demo 标签 |
| app/routes/handlers/demo.js | 从实际 Snapshot 补全证据 URL；AI 输入 Demo 标签和 null 币种，约束解读 |
| app/test/demo-fixture.test.js | 断言实际 AI 输入保留演示标签与未知币种 |
| app/scripts/verify-demo-scenario.js（新增） | 可重复核验完整链、raw hash、幂等与真实 AI |
| scripts/secret-scan.js | 既有模拟凭据误报登记精确哈希，未放宽正则 |
| docs/superpowers/plans/2026-10-08-demo-data.md（新增） | 实施计划 |
| docs/demo-recording.md（新增） | 录屏步骤和完成报告 |

Schema / Migration：无。数据库：复用现有 multitenant.db。API：无新增端点；既有 evidence-detail 的 snapshots 元素仅补充 source_url，实际快照缺失时为 null。未改 Canonical Brand、Coverage、Scheduler 实现，未新增第三方来源，未触碰生产。其他未提交工作未修改。

本地服务监听 3000 / 3300；仅本次启动进程使用既有 SCHEDULER_ENABLED=0，避免后台扫描干扰录屏，未改调度代码或持久化配置。

Open Issues：无本任务阻塞项；新的 AI 调用仍取决于供应商网络，本次录屏已有真实缓存；其他未提交工作未全面验收；本地数据未部署至线上。
