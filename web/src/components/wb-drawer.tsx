'use client';
// 材料详情抽屉（r4 §三 抽屉整改）
// · 标题中性：「CASETiFY 价格观察」这类 形式（类型徽章 + 品牌名），不再叠加「推算」；
// · 不展示材料内部 ID（mat_* 已从载荷移除）；
// · 只渲染实际有内容的章节（不固定五段、不渲染空章节占位）；
// · tier-* 内部词表不出现在页面上（无正式可信度产品口径时隐藏）；
// · 「$40–$100」这类区间标记为「观察到的价格范围」，不放在「媒体」字段下；
// · 证据行包含：来源页面 / 可打开 URL / 观察时间 / 原始价格与币种 / 核验状态。
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

// 来源标签 → 用户可读（tier 内部词表不出页面）
function srcBadge(s: { url?: string; tier?: number }): { cls: string; txt: string } {
  if (s.url && s.tier === 1) return { cls: 'ev-ok', txt: '实抓' };
  if (s.url) return { cls: 'ev-ok', txt: '公开来源' };
  return { cls: 'ev-unk', txt: '未附来源' };
}

export function MaterialDrawer({ m, decision, onSet, onClose }: MaterialDrawerProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ev = wbEvidence(m);
  const sources = (m.sources || []).map((s) => (typeof s === 'string' ? { label: s } : s));
  const capturedAt = m.capturedAt || m.at;
  const hasPrice = !!(m.price && (m.price.old != null || m.price.new != null));
  const priceRange = m.price && m.price.range ? m.price.range : null;
  const typeLabel = wbTypeLabel(m);

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
              <span className={'mtype mt-' + wbSignalOf(m)}>{typeLabel}</span>
              {wbBrandName(m)} <span className={'ev ' + ev.cls}>{ev.txt}</span>
            </div>
            <div className="dr-sub">
              {capturedAt ? '观察于 ' + new Date(capturedAt).toLocaleString('zh-CN') : ''}
              {sources.length ? ` · 来源 ${sources.length} 条` : ''}
            </div>
          </div>
          <button className="dr-close" aria-label="关闭" type="button" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="dr-body">
          {/* 发生了什么（有内容才渲染） */}
          {m.summary || m.title || m.body ? (
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
                    {m.price.old != null ? <div className="pc-arrow">→</div> : null}
                    <div className="pc-new">
                      <div className="k">{m.price.old != null ? '调整后' : '当前价格' + (m.price.currency ? `（${m.price.currency}）` : '')}</div>
                      <div className="v num">
                        {m.price.new != null ? wbMoney(m.price.new, m.price.currency || 'USD') : ''}
                        {m.price.old != null && m.price.deltaPct != null ? (
                          <span style={{ fontSize: 12 }}>
                            {m.price.deltaPct > 0 ? '▲' : '▼'}
                            {Math.abs(m.price.deltaPct)}%
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ) : null}
                {/* 价格区间：如实标注为「观察到的价格范围」，不做市场判断表述 */}
                {priceRange ? (
                  <p className="hint">
                    观察到的价格范围：{wbMoney(priceRange.min, m.price?.currency || 'USD')} –{' '}
                    {wbMoney(priceRange.max, m.price?.currency || 'USD')}
                    {typeof (priceRange as { marketBrandCount?: number }).marketBrandCount === 'number'
                      ? `（同币种 ${(priceRange as { marketBrandCount?: number }).marketBrandCount} 家品牌实抓标价的范围）`
                      : '（来源见下）'}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* 历史价格：只有真的存在两个可比价格点才渲染；单点价格不画曲线 */}
          {m.price && m.price.old != null && m.price.new != null ? (
            <div className="sec">
              <div className="sec-h">
                <span className="n">2</span>价格变化（两个可比观察点）
              </div>
              <div className="sec-b">
                <p className="hint">
                  以上「调整前 → 调整后」来自两次不同时间的真实观察；除此之外没有连续历史价格，不编造曲线。
                </p>
              </div>
            </div>
          ) : null}

          {/* 推算影响面：只在有完整输入（输入事实/方法/适用范围/可信度/证据）时渲染 */}
          {m.inference && (m.inference.text || m.inference.why) ? (
            <div className="sec">
              <div className="sec-h">
                <span className="n">3</span>推算影响面 <span className="ev ev-warn" style={{ marginLeft: 'auto' }}>推算 · 非实抓</span>
              </div>
              <div className="sec-b">
                <div className="infer-note">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 3l10 18H2z" strokeLinejoin="round" />
                  </svg>
                  <div>
                    {m.inference.text || ''}
                    <span className="why">为什么这么推：{m.inference.why || ''} —— 推理项，供你判断，非行动建议。</span>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {/* 证据来源：每条含 来源页/URL/观察时间/核验状态（有内容才渲染） */}
          {sources.length ? (
            <div className="sec">
              <div className="sec-h">
                <span className="n">4</span>证据来源 · 逐条可验
              </div>
              <div className="sec-b">
                <div className="src-list">
                  {sources.map((s, i) => {
                    const b = srcBadge(s);
                    return (
                      <div className="src-row" key={i}>
                        <span className={'ev ' + b.cls}>{b.txt}</span>
                        <div className="txt">
                          {s.url ? (
                            <a href={s.url} target="_blank" rel="noopener" className="core-text-link">
                              {s.label || '来源页面'} ↗
                            </a>
                          ) : (
                            s.label || '来源记录'
                          )}
                          <br />
                          <span className="u">{s.url || ''}</span>
                        </div>
                        {/* tier 内部词表不出页面；无 URL 的来源明确标「未附来源」 */}
                      </div>
                    );
                  })}
                </div>
                {capturedAt ? (
                  <p className="hint">观察时间：{new Date(capturedAt).toLocaleString('zh-CN')} · 核验状态：{ev.txt}</p>
                ) : (
                  <p className="hint">核验状态：{ev.txt}</p>
                )}
              </div>
            </div>
          ) : null}

          {/* 未探测（≠ 确认没有）：不再出现内部缺域代码（数据缺口由覆盖区承载） */}
          {m.missingFields && m.missingFields.length ? (
            <div className="sec">
              <div className="sec-h">
                <span className="n">·</span>未探测
              </div>
              <div className="sec-b">
                <p className="hint">部分字段未探测（≠ 确认没有）。</p>
              </div>
            </div>
          ) : null}
        </div>
        <div className="dr-foot">
          <button className={'btn-act act-keep' + (decision === 'keep' ? ' active' : '')} type="button" onClick={() => setAndClose('keep')}>
            ✓ 收录
          </button>
          <button className={'btn-act act-later' + (decision === 'later' ? ' active' : '')} type="button" onClick={() => setAndClose('later')}>
            稍后处理
          </button>
          <button className={'btn-act act-drop' + (decision === 'ignore' ? ' active' : '')} type="button" onClick={() => setAndClose('ignore')}>
            忽略
          </button>
        </div>
      </div>
    </>
  );
}
