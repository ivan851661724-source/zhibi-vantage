// 反馈闭环冒烟：带原因移除 → 提炼规则 → 审核 → 生效 → 复原
// 用 Node 发请求，避免 Git Bash 对中文参数的编码问题
const BASE = 'http://127.0.0.1:3300';
const j = async (p, opt) => {
  const r = await fetch(BASE + p, opt);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; }
};
const post = (p, o) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

(async () => {
  const st = (await j('/api/state')).body;
  console.log('赛道:', st.track, '| 竞品:', (st.competitors || []).length);

  const pick = (kw) => (st.competitors || []).find(c => (c.name || '').includes(kw));
  const targets = [
    [pick('赛纳'), 'irrelevant'],
    [pick('德蒙'), 'irrelevant'],
    [pick('MiniYou'), 'noTraction'],
  ].filter(x => x[0]);

  for (const [c, reason] of targets) {
    const r = await post('/api/exclude', { id: c.id, action: 'remove', reason });
    console.log(`移除 ${c.name} (${reason}) → HTTP ${r.status}`);
  }

  let rep = (await j('/api/feedback-report')).body;
  console.log('\n--- 纠错报告 ---');
  rep.removed.forEach(x => console.log(` 移除: ${x.name} | ${x.reasonZh} | 信号缺口=${x.isTractionBlind}`));
  rep.rules.forEach(x => console.log(` 规则[${x.id}] 可执行=${x.enforceable} 裁决=${x.decision} kw=${JSON.stringify(x.keywords || [])}\n    ${x.text}\n    效果: ${x.effect || '—'}`));
  console.log(` 待审(可执行)=${rep.pendingCount} 生效词=${JSON.stringify(rep.activeKeywords)}`);

  // 不可执行的规则不许被采纳（不给假开关）
  const na = rep.rules.find(r => !r.enforceable);
  if (na) {
    const r = await post('/api/rule-review', { id: na.id, decision: 'approved' });
    console.log(`\n采纳不可执行规则[${na.id}] → HTTP ${r.status} ${JSON.stringify(r.body.error || '')} (应为 400 NOT_ENFORCEABLE)`);
  }

  // 可执行规则：采纳 → activeKeywords 生效
  const en = rep.rules.find(r => r.enforceable);
  if (en) {
    const r = await post('/api/rule-review', { id: en.id, decision: 'approved' });
    console.log(`\n采纳[${en.id}] → HTTP ${r.status} 生效词=${JSON.stringify(r.body.activeKeywords)}`);
    const r2 = await post('/api/rule-review', { id: en.id, decision: 'rejected' });
    console.log(`撤回[${en.id}] → 生效词=${JSON.stringify(r2.body.activeKeywords)} (应清空)`);
  } else {
    console.log('\n（本轮样本无共性关键词 → 未提炼可执行规则，符合"没找到就说没找到"的纪律）');
  }

  // 复原：把移除的拉回，不污染用户档案
  for (const [c] of targets) {
    await post('/api/exclude', { id: c.id, action: 'restore' });
  }
  rep = (await j('/api/feedback-report')).body;
  const after = (await j('/api/state')).body;
  console.log(`\n复原后：suppressed=${rep.removed.length} 竞品=${(after.competitors || []).length} 已排除=${(after.excluded || []).length}`);
})();
