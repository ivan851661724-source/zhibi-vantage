# 线上比赛 Demo 录制与发布记录

站点：http://47.254.35.254:3002/demo

专用工作区：`Demo / Sample Data · 比赛录屏`，tenant ID `tenant:b039e47ca560`。通过正常注册入口创建，未修改已有账号密码。登录凭据不写入本报告或录屏。

## 数据与来源

沿用现有 Demo seed，固定品牌 `Demo Brand`、商品 `Demo Product`。

| 对象 | 旧观察（39） | 新观察（29） |
| --- | --- | --- |
| observed_at | 2026-10-07T09:00:00.000Z | 2026-10-07T11:00:00.000Z |
| SourceSnapshot | ss_product_catalog_1791440037172_246bd0 | ss_product_catalog_1791440037186_27eb43 |
| Evidence | ev_41e4d082b2edf9781022 | ev_39c13eb8ef763db73efe |
| Fact | fact_887209fc4fe4ddad580b | fact_8ccdfd7aeb840c45a80a |

Diff：`diff_393462491cdcfb9fc22c`，status `changed`，old_value `{price_min:39,price_max:39}`，new_value `{price_min:29,price_max:29}`。

Event：`evt_1882cbf522c1474b4802`，type `price_change_observed`，降幅显示 `25.64%`。

原始来源：`https://demo-brand.example.com/products.json?limit=100`。该地址为明确标注的 Demo 来源，不是真实线上竞品网站。provider 为 `shopify_products_json`，capability 为 `product_catalog`。

服务器原始内容位于容器 `/app/data/snapshots/tenant_b039e47ca560/20261008/`；目录映射到现有 Docker 数据卷 `zhibi_data`。所有演示对象沿用现有 Demo 标识。

## 已授权发布的最小修复

依据：00 Engineering Baseline v1.2（事实/溯源与 projection 规则）、01 PRD v1.3.3、02 Data Algorithm v0.3、03 API Contract v0.3、04 Frontend Interaction v0.3、06 Golden Dataset Acceptance v0.3，以及用户对两文件线上补丁的明确批准。

- `app/routes/handlers/demo.js`：Evidence Detail 从实际关联 Snapshot 取来源 URL；AI 输入加入币种和 Demo 标识，禁止推测未知币种，要求注明演示数据。
- `web/src/app/(panel)/demo/page.tsx`：百分比保留两位小数；observed 事件使用“已观察”文案；现有技术折叠区展示 Fact/Diff 原值；Evidence Detail 保留 Demo 标识。

保留线上原有布局和业务层价格展示。未更改 SourceSnapshot/Evidence/Fact/Event Schema、数据库、API 路由、Scheduler、Canonical Brand、Coverage 或外部供应商。已有 Evidence Detail 响应中补充真实来源 URL。

两文件审阅补丁：`app/data/demo-recording/online-review/demo-fixes.patch`。服务器回滚源文件目录：`/opt/vantage-demo-rollback-20261008`。保留镜像标签 `zhibi-vantage:demo-rollback-20261008` 和 `zhibi-web:demo-rollback-20261008`。

## 核验结果

- 生产构建、TypeScript 检查通过；其他页面有既有 lint 警告。
- 前、后端容器健康检查通过。
- 独立服务器进程核验固定时间、原始价格、原始内容 SHA256 与完整对象引用，通过。
- 两次重复 seed 返回 already，证据链文件哈希不变，通过。
- Event Detail、两条 Evidence Detail 均可回溯真实 Snapshot URL，通过。
- 浏览器刷新仍可见 39 → 29、25.64%，通过。
- 只重新生成本演示事件的 AI 缓存，未修改事实链；输出明确注明演示数据，未添加未知币种或无依据的销量/GMV数字，通过。
- 本次未新增产品测试；沿用已验证的 Demo handler 修复和现有链路核验脚本，并完成线上生产构建。

AI 输出：

> 这是演示数据，非真实线上事件。Demo Brand将Demo Product价格从39降至29，降幅25.64%，可能意图抢占市场份额或清库存。建议卖家关注其后续调价节奏，评估自身定价是否需跟进，同时核算利润底线，避免价格战恶化。

## 视频与页面

主要页面为 `/demo`，从今日竞争情报进入 Event Detail，再进入两条 Evidence Detail，并展开技术溯源。品牌与商品通过现有 Event Detail 展示；新工作区没有独立品牌档案，未为录制虚构档案。

视频输出目录：`app/data/demo-recording/online-video/`。本地 Chrome 录制器访问上述线上站点，连续录制真实页面；剪辑只添加外侧 Demo 标签、中文旁白与字幕，并在录屏浏览器内隐藏模型元信息，不修改价格、AI 正文或溯源数据。

此前浏览器工具连续采集超时的尝试不作为交付成片。最终视频核验以同目录 `video-verification.json` 为准。

最终交付：`app/data/demo-recording/online-video/Vantage-Online-Demo-3min.mp4`，已完成，状态 PASS。时长严格 180.000 秒，1920×1080、30fps、H.264/AAC，约 6.12 MB，中文旁白与字幕。

从展开完整链路至返回首页约 30 秒；旧、新 Evidence / SourceSnapshot 实际停留合计 20.40 秒。成片九个时间点及完整 AI 画面已人工检查，视频全文件解码通过，旁白音轨非静音、无峰值削波。全程保留外侧 Demo 标签，录制的是线上真实页面。

字幕文件：`app/data/demo-recording/online-video/captions.srt`。无未解决的录制或数据问题；独立品牌档案的展示差异已在上文说明。
