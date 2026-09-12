'use client';
// Onboarding 入口（复刻 index.html #onboarding：赛道输入 + 目标/地域/平台 chips + 发现按钮 + 品牌检索）
import { useState } from 'react';
import { lbl } from '@/lib/labels';

export const GOALS = [
  { k: 'channel', t: '进新渠道' },
  { k: 'pricing', t: '看定价' },
  { k: 'newlaunch', t: '看上新' },
  { k: 'reviews', t: '看口碑' },
  { k: 'whitespace', t: '找空位' },
];
export const REGIONS = ['us', 'uk', 'eu', 'cn', 'jp', 'sea'];
export const PLATFORM_GROUPS: { label: string; keys: string[] }[] = [
  { label: '海外', keys: ['amazon', 'shopifyDTC', 'tiktokShop', 'instagramShop', 'etsy'] },
  { label: '国内', keys: ['tmallJD', 'xiaohongshu'] },
  { label: '通用', keys: ['offlineRetail'] },
];

export function Chips({
  keys,
  labels,
  selected,
  onToggle,
}: {
  keys: string[];
  labels?: (k: string) => string;
  selected: Set<string>;
  onToggle: (k: string) => void;
}) {
  return (
    <div className="chips">
      {keys.map((k) => (
        <button
          key={k}
          type="button"
          className={'chip' + (selected.has(k) ? ' on' : '')}
          onClick={() => onToggle(k)}
        >
          {labels ? labels(k) : k}
        </button>
      ))}
    </div>
  );
}

export function Onboarding({
  onDiscover,
  onLookup,
  busy,
}: {
  onDiscover: (track: string, intent: Record<string, unknown>) => void;
  onLookup: (name: string) => void;
  busy: boolean;
}) {
  const [track, setTrack] = useState('');
  const [goals, setGoals] = useState<Set<string>>(new Set());
  const [regions, setRegions] = useState<Set<string>>(new Set());
  const [platforms, setPlatforms] = useState<Set<string>>(new Set());
  const [lookupName, setLookupName] = useState('');
  const [status, setStatus] = useState('');

  const toggle = (set: Set<string>, k: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setter(next);
  };

  function goDiscover() {
    if (!track.trim()) {
      setStatus('请先填写你要做的赛道');
      return;
    }
    setStatus('');
    onDiscover(track.trim(), {
      goals: Array.from(goals),
      regions: Array.from(regions),
      platforms: Array.from(platforms),
      profile: {},
    });
  }

  function goLookup() {
    if (!lookupName.trim()) {
      setStatus('请填写要检索的品牌名');
      return;
    }
    setStatus('');
    onLookup(lookupName.trim());
  }

  return (
    <section className="onboarding" id="onboarding">
      <div className="ob-wrap">
        <div className="ob-hero">
          <span className="ob-badge">知彼</span>
          <h1>先告诉我，你要做哪个赛道？</h1>
          <p className="ob-sub">
            我会替你去把对手摸清楚，给你一份带收据的全景简报，并标出他们留的空位。不止玩具——任何消费品赛道都行。
          </p>
        </div>
        <div className="ob-card">
          <label className="field-label" htmlFor="trackInput">我要做的赛道</label>
          <input
            id="trackInput"
            className="track-input"
            type="text"
            placeholder="例如：定制首饰 / 宠物营养品 / 户外露营装备 / 养生茶饮 / 居家香薰 …"
            autoComplete="off"
            value={track}
            onChange={(e) => setTrack(e.target.value)}
          />
          <div className="ob-more">
            <details className="ob-details">
              <summary>＋ 告诉我更多，报告更准（可选）</summary>
              <div className="ob-extra">
                <label className="field-label">你当前最关心什么？（可多选，决定先给你看什么）</label>
                <Chips
                  keys={GOALS.map((g) => g.k)}
                  labels={(k) => GOALS.find((g) => g.k === k)?.t || k}
                  selected={goals}
                  onToggle={(k) => toggle(goals, k, setGoals)}
                />
                <label className="field-label">重点地域（可选）</label>
                <Chips
                  keys={REGIONS}
                  labels={(k) => lbl('regions', k)}
                  selected={regions}
                  onToggle={(k) => toggle(regions, k, setRegions)}
                />
                <label className="field-label">调研平台（决定去哪些平台摸底；海外赛道无需小红书/天猫数据）</label>
                {PLATFORM_GROUPS.map((g) => (
                  <div key={g.label} style={{ marginBottom: 6 }}>
                    <span className="muted" style={{ fontSize: 12 }}>{g.label}</span>
                    <Chips
                      keys={g.keys}
                      labels={(k) => lbl('channels', k)}
                      selected={platforms}
                      onToggle={(k) => toggle(platforms, k, setPlatforms)}
                    />
                  </div>
                ))}
              </div>
            </details>
          </div>
          <button id="btnDiscover" className="btn-primary" type="button" disabled={busy} onClick={goDiscover}>
            {busy ? '研究中…' : '帮我找对手 →'}
          </button>
          <div className="divider"><span>或</span></div>
          <label className="field-label" htmlFor="lookupInput">指定一个具体品牌（防止漏掉关键对手）</label>
          <div className="lookup-row">
            <input
              id="lookupInput"
              className="track-input"
              type="text"
              placeholder="例如：某头部品牌 / 你心里那个对标 …"
              autoComplete="off"
              value={lookupName}
              onChange={(e) => setLookupName(e.target.value)}
            />
            <button className="btn-lookup" type="button" disabled={busy} onClick={goLookup}>
              检索这个品牌 →
            </button>
          </div>
          <p className="ob-status" id="obStatus">{status}</p>
        </div>
        <p className="ob-foot">你的数据只在本地本机处理；结论的每条都带来源与置信度，决策权始终在你。</p>
      </div>
    </section>
  );
}
