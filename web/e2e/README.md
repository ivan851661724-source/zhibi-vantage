# SC-04 UI 框架轮 · Playwright 验收用例（真实租户链路，零 mock）

对 `review/core-product-ui-framework` 系列（r2 / r3）修复项的可复跑浏览器验收：项目上下文贯穿（顶部选择器 / 侧栏导航 / 深链接）、跨项目切换的资源上下文清理（r3）、报告「重新生成」跳转新任务。数据走真实 SQLite + 真实 HTTP API，不使用任何 mock 响应。

## 用例清单（core-ui-r2.cjs）

| 场景 | 断言要点 |
|---|---|
| S1 深链接项目 B | 打开 `/brands?projectId=B`：顶部选择器显示项目 B 的赛道名、品牌卡为 B 的品牌、页面发出的 `/api/*` 请求全部携带 `projectId=B`（A 为 0 次） |
| S2 品牌详情切项目（r3 规则 2） | 品牌详情 `?projectId=A&tab=timeline` → 顶部选择器切到 B → URL 变为 `/brands?projectId=B`（**不保留** brandId / tab——r2 的「保留 tab」语义已被 r3 覆盖）→ 页面展示 B 的竞品列表，无 `BRAND_NOT_IN_PROJECT` / 404 现场 |
| S3 侧栏四核心入口 | 带 `projectId=A` 的品牌详情 → 点击侧栏 竞品库/情报库/机会视图/调研报告 → 四次跳转 URL 均保留 `projectId=A` |
| S4 失败报告重新生成 | `/report?projectId=A` 列表含「生成失败」行 → 点「重新生成」→ URL 切换为 `/report/<新reportId>?projectId=A`（≠ 失败报告 id）→ 新任务状态可见（排队中/生成中/已完成），页面轮询至终态 |
| S5 未接入维度诚实呈现 | 品牌详情 coverage tab 建设中区域：列出 社媒内容/广告活动/口碑与评论/搜索与热度 四维度，标注「尚未接入」「刷新：不可用」，区域内无 `<svg>` 图表、无 0 值徽章、无虚构来源 |
| S6 报告详情切项目（r3 规则 3） | 报告详情 `?projectId=A` → 顶部选择器切到 B → URL 变为 `/report?projectId=B`（**不保留** reportId）→ 页面不再展示 A 的报告内容（无「生成失败」「结构化事实版本」），展示 B 的报告列表空状态「暂无报告」 |
| S7 情报库 brandId 清理（r3 规则 1） | `/intel?projectId=A&brandId=<A品牌>` 筛选生效（展示该品牌情报）→ 顶部选择器切到 B → URL **清除 brandId** → 页面展示 B 的真实数据或真实空状态，无「当前筛选没有结果」假空、无 A 项目情报内容 |
| S8 情报库噪音修复（r4.10） | `/intel?projectId=A`：主列表无「XX：未接入」卡片（未接入维度是项目级覆盖状态，不是情报事件）；真实采集项（成功/部分完成）保留；底部「数据覆盖与建设中维度」折叠区域恰 4 项、每维度恰一次、统一文案「尚未接入，当前不生成数据、估算或结论。」、无时间戳/来源链接/Evidence/「待核实」/「资料不足」/svg 图表 |

## 用例清单（tiktok-coverage-r5.cjs · TikTok 覆盖范围浏览器级验证）

专用场景：验证「populated `ad_creatives` 摘要」在真实浏览器里的呈现（不只是 adapter summary）。

| 场景 | 断言要点 |
|---|---|
| T1 美国品牌（覆盖外） | 广告活动卡显示「该公开来源当前无覆盖」，注明「当前 N 国」「不含美国」；不显示「公开广告素材 0 条」 |
| T2 零值/结论式文案 | 页面无「0 条广告」「未观察到广告」、无结论式「没有广告」（`不代表…没有广告` 的否定说明不算）、无虚构趋势 |
| T3 素材与结论边界 | 覆盖外品牌仍有素材时：标注来源「平台公开披露」+ 覆盖限制，不表述为「美国市场投放」结论；同时校验 overview API 的 `coverageState / coverageCountryCount / brandMarket` |
| T4 德国品牌（覆盖内） | 正常显示「公开广告素材 1 条」；展示字段仅限已落库的官方字段；无花费/CPM/转化/GMV |
| T5 status_statement | 缺失（US 素材）不渲染状态说明行；有值（DE 素材）才展示 |
| T6 泄漏 | 页面可见文本无 client key/secret 名、Bearer、环境变量名、内部路径、调用栈、token 形态（只扫 `innerText`，避免把 Next RSC 载荷算进来） |

### 数据来源与诚实性约定

- `seed.cjs` → `seed-svc.cjs` 经**生产真值链**写入：`Snapshot.record` → `EvidenceStore.recordEvidence` → `SurfaceStore.createAttempt / completeAttempt`；summary 与观察由生产 `tiktok` adapter 的 `normalize()` 生成（覆盖判定读 `lib/tiktok-adlib.js`，不手写国数）。
- 原始响应体带 `"_e2e_fixture": "controlled e2e test record; NOT a real provider response"` 标记，快照里可审计。
- **这不是真实 TikTok provider 调用**，也不代表广告源已接通；页面读取走真实后端 HTTP（`/api/data-surface/overview`、`/api/data-surface/dimension`）。
- 数据面链路：US 品牌（intent.regions=[us]）→ `out_of_coverage`；德国品牌（`market: 'de'`）→ `covered`，并带 `status_statement`。

```bash
node tiktok-coverage-r5.cjs --front http://127.0.0.1:3100 --seed .e2e-seed.json
```

成功输出：`[tiktok-r5] ALL PASS（T1-T6，截图目录 ...）`。

## 运行前提

1. Node ≥ 22（需内置 `node:sqlite`）。
2. 后端依赖零安装（`app/` 零依赖）；前端依赖已装（`web/`）。
3. Playwright 运行时：任一方式
   - `cd web/e2e && npm i playwright --no-save`（或全局安装），并 `npx playwright install chromium`；
   - 或本机已有 playwright（脚本通过 `require('playwright')` 解析，NODE_PATH 可用）。
   浏览器通道默认用本机 Edge（`channel: 'msedge'`），无需下载 chromium。

## 运行步骤（干净数据目录可复跑）

```bash
# 1) 启动后端（独立数据目录；目录不存在则首次启动自动创建，必须与 seed --data-dir 一致）
cd <repo>/app
ZB_DATA_DIR=/tmp/zhibi-e2e node server.js            # 默认 PORT 3300

# 2) 启动前端生产服务（需先构建）
cd <repo>/web
npm run build
npx next start -p 3100

# 3) 准备数据（真实注册 + 真实 SQLite 直插 + 真实报告创建→终态→置 failed）
#    每次运行生成新租户/新项目/新品牌（id 含进程号），同一数据目录可重复执行
cd <repo>/web/e2e
node seed.cjs --data-dir /tmp/zhibi-e2e --backend http://127.0.0.1:3300

# 4) 跑用例
node core-ui-r2.cjs --front http://127.0.0.1:3100 --seed .e2e-seed.json
```

成功输出：`[e2e] ALL PASS（8 场景，截图目录 ...）`，截图落 `web/e2e/.e2e-shots/`（gitignore，不进仓库）。退出码 0=全过 / 1=有失败 / 2=环境缺失（如未装 playwright）。

## 数据诚实性说明

- `seed.cjs` 通过真实 HTTP 注册租户、创建报告（`POST /api/reports` → 202 → 轮询终态）；项目行与品牌/证据/时间线数据通过服务层直插**真实 SQLite**（`seed-svc.cjs`，走 brand-store / surface-store / evidence-store 真值链），与线上同构，无任何伪造 API 响应。
- S4 的「失败报告」由真实成功报告经 SQL 置为 `failed`（`error_text` 注明 e2e 注入现场），「重新生成」点击后的创建、跳转、轮询全部走真实 HTTP。
- 用例断言中明确检查：未接入维度区域无 0 值、无模拟图表、无虚构来源；URL 侧 `projectId` 全程不丢；跨项目切换后 URL 与页面均不残留原项目的资源 id 或筛选（r3）。
