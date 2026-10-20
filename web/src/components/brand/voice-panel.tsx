'use client';
// ============================================================
// components/brand/voice-panel.tsx —— 「用户声音与公开评论」（SC-06 三）
// ------------------------------------------------------------
// 消费统一读模型（/api/brands/:brandId 详情内 unifiedVoice 字段）：
//   · 只有一套用户可见统计口径（verified.summary）；
//   · 每条已核实评论带来源 URL / Snapshot / Evidence / 观察时间；
//   · 情绪字段当前不产出（不展示情绪标签，不从片段猜）；
//   · 样本不足显示「资料不足，暂不形成群体结论」；
//   · 旧 voiceItems 是迁移投影，折叠展示、注明不计入统计。
// ============================================================
import type { UnifiedVoice, EvidenceRefLite } from '@/lib/core-api';

function fmtDate(s: string | null | undefined) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? String(s).slice(0, 10) : d.toLocaleString();
}

export function VoicePanel({ voice, onEvidence }: { voice: UnifiedVoice | null | undefined; onEvidence?: (refs: EvidenceRefLite[]) => void }) {
  if (!voice) return <p className="hint">加载用户声音…</p>;
  const verified = voice.verified || { items: [], summary: null };
  const legacy = voice.legacy || { items: [], note: null };
  const sufficient = voice.status === 'sufficient';

  return (
    <div className="core-voice">
      <h3>用户声音与公开评论</h3>

      {sufficient && verified.summary ? (
        <p className="hint">
          样本：{verified.summary.sampleSize} 条评论观察 · {verified.summary.sourceCount} 个公开来源页面
          {verified.summary.periodStart ? `（观察窗口 ${String(verified.summary.periodStart).slice(0, 10)} ~ ${String(verified.summary.periodEnd || '').slice(0, 10) || '至今'}）` : ''}。
          {verified.summary.sampleNote}
        </p>
      ) : (
        <div className="mem-empty">
          <p><b>{voice.insufficientText}</b></p>
          <p className="hint">
            {verified.items.length
              ? '已采集到公开评论页面，但样本量还不足以形成群体结论；以下逐条列出可核验的观察，不做「满意/不满意」汇总。'
              : '还没有通过公开评论页采集到可核验的评论观察。这只代表本系统尚无可核验的公开评论观察，不构成对该品牌口碑状况的任何判断。'}
          </p>
        </div>
      )}

      {verified.summary ? (
        <ul className="core-voice-limits">
          {(verified.summary.limitations || []).map((l, i) => <li key={i}>{l}</li>)}
        </ul>
      ) : null}

      {/* SC-06 r2：机会判断资格与样本充分性分开说——采到评论 ≠ 能形成满意度判断 */}
      {verified.items.length ? (
        <p className="hint">
          机会判断资格：{verified.items.some(it => it.polarity && it.sentimentBasis)
            ? '已有带依据的正负分类；是否形成群体结论仍取决于样本量与覆盖率。'
            : '尚未形成。当前只有评论片段/评分/评价数，没有带依据（polarity + sentimentBasis）的正负主题，因此不进入「满意度 × 重要性」机会算法，也不把中性评论算进满意度分母。'}
        </p>
      ) : null}

      {verified.items.length ? (
        <ul className="core-voice-list">
          {verified.items.map((it, i) => {
            const refs: EvidenceRefLite[] = [];
            if (it.evidenceId || it.snapshotId) {
              refs.push({ evidenceId: it.evidenceId, snapshotId: it.snapshotId, sourceUrl: it.sourceUrl, label: it.title || '公开评论页' });
            }
            return (
              <li key={(it.sourceUrl || '') + i} className="core-voice-item">
                <div className="core-voice-item-head">
                  {it.sourceUrl ? (
                    <a href={it.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">{it.title || it.sourceUrl}</a>
                  ) : (it.title || '公开评论页')}
                  {typeof it.rating === 'number' ? <span className="core-voice-rating">评分 {it.rating}</span> : null}
                  {typeof it.reviewCount === 'number' ? <span className="core-voice-count">{it.reviewCount} 条评价</span> : null}
                </div>
                {it.snippet ? <p className="core-voice-snippet">{it.snippet}</p> : null}
                <div className="core-voice-meta">
                  <span>观察时间：{fmtDate(it.observedAt)}</span>
                  <span>{it.evidenceId || it.snapshotId ? '已核实（有快照与证据引用）' : '待核实'}</span>
                  {refs.length && onEvidence ? (
                    <button type="button" className="btn-mini" onClick={() => onEvidence(refs)}>查看证据</button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {legacy.items.length ? (
        <details className="core-voice-legacy">
          <summary>历史采集投影（{legacy.items.length} 条，不计入公开评论统计）</summary>
          <p className="hint">{legacy.note}</p>
          <ul>
            {legacy.items.map((v, i) => (
              <li key={i}>
                <span>{v.platform || '来源未知'}</span>
                <span>{v.text ? v.text.slice(0, 120) : ''}</span>
                <span>{fmtDate(v.date)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
