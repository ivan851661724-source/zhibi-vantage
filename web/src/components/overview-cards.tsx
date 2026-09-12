'use client';
// 首页概览：按示例 UI 把「赛道 / 雷达 / 品牌检索」拆成三张卡
// 复用 Onboarding 的赛道输入逻辑与 Chips；赛道检索走 onDiscover（discover.start），品牌检索走 onLookup
import { useState } from 'react';
import Link from 'next/link';
import { lbl } from '@/lib/labels';
import { GOALS, REGIONS, PLATFORM_GROUPS, Chips } from '@/components/onboarding';

export function OverviewCards({
  onDiscover,
  onLookup,
  busy,
}: {
  onDiscover: (track: string, intent: Record<string, unknown>) => void;
  onLookup: (name: string) => void;
  busy: boolean;
}) {
  const [track, setTrack] = useState('');
  const [lookupName, setLookupName] = useState('');
  const [status, setStatus] = useState('');
  const [goals, setGoals] = useState<Set<string>>(new Set());
  const [regions, setRegions] = useState<Set<string>>(new Set());
  const [platforms, setPlatforms] = useState<Set<string>>(new Set());

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
    <section className="ov-cards" aria-label="知彼概览">
      {/* 卡 1：赛道（绿色渐变 hero，跨两列） */}
      <div className="ov-card ov-track">
        <span className="ov-badge">知彼</span>
        <h2 className="ov-h">先告诉我，你要做哪个赛道？</h2>
        <p className="ov-sub">
          我会替你把对手摸清楚，给你一份带收据的全景简报，并标出他们留的空位。不止玩具——任何消费品赛道都行。
        </p>
        <input
          className="track-input"
          type="text"
          placeholder="例如：定制首饰 / 宠物营养品 / 户外露营装备 / 养生茶饮 / 居家香薰 …"
          autoComplete="off"
          value={track}
          onChange={(e) => setTrack(e.target.value)}
        />
        <details className="ov-details">
          <summary>＋ 告诉我更多，报告更准（可选）</summary>
          <div className="ov-extra">
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
              <div key={g.label}>
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
        <button className="ov-btn-dark" type="button" disabled={busy} onClick={goDiscover}>
          {busy ? '研究中…' : '帮我找对手 →'}
        </button>
        <p className="ov-status">{status}</p>
      </div>

      {/* 卡 3：品牌检索（白色） */}
      <div className="ov-card ov-brand">
        <div className="ov-brand-main">
          <span className="ov-label">指定品牌</span>
          <p className="ov-sub">快捷检索，防止漏掉你心里那个关键对手。</p>
        </div>
        <div className="ov-brand-row">
          <input
            className="track-input"
            type="text"
            placeholder="例如：某头部品牌 / 你心里那个对标 …"
            autoComplete="off"
            value={lookupName}
            onChange={(e) => setLookupName(e.target.value)}
          />
          <button className="ov-btn-dark" type="button" disabled={busy} onClick={goLookup}>
            检索这个品牌 →
          </button>
        </div>
        <p className="ov-status">{status}</p>
      </div>

      {/* 卡 2：雷达（深色） */}
      <div className="ov-card ov-radar">
        <span className="ov-label">雷达状态</span>
        <div className="ov-radar-head">
          <span className="ov-pulse" /> 雷达运行中
        </div>
        <div className="ov-radar-row">实时监控</div>
        <div className="ov-radar-row">数据本地处理 · 结论带来源</div>
        <div className="ov-radar-actions">
          <Link href="/radar" className="ov-link">竞品雷达 →</Link>
          <Link href="/intel" className="ov-link">情报库 →</Link>
        </div>
      </div>
    </section>
  );
}
