# 线上竞品雷达渲染异常排查

状态：PARTIAL（本地修复与验证完成，尚未部署；用户当前工作区身份未提供）。

服务检查：前后端容器 healthy，`/radar` HTTP 200。录屏账号可打开空雷达，没有浏览器错误，因此该问题与页面数据相关，不能把新录屏账号的空列表视为用户故障。

只读检查现存调研档案发现，工作区 `tenant_2d0bf0df252a` 的 Osprey `priceBand.range` 为 `{min:155,max:350}`，其核心价格带为空。线上与本地 `fmtPrice` 在此分支直接返回对象；React 渲染价格节点抛出 `Objects are not valid as a React child (found: object with keys {min, max})`。这会造成用户描述的 Application error。该数据还含数组形式的历史区间。

修复计划：只让格式化函数返回可渲染文字。非文字的历史区间回退至既有 `priceField.display`，保留其来源/推断标识；缺失时显示“价位未明”。不重新解析历史原始区间，不修改价格算法或存储值。

改动：

- `web/src/lib/labels.ts`：为旧区间与标准化显示值加入运行时文字类型检查。
- `web/scripts/check-radar-price.cjs`：六组回归案例，使用实际 React 渲染验证对象/数组、缺失值、推断标识、正常区间与核心价格带。

验证：修改前用线上问题的数据形状复现实际 React 异常；修改后全部通过。价格解析前后端一致性检查通过。生产构建编译、类型检查、静态页面生成通过（已有 lint 警告）；secret-scan 通过。

规格依据：00 Engineering Baseline 数据真实性规则；01 PRD 真实数据优先；04 Frontend §0 缺口可见；03 API §0 REST 为事实源。Schema/Migration/API/调度变化：无。当前改动不触碰 Demo 数据与事件链。

待完成：确认部署授权，备份线上 `labels.ts`，只应用此最小补丁、重建前端，验证受影响账号实际雷达页面。AGENTS.md 的 “Forbidden Without Explicit Spec / Ticket Authority” 明确禁止直接编辑生产系统；前次授权针对 Demo 两个文件，不包含这次雷达工具文件。
