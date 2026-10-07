# SC-01 Spec Change：collector_version 与 parser_version 语义分离

**状态：已裁决（Approved，2026-10-07 M0-01 PR#2 二审裁决）**
**影响规格：05 Data Source & Collection Spec v0.3 → v0.3.1（§4 Raw Snapshot 至少记录 / §10 Adapter Record 字段 / §19.5 Generic fetchPage 安全要求）**
**上位依赖：00 v1.2 / 03 v0.3（不受影响）**

## 1. 问题

05 v0.3 原文在 Raw Snapshot 必录字段与 Adapter 合同中要求 `parser_version`（§19.5 为「必填」）。但 Raw SourceSnapshot 的定义是**解析发生之前**的原始响应留痕（05 §4 采集边界；00 §54 freshness 语义）：此刻没有任何 parser 运行过。若实现按原文字面填 `parser_version = <采集器版本>`，即伪造 parser 版本；若留空则违反原文「必填」。规格与实现存在结构性分歧，不可静默处理。

## 2. 裁决语义（SC-01 冻结）

| 层 | 字段 | 语义 |
|---|---|---|
| Raw SourceSnapshot（采集层） | `collector_version` **必填** | 标识 fetch/网络采集实现版本（当前 `net-1`） |
| Raw SourceSnapshot（采集层） | `parser_version` **nullable** | 原始采集时刻未解析 → 必须 `null`，不得以 collector 版本冒充 |
| Structured Adapter / Evidence / Fact 提取层 | `parser_version` / extractor version **必填** | 由实际产生结构化结果的解析层写入其真实版本 |

## 3. 变更明细（05 v0.3 → v0.3.1）

1. §4「Raw Snapshot 至少记录」：新增 `collector_version`；`parser_version` 标注 nullable 及 null 语义。
2. §10 Adapter Record 字段清单：新增 `collector_version`；`parser_version` → `parser_version?`（nullable，未解析时 null；结构化层必填）。
3. §19.5 Generic fetchPage 安全要求：「parser_version 必填」→「collector_version 必填；parser_version 可空（未解析时 null，不得伪造；结构化提取层必填）」。

## 4. 实现对应

- `app/research/source-snapshot.js`：写入 `collector_version: 'net-1'`，无 `parser_version` 字段（解析在下游 Evidence/Fact 层发生）。
- 测试锁定：`app/test/source-snapshot.test.js` #1（collector_version 存在且 parser_version 不得出现）。
- Evidence/Fact 层引入 parser_version 的时机归 M0-02/M0-03 ticket。

## 5. 治理记录

- 提出：M0-01 实施计划 v0.2 修正 7（评审指出 05 §10 缺 collector 版本字段）。
- 裁决：2026-10-07，M0-01 PR#2 第二次评审，批准方向 = 本文件 §2 表格。
- 生效：05 内部版本号 v0.3 → v0.3.1；引用格式更新为 `05 v0.3.1 §<n>`。
