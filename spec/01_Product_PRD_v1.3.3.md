# 知彼 Vantage · 01 Product PRD

**版本：v1.3.3 成本与品牌资产治理版**  
**日期：2026-10-07**  
**状态：产品层冻结候选版**  
**上位依据：《Vantage v1.2 工程冻结基线》**

---

# 0. 文档定位

本文件定义 Vantage 的：

- 产品为什么存在
- 核心用户与商业化假设
- 用户从第一次查询到长期使用的完整闭环
- 产品必须兑现的信任承诺
- v0 / v1 产品范围
- 数据真实性在产品层的要求
- 发现、监控、分析、通知、历史资产的用户行为
- 产品级验收标准

本文件不定义：

- 算法公式和具体阈值
- 数据库表结构
- REST / SSE schema
- 供应商接口参数
- 爬虫细节
- 页面像素级 UI

若本 PRD 与《Vantage v1.2 工程冻结基线》冲突，以工程冻结基线为准。

---

# 1. Product Thesis

## 1.1 一句话

**Vantage 是跨境电商卖家的竞争情报值班系统。**

用户第一次提出竞争问题后，Vantage 不只生成一次报告，而是：

> 找到真正值得盯的竞争对象 → 建立品牌情报档案 → 持续记录价格、上新、促销等事实 → 形成长期时间线 → 识别重要变化 → 给出有证据的分析 → 在用户需要时主动送达。

---

## 1.2 产品核心价值顺序

产品价值优先级冻结为：

> **真实数据 > 有用分析 > 主动送达 > 漂亮展示**

解释：

1. 数据错误，分析和通知都会放大错误。
2. 数据真实但没有解释，用户仍要自己做 Excel。
3. 数据真实且分析有用后，主动通知才产生“我不用自己盯”的价值。
4. Dashboard 是审计和深入分析工具，不是主要付费理由。

---

## 1.3 产品的长期价值

Vantage 的价值必须随时间增长。

### Day 1
回答：

> 谁是我的真实竞争对手？

### Day 7
回答：

> 最近谁发生了变化？

### Day 30
回答：

> 谁更爱降价、谁上新更快、谁频繁促销？

### Day 90
回答：

> 哪些动作已经形成趋势？

### Day 180
回答：

> 这个品牌过去半年到底在怎么竞争？

因此 Vantage 的核心资产不是一次分析报告，而是：

> **持续增长的竞争情报数据库。**

---

# 2. 核心用户与购买理由

## 2.1 核心 ICP

优先服务：

- Shopify / DTC 为主的跨境电商卖家
- 约 2–5 人团队
- 已有稳定业务，而不是刚开店的新手
- 已知道部分对手，但担心漏掉关键竞争者
- 每周需要人工查看多个竞品站点
- 当前依赖 2–3 套工具拼竞品发现、监控、分析
- 没有专职竞争情报团队
- 不愿意支付 Enterprise CI 的高价格
- 愿意为“少开两个工具、少做重复检查、少错过关键变化”支付 **$20–50/月**

---

## 2.2 真正竞争对手

Vantage 最大的竞争对手不是某一款 SaaS，而是：

> **用户已经习惯的“手工 + 三套工具”工作流。**

因此商业成功不是：

> 功能数量更多。

而是：

> **用户是否真的可以停止或显著减少原有 1–2 套工具的使用。**

---

# 3. 商业化成功定义

## 3.1 Tool Replacement Rate

核心商业结果：

> 使用 Vantage 30 天后，用户是否停止或显著减少至少 1 套旧竞品工具。

更强目标：

> 用户是否认为 Vantage 已经可以替代原“三件套”中的至少 2 套。

---

## 3.2 竞争数据依赖形成

用户从：

> “我试一下。”

变成：

> “我不想失去已经积累几个月的竞争历史。”

这种依赖应来自：

- 品牌档案
- 核心产品线
- 历史价格
- 上新历史
- 促销历史
- 跨平台身份
- 判断与更正记录
- 长期品牌时间线
- 用户历史关注点

而不是来自人为锁定。

---

# 4. 四大核心产品能力

---

## A. Discover：我该盯谁？

用户输入：

- 赛道
- 品类
- 品牌
- URL
- 可选参考商品
- 可选参考价格

Vantage 输出：

> **真正值得长期关注的竞争对象。**

产品要求：

- 宁缺毋滥
- 不为了 KPI 凑数量
- 每个对手说明“为什么”
- 跨平台身份尽量归并
- 返回核心产品线和核心价格结构
- 发现结果可转为长期监控对象

这是：

> **#1 赛道 → 对手名单**

---

## B. Watch：对手最近在干什么？

用户把对象“加入监控”后，Vantage 持续建立变化历史。

v0 优先信号：

1. 价格
2. 上新
3. 促销

后续增强：

- 库存 / 断货
- 评论 / 口碑
- 广告
- 渠道
- 热度

---

## C. Decide：这对我意味着什么？

Vantage 不只展示事实，还必须帮助用户理解：

- 我的价格处于什么竞争位置？
- 哪些对手近期持续降价？
- 哪些品牌明显加快上新？
- 某品牌的核心价格带是否在下移？
- 当前变化是偶发还是持续趋势？

输出必须包含：

> **判断 + 证据 + 时间范围 + 样本范围 + 数据缺口**

这是：

> **#6 带证据的落点判断**

---

## D. Trust / Brief：今天你到底有没有替我看？

每天给用户一个明确答案：

### 有重要变化
> 今天有 2 个重要变化。

### 无变化且覆盖完整
> 今天关键巡检已完成，没有发现已核实的重要变化。

### 覆盖不足
> 今天完成 8/10 家，2 家暂未看全，因此不能确认它们没有变化。

这是：

> **#7 静默日报**

---

# 5. 四条不可削弱的产品承诺

## 5.1 警报当天到

对正式监控对象中已支持的重要变化：

> **今天发生，今天告诉用户。**

产品必须区分：

- 首次观察到变化
- 后续持续确认

后续确认不得阻塞首次提醒。

---

## 5.2 空报认账

Vantage 必须支持：

### 用户挑战
用户指出：

> 这个警报 / 判断不对。

系统进入复核。

**复核 SLA：**

- 用户挑战进入系统后，最迟 **1 个工作日内** 给出以下之一：
  - 已确认正确；
  - 已确认错误；
  - 初步复核结论 + 尚缺什么证据 + 下一次明确更新时间。
- 不允许 challenge 无限期停留在“复核中”而没有用户可见进展。

### 系统主动认账
系统后续发现：

- variant 识别错误
- 商品身份错配
- 页面瞬时异常
- parser 错误
- 来源数据错误

必须主动：

> 更正 / 撤回

不能等用户投诉。

**一旦确认错误，最晚 24 小时内完成更正或撤回。**

这两个时限分别约束：

> Challenge / Suspicion → Review Response

和：

> Error Confirmed → Correction / Retraction

---

## 5.3 没动静也说一声

每日固定向用户证明：

> 系统今天确实工作过。

只有 coverage 达标时才允许说：

> 没有变化。

---

## 5.4 数字带来源

所有参与以下内容的用户可见定量声明：

- 事实
- 指标
- 判断

必须可以追溯：

> 来源 + 时间 + 对象 + 数据上下文

---

# 6. 用户长期行为闭环

Vantage 的核心循环：

```text
用户提出竞争问题
        ↓
系统理解用户需求与市场上下文
        ↓
确定需要的数据能力
        ↓
查找并核验竞争对象
        ↓
收集当前事实
        ↓
复核 / 打标
        ↓
建立品牌情报档案
        ↓
分析
        ↓
给出结论
        ↓
用户决策
        ↓
用户离线
        ↓
Vantage 持续巡检
        ↓
更新品牌数据库
        ↓
检测变化
        ↓
更新品牌时间线和分析
        ↓
重要变化当天通知
        ↓
用户重新上线
        ↓
查看最新事实 / 历史 / 分析
        ↓
提出新的数据需求
        ↓
在已有品牌资产上继续采集和分析
        ↓
循环继续
```

---

# 7. 数据真实性是第一产品能力

数据源不是后台技术细节，而是产品质量的一部分。

Vantage 必须在产品层遵守：

> **任何结论都不能比底层数据更可信。**

---

## 7.1 数据能力，而不是 API 数量

产品不以：

> “接了多少个 API”

作为能力描述。

必须按“需要回答什么事实”定义数据能力。

例如：

| 用户需要知道 | 数据能力 |
|---|---|
| 这个品牌是谁 | Brand Identity |
| 它卖什么 | Product Catalog |
| 核心产品是什么 | Core Product Line |
| 现在卖多少钱 | Current Price |
| 历史价格如何 | Price History |
| 是否上新 | Product Launch |
| 是否促销 | Promotion |
| 是否同一品牌跨平台 | Cross-platform Identity |
| 最近几个月怎么竞争 | Historical Timeline |

---

## 7.2 数据源准确性产品要求

任何用户可见事实都必须满足：

- 有来源
- 有观察时间
- 有市场 / 币种等必要上下文
- 有数据状态
- 有 freshness
- 数据源失败不当成 0
- 页面抓取失败不当成“无变化”
- 跨来源差异未归一前不直接叫“冲突”

具体 source validation 由 02 / 05 定义。

## 7.3 数据源依赖分层

产品层继承 00 基线的数据源依赖原则：

- **核心 / Tier A 能力**：v0 Discovery 与基础监控成立所必需；
- **增强 / Tier B、Tier C 能力**：用于提高覆盖、丰富分析或增加额外 surface，但不得成为 v0 Discovery / 基础监控的硬依赖。

当增强源不可用时：

> 核心链应继续运行，并明确降级后的 coverage / capability。

不得因为增强数据缺失，就把本可成立的核心结果整体判为失败。

---

# 8. 数据链路

产品级链路冻结为：

```text
用户需求
   ↓
Data Requirement Plan
   ↓
Source Routing
   ↓
采集
   ↓
原始事实保留
   ↓
标准化
   ↓
实体归一
   ↓
数据验证
   ↓
数据打标
   ↓
Canonical Brand Intelligence
   ↓
用户上下文筛选
   ↓
竞品资格判断
   ↓
数据分析
   ↓
Evidence-backed Conclusion
   ↓
持续监控
```

关键原则：

> **用户需求决定“要分析什么”，但不应该过早删除未来可能有价值的品牌事实。**

品牌基础事实先进入长期品牌库，再根据不同 Workspace 做用户相关筛选。

---

# 9. 品牌情报库

## 9.1 Canonical Brand Intelligence

同一个品牌的公共事实只维护一份。

品牌档案至少包含概念上：

```text
Brand
├── Identity
├── Domains
├── Platforms
├── Categories
├── Products
├── Product Lines
├── Core Product Lines
├── Current Prices
├── Price History
├── Promotions
├── Product Launches
├── Evidence
└── Timeline
```

---

## 9.2 Workspace Relationship

同一个品牌对不同用户可能是不同关系。

例如：

```text
Workspace A × Brand
├── Relevant Category
├── Market
├── Competitor Relation
├── Price Fit
├── Audience Fit
├── Channel Relation
├── Monitoring Scope
└── User Interest
```

原则：

> **品牌事实是一套，用户竞争关系是另一套。**

## 9.3 持续品牌库的增长方式

Vantage 必须持续积累品牌情报，但默认采用：

> **用户需求驱动（demand-driven）的 Canonical Brand Intelligence 增长。**

主要来源：

- 用户 Discovery / 手动添加；
- 正式 WatchTarget；
- 已存在品牌的跨渠道 identity 扩展；
- 高频类目 / 市场的有限主动预热。

产品不以“收录品牌数量最大”为目标，也不默认对全网品牌做持续高频抓取。

同一公开品牌被多个 Workspace 关注时，应尽可能复用：

- Identity
- Public Catalog Facts
- Public Price / Promotion / Launch Facts
- Evidence / SourceSnapshot
- Canonical Timeline

Workspace 只保存用户相关竞争关系与私有上下文。

长期护城河不是 Brand Directory，而是：

> **持续增长、可追溯、可复用的 Brand Intelligence History。**

---

# 10. 竞争对象语义

Vantage 不把：

> 一个域名

简单等同于：

> 一个竞争对象。

真实竞争对象更接近：

> **Brand × Category × Market**

例如：

> Zesty Paws × Dog Supplements × US

原因：

- 同一品牌可能跨多个完全不同品类
- 用户只关心相关竞争战场
- 可减少噪声
- 可降低采集成本
- 可提高价格比较准确性

---

# 11. Core Product Identification 是 P0

这是产品能否正确识别竞品的入口能力。

---

## 11.1 问题定义

不能直接使用：

> Brand Min Price / Max Price

判断竞争关系。

例如：

```text
品牌全店：
$20 – $2,000
```

并不能说明它是不是一个 $50 产品卖家的竞争对手。

产品必须识别：

> **这个品牌在当前用户相关品类里的核心产品线，以及这些核心产品的主力价格。**

---

## 11.2 POP MART 示例

假设用户：

```text
品类：Collectible Figures
参考价格：$50
市场：US
```

某品牌全店：

```text
$20 – $2,000
```

系统不能直接判断：

> 价格跨度太大，无法判断。

而应该识别：

```text
相关核心产品线：
Standard Collectible Figures

主力价格：
$59–79
```

$2,000 的收藏级产品：

> 不应主导当前竞品判定。

$20 的配件：

> 也不应主导当前竞品判定。

最终再结合：

- 品类
- 核心价格
- 人群
- 市场
- 渠道

判断是否属于用户真实竞争对象。

---

## 11.3 不反推竞品 AOV

公开商品价格不能可靠推出：

> 竞品真实订单 AOV。

因此产品层统一使用：

- Typical Product Price
- Primary Product Price Band
- Core Product Price

不把商品价格叫：

> 竞品平均客单价。

只有未来取得真实订单级数据时，才允许使用真实 AOV。

---

# 12. Competitor Qualification 是 P0

是否把一个品牌纳入正式竞品，至少必须考虑：

1. Category Fit
2. Core Product Price Fit
3. Audience Fit
4. Market Fit
5. Channel Relation

其中：

- Category Fit 是硬基础
- Price Fit 必须使用核心产品价格，而不是全店 min/max
- 渠道不同不直接淘汰
- 数据不足时允许“待核”，不能强行下结论

---

# 13. 四平台第一梯队

## 13.1 产品模型

“四平台”不是四个独立产品模块。

正确模型：

> **一个竞争品牌 → 多个平台 surface → 统一品牌档案 → 统一时间线**

用户看到的是：

> 这个对手最近干了什么？

而不是：

> Meta 模块今天有什么？

---

## 13.2 两层能力

### Identity Layer
能识别：

> 多个平台上的对象是不是同一个品牌。

### Monitoring Layer
能持续获取：

> 对应平台上的已支持变化。

只有具体信号通过生产验收后，才承诺该平台的持续监控。

---

# 14. First Value

30 分钟可以是完整发现目标，但不能让用户空等 30 分钟。

### 0–2 分钟
展示：

> 找到 N 家可能相关对象，正在核实。

### 2–10 分钟
逐步出现：

- 已确认
- 待核
- 不匹配

### ≤30 分钟
返回：

- 完整核验结果
- 或诚实的“完成但有缺口”

原则：

> **30 分钟是完整度目标，不是第一价值出现时间。**

---

# 15. Discover 产品行为

每个已确认对手至少必须给用户：

- 品牌名称
- 竞争关系
- 为什么是对手
- 相关核心产品线
- 核心价格结构
- 当前平台身份
- 数据覆盖
- 是否建议加入监控

真实合格对象不足时：

> 返回实际数量，不凑够 5 家。

系统失败时：

> 明确失败，不用“0 家”伪装成功。

---

# 16. 加入监控

发现结果不会自动进入长期监控。

用户明确执行：

> **加入监控**

之后才进入：

- 正式巡检
- 监控额度
- 当天警报
- 静默日报 coverage
- 长期时间线

Watchlist：

- 保存候选
- 不等同正式监控
- 不承诺完整持续监控 SLA

---

# 17. 日常监控策略

盯对手是 Vantage 的日常任务。

v0 产品默认：

> **正式监控对象的核心信号每日完成 3 个巡检周期。**

默认窗口按 Workspace 目标市场时区：

- **06:00**
- **14:00**
- **22:00**

而不是服务器时间。

具体调度语义、容错和夏令时处理以 **03 Backend & API Contract** 为唯一实现口径；本 PRD 只冻结“每日 3 个核心巡检周期”的产品承诺。

---

## 17.1 默认高频信号

### 价格
默认 3 次 / 天。

### 促销
默认 3 次 / 天。

### 上新
默认 2–3 次 / 天；如果与同一商品目录巡检共用数据，可随核心巡检运行。

---

## 17.2 低频信号

例如：

- 评论
- 评分
- 慢变化品牌资料

可按 1 次 / 天或更低频率运行。

---

## 17.3 变化后加密复查

首次观察到重要变化后：

> 不需要提高全部竞品的巡检频率。

系统应优先对该对象触发：

> 额外定向复查。

用途：

- 确认变化是否持续
- 避免瞬时页面错误
- 降低误报
- 控制成本

---

## 17.4 巡检频率与通知频率分离

一天抓 3 次：

> 不等于一天通知 3 次。

只有值得用户知道的变化才通知。

## 17.5 Monitoring ≠ Research

日常巡检的默认产品行为必须是低成本验证路径：

```text
Cheap Probe / Direct Collection
→ fingerprint / structured diff
→ no meaningful change: stop
→ change / conflict: targeted verification
→ only when needed: paid search / LLM judgment
```

禁止把完整 Discovery / Deep Research 作为每个 WatchTarget 每轮巡检的默认实现。

---

# 18. 核心监控信号优先级

## P0

### 价格
- 当前价格
- 价格变化
- 历史价格
- 核心价格结构

### 上新
- 新商品
- 新品节奏
- 产品线变化

### 促销
- 折扣
- Sitewide Sale
- BOGO
- Bundle
- Free Shipping Threshold
- Subscribe & Save
- 其他可验证促销

---

## P1

- 库存 / 断货
- 评论 / 口碑
- 广告动作

---

## P2

- 热度
- 销量代理
- 更复杂市场情报

原则：

> **核心信号的准确性优先于信号数量。**

---

# 19. 变化检测与通知

产品概念链：

```text
采集
  ↓
新事实
  ↓
与历史比较
  ↓
发现变化
  ↓
Observed
  ↓
当天进入用户可见面
  ↓
定向复查
  ↓
Confirmed / Reverted / Corrected
```

用户必须能区分：

> 我们刚观察到变化

与：

> 我们已经确认变化持续存在

---

# 20. 数据分析

Vantage 不应该把原始抓取内容直接交给 LLM。

产品层要求：

```text
Validated Facts
      ↓
Metrics
      ↓
Competitor Context
      ↓
Historical Context
      ↓
Structured Analysis
      ↓
User Conclusion
```

LLM 的职责：

> 把已经成立的结构化分析写成人话。

LLM 不得创造数字或补不存在的事实。

---

# 21. 落点判断

用户至少输入：

- 产品名称
- 品类
- 参考价格
- 市场
- 币种

Vantage 可以输出：

> $29 位于当前核心竞品主力价格结构中段。

> $19 以下聚集 3 家直接低价竞争对象。

> 高于 $39 后竞争密度明显下降，但进入另一组价格定位。

不得输出：

> $29 有肉吃。

不得替用户说：

> 你应该卖 $29。

---

# 22. Watch → Decide

落点判断不能只存在独立页面。

重要事件之后应自然进入分析：

```text
竞品 A：
$34 → $29
      ↓
用户打开事件
      ↓
“这对我的 $32 意味着什么？”
      ↓
Vantage 使用最新 + 历史竞争数据
      ↓
给出落点分析
```

---

# 23. 用户离线是正常状态

产品不能假设用户每天登录。

正常使用模式：

1. 用户第一次配置
2. 用户离线
3. Vantage 持续工作
4. 重要变化主动找用户
5. 用户需要时回来查证据 / 历史 / 分析

---

# 24. 每日 Brief / 静默日报

默认：

> **08:00（Workspace 时区）**

用户可修改。

### 有变化

> 今天 2 个重要变化  
> A：核心价格 $34 → $29  
> B：新增 4 个商品  
> 其他 6 家未发现已核实重要变化  
> 今日覆盖 8/8

### 无变化且覆盖完整

> 今日关键巡检已完成。  
> 没有发现已核实的重要变化。

### 覆盖不足

> 今日完成 6/8 家。  
> 已完成部分没有发现已核实变化；另外 2 家访问异常，无法确认。

---

# 25. Weekly Value Receipt

每周向用户证明：

> Vantage 实际替你完成了什么。

例如：

- 监控 8 个竞争对象
- 完成 196 次有效巡检
- 发现 4 次价格变化
- 7 个新品
- 2 次促销变化
- 3 次异常自动重试
- 1 条误报主动撤回

这是：

> **subscription value receipt**

而不是传统长周报。

---

# 26. 品牌时间线

每个正式监控对象必须有长期时间线。

记录：

- 价格变化
- 上新
- 促销
- 已支持的其他动作
- 分析
- 更正 / 撤回
- 数据缺口
- 用户重要标记

时间拉长后，用户应该清楚回答：

> **这个对手这几个月到底在干什么？**

---

# 27. 用户新的数据需求

用户再次回来时，可以提出：

- 最近两个月谁促销最多？
- A 和 B 谁上新更快？
- 某品牌过去 90 天价格带怎么变化？
- 把广告也加入这个品牌的关注范围。
- 把这个新品类也纳入同一个品牌档案。
- 最近谁更像在打价格战？

原则：

> **新的问题在旧品牌资产上继续生长。**

不重新建立孤立项目。

---

# 28. 产品 IA

一级导航：

1. 工作台
2. 对手
3. 判断
4. 设置

但真实高频路径是：

```text
Brief / Alert
      ↓
事件详情
      ↓
证据 / 时间线
      ↓
新的分析问题
```

---

## 工作台

回答：

> 今天发生什么？系统今天看全了吗？

---

## 对手

回答：

> 我在盯谁？为什么？他最近几个月做了什么？

---

## 判断

回答：

> 当前竞争数据对我的产品和价格意味着什么？

---

## 设置

管理：

- 市场
- 币种
- 时区
- 监控对象
- 通知
- 巡检偏好
- 套餐
- 账户

---

# 29. 商业化设计

## 29.1 收费核心

Discovery 是用户第一次价值入口。

真正持续产生价值和成本的是：

> **Watch**

因此主要收费围绕：

- 正式监控对象数量
- 市场数量
- 巡检频率
- 历史长度
- 高级分析能力

而不是单纯搜索次数。

---

## 29.2 商业假设

### Trial / Free

目标：

> 让用户看到第一次可信价值。

建议：

- 1 个赛道完整发现
- 完整查看候选
- 2–3 个对象短期试监控
- 基础证据

---

### Watch · 约 $29/月

建议：

- 单市场
- 约 5 个正式监控对象
- 核心品牌档案
- 价格 + 上新 + 促销
- 默认 3 次 / 天核心巡检
- 当天变化提醒
- 每日 Brief
- 基础落点判断
- 基础历史时间线

---

### Pro · 约 $49/月

建议：

- 更多正式监控对象
- 多市场
- 更高优先级 / 更高频重点监控
- 更长历史
- 更丰富分析
- 分享 / 协作

最终额度和价格由成本、留存、转化验证。

## 29.3 Unit Economics Guardrail

Vantage 的套餐设计必须同时约束：

- active WatchTargets
- required capabilities
- history retention
- paid enhancement capability
- escalation policy

产品内部必须持续衡量：

- Variable Intelligence Cost / Active Workspace
- Variable Intelligence Cost / Active WatchTarget

具体目标值不在 PRD 里永久写死，由 Finance / Product 基于真实 ARPU 与 provider contract 版本化配置。

内部预算不足不得静默降低已承诺的 P0 coverage；若 required capability 无法完成，必须对用户显示 coverage gap / degraded。

---

# 30. 产品级指标

## 30.1 Tool Replacement Rate

核心商业指标。

---

## 30.2 Query → Monitored Asset Conversion

第一次查询后：

> 有多少用户把至少一个对象加入长期监控。

---

## 30.3 First Trusted Value Proxy

“用户第一次觉得这个数据可信”属于主观心理状态，不能直接作为线上可采集指标。

因此产品层使用可观测代理：

### First Trusted Value Proxy

用户首次进入一个带 Evidence 的核心事实 / 判断详情后，在后续定义的观察窗口内：

1. 至少打开 1 条底层证据；
2. 未对该事实提交“数据有误 / 判断有误”挑战；
3. 该事实后续未被系统主动 correction / retraction。

记录：

- 首次达到该代理行为的时间；
- 达到代理行为的用户占比；
- Evidence Open Rate；
- Challenge Rate；
- Post-view Correction / Retraction Rate。

该指标仅作为“可信价值形成”的**行为代理**，不得宣称等价于用户真实心理信任。

用户访谈中的：

> “这个数据我验证过，是对的。”

继续作为定性研究问题，不进入自动 Freeze Gate。

---

## 30.4 Alert Usefulness

重要变化收到后：

- 打开
- 标记有用
- 进入进一步分析
- 忽略

---

## 30.5 Returning Question Rate

用户再次回来时：

> 是否基于已有历史继续提出问题。

---

## 30.6 History Utilization

30 / 60 / 90 天：

> 用户是否真正使用长期时间线、趋势和历史分析。

## 30.7 Variable Intelligence Cost / Active Workspace

统计活跃 Workspace 在计费周期内产生的可变数据/AI成本。

用于判断：

> 用户增长是否带来健康的单位经济。

## 30.8 Variable Intelligence Cost / Active WatchTarget

衡量一个正式监控对象的平均可变成本，并按 capability/provider 分解。

## 30.9 Canonical Reuse Rate

同一公开品牌事实 / collection task 被多个 Workspace 复用的比例。

该指标长期应随品牌情报库成熟而提高。

---

# 31. 信任护栏指标

- Evidence Traceability：100%
- 确认错误 24h 更正率：100%
- quiet coverage 合规率：100%
- false alert rate
- core product identification accuracy
- competitor qualification precision
- 数据源失败透明率
- correction / retraction 完整率
- Freshness SLA 合规率
- Cost Attribution Completeness
- No-change No-LLM Compliance
- Canonical Identity / History Continuity 合规率

---

# 32. 产品验收矩阵

| ID | Given / When | Then |
|---|---|---|
| A01 | 用户第一次输入赛道 | 2 分钟内看到候选进展，目标 30 分钟内得到核验结果或诚实部分结果。 |
| A02 | 品牌全店价格跨度极大 | 系统不能用全店 min/max 直接判断竞品，必须识别相关核心产品线。 |
| A03 | 用户参考价格 $50，品牌核心产品 $59–79 | 系统按核心产品价格关系参与竞品判断，而不是被 $1 / $500 极端 SKU 干扰。 |
| A04 | 真实合格对手不足 5 家 | 返回实际数量，不凑数。 |
| A05 | 用户确认一个对手并加入监控 | 建立长期竞争档案、当前事实基线和持续巡检。 |
| A06 | 用户没有加入监控 | 对象不进入正式 SLA。 |
| A07 | 用户离线 | 正式监控对象继续更新数据库和时间线。 |
| A08 | 核心信号日常监控 | 默认每日执行 3 个核心巡检周期。 |
| A09 | 首次观察到重要变化 | 当天进入用户可见面，不等待长期确认。 |
| A10 | 变化需要复核 | 优先对该对象进行额外定向复查，而非全局加密抓取。 |
| A11 | 后续发现先前警报错误 | 主动更正 / 撤回，不等用户投诉。 |
| A12 | 无变化但 coverage 完整 | 允许发送静默摘要。 |
| A13 | coverage 不完整 | 不得说“所有对手没动”。 |
| A14 | 用户一个月后问“谁一直降价” | 基于历史数据库回答，不只重新搜索当前网页。 |
| A15 | 用户三个月后查看品牌 | 可以看到连续品牌行为时间线。 |
| A16 | 用户提出新的数据需求 | 在已有品牌档案上扩展，不从零建孤立项目。 |
| A17 | 用户查看关键数字 | 可追到来源、时间、对象与上下文。 |
| A18 | 用户问参考价格位置 | 给竞争落点，不给无成本依据的利润结论。 |
| A19 | 同品牌出现在多个平台 | 尽可能进入统一品牌档案和时间线。 |
| A20 | 某平台只能识别不能持续监控 | 明确能力边界，不冒充完整支持。 |
| A21 | 用户持续使用数月 | 产品能利用历史回答趋势 / 行为模式类问题。 |
| A22 | 周度价值回执生成 | 用户可以看清本周系统实际完成多少监控工作。 |
| A23 | 用户停止使用旧竞品工具 | 记录 Tool Replacement 作为商业验证。 |
| A24 | 用户从价格 / 上新 / 促销事件详情发起“这对我意味着什么？” | 系统必须携带当前事件、用户参考商品 / 价格、最新竞品集合与历史上下文进入 Decide，并返回带证据的落点 / 竞争含义分析；不得要求用户重新从零输入同一竞争上下文。 |
| A25 | 用户对警报或判断提交挑战 | 最迟 1 个工作日内返回已确认正确、已确认错误，或“初步结论 + 尚缺证据 + 下一次明确更新时间”之一。 |
| A26 | 系统无法获得真实成交 / 订单级来源 | 不得展示或宣称竞品“近 30 天真实到手价”，只能展示有来源支撑的当前价格、自建历史观察或明确标注的派生统计。 |
| A27 | v0 Discovery / 基础监控运行 | 即使 Tier B / Tier C 增强源不可用，核心发现与基础监控不得因其缺失整体不可用；增强能力应降级而非阻塞核心链。 |
| A28 | 日常巡检没有检测到 meaningful change | 不触发完整 Research 或 LLM Judgment；允许记录轻量扫描成本与 no-change fact。 |
| A29 | 同一 Brand 已被其他 Workspace 建立 Canonical Identity | 新 Workspace 优先复用公开 Identity / Facts / history，不从零重复 discovery；用户私有 relationship 单独计算。 |
| A30 | 历史由第三方历史源后来补入 | Timeline 明确标记为 Backfilled History，不冒充 Vantage 当时已观察。 |
| A31 | 用户查看关键事实 | 能看到 observed_at / freshness，并在超 SLA 时显示 stale/unknown。 |
| A32 | Provider outage / quota / internal cost ceiling 阻断 required capability | Coverage 进入 gap/degraded，禁止 quiet；不得当成 no_change。 |
| A33 | 大量 Workspace 在同一窗口触发扫描 | 系统允许 jitter/backpressure，但需保持 Workspace 公平性与 P0 SLA 可观测。 |
| A34 | 同一公开品牌被多个 Workspace 监控 | Canonical public collection 应尽可能合并/复用，避免按 Workspace 线性重复抓取。 |
| A35 | schema / algorithm / identity mapping 升级 | 历史保持可追溯，迁移失败可见，不静默覆盖旧事实与事件。 |

---

# 33. Explicit Non-goals

v0 / v1 不优先追求：

- 全功能 Jungle Scout
- 销量 / GMV 绝对值预测
- Enterprise BI
- 全自动定价执行
- 大量 AI 长报告
- 花哨综合评分
- 没有直接决策价值的数据大屏
- 为了“数据源更多”接低质量来源
- 为了“信号更多”牺牲核心信号准确率
- 从公开商品价格伪造竞品真实 AOV
- 在没有可验证来源时宣称竞品拥有“近 30 天真实到手价”

### 数据资产边界

非目标：

- 为了“数据库规模”而爬取全球所有品牌；
- 对无人关注的 cold brand 永久保持与活跃 WatchTarget 相同频率；
- 把 Canonical public facts 与 Workspace 私有竞争关系混为一体。

### 数据能力边界

v0 产品层不得把以下能力写成既成事实：

> “竞品近 30 天真实到手价”

除非数据源能够提供并满足对应证据与验证要求。

在没有真实成交 / 订单级数据源时，只允许表达：

- 当前可验证商品价格
- 当前可验证促销价格
- Vantage 自建历史观察价格
- 明确标注来源和时间范围的派生价格统计

原则：

> **深度优先于宽度。**

---

# 34. Product Freeze Gate

产品层冻结前必须满足：

- [ ] 产品主循环为 Query → Collect → Remember → Analyze → Monitor → Detect → Notify → Query Again。
- [ ] 一次查询转化为长期品牌情报资产，而不是一次性报告。
- [ ] 数据真实性被定义为第一产品能力。
- [ ] 数据能力按“事实能力”组织，不按 API 数量组织。
- [ ] 品牌事实与用户竞争关系分层。
- [ ] 竞争对象语义至少支持 Brand × Category × Market。
- [ ] Core Product Identification 是正式 P0 能力。
- [ ] 竞品资格不允许直接使用全店 min/max。
- [ ] 不从商品价格反推竞品真实 AOV。
- [ ] 在无真实成交 / 订单级来源支撑时，不宣称竞品拥有“近 30 天真实到手价”。
- [ ] v0 Discovery 和基础监控不能把 Tier B / Tier C 增强数据源设为硬依赖；核心链必须能在 Tier A / 已冻结核心能力范围内成立。
- [ ] 四平台围绕统一品牌档案组织。
- [ ] 用户离线后持续监控。
- [ ] 正式监控核心信号默认 3 次 / 天巡检。
- [ ] 默认巡检窗口由 03 唯一定义为 Workspace 目标市场时区 06:00 / 14:00 / 22:00；其他文档不得另设平行口径。
- [ ] 价格、上新、促销为 v0 P0 信号。
- [ ] 变化后支持定向额外复查。
- [ ] 巡检频率和通知频率分离。
- [ ] 警报当天到。
- [ ] 用户挑战后最迟 1 个工作日内给出确认、否定或带下一更新时间的初步复核结论。
- [ ] 系统一旦确认错误，最晚 24 小时内 correction / retraction。
- [ ] 系统可主动认账。
- [ ] quiet 必须经过 coverage。
- [ ] 所有关键数字和判断可追溯。
- [ ] First Trusted Value 只使用可观测行为代理进入量化指标，不把主观心理状态当线上可采集事实。
- [ ] Watch → Decide 路径成立，并有对应验收用例。
- [ ] 历史时间线能支撑 30 / 60 / 90 天问题。
- [ ] 收费核心围绕 Watch，而不是搜索次数。
- [ ] Tool Replacement Rate 是商业主指标。
- [ ] Dashboard 是审计中心，不要求用户每天主动打开。

---

# 35. 后续专项规格必须回答的问题

## 02 Data & Algorithm Spec

必须回答：

- Core Product Line 怎么识别？
- 主力价格带怎么算？
- 哪些 SKU 删除 / 保留？
- 数据验证规则是什么？
- Competitor Qualification 如何计算？
- 什么叫 price change / new product / promotion？
- coverage 怎么算？
- Identity merge/split 与历史连续性怎么处理？
- Observed History 与 Backfilled History 如何区分？
- 什么情况下 no-change 必须停止 paid escalation / LLM？
- 数据冲突怎么处理？
- 什么条件允许生成结论？

---

## 05 Data Source & Collection Spec

必须回答：

- 每种事实需要哪些数据源？
- 每个 source 能提供什么字段？
- freshness 如何？
- coverage 如何？
- 成本如何？
- 失败模式是什么？
- fallback 是什么？
- 哪些能力已经达到 GA？
- 每个 capability 的 Accuracy / Freshness / Coverage / Cost / Failure / Fallback / Evidence Strength 是什么？
- direct-first / fingerprint / cache / canonical reuse 如何降低重复采集？
- retry/fallback 的 cost ceiling 是什么？

---

## 03 Backend & API Contract

必须回答：

- 品牌库如何表示？
- 品牌事实与 Workspace Relationship 如何分层？
- 长期历史如何保存？
- 巡检如何调度？
- 事件如何去重 / 更正？
- API / SSE 如何交付？
- ExternalCallLedger / WorkspaceCostBudget 如何持久化？
- Canonical public monitoring 如何跨 Workspace 去重并保持隔离？
- scheduler 如何处理 backpressure / fairness / migration jobs？

---

## 04 Frontend Interaction Spec

必须回答：

- 第一次查询如何在 2 分钟内出现价值？
- 用户如何查看品牌核心产品？
- 如何展示证据和数据缺口？
- 如何查看几个月时间线？
- 如何从 Alert 进入 Decision？
- 如何展示 quiet / degraded / corrected？

---

# 36. 产品定义总结

Vantage 不是：

> “帮你查一次竞品。”

而是：

> **你第一次告诉我你在跟谁竞争，我把它变成长期竞争档案。之后即使你离线，我也持续收集事实、识别核心产品、更新历史、发现变化、给出分析；有重要动作当天找你，没动作也告诉你今天看过了。你下一次回来时，我们不是重新开始，而是在几周、几个月的竞争历史上继续问更深的问题。**

最终形成：

> **真实数据 → 有用分析 → 主动送达 → 长期记忆 → 更深分析**

这就是 Vantage 的产品闭环。

---

# 37. Cold Start / Historical Bootstrap

新用户第一次 Watch 某品牌时允许出现：

- 当前事实已建立；
- 趋势历史仍在 warming；
- 部分平台可从合法历史源 backfill。

产品必须明确区分：

> “Vantage 从今天开始观察”

与：

> “Vantage 从外部历史源补得过去数据”。

不得为了让 Timeline 看起来丰富而伪造连续观察历史。

---

# 38. 产品级成本与品牌资产原则

Vantage 的长期增长循环应是：

```text
更多真实用户需求
→ 更多 Canonical Brands / Identities
→ 更多可复用历史
→ 更少重复 Discovery / Collection
→ 更快 First Value + 更低单位成本
→ 更高持续价值
```

因此“Remember”同时是产品护城河与成本护城河。


---

# 39. 最终产品定义

Vantage 不是“竞品搜索器”或“漂亮 Dashboard”。

它是一个：

> **持续积累 Canonical Brand Intelligence、以可信证据和可控单位成本长期替用户值守竞争变化的情报系统。**

产品长期成立必须同时满足：

- 事实可信；
- 历史连续；
- 主动监控；
- 错误可更正；
- 成本可持续；
- 公共品牌资产可复用；
- 用户私有竞争关系严格隔离。
