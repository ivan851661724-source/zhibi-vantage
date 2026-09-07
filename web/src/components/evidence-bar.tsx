'use client';
// 诚实条（PRD R6.2）：报告/工作台顶部的三色横条——实查/推测/未探测占比一目了然，
// 点击展开字段清单（按维度）。数据源 state.evidenceDist（lib/evidence-dist.js 实时派生）。
import { useState } from 'react';

export interface EvidenceDist {
  verified: number;
  inferred: number;
  unverified: number;
  total: number;
  pct: { verified: number; inferred: number; unverified: number };
  byDim?: Record<string, { verified: number; inferred: number; unverified: number; total: number }>;
}

const DIM_LABELS: Record<string, string> = {
  价格: '价格带',
  上新节奏: '上新节奏',
  口碑: '口碑',
  规模: '估算规模',
  定位: '定位战略',
};

function dimLabel(k: string): string {
  if (DIM_LABELS[k]) return DIM_LABELS[k];
  if (k.startsWith('渠道·')) return '渠道·' + (k.slice(3) || '');
  return k;
}

export function EvidenceBar({ dist }: { dist: EvidenceDist | null | undefined }) {
  const [open, setOpen] = useState(false);
  if (!dist || !dist.total) return null; // 空报告不显示（避免误导性 0%）
  const { pct } = dist;
  return (
    <div className="evidence-bar-wrap">
      <button
        type="button"
        className="evidence-bar"
        onClick={() => setOpen(!open)}
        title="点击展开字段级证据清单"
      >
        <span className="eb-seg eb-verified" style={{ width: pct.verified + '%' }} />
        <span className="eb-seg eb-inferred" style={{ width: pct.inferred + '%' }} />
        <span className="eb-seg eb-unverified" style={{ width: pct.unverified + '%' }} />
        <span className="eb-text">
          {pct.verified}% 实查 · {pct.inferred}% 推测 · {pct.unverified}% 未探测
          <span className="eb-hint">{open ? '（收起）' : '（展开字段清单）'}</span>
        </span>
      </button>
      {open && (
        <div className="evidence-detail">
          <div className="ed-row ed-head"><span>字段</span><span>实查 / 推测 / 未探测</span></div>
          {Object.keys(dist.byDim || {}).sort().map((k) => {
            const d = (dist.byDim || {})[k];
            return (
              <div className="ed-row" key={k}>
                <span>{dimLabel(k)}</span>
                <span>{d.verified} / {d.inferred} / {d.unverified}（共 {d.total}）</span>
              </div>
            );
          })}
          <p className="ed-note">
            实查=公开来源实抓或双源一致；推测=单源或推算（已降级）；未探测=查过没拿到或未查。跨维度覆盖率不足 70% 的结论已强制降级。
          </p>
        </div>
      )}
    </div>
  );
}
