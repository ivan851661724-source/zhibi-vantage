'use client';
// TimeRangePicker（SC-05 §7.1）：近 30 天 / 近 90 天 / 近一年 / 全部可用历史 / 自定义
// 纯 UI 选项；「全部可用历史」的起点来自后端覆盖投影，不在此处猜。
import { useState } from 'react';
import type { RangePreset } from '@/lib/memory-api';

const PRESETS: { key: RangePreset; label: string }[] = [
  { key: '30d', label: '近 30 天' },
  { key: '90d', label: '近 90 天' },
  { key: '1y', label: '近一年' },
  { key: 'all', label: '全部可用历史' },
];

export function TimeRangePicker({
  preset, from, to, earliest, disabled, onChange,
}: {
  preset: RangePreset;
  from: string | null;
  to: string | null;
  earliest?: string | null;
  disabled?: boolean;
  onChange: (next: { preset: RangePreset; from: string | null; to: string | null }) => void;
}) {
  const [customFrom, setCustomFrom] = useState(from || '');
  const [customTo, setCustomTo] = useState(to || '');
  const [showCustom, setShowCustom] = useState(preset === 'custom');

  return (
    <div className="mem-range">
      <div className="mem-range-presets" role="group" aria-label="时间范围">
        {PRESETS.map(p => (
          <button
            key={p.key}
            type="button"
            className={'mem-range-btn' + (preset === p.key ? ' on' : '')}
            disabled={disabled || (p.key === 'all' && !earliest)}
            title={p.key === 'all' && !earliest ? '该品牌还没有可用历史' : undefined}
            onClick={() => { setShowCustom(false); onChange({ preset: p.key, from: null, to: null }); }}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          className={'mem-range-btn' + (preset === 'custom' ? ' on' : '')}
          disabled={disabled}
          onClick={() => setShowCustom(v => !v)}
        >
          自定义
        </button>
      </div>
      {showCustom ? (
        <div className="mem-range-custom">
          <label>
            从
            <input type="date" value={customFrom} max={customTo || undefined} disabled={disabled}
              onChange={e => setCustomFrom(e.target.value)} />
          </label>
          <label>
            到
            <input type="date" value={customTo} min={customFrom || undefined} disabled={disabled}
              onChange={e => setCustomTo(e.target.value)} />
          </label>
          <button type="button" className="mem-range-apply" disabled={disabled || !customFrom || !customTo}
            onClick={() => onChange({ preset: 'custom', from: customFrom, to: customTo })}>
            应用
          </button>
        </div>
      ) : null}
      <p className="hint mem-range-note">
        {preset === 'all'
          ? '显示该品牌全部可用历史（起点来自已核验证据，不是产品默认值）。'
          : '所选范围之外的时间没有纳入本次查看；无记录不等于没有变化。'}
      </p>
    </div>
  );
}
