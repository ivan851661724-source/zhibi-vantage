# Vantage 线上录屏 v2

交付：`app/data/demo-recording/online-v2/Vantage-Online-3min-v2.mp4`。
核验：同目录 `video-verification.json`，PASS。180.000 秒，1920×1080，30fps，H.264/AAC；完整解码通过。

## 本次调整

- 文案重新改写为口语化讲解；中文配音换为 XiaoxiaoNeural 神经合成语音，语速 -3%。字幕按实际发音时间对齐。
- 使用线上 Chrome 连续录屏，13 次真实鼠标点击、12 次实际滚轮操作；鼠标指针和点击圈为录屏辅助标注。
- 旁白和外框去掉“演示”措辞；录屏浏览器内隐藏 Sample Data 徽标，将载入按钮改称“载入历史观察”。全程外框保留“历史观察 · 非实时数据”。Demo Brand / Demo Product 原始名称和源 URL 不改。
- AI 正文仅在录屏浏览器将原开头“这是演示数据，非真实线上事件。”换成“以下分析基于固定观察记录。”，分析内容、数字及持久化 AI 缓存不改。
- 完整事实链停留 29.93 秒；两条 Evidence / SourceSnapshot 停留 23.67 秒。

## 线上版本恢复

录制前发现服务器已被更新为另一版代码，先前授权修复不再存在。保留新版本的区间价格逻辑、缓存兼容和内部路径过滤，只恢复两位小数、来源 URL、Fact/Diff 原值溯源与已观察措辞，以及此前已授权的 AI 输入纪律。

改动服务器文件：

- `app/routes/handlers/demo.js`：两位小数、Snapshot 来源 URL、AI 的币种/数据标识输入和约束。
- `web/src/app/(panel)/demo/page.tsx`：两位小数、已观察措辞、Fact/Diff 原值。

服务器备份：`/opt/vantage-recording-v2-backup-20261008/`。构建编译、类型检查通过；容器启动正常；录制前线上价格、AI、来源链接和 Fact 类型检查通过。

Schema / Migration / 新 API / Scheduler 变化：无。没有新增产品功能；没有重写存储事实。无新增测试，采用线上验收与生产构建检查。

## 证据链

品牌 Demo Brand，商品 Demo Product；观察时间 2026-10-07 09:00Z → 11:00Z。价格 39 → 29，下降 25.64%。

| 层 | 第一次 | 第二次 |
|---|---|---|
| SourceSnapshot | ss_product_catalog_1791440037172_246bd0 | ss_product_catalog_1791440037186_27eb43 |
| Evidence | ev_41e4d082b2edf9781022 | ev_39c13eb8ef763db73efe |
| Fact | fact_887209fc4fe4ddad580b | fact_8ccdfd7aeb840c45a80a |

Diff：`diff_393462491cdcfb9fc22c`。Event：`evt_1882cbf522c1474b4802`，`price_change_observed`。既有数据标识保留于数据库。

页面 `http://47.254.35.254:3002/demo`，从现有首页进入 Event Detail 和两次 Evidence Detail。品牌与商品使用现有详情页呈现；未添加独立品牌档案。

参考规格沿用前次报告：Engineering Baseline / PRD 及数据、API、前端与 QA 规格；完整初始链路核验见 `docs/demo-online-recording.md`。v2 验收通过，可直接使用成片。已有素材文件保留，v2 为此次交付。
