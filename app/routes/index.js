'use strict';
// ============================================================
// routes/index.js —— 注册表装配（Phase 1 完整版）
// 所有端点在此注册：加端点 = 这里加一行 + handlers/ 一个文件。
// 依赖注入：dispatch(ctx, req, res, url, p)，ctx 由 server.js 组装，
// 含 handler 所需的全部服务函数与常量（loadState/decorateState/...）。
//
// 接管策略：全部 /api 端点已迁移；未命中注册表 → 落回 server.js
// 静态文件服务（唯一兜底）。单一实现原则：旧 if/else 已删除。
// ============================================================
const registry = require('./registry.js');
const ReadH = require('./handlers/read.js');
const MetricsH = require('./handlers/metrics.js');
const FeedbackH = require('./handlers/feedback.js');
const SystemH = require('./handlers/system.js');
const CollectH = require('./handlers/collect.js');
const CorrectionH = require('./handlers/correction.js');
const MiscH = require('./handlers/misc.js');
const TelemetryH = require('./handlers/telemetry.js');
const AuthH = require('./handlers/auth.js'); // P0 恢复：login/register

function registerAll() {
  // —— 账号（public，匿名可访问；POST 限流在鉴权门统一处理） ——
  registry.register('POST', '/api/login', 'public', AuthH.login);
  registry.register('POST', '/api/register', 'public', AuthH.register);
  // —— 系统可观测（public） ——
  registry.register('GET', '/metrics', 'public', SystemH.metrics);
  registry.register('GET', '/healthz', 'public', SystemH.healthz);
  // —— 前端启动期公开开关（F-04：演示模式闸门） ——
  registry.register('GET', '/api/public-config', 'public', SystemH.publicConfig);
  // —— 只读/派生组 ——
  registry.register('GET', '/api/version', 'public', ReadH.version);
  registry.register('GET', '/api/state', 'tenant', ReadH.state);
  registry.register('GET', '/api/domains', 'tenant', ReadH.domains);
  registry.register('GET', '/api/materials', 'tenant', ReadH.materials);
  registry.register('GET', '/api/heroes', 'tenant', ReadH.heroes);
  registry.register('GET', '/api/radar-changes', 'tenant', ReadH.radarChanges);
  registry.register('POST', '/api/quadrant', 'tenant', ReadH.quadrant);
  registry.register('POST', '/api/compare', 'tenant', ReadH.compare);
  // —— 度量层组（P0-2/3/4） ——
  registry.register('POST', '/api/snapshot', 'tenant', MetricsH.snapshot);
  registry.register('POST', '/api/consume', 'tenant', MetricsH.consume);
  registry.register('POST', '/api/calibration', 'tenant', MetricsH.calibration);
  registry.register('GET', '/api/calibration/summary', 'tenant', MetricsH.calibrationSummary);
  registry.register('POST', '/api/calibration/computation', 'tenant', MetricsH.calibrationComputation);
  registry.register('POST', '/api/accuracy/sample', 'tenant', MetricsH.accuracySample);
  registry.register('GET', '/api/accuracy/summary', 'tenant', MetricsH.accuracySummary);
  registry.register('GET', '/api/north-star', 'tenant', MetricsH.northStar);
  // —— 反馈/规则/私有记录组 ——
  registry.register('GET', '/api/feedback-report', 'tenant', FeedbackH.feedbackReport);
  registry.register('POST', '/api/rule-review', 'tenant', FeedbackH.ruleReview);
  registry.register('ALL', '/api/user-notes', 'tenant', FeedbackH.userNotes);
  // —— 工作台三动作裁决（收了/先放着/忽略）：落盘到服务端，跨设备还原 ——
  registry.register('POST', '/api/material-action', 'tenant', FeedbackH.materialAction);
  // —— 采集/研究组 ——
  registry.register('GET', '/api/stream', 'tenant', CollectH.stream);
  registry.register('POST', '/api/voice', 'tenant', CollectH.voice);
  registry.register('POST', '/api/sector', 'tenant', CollectH.sector);
  registry.register('POST', '/api/discover', 'tenant', CollectH.discover);
  registry.register('POST', '/api/enrich', 'tenant', CollectH.enrich);
  registry.register('POST', '/api/lookup', 'tenant', CollectH.lookup);
  registry.register('POST', '/api/timeline', 'tenant', CollectH.timeline);
  registry.register('POST', '/api/brief', 'tenant', CollectH.brief);
  registry.register('POST', '/api/deepdive', 'tenant', CollectH.deepdive);
  // —— 纠错/意图/排除/反馈组 ——
  registry.register('POST', '/api/field-correct', 'tenant', CorrectionH.fieldCorrect);
  registry.register('POST', '/api/field-review', 'tenant', CorrectionH.fieldReview);
  registry.register('POST', '/api/field-correct/revoke', 'tenant', CorrectionH.fieldRevoke);
  registry.register('POST', '/api/intent', 'tenant', CorrectionH.intent);
  registry.register('POST', '/api/exclude', 'tenant', CorrectionH.exclude);
  registry.register('POST', '/api/feedback', 'tenant', CorrectionH.feedback);
  // —— 配置/搜索测试/档案管理/报错组 ——
  registry.register('GET', '/api/config', 'tenant', MiscH.configGet);
  registry.register('POST', '/api/config', 'tenant', MiscH.configPost);
  registry.register('POST', '/api/searchtest', 'tenant', MiscH.searchtest);
  registry.register('POST', '/api/reset', 'tenant', MiscH.reset);
  registry.register('GET', '/api/projects', 'tenant', MiscH.projectsList);
  registry.register('POST', '/api/projects/switch', 'tenant', MiscH.projectsSwitch);
  registry.register('POST', '/api/projects/delete', 'tenant', MiscH.projectsDelete);
  registry.register('POST', '/api/report', 'tenant', MiscH.report);
  // —— 数据自动化新接口（A12 §7）：任务状态 / 成本汇总 / 调度状态 ——
  registry.register('GET', '/api/tasks', 'tenant', TelemetryH.tasks);
  registry.register('GET', '/api/cost/summary', 'tenant', TelemetryH.costSummary);
  registry.register('GET', '/api/scheduler/status', 'tenant', TelemetryH.schedulerStatus);
  // —— 预警推送（2026-09-05 §6 ⬜）：站内信列表 / 已读 ——
  registry.register('GET', '/api/alerts/settings', 'tenant', TelemetryH.alertsSettings);
  registry.register('POST', '/api/alerts/settings', 'tenant', TelemetryH.alertsSettings);
  registry.register('GET', '/api/alerts', 'tenant', TelemetryH.alerts);
  registry.register('POST', '/api/alerts/read', 'tenant', TelemetryH.alertsRead);
  // R5.2 候补名单（public，匿名可提交）+ R7.2 真实数据示例（闸门在 handler 内）
  registry.register('POST', '/api/waitlist', 'public', SystemH.waitlist);
  registry.register('GET', '/api/sample', 'public', SystemH.sample);
}

registerAll();

module.exports = { registry, dispatch: registry.dispatch, match: registry.match, list: registry.list };
