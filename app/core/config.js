'use strict';
// ============================================================
// 本文件由拆分脚本自 server.js 机械搬运（行为保持不变，历史见 git）。
// core/config.js —— 导出: ensureData, loadConfig, saveConfig, migrateConfigSecrets, activeSearchKey
// ============================================================

const secret = require('../lib/secret.js');
const { safeWrite } = require('../lib/fs-util.js');
const { normalizeSerperKeys } = require('../services/providers/search.js');
const { DATA, CONFIG_PATH } = require('./paths.js');
const fs = require('fs');

function ensureData() { if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true }); }
// ---------- 配置密钥加密（P0-4.1） ----------
// 落盘时抽取的密钥字段（非空白才抽）；加载时解密回填到内存态，内存中始终为明文可用。
const SECRET_PATHS = [
  ['search', 'serperKey'], ['search', 'serperKeys'], ['search', 'apiKey'],
  ['search', 'tavilyKey'], ['search', 'braveKey'], ['search', 'bochaKey'],
  ['llm', 'apiKey']
];
function extractSecrets(cfg) {
  const sec = { search: {}, llm: {} };
  let any = false;
  for (const [s, key] of SECRET_PATHS) {
    if (cfg[s] && cfg[s][key] !== undefined && cfg[s][key] !== '') { sec[s][key] = cfg[s][key]; any = true; }
  }
  return any ? sec : null;
}
function applySecrets(cfg, sec) {
  if (!sec) return;
  for (const [s, key] of SECRET_PATHS) {
    if (sec[s] && sec[s][key] !== undefined) { cfg[s] = cfg[s] || {}; cfg[s][key] = sec[s][key]; }
  }
}
function loadConfig() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return null; }
  if (raw && raw.secrets) {
    try { applySecrets(raw, secret.decrypt(raw.secrets)); delete raw.secrets; }
    catch (e) { console.error('[config] 密钥解密失败（主密钥不符或未设置 MT_MASTER_KEY）：' + e.message); }
  }
  return raw;
}
async function saveConfig(next) {
  const out = JSON.parse(JSON.stringify(next));
  const sec = extractSecrets(out);
  let encrypted = false;
  if (sec) {
    const bundle = secret.encrypt(sec);
    if (bundle) {
      out.secrets = bundle;
      encrypted = true;
      for (const [s, key] of SECRET_PATHS) { if (out[s]) delete out[s][key]; } // 从明文层移除密钥
    }
  }
  if (!encrypted) {
    console.error('[config] 警告：MT_MASTER_KEY 未设置，密钥将以明文写入 config.json！请设置 64 位 hex 主密钥后重启以启用加密。');
  }
  out._secretsEncrypted = encrypted;
  await safeWrite(CONFIG_PATH, out, true);
  return out;
}
// 启动迁移：若已设置主密钥且 config 仍为明文密钥，则一次性加密落盘（幂等）。
function migrateConfigSecrets() {
  if (!secret.getMasterKey()) return;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return; }
  if (!raw || raw.secrets) return;
  const sec = extractSecrets(raw);
  if (!sec) return;
  const bundle = secret.encrypt(sec);
  if (!bundle) return;
  const out = JSON.parse(JSON.stringify(raw));
  out.secrets = bundle;
  for (const [s, key] of SECRET_PATHS) { if (out[s]) delete out[s][key]; }
  out._secretsEncrypted = true;
  safeWrite(CONFIG_PATH, out, true);
  console.log('[config] 已将明文密钥迁移为加密存储（MT_MASTER_KEY 已启用）。');
}
// 返回当前搜索源的 key（按 provider 选择），无则 null
function activeSearchKey(config) {
  if (!config || !config.search) return null;
  const p = config.search.provider || 'tavily';
  if (p === 'serper') return normalizeSerperKeys(config.search)[0] || null;
  if (p === 'brave') return config.search.braveKey || null;
  if (p === 'bocha') return config.search.bochaKey || null;
  return config.search.tavilyKey || config.search.apiKey || null;
}


module.exports = { ensureData, loadConfig, saveConfig, migrateConfigSecrets, activeSearchKey };
