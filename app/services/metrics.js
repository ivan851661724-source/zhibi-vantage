'use strict';
// ============================================================
// 指标计数器（Phase 1 · L-可观测层 /metrics 数据源）
// ------------------------------------------------------------
// 零依赖实现：内存计数器 + 环形窗口，供 /metrics 端点输出。
// 未来接 Prometheus 时只需把 snapshot() 格式化为文本暴露协议。
// 指标命名（语义）：
//   http_requests_total     请求总数
//   http_errors_total       5xx 错误数
//   http_latency_ms_p95     p95 延迟（环形窗口）
//   tasks_pending / tasks_running / tasks_dead  任务队列深度（Phase 3 接入）
//   external_api_total      外部 API 调用数（供应商维度）
//   external_api_failures   外部 API 失败数
// ============================================================

const counters = {
  http_requests_total: 0,
  http_errors_total: 0,
  tasks_pending: 0,
  tasks_running: 0,
  tasks_dead: 0,
  external_api_total: 0,
  external_api_failures: 0,
  external_search_total: 0,
  external_search_failures: 0,
  external_llm_total: 0,
  external_llm_failures: 0,
};

// 按 key 分桶的计数器（如外部 API 按供应商：serper/brave/bocha/deepseek）
const buckets = {
  external_api_by_provider: {},       // provider -> { total, failures }
  http_status_by_code: {},            // code -> count
};

// 延迟环形窗口：保留最近 N 个样本，p95 直接排序取（数据量小，够用）
const LATENCY_SAMPLES = [];
const LATENCY_MAX = 2000;

const startedAt = Date.now();

function inc(name, n) {
  if (name in counters) counters[name] += (n || 1);
}

function incBucket(bucket, key, n) {
  if (!(bucket in buckets)) return;
  const b = buckets[bucket];
  if (!b[key]) b[key] = { total: 0, failures: 0 };
  b[key].total += (n || 1);
}

function incBucketFail(bucket, key) {
  if (!(bucket in buckets)) return;
  const b = buckets[bucket];
  if (!b[key]) b[key] = { total: 0, failures: 0 };
  b[key].failures += 1;
}

// 记录一次 HTTP 请求：status + durationMs
function recordRequest(status, durationMs) {
  inc('http_requests_total');
  if (status >= 500) inc('http_errors_total');
  incBucket('http_status_by_code', String(status));
  if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
    LATENCY_SAMPLES.push(durationMs);
    if (LATENCY_SAMPLES.length > LATENCY_MAX) LATENCY_SAMPLES.shift();
  }
}

// 记录一次外部 API 调用
function recordExternal(provider, ok, kind) {
  inc('external_api_total');
  if (!ok) inc('external_api_failures');
  if (kind === 'search') {
    inc('external_search_total');
    if (!ok) inc('external_search_failures');
  } else if (kind === 'llm') {
    inc('external_llm_total');
    if (!ok) inc('external_llm_failures');
  }
  incBucket('external_api_by_provider', provider || 'unknown');
  if (!ok) incBucketFail('external_api_by_provider', provider || 'unknown');
}

function setTaskMetric(name, value) {
  if (name in counters) counters[name] = value;
}

function p95() {
  if (!LATENCY_SAMPLES.length) return 0;
  const sorted = LATENCY_SAMPLES.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return Math.round(sorted[idx]);
}

function uptimeSec() {
  return Math.round((Date.now() - startedAt) / 1000);
}

// 输出当前指标快照（/metrics 端点消费；亦可用于日志周期上报）
function snapshot() {
  return {
    uptime_seconds: uptimeSec(),
    counters: Object.assign({}, counters),
    buckets: {
      http_status_by_code: Object.assign({}, buckets.http_status_by_code),
      external_api_by_provider: Object.assign({}, buckets.external_api_by_provider),
    },
    latency: {
      p95_ms: p95(),
      samples: LATENCY_SAMPLES.length,
    },
  };
}

// Prometheus 文本格式（零依赖手写，供未来接监控系统；不引依赖）
function toPrometheus() {
  const s = snapshot();
  const lines = [
    '# TYPE http_requests_total counter',
    'http_requests_total ' + s.counters.http_requests_total,
    '# TYPE http_errors_total counter',
    'http_errors_total ' + s.counters.http_errors_total,
    '# TYPE http_latency_p95_ms gauge',
    'http_latency_p95_ms ' + s.latency.p95_ms,
    '# TYPE tasks_pending gauge',
    'tasks_pending ' + s.counters.tasks_pending,
    '# TYPE tasks_running gauge',
    'tasks_running ' + s.counters.tasks_running,
    '# TYPE tasks_dead gauge',
    'tasks_dead ' + s.counters.tasks_dead,
    '# TYPE external_api_failures_total counter',
    'external_api_failures_total ' + s.counters.external_api_failures,
    '# TYPE process_uptime_seconds gauge',
    'process_uptime_seconds ' + s.uptime_seconds,
  ];
  return lines.join('\n') + '\n';
}

module.exports = {
  inc, incBucket, incBucketFail,
  recordRequest, recordExternal, setTaskMetric,
  snapshot, toPrometheus, p95,
};
