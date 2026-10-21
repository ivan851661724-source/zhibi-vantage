'use strict';
// ============================================================
// lib/search-credentials.js —— 搜索凭据统一解析（SC-07 r2 §一）
// ------------------------------------------------------------
// 为什么存在：SC-07 r1 后仍存在「门控通过、调用失败」——providerConfigured()
// 已能识别环境变量，但 providerCall() 只从 config.search 取密钥。结果：
// 仅配 SERPER_API_KEY 环境变量的部署，就绪判断说可用、真实调用抛 NO_SERPER_KEY。
//
// 本模块是**唯一**的搜索凭据解析点，供两处共同使用：
//   · 来源就绪判断（source-readiness → search.providerConfigured）
//   · 实际 provider 请求（search.providerCall → serper/brave/bocha/tavily/wigolo）
// 覆盖通道（env 名 ↔ 配置文件字段一一对应）：
//   SERPER_API_KEY  ↔ search.serperKey / search.serperKeys（既有 Serper 多 key 池）
//   BRAVE_API_KEY   ↔ search.braveKey
//   BOCHA_API_KEY   ↔ search.bochaKey
//   TAVILY_API_KEY  ↔ search.tavilyKey / search.apiKey（历史别名）
//   WIGOLO_URL / WIGOLO_API_TOKEN ↔ search.wigoloUrl / search.wigoloToken
//
// 配置优先级（明确且一致）：**环境变量 > 运行配置文件**（app/data/config.json）。
//   · 单 key 通道：env 有值用 env；否则用配置文件字段。
//   · Serper 多 key 池：env key（支持逗号分隔多个）排在最前，其后合并配置文件的
//     serperKeys/serperKey，去空去重、保留顺序——env-only / config-only / 双配
//     三种部署形态都成立，failover 池行为与既有语义兼容。
//
// 安全纪律：本模块只解析，不打印、不落库。密钥不得进入日志、Snapshot、Evidence、
// 数据库、API 响应和错误信息——调用链上的错误一律是 NO_*_KEY / PROVIDER_xxx
// 这类不含凭据值的分类码。
// ============================================================

// env 值支持逗号分隔多 key（与配置文件 serperKeys 数组对齐）
function splitEnvKeys(v) {
  return String(v == null ? '' : v).split(',').map(s => s.trim()).filter(Boolean);
}

function pick(a, b) {
  const x = String(a == null ? '' : a).trim();
  if (x) return x;
  const y = String(b == null ? '' : b).trim();
  return y || null;
}

/**
 * 解析全部搜索通道凭据。
 * @param {object} config 运行配置（config.loadConfig() 产物；可 null）
 * @returns {{
 *   serper: { keys: string[] },
 *   brave: { key: ?string }, bocha: { key: ?string },
 *   tavily: { key: ?string },
 *   wigolo: { url: ?string, token: ?string },
 * }}
 */
function resolveSearchCredentials(config) {
  const sc = (config && config.search) || {};
  const env = process.env;
  // Serper：多 key 池 = env 在前 + 配置文件池在后（去空去重，保留顺序）
  const serperKeys = [];
  const push = (k) => { const s = String(k == null ? '' : k).trim(); if (s && !serperKeys.includes(s)) serperKeys.push(s); };
  splitEnvKeys(env.SERPER_API_KEY).forEach(push);
  if (Array.isArray(sc.serperKeys)) sc.serperKeys.forEach(push);
  push(sc.serperKey);
  return {
    serper: { keys: serperKeys },
    brave: { key: pick(env.BRAVE_API_KEY, sc.braveKey) },
    bocha: { key: pick(env.BOCHA_API_KEY, sc.bochaKey) },
    tavily: { key: pick(env.TAVILY_API_KEY, pick(sc.tavilyKey, sc.apiKey)) },
    wigolo: {
      url: pick(sc.wigoloUrl, env.WIGOLO_URL),
      token: pick(sc.wigoloToken, env.WIGOLO_API_TOKEN),
    },
  };
}

/**
 * 单 provider 是否具备可用凭据（就绪判断与真实调用共用同一判定）。
 * @param {'serper'|'brave'|'bocha'|'tavily'|'wigolo'} name
 */
function providerConfigured(name, config) {
  const c = resolveSearchCredentials(config);
  if (name === 'serper') return c.serper.keys.length > 0;
  if (name === 'brave') return !!c.brave.key;
  if (name === 'bocha') return !!c.bocha.key;
  if (name === 'tavily') return !!c.tavily.key;
  if (name === 'wigolo') return !!c.wigolo.url;
  return false;
}

module.exports = { resolveSearchCredentials, providerConfigured };
