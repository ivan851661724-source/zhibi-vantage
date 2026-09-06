'use strict';
// ============================================================
// 密钥加密 at rest（P0-4.1）
// ------------------------------------------------------------
// config.json 含搜索源 / LLM 密钥（serperKey、serperKeys、tavilyKey、braveKey、
// bochaKey、apiKey、llm.apiKey）。明文落盘 = 服务器被拖库/备份泄露即被盗用。
// 本模块用 AES-256-GCM 把这些密钥段加密为 {v,alg,iv,tag,data} 密文；主密钥取自
// 环境变量 MT_MASTER_KEY（绝不落盘、绝不进代码、绝不进部署包）。
//
// 设计裁决：
//  - 无 MT_MASTER_KEY：encrypt 返回 null（调用方退化为明文兼容 + 警告，不阻断服务）；
//    decrypt 抛错（调用方记录并降级，密钥缺位时配置以未解密态加载）。
//  - 有 MT_MASTER_KEY：loadConfig 解密回填、saveConfig 抽取密钥加密存储，磁盘无明文。
//  - 主密钥格式：64 位 hex（推荐）| 43~44 位 base64 | 任意字符串（取前 32 字节，弱）。
// ============================================================
const crypto = require('crypto');
const ALGO = 'aes-256-gcm';

function getMasterKey() {
  const k = process.env.MT_MASTER_KEY;
  if (!k) return null;
  if (/^[0-9a-f]{64}$/i.test(k)) return Buffer.from(k, 'hex');
  if (/^[A-Za-z0-9+/=_-]{43,44}$/.test(k)) {
    try { const b = Buffer.from(k, 'base64'); if (b.length === 32) return b; } catch (_) {}
  }
  // 兜底：任意字符串取 UTF-8 前 32 字节（弱，仅防误提交，强烈建议用 64hex/base64）
  const b = Buffer.from(k, 'utf8');
  if (b.length >= 32) return b.subarray(0, 32);
  return null;
}

// 加密任意 JSON 对象 → 密文包；无主密钥返回 null
function encrypt(obj) {
  const key = getMasterKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const json = JSON.stringify(obj);
  const enc = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: 1, alg: ALGO, iv: iv.toString('base64'), tag: tag.toString('base64'), data: enc.toString('base64') };
}

function decrypt(bundle) {
  const key = getMasterKey();
  if (!key) throw new Error('MT_MASTER_KEY 未设置，无法解密配置密钥');
  if (!bundle || !bundle.data || !bundle.iv || !bundle.tag) throw new Error('密文格式非法');
  const iv = Buffer.from(bundle.iv, 'base64');
  const tag = Buffer.from(bundle.tag, 'base64');
  const data = Buffer.from(bundle.data, 'base64');
  const decipher = crypto.createDecipheriv(bundle.alg || ALGO, key, iv);
  decipher.setAuthTag(tag);
  const json = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(json);
}

module.exports = { encrypt, decrypt, getMasterKey, ALGO };
