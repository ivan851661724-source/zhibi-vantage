# Vantage · 04 Frontend Interaction Spec

**版本：v0.4.0（SC-03 修订，2026-10-18）**  
**状态：受控规格；未接入数据面必须诚实显示能力状态**  
**上位依赖：00 v1.2 / 01 v1.5.0 / 02 v0.4 / 03 v0.4 / SC-03**

---

# 0. 产品交互原则

1. 首次价值先于完整度。
2. 默认用户不会每天主动登录。
3. Brief / Alert 是高频入口。
4. Dashboard 是审计与深入分析中心。
5. 用户必须能看到“为什么这么判断”。
6. 失败 / 缺口 / warming 必须可见。

---

# 1. 一级 IA

- 工作台
- 对手
- 判断
- 设置

高频路径：

```text
Brief / Alert
→ Event Detail
→ Evidence / Timeline
→ Decide
```

---

# 2. Onboarding

入口优先：

> 输入店铺 / 品类 / 目标市场

系统尽量自动推断：

- 品类
- 市场
- 币种
- 参考价格区间

用户确认，而不是填写复杂表单。

---

# 3. Discovery

## 3.1 0–2 分钟

展示：

> 找到 N 家候选，正在核实。

不得空白等待。

## 3.2 Progressive Result

每个候选显示：

- 品牌
- qualification 状态
- why
- core product line
- price band
- platform identity
- coverage
- freshness / stale gaps

用户可提前：

> 加入监控

仅对已满足最低资格者开放。

---

# 4. Competitor Card

必须优先展示：

- 为什么是竞品
- 核心产品线
- 核心价格带
- 最近一次重要变化
- 当前数据 freshness
- 是否正式监控

不要把全店 min/max 放在主视觉。

---

# 5. Today / Brief

回答三个问题：

1. 今天发生什么？
2. 什么值得我看？
3. 系统今天看全了吗？

状态：

### 有变化
显示重要事件。

### Quiet
显示：
- coverage
- “未发现已核实重要变化”

### Coverage不足
明确：
> 无法确认全部没动。

---

# 6. Event Detail

结构：

- What happened
- Old → New
- Observed / Confirmed
- Time
- Evidence
- Historical context
- Why it matters
- “这对我意味着什么？”

---

# 7. Watch → Decide

点击：

> 这对我意味着什么？

自动带入：

- current event
- user reference product
- user price
- market
- competitor set
- recent history

用户不应重新输入相同上下文。

---

# 8. Competitor Profile

页面至少：

## Overview
- brand
- relationship
- core product
- core price band

## Timeline
- price
- launch
- promotion
- correction
- data gap

## Products
按 Product Line 组织。

## Evidence
可审计事实。

---

# 9. Timeline

默认支持：

- 7d
- 30d
- 90d
- 180d

Timeline item 必须区分：

- business event
- correction
- retraction
- data gap
- system note

同时必须标识历史来源：

- observed：Vantage 当时真实观察
- backfilled：后来由外部历史源补入

Backfilled item 不得使用会让用户误以为“Vantage 当时已经监控到”的文案。

---

# 10. Judgment

输出结构：

1. 一句话结论
2. 当前落点
3. 竞争含义
4. 支撑事实
5. 数据缺口
6. Evidence

禁止 UI 暗示：

> AI 已替你做经营决定。

---

# 11. Evidence Drawer

点击 #F 或数字：

展示：

- source
- URL
- observed_at
- source_updated_at（若有）
- collected_at
- history_origin（observed/backfilled，如适用）
- field
- value
- status
- freshness
- related snapshot

Evidence Drawer 是信任核心组件。

---

# 12. 状态词典

必须覆盖：

- loading
- warming
- partial
- unavailable
- conflicted
- degraded
- quiet
- corrected
- retracted
- stale

不得统一显示：

> 数据异常

## 12.1 00 正交状态 → UI 状态映射

| 领域状态/条件 | UI 主状态 | 说明 |
|---|---|---|
| enrichment_status=running 且尚无可用结果 | loading | 正在补全 |
| enrichment_status=partial | partial | 展示已有数据 + 明确缺口 |
| monitoring_status=degraded | degraded | 监控仍运行但能力受损 |
| freshness_status=stale | stale | 数据存在但超过 freshness SLA |
| freshness_status=unknown | partial | 若无更高优先状态，提示新鲜度未知 |
| EvidenceStatus=unavailable | unavailable | 对应字段/模块不可用 |
| EvidenceStatus=conflicted | conflicted | 来源归一后仍冲突 |
| unavailable.reason_code=insufficient_history | warming | 当前事实可用但历史不足 |
| qualification_status=unresolved | partial | 资格待核，不伪装成 qualified |
| judgment_review_status=corrected | corrected | 显示更正链 |
| judgment_review_status=retracted | retracted | 显示撤回链 |
| Daily window complete + coverage gate pass + no actionable event | quiet | 仅此条件允许 quiet |
| coverage gate fail | degraded / partial | 禁止 quiet |

## 12.2 UI 状态优先级

同一对象同时命中多个状态时，默认显示优先级：

```text
retracted
> corrected
> conflicted
> unavailable
> degraded
> stale
> warming
> partial
> quiet
> normal
```

说明：

- quiet 永远不是“默认无事件状态”，只能由 Coverage Gate 产生。
- stale 与 degraded 可同时存在；主 badge 用 degraded，详情显示 stale。
- corrected/retracted 不应被后续 normal 状态覆盖历史标识。

---

# 13. Warming

新监控对象没有历史时：

> warming / insufficient_history

UI 明确：

> 当前事实可用，但趋势判断尚未形成。

若系统存在 Backfilled History，可展示历史，但必须继续区分：

> 外部历史补全 ≠ Vantage 连续观察历史。

---

# 14. Correction UX

原事件保留。

原事件上显示：

> 已更正 / 已撤回

用户可查看：

- 原内容
- 新内容
- 原因
- 更新时间

---

# 15. Challenge UX

用户点击：

> 数据有问题 / 判断有问题

进入：

- 已提交
- 复核中
- 初步结论
- 已确认
- 已更正

必须显示 SLA。

---

# 16. Notification UX

通知不要堆原始数据。

格式：

> 对手 + 变化 + 为什么重要 + 时间

例：

> A 核心款 $34 → $29；这是过去 30 天最大一次下调。

点击进入 Event Detail。

---

# 17. Weekly Value Receipt

轻量卡片展示：

- monitored targets
- successful scans
- detected changes
- retries
- corrections
- coverage

目的：

> 证明 Vantage 在持续工作。

---

# 18. Mobile

移动端优先：

- Brief
- Alert
- Event detail
- Evidence
- Challenge

复杂全量分析可优先 desktop。

---

# 19. P0 验收

1. 2 分钟内能看见 Discovery progress。
2. 任何关键数字一键打开 Evidence。
3. Coverage 不足不能显示“无变化”。
4. Watch → Decide 不重复输入上下文。
5. Correction 不覆盖原事件。
6. Warming 与失败区分。
7. 多平台事实进入同一 Competitor Profile。
8. stale / unknown freshness 对用户可见。
9. observed / backfilled history 明确区分。
10. provider/budget failure 导致 required coverage 缺口时不得显示 quiet。
11. Identity unresolved 不在 UI 中伪装成已确认同一品牌。

---

# 20. Cost / Capability UX Boundary

前端不向普通用户暴露 provider token、内部 cost ledger 或 fallback 细节。

用户应看到的是：

- capability 是否可用
- coverage 是否完整
- freshness
- degraded / unavailable 原因的产品化说明
- 套餐是否支持某增强能力

内部成本控制不得表现为“数据看起来正常但其实没有扫描”。

# 21. 竞争数据面交互合同（SC-03）

## 21.1 信息架构

首批不新增一级导航。现有 Competitor Profile / 情报档案逐步增加：

- 总览；
- 商品与价格；
- 广告素材；
- 社媒内容；
- KOL 与品牌合作；
- 评论与卖点；
- 流量与受众；
- 平台经营估算；
- 历史时间线；
- 来源与计算说明。

没有真实 capability 的栏目不得使用 mock 填充，可显示“未接入”“该市场不支持”或“正在验证”，并提供适当说明。

## 21.2 数据性质表达

所有定量卡片同时显示平台、市场、统计周期、更新时间和数据性质。用户可见标签至少覆盖：来源直接记录、官方公开数据、数据服务估算、按已有数据计算、根据公开内容归纳、历史回填。

`verified` 不能替代数据性质，freshness 不能替代 EvidenceStatus。估算值与直接观测不得使用完全相同的标签；范围值不得压成单点；proxy 不得简写成真实 CAC、AOV、ROI 或 GMV。

## 21.3 数据面状态

| 状态 | 用户表达 |
|---|---|
| unsupported | 当前数据源不支持该平台/市场/字段 |
| loading | 已开始刷新，保留上次成功数据和时间 |
| failed | 本次获取失败，显示原因和可重试动作 |
| empty | 已成功检查，当前范围没有记录 |
| stale | 有历史数据，但已超过新鲜度要求 |
| partial | 已取得部分字段或部分分页，明确缺口 |
| ok | 当前范围采集完成 |

状态优先级沿用批准的数据面规则。失败和 empty 不得互换；stale 不得刷新成“刚刚更新”。

## 21.4 来源与计算抽屉

点击数字、素材或时间线项目必须可以查看：原始来源/供应商、对象、平台、市场、观察时间、统计周期、measurement_method、EvidenceStatus、freshness、公式输入与版本、限制、历史来源。受许可限制不能展示原始响应时，展示允许的来源说明和记录标识。

## 21.5 时间线

时间线按数据面筛选，区分 Vantage 当时观察、供应商历史、档案回填、重新计算、correction 和 retraction。用户不得因回填时间而误以为系统在过去已经持续监控。

## 21.6 前端边界与验收

前端只渲染后端投影，不重新计算业务指标、融合供应商值或推断状态。未知 `summary.kind`、measurement_method 或 capability 必须走通用诚实降级。

验收至少覆盖：直接值与估算值可区分、范围不丢失、失败不显示空态、stale 时间真实、公式可展开、素材失效可识别、历史来源可区分、跨租户 URL 不能访问、移动端证据链可用。
