# SC-04 UI 框架轮 r2 · Playwright 验收用例（真实租户链路，零 mock）

对 `review/core-product-ui-framework-r2` 修复项的可复跑浏览器验收：项目上下文贯穿（顶部选择器 / 侧栏导航 / 深链接）与报告「重新生成」跳转新任务。数据走真实 SQLite + 真实 HTTP API，不使用任何 mock 响应。

## 用例清单（core-ui-r2.cjs）

| 场景 | 断言要点 |
|---|---|
| S1 深链接项目 B | 打开 `/brands?projectId=B`：顶部选择器显示项目 B 的赛道名、品牌卡为 B 的品牌、页面发出的 `/api/*` 请求全部携带 `projectId=B`（A 为 0 次） |
| S2 切换项目保留参数 | 品牌详情 `?projectId=A&tab=timeline` → 顶部选择器切到 B → URL 变为 `?projectId=B&tab=timeline`（只替换 projectId，非项目参数保留） |
| S3 侧栏四核心入口 | 带 `projectId=A` 的品牌详情 → 点击侧栏 竞品库/情报库/机会视图/调研报告 → 四次跳转 URL 均保留 `projectId=A` |
| S4 失败报告重新生成 | `/report?projectId=A` 列表含「生成失败」行 → 点「重新生成」→ URL 切换为 `/report/<新reportId>?projectId=A`（≠ 失败报告 id）→ 新任务状态可见（排队中/生成中/已完成），页面轮询至终态 |
| S5 未接入维度诚实呈现 | 品牌详情 coverage tab 建设中区域：列出 社媒内容/广告活动/口碑与评论/搜索与热度 四维度，标注「尚未接入」「刷新：不可用」，区域内无 `<svg>` 图表、无 0 值徽章、无虚构来源 |

## 运行前提

1. Node ≥ 22（需内置 `node:sqlite`）。
2. 后端依赖零安装（`app/` 零依赖）；前端依赖已装（`web/`）。
3. Playwright 运行时：任一方式
   - `cd web/e2e && npm i playwright --no-save`（或全局安装），并 `npx playwright install chromium`；
   - 或本机已有 playwright（脚本通过 `require('playwright')` 解析，NODE_PATH 可用）。
   浏览器通道默认用本机 Edge（`channel: 'msedge'`），无需下载 chromium。

## 运行步骤

```bash
# 1) 启动后端（独立数据目录；必须与 seed --data-dir 一致）
cd <repo>/app
ZB_DATA_DIR=/tmp/zhibi-e2e node server.js            # 默认 PORT 3300

# 2) 启动前端生产服务（需先构建）
cd <repo>/web
npm run build
npx next start -p 3100

# 3) 准备数据（真实注册 + 真实 SQLite 直插 + 真实报告创建→终态→置 failed）
cd <repo>/web/e2e
node seed.cjs --data-dir /tmp/zhibi-e2e --backend http://127.0.0.1:3300

# 4) 跑用例
node core-ui-r2.cjs --front http://127.0.0.1:3100 --seed .e2e-seed.json
```

成功输出：`[e2e] ALL PASS（5 场景，截图目录 ...）`，截图落 `web/e2e/.e2e-shots/`（gitignore，不进仓库）。退出码 0=全过 / 1=有失败 / 2=环境缺失（如未装 playwright）。

## 数据诚实性说明

- `seed.cjs` 通过真实 HTTP 注册租户、创建报告（`POST /api/reports` → 202 → 轮询终态）；项目行与品牌/证据/时间线数据通过服务层直插**真实 SQLite**（`seed-svc.cjs`，走 brand-store / surface-store / evidence-store 真值链），与线上同构，无任何伪造 API 响应。
- S4 的「失败报告」由真实成功报告经 SQL 置为 `failed`（`error_text` 注明 e2e 注入现场），「重新生成」点击后的创建、跳转、轮询全部走真实 HTTP。
- 用例断言中明确检查：未接入维度区域无 0 值、无模拟图表、无虚构来源；URL 侧 `projectId` 全程不丢。
