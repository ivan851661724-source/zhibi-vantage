'use client';
// 字段纠错弹窗（Phase 3 首项：复刻 app.js L2900-3055）
// 忠实助理红线：纠错不直接改写「已核实」结论——除 confirm-correct 外须附证据来源，
// 进待复核队列；真实用户走私有覆盖层（仅本人可见）。
import { useEffect, useMemo, useState } from 'react';
import { apiPost } from '@/lib/api';
import { toast } from '@/lib/toast';
import { LABELS, lbl } from '@/lib/labels';
import { useZhibiState } from '@/hooks/use-zhibi-state';
import type { Competitor, ZhibiState } from '@/types/state';

// ---- 纠错类型选项（对齐后端 handlers/correction.js 的 *_TYPES 白名单） ----
const FC_PRICE_TYPES = [
  { v: 'wrong-value', t: '价格区间错了（我来给正确值）' },
  { v: 'wrong-currency', t: '币种标错了' },
  { v: 'over-confident', t: '置信度偏高，应降级' },
  { v: 'confirm-correct', t: '我确认这个价格是准的' },
  { v: 'missing-source', t: '应有价格但缺来源（待重研）' },
];
const FC_CHAN_TYPES = [
  { v: 'wrong-state', t: '渠道状态错了（我来给真实状态）' },
  { v: 'over-confident', t: '置信度偏高，应降级' },
  { v: 'confirm-correct', t: '我确认这个渠道判定准的' },
  { v: 'missing-source', t: '应有渠道证据但缺来源（待重研）' },
];
const FC_SCALAR_TYPES = [
  { v: 'wrong-value', t: '取值错了（我来给正确值）' },
  { v: 'over-confident', t: '置信度偏高，应降级' },
  { v: 'confirm-correct', t: '我确认这个取值准的' },
  { v: 'missing-source', t: '应有数据但缺来源（待重研）' },
];
const SCALAR_LABEL: Record<string, string> = {
  launchCadence: '上新节奏',
  'reviews.rating': '口碑评分',
  'reviews.trend': '口碑趋势',
};

// 卡片级纠错：列出该品牌当前有数据的可纠错项（复刻 buildFieldOptions L2929-2940）
function buildFieldOptions(c: Competitor): { v: string; t: string }[] {
  const opts: { v: string; t: string }[] = [];
  const pricePoints = c.pricePoints as unknown[] | undefined;
  if (c.priceField || c.priceBand || (pricePoints && pricePoints.length)) opts.push({ v: 'price', t: '定价' });
  Object.keys(LABELS.channels).forEach((k) => opts.push({ v: 'channels.' + k, t: '渠道 · ' + lbl('channels', k) }));
  if (c.categoryFields)
    Object.keys(c.categoryFields).forEach((k) => opts.push({ v: 'categories.' + k, t: '品类 · ' + lbl('categories', k) }));
  if (c.reviewField) {
    opts.push({ v: 'reviews.rating', t: '口碑评分' });
    opts.push({ v: 'reviews.trend', t: '口碑趋势' });
  }
  const lc = c.launchCadence as { value?: string } | undefined;
  if (lc && lc.value) opts.push({ v: 'launchCadence', t: '上新节奏' });
  const rf = c.reviewField as
    | { negThemes?: { items?: { text: string }[] }; posThemes?: { items?: { text: string }[] } }
    | undefined;
  if (rf && rf.negThemes && rf.negThemes.items)
    rf.negThemes.items.forEach((i) => opts.push({ v: 'reviews.negThemes.' + encodeURIComponent(i.text), t: '负面主题 · ' + i.text }));
  if (rf && rf.posThemes && rf.posThemes.items)
    rf.posThemes.items.forEach((i) => opts.push({ v: 'reviews.posThemes.' + encodeURIComponent(i.text), t: '正面主题 · ' + i.text }));
  return opts.length ? opts : [{ v: 'price', t: '定价' }];
}

// /api/field-correct 响应（handlers/correction.js L131-162）
interface FcResponse {
  ok?: boolean;
  correction: { competitorId: string; field: string; type: string };
  status?: string;
  private?: boolean;
  message?: string;
  state?: ZhibiState;
  priceField?: unknown;
  channelField?: unknown;
  categoryField?: unknown;
  launchCadence?: unknown;
  reviewField?: unknown;
}

// 私有覆盖：把返回的「该用户私有值」叠加到本地卡片（复刻 applyPrivateOverride L3045-3055）
function applyPrivateOverride(base: ZhibiState, s: FcResponse): ZhibiState {
  const fc = s.correction;
  const f = fc.field;
  const competitors = (base.competitors || []).map((c) => {
    if (c.id !== fc.competitorId) return c;
    const next: Competitor = { ...c };
    if (f.indexOf('channels.') === 0) {
      next.channelFields = { ...(next.channelFields || {}) };
      (next.channelFields as Record<string, unknown>)[f.split('.')[1]] = s.channelField;
    } else if (f.indexOf('categories.') === 0) {
      next.categoryFields = { ...(next.categoryFields as Record<string, unknown>) };
      (next.categoryFields as Record<string, unknown>)[f.split('.')[1]] = s.categoryField;
    } else if (f.indexOf('price') === 0) {
      next.priceField = s.priceField as Competitor['priceField'];
    } else if (f === 'launchCadence') {
      next.launchCadence = s.launchCadence;
    } else if (f.indexOf('reviews.') === 0) {
      next.reviewField = s.reviewField as Competitor['reviewField'];
    }
    return next;
  });
  return { ...base, competitors };
}

interface FieldCorrectModalProps {
  competitorId: string;
  initialField?: string;
  onClose: () => void;
}

export function FieldCorrectModal({ competitorId, initialField, onClose }: FieldCorrectModalProps) {
  const { state, patch } = useZhibiState();
  const comp = useMemo(
    () => ((state && state.competitors) || []).find((x) => x.id === competitorId),
    [state, competitorId],
  );

  const fieldOpts = useMemo(() => buildFieldOptions(comp || { id: competitorId, name: competitorId }), [comp, competitorId]);
  const [field, setField] = useState(initialField || fieldOpts[0].v);
  const [type, setType] = useState('wrong-value');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [currency, setCurrency] = useState('');
  const [valText, setValText] = useState('');
  const [state_, setState_] = useState('present');
  const [text, setText] = useState('');
  const [source, setSource] = useState('');
  const [status, setStatus] = useState('');
  const [sending, setSending] = useState(false);

  // 字段类别判定（复刻 applyFcField / toggleFcWraps 的分类逻辑）
  const isChan = field.indexOf('channels.') === 0;
  const isCat = field.indexOf('categories.') === 0;
  const isReviewSet = field.indexOf('reviews.negThemes.') === 0 || field.indexOf('reviews.posThemes.') === 0;
  const isSetField = isChan || isCat || isReviewSet;
  const isScalar = SCALAR_LABEL[field] !== undefined;

  const typeOpts = isChan || isCat || isReviewSet ? FC_CHAN_TYPES : isScalar ? FC_SCALAR_TYPES : FC_PRICE_TYPES;

  // 切字段时重置为该字段第一个可用类型
  useEffect(() => {
    setType(typeOpts[0].v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field]);

  const showValue = !isSetField && !isScalar && type === 'wrong-value';
  const showCur = !isSetField && !isScalar && type === 'wrong-currency';
  const showState = isSetField && type === 'wrong-state';
  const showValText = isScalar && type === 'wrong-value';

  async function submit() {
    if (!comp) return;
    const body: Record<string, unknown> = { id: competitorId, field, type, text: text.trim(), source: source.trim() };
    if (isScalar) {
      if (type === 'wrong-value') {
        const v = valText.trim();
        if (!v) {
          setStatus('请填写正确取值（如：月更及以上 / 高频）。');
          return;
        }
        body.valueText = v;
      }
    } else if (!isSetField) {
      if (type === 'wrong-value') {
        const mn = parseFloat(min);
        const mx = parseFloat(max);
        if (isNaN(mn) || isNaN(mx) || mn <= 0 || mx < mn) {
          setStatus('请填正确的价格区间（最低≤最高，且为正）。');
          return;
        }
        body.value = [mn, mx];
      }
      if (type === 'wrong-currency') {
        const cur = currency.trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(cur)) {
          setStatus('请填 3 位币种代码，如 USD / CNY / EUR。');
          return;
        }
        body.currency = cur;
      }
    } else {
      if (type === 'wrong-state') {
        if (!['present', 'absent', 'undetected'].includes(state_)) {
          setStatus('请选择真实状态。');
          return;
        }
        body.value = state_;
      }
    }
    if (type !== 'confirm-correct' && !body.source) {
      setStatus('请附上证据来源（必填，否则无法受理）。');
      return;
    }
    setSending(true);
    try {
      const s = await apiPost<FcResponse>('/api/field-correct', body);
      if (s.state) patch(applyPrivateOverride(s.state, s));
      onClose();
      // 待复核：不直接改写可信结论，仅记录（私有覆盖仅该用户可见）
      if (s.status === 'pending') {
        toast(
          s.private
            ? '已收到你的私有纠错，待复核后触发系统重采（仅你可见，不影响系统结论）'
            : '已收到纠错，待复核后生效（不直接改写可信结论）',
        );
        return;
      }
      let msg = '已记录';
      const corrType = s.correction && s.correction.type;
      if (isChan && s.channelField) {
        const stMap: Record<string, string> = { present: '在售', absent: '确认未入驻', undetected: '暂未发现', conflict: '存在矛盾' };
        const cf = s.channelField as { state?: string };
        msg = '已更新渠道判定：' + (stMap[cf.state || ''] || cf.state || '') + (corrType === 'confirm-correct' ? '（已确认）' : '（已生效）');
      } else if (isCat && s.categoryField) {
        const stMap: Record<string, string> = { present: '在售', absent: '推断未经营', undetected: '暂未发现', conflict: '存在矛盾' };
        const cf = s.categoryField as { state?: string };
        msg = '已更新品类判定：' + (stMap[cf.state || ''] || cf.state || '') + (corrType === 'confirm-correct' ? '（已确认）' : '（已生效）');
      } else if (isScalar && s.launchCadence) {
        const lc = s.launchCadence as { value?: string };
        msg = '已更新「' + (SCALAR_LABEL[field] || '取值') + '」：' + (lc.value || '—') + (corrType === 'confirm-correct' ? '（已确认）' : '（已生效）');
      } else if (field.indexOf('reviews.') === 0 && s.reviewField) {
        msg = '已更新口碑（' + (SCALAR_LABEL[field] || '主题') + '）' + (corrType === 'confirm-correct' ? '（已确认）' : '（已生效）');
      } else if (s.priceField) {
        const pf = s.priceField as { display?: string };
        msg = '已更新「' + (pf.display || '') + '」' + (corrType === 'confirm-correct' ? '（已确认）' : '（已生效）');
      }
      if (s.private) toast('你的私有覆盖已记录 · ' + msg + '（仅你可见，不影响系统结论）');
      else toast(msg);
    } catch (e) {
      setStatus('提交失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSending(false);
    }
  }

  const name = comp ? comp.name : competitorId;

  return (
    <div className="modal">
      <div className="modal-card" style={{ maxWidth: 520 }}>
        <div className="cmp-head">
          <h3>纠正「{name}」的数据</h3>
          <button className="cmp-x" title="关闭" type="button" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="fc-body">
          <p className="modal-sub">
            忠实助理红线：你的纠错不会直接改写&quot;已核实&quot;结论。除「我确认这是准的」外，纠错须附证据来源、进入待复核队列，复核通过后才会生效。我们不直接替你下结论。
          </p>
          <label className="field-label">要纠错的数据项 *</label>
          <select
            className="text-input"
            value={field}
            onChange={(e) => setField(e.target.value)}
          >
            {fieldOpts.map((o) => (
              <option key={o.v} value={o.v}>
                {o.t}
              </option>
            ))}
          </select>
          <label className="field-label">纠错类型 *</label>
          <select className="text-input" value={type} onChange={(e) => setType(e.target.value)}>
            {typeOpts.map((o) => (
              <option key={o.v} value={o.v}>
                {o.t}
              </option>
            ))}
          </select>
          {showValue ? (
            <div className="fc-wrap">
              <label className="field-label">正确价格区间（原币种，不换算）</label>
              <div className="fc-row">
                <input className="text-input num" type="number" placeholder="最低" value={min} onChange={(e) => setMin(e.target.value)} />
                <span className="fc-tilde">~</span>
                <input className="text-input num" type="number" placeholder="最高" value={max} onChange={(e) => setMax(e.target.value)} />
              </div>
            </div>
          ) : null}
          {showCur ? (
            <div className="fc-wrap">
              <label className="field-label">正确币种</label>
              <input className="text-input" type="text" placeholder="如 USD / CNY / EUR" value={currency} onChange={(e) => setCurrency(e.target.value)} />
            </div>
          ) : null}
          {showValText ? (
            <div className="fc-wrap">
              <label className="field-label">正确取值</label>
              <input className="text-input" type="text" placeholder="如：月更及以上 / 高频" value={valText} onChange={(e) => setValText(e.target.value)} />
            </div>
          ) : null}
          {showState ? (
            <div className="fc-wrap">
              <label className="field-label">{isReviewSet ? '该主题的真实状态' : '该渠道的真实状态'}</label>
              <select className="text-input" value={state_} onChange={(e) => setState_(e.target.value)}>
                <option value="present">在售 / 已入驻</option>
                <option value="absent">确认未入驻（核查过确实没有）</option>
                <option value="undetected">暂未发现（不等于&quot;没有&quot;，待重研）</option>
              </select>
            </div>
          ) : null}
          <label className="field-label">补充说明（可选）</label>
          <input className="text-input" type="text" placeholder="例如：我买过，实际均价约 $50" value={text} onChange={(e) => setText(e.target.value)} />
          <label className="field-label">
            证据来源 *<span className="muted">（必填，否则无法受理）</span>
          </label>
          <input
            className="text-input"
            type="text"
            placeholder="如：品牌官网链接 / 我买过的订单截图 / 第三方报道 URL"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
          <div className="modal-actions">
            <button className="btn-ghost" type="button" onClick={onClose}>
              取消
            </button>
            <button className="btn-primary" type="button" disabled={sending} onClick={() => void submit()}>
              {sending ? '提交中…' : '提交纠错'}
            </button>
          </div>
          <p className="ob-status">{status}</p>
        </div>
      </div>
    </div>
  );
}
