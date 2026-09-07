'use client';
// 候补名单表单（PRD R5.2）：每日免费额度用尽时，留联系方式加入候补。
import { useState } from 'react';
import { apiPost } from '@/lib/api';

export function WaitlistForm() {
  const [contact, setContact] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!contact.trim() || state === 'busy') return;
    setState('busy');
    try {
      await apiPost('/api/waitlist', { contact: contact.trim() });
      setState('done');
    } catch {
      setState('error');
    }
  }
  if (state === 'done') return <p className="hint wl-done">✓ 已加入候补名单，我们会尽快联系你。</p>;
  return (
    <form className="waitlist-form" onSubmit={submit}>
      <p className="hint">想早点解锁更多调研次数？留下联系方式加入候补名单：</p>
      <div className="row">
        <input
          className="text-input"
          type="text"
          placeholder="邮箱 / 微信 / 手机"
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          maxLength={120}
        />
        <button className="btn primary" type="submit" disabled={state === 'busy' || !contact.trim()}>
          {state === 'busy' ? '提交中…' : '加入候补'}
        </button>
      </div>
      {state === 'error' && <p className="hint">提交失败，请稍后再试。</p>}
    </form>
  );
}
