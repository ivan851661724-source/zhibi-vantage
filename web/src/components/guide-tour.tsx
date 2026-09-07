'use client';
// 新手导读（PRD R7.1）：首次报告生成后的 5 步导读，一次性（localStorage 标记）。
// 不拦操作、可随时跳过；纯前端引导，不产生任何请求。
import { useState } from 'react';

const GUIDE_KEY = 'zhibi_guide_done';

export function guideNeeded(): boolean {
  try { return typeof window !== 'undefined' && !window.localStorage.getItem(GUIDE_KEY); } catch { return false; }
}
export function markGuideDone(): void {
  try { window.localStorage.setItem(GUIDE_KEY, '1'); } catch { /* 隐私模式静默 */ }
}

const STEPS: { title: string; body: string }[] = [
  { title: '① 工作台 · 材料流', body: '对手一有动作（降价/上新/开新店/差评暴涨）就会出现在这里。每条材料都带来源，点开可溯源；用「收了 / 稍后 / 忽略」三键裁决，我们绝不替你做决定。' },
  { title: '② 情报库 · 竞品档案', body: '每家对手的完整档案：价格带、渠道布局、口碑、上新节奏。所有字段都标注「实查 / 推测 / 未探测」——只有实查和双源一致的才叫查证。' },
  { title: '③ 机会视图 · 市场空位', body: '用户在抱怨、但没人做的方向会浮现成机会条目。每条带提及广度（几家对手提到）与来源，可点开核验。' },
  { title: '④ 纠错 · 越用越准', body: '看到不准的字段？直接提交纠错。你的纠错只影响你自己的视图并即时重算，同时触发系统重新采集核验。' },
  { title: '⑤ 雷达 · 每日盯防', body: '系统每天 4 趟自动扫描对手动向，价格变化会推送到站内信（可配 Webhook）。你不用天天盯，有动静它会找你。' },
];

export function GuideTour({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const s = STEPS[step];
  function close() {
    markGuideDone();
    onDone();
  }
  return (
    <div className="guide-overlay" role="dialog" aria-label="新手导读">
      <div className="guide-card">
        <div className="guide-brand">知彼 Vantage · 5 步上手</div>
        <h3 className="guide-title">{s.title}</h3>
        <p className="guide-body">{s.body}</p>
        <div className="guide-dots">
          {STEPS.map((_, i) => (
            <span key={i} className={'gd' + (i === step ? ' on' : '')} />
          ))}
        </div>
        <div className="guide-actions">
          <button className="btn-ghost" type="button" onClick={close}>跳过</button>
          {step > 0 && (
            <button className="btn-ghost" type="button" onClick={() => setStep(step - 1)}>上一步</button>
          )}
          {step < STEPS.length - 1 ? (
            <button className="btn primary" type="button" onClick={() => setStep(step + 1)}>下一步</button>
          ) : (
            <button className="btn primary" type="button" onClick={close}>开始使用 →</button>
          )}
        </div>
      </div>
    </div>
  );
}
