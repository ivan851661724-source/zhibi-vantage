'use strict';
// ============================================================
// lib/robots.js —— robots.txt 解析（RFC 9309 简化实现 · 纯函数零依赖）
// 抓取需求 §2.2 P0 合规缺口：fetchPage 此前零 robots 检查。
// 规则集：取 User-agent: * 组（我们不声明专属 UA）；最长路径匹配胜出（Google 纪律），
// 同长 Allow 胜 Disallow；支持 * 通配与 $ 结尾锚；空 Disallow 值 = 全允许；无匹配 = 允许。
// robots.txt 抓取失败（网络/5xx）→ 由调用方 fail-open（放行），本模块只管解析与判定。
// ============================================================

// 单条规则路径 → 正则（* → 任意串；$ → 结尾锚；其余按字面）
function ruleToRegex(path) {
  const escaped = path
    .replace(/[.+?^{}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp('^' + escaped + (path.endsWith('$') ? '' : ''));
}

// robots.txt 文本 → 规则数组 [{type:'allow'|'disallow', path, len, re}]
// 只取 '*' 组（含无 UA 头的裸规则）；其余 UA 组（googlebot 等）不适用我们。
function parse(robotsTxt) {
  const rules = [];
  const lines = String(robotsTxt || '').split(/\r?\n/);
  let inStarGroup = false;
  let sawAnyAgent = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^(allow|disallow)\s*:\s*(.*)$/i.exec(line);
    if (m) {
      if (!inStarGroup) continue; // 规则属于其它 UA 组
      const path = m[2].trim();
      if (!path) continue;        // 空 Disallow = 全允许（RFC 9309），不生成规则
      rules.push({ type: m[1].toLowerCase(), path, re: ruleToRegex(path) });
      continue;
    }
    const a = /^user-agent\s*:\s*(.*)$/i.exec(line);
    if (a) {
      sawAnyAgent = true;
      inStarGroup = a[1].trim() === '*';
      continue;
    }
    // 其它行（sitemap 等）忽略
  }
  if (!sawAnyAgent && rules.length === 0) return rules; // 空文件 → 无规则（全允许）
  return rules;
}

// 判定 path 是否被允许。rules 为空 → true（全允许）。
function isAllowed(rules, pathname) {
  if (!rules || !rules.length) return true;
  const p = String(pathname || '/');
  let best = null;
  for (const r of rules) {
    if (!r.re.test(p)) continue;
    if (!best || r.path.length > best.path.length) best = r; // 最长匹配胜出
    else if (r.path.length === best.path.length && r.type === 'allow') best = r; // 同长 Allow 胜
  }
  if (!best) return true; // 无匹配 → 允许
  return best.type === 'allow';
}

module.exports = { parse, isAllowed, ruleToRegex };
