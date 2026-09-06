'use client';
// 材料详情抽屉（Phase 3 首项：复刻 app.js openWbDrawer L1669-1725 五段式骨架）
// P0-2 纪律：五段固定渲染（发生了什么→历史价→市场区间→推算影响面→证据来源），
// 无数据时显示统一空态占位，不条件截断导致编号跳号。
import { useEffect } from 'react';
import {
  wbEvidence,
  wbMoney,
  wbBrandName,
  wbSignalOf,
  wbTypeLabel,
  type WbAction,
  type WbMaterial,
} from '@/lib/wb';

interface MaterialDrawerProps {
  m: WbMaterial;
  decision: WbAction | undefined;
  onSet: (id: string, act: WbAction | '') => void;
  onClose: () => void;
}

export function MaterialDrawer({ m, decision, onSet, onClose }: MaterialDrawerProps) {
  // Escape 关闭（对齐旧版 document keydown 监听）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ev = wbEvidence(m);
  const hasPrice = !!(m.price && (m.price.old != null || m.price.new != null));
  const sources = (m.sources || []).map((s) => (typeof s === 'string' ? { label: s } : s));
  const capturedAt = m.capturedAt
    ? ' · 捕获于 ' + new Date(m.capturedAt).toLocaleString('zh-CN')
    : '';

  const setAndClose = (act: WbAction) => {
    onSet(m.id, act);
    onClose();
  };

  return (
    <>
      <div className="drawer-mask on" onClick={onClose} />
      <div className="drawer on" aria-hidden="false">
        <div className="dr-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="dr-title">
              <span className={'mtype mt-' + wbSignalOf(m)}>{wbTypeLabel(m)}</span>
              {wbBrandName(m)} <span className={'ev ' + ev.cls}>{ev.txt}</span>
            </div>
            <div className="dr-sub">
              材料 #{m.id}
              {capturedAt} · 来源 {sources.length} 条
            </div>
          </div>
          <button className="dr-close" aria-label="关闭" type="button" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="dr-body">
          {/* ① 发生了什么 */}
          <div className="sec">
            <div className="sec-h">
              <span className="n">1</span>发生了什么
            </div>
            <div className="sec-b">
              <div style={{ fontSize: '13px', color: 'var(--ink2)', lineHeight: 1.7 }}>
                {m.summary || m.title || m.body || ''}
              </div>
              {hasPrice && m.price ? (
                <div className="price-cmp" style={{ marginTop: 14 }}>
                  {m.price.old != null ? (
                    <div className="pc-old">
                      <div className="k">调整前</div>
                      <div className="v num">{wbMoney(m.price.old, m.price.currency || 'USD')}</div>
                    </div>
                  ) : null}
                  <div className="pc-arrow">→</div>
                  <div className="pc-new">
                    <div className="k">调整后</div>
                    <div className="v num">
                      {m.price.new != null ? wbMoney(m.price.new, m.price.currency || 'USD') : ''}
                      {m.price.deltaPct != null ? (
                        <span style={{ fontSize: 12 }}>
                          {m.price.deltaPct > 0 ? '▲' : '▼'}
                          {Math.abs(m.price.deltaPct)}%
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {/* ② 历史价格（空态占位，不编造曲线） */}
          <div className="sec">
            <div className="sec-h">
              <span className="n">2</span>历史价格 · 近 12 周
            </div>
            <div className="sec-b">
              <p className="hint">
                历史价格序列待接入（data/events.json 或 gap_snapshots）。当前无 12 周连续数据，不编造曲线。
              </p>
            </div>
          </div>

          {/* ③ 市场区间 */}
          <div className="sec">
            <div className="sec-h">
              <span className="n">3</span>市场区间 · 同赛道在售价
            </div>
            <div className="sec-b">
              {m.price && m.price.range ? (
                <p className="hint">
                  市场区间 {wbMoney(m.price.range.min, m.price.currency || 'USD')} –{' '}
                  {wbMoney(m.price.range.max, m.price.currency || 'USD')}（来源见下）
                </p>
              ) : (
                <p className="hint">市场区间待 2 家以上实抓价（当前样本不足，不编造）。</p>
              )}
            </div>
          </div>

          {/* ④ 推算影响面 */}
          {m.inference && (m.inference.text || m.inference.why) ? (
            <div className="sec">
              <div className="sec-h">
                <span className="n">4</span>推算影响面 <span className="ev ev-warn" style={{ marginLeft: 'auto' }}>推算 · 非实抓</span>
              </div>
              <div className="sec-b">
                <div className="infer-note">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 3l10 18H2z" strokeLinejoin="round" />
                  </svg>
                  <div>
                    {m.inference.text || ''}
                    <span className="why">
                      为什么这么推：{m.inference.why || ''} —— 推理项，供你判断，非行动建议。
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="sec">
              <div className="sec-h">
                <span className="n">4</span>推算影响面
              </div>
              <div className="sec-b">
                <p className="hint">影响面推算待接入（需对手价格带 + 你的定位锚点），当前不臆测。</p>
              </div>
            </div>
          )}

          {/* ⑤ 证据来源 · 逐条可验 */}
          <div className="sec">
            <div className="sec-h">
              <span className="n">5</span>证据来源 · 逐条可验
            </div>
            <div className="sec-b">
              <div className="src-list">
                {sources.length ? (
                  sources.map((s, i) => (
                    <div className="src-row" key={i}>
                      <span className={'ev ' + (s.tier === 1 ? 'ev-ok' : 'ev-warn')}>
                        {s.tier === 1 ? '实抓' : '媒体'}
                      </span>
                      <div className="txt">
                        {s.label || ''}
                        <br />
                        <span className="u">{s.url || ''}</span>
                      </div>
                      <span className="tier">tier-{s.tier || 3}</span>
                    </div>
                  ))
                ) : (
                  <p className="hint">暂无来源记录。</p>
                )}
              </div>
            </div>
          </div>

          {/* 未探测（≠ 确认没有） */}
          {m.missingFields && m.missingFields.length ? (
            <div className="sec">
              <div className="sec-h">
                <span className="n">·</span>未探测
              </div>
              <div className="sec-b">
                <p className="hint">未探测：{m.missingFields.join(' / ')}（≠ 确认没有）</p>
              </div>
            </div>
          ) : null}
        </div>
        <div className="dr-foot">
          <button className={'btn-act act-keep' + (decision === 'keep' ? ' active' : '')} type="button" onClick={() => setAndClose('keep')}>
            ✓ 收了
          </button>
          <button className={'btn-act act-later' + (decision === 'later' ? ' active' : '')} type="button" onClick={() => setAndClose('later')}>
            先放着
          </button>
          <button className={'btn-act act-drop' + (decision === 'ignore' ? ' active' : '')} type="button" onClick={() => setAndClose('ignore')}>
            忽略
          </button>
        </div>
      </div>
    </>
  );
}
