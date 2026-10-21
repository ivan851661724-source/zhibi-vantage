'use client';
// 正式监控入口（01 PRD §16 加入监控 / 04 前端规格 §4 Competitor Card「是否正式监控」）
// 最小入口：卡片内嵌按钮 + 状态行，不新增一级页面、不做视觉重构。
// 三态：未监控 → 加入监控；已监控 → 暂停/恢复 + 信号与最近成功检查；
// Coverage 不完整 → 显式提示（00 §21：不把失败当无变化）。
import { useCallback, useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';

interface WatchIntent {
  intentId: string;
  competitorId: string;
  state: 'establishing' | 'source_failed' | 'promoted' | 'cancelled';
  stateText: string;
  reasonText?: string | null;
  // SC-07 r2 §二：持久化建立流程——明确下一步（已安排探测 / 限流自动重试 / 等待用户重试）
  nextStepText?: string | null;
  nextProbeAt?: string | null;
  monitoring: boolean;
}

interface WatchTarget {
  watchTargetId: string;
  competitorId: string;
  monitoringStatus: string;
  enabledSignals: string[];
  supportedSignals?: string[];
  freshnessStatus: string;
  lastSuccessAt?: string | null;
  lastWindow?: { slot: string; coverage: string; partialScan: boolean; failureReasons?: Record<string, number> } | null;
}

const SIGNAL_ZH: Record<string, string> = { price: '价格', launch: '上新', stock: '断货' };

export function WatchControl({ competitorId }: { competitorId: string }) {
  const [target, setTarget] = useState<WatchTarget | null>(null);
  const [intent, setIntent] = useState<WatchIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiGet<{ targets: WatchTarget[]; intents?: WatchIntent[] }>('/api/watch-targets');
      setTarget((r.targets || []).find((t) => t.competitorId === competitorId) || null);
      // SC-07 §2：监控意向与正式监控严格分开——意向不等于「监控中」
      setIntent((r.intents || []).find((i) => i.competitorId === competitorId && i.state !== 'cancelled') || null);
    } catch {
      /* 未登录/网络异常：按钮退化为未监控态 */
    }
  }, [competitorId]);

  useEffect(() => {
    load();
  }, [load]);

  // SC-07 r3 P1：意向建立中（或限流后已安排重试）时轮询监控状态——
  // 晋升后无需刷新页面即可从「正在建立监控来源」自动切换为正式监控（只显示价格信号）；
  // 进入终态（promoted / cancelled / 无下次重试的 source_failed）或卸载即停止，禁止定时器泄漏。
  const shouldPoll = !target && !!intent
    && (intent.state === 'establishing' || (intent.state === 'source_failed' && !!intent.nextProbeAt));
  useEffect(() => {
    if (!shouldPoll) return;
    let alive = true;
    const t = setInterval(() => { if (alive) load(); }, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [shouldPoll, load, competitorId]);

  const join = async () => {
    setBusy(true);
    setErr(null);
    try {
      await apiPost('/api/watch-targets', { competitorId });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '加入监控失败');
    } finally {
      setBusy(false);
    }
  };

  const togglePause = async () => {
    if (!target) return;
    setBusy(true);
    setErr(null);
    try {
      await apiPatch('/api/watch-targets/' + encodeURIComponent(target.watchTargetId), {
        action: target.monitoringStatus === 'paused' ? 'resume' : 'pause',
      });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!target) return;
    setBusy(true);
    setErr(null);
    try {
      await apiDelete('/api/watch-targets/' + encodeURIComponent(target.watchTargetId));
      setTarget(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '移除失败');
    } finally {
      setBusy(false);
    }
  };

  const cancelIntent = async () => {
    if (!intent) return;
    setBusy(true);
    setErr(null);
    try {
      await apiDelete('/api/watch-intents/' + encodeURIComponent(intent.intentId));
      setIntent(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '退出监控意向失败');
    } finally {
      setBusy(false);
    }
  };

  if (!target) {
    // 已保存意向但尚无正式监控：如实显示「正在建立监控来源 / 来源建立失败」，绝不说「监控中」
    if (intent) {
      const failed = intent.state === 'source_failed';
      return (
        <div className="watch-ctl" onClick={(e) => e.stopPropagation()}>
          <div className="watch-line">
            <span className={'watch-badge ' + (failed ? 'is-paused' : 'is-pending')}>
              {failed ? '来源建立失败' : '正在建立监控来源'}
            </span>
            <span className="watch-meta">
              {failed
                ? (intent.reasonText || '暂无可核验的商品来源，稍后会自动重试')
                : '已记录你的监控意向：正在建立可重复抓取的公开商品来源；完成两次可比较采集后才会进入正式监控'}
            </span>
          </div>
          {/* SC-07 r2 §二：意向永远有明确下一步，不出现无后续的「建立中」 */}
          {intent.nextStepText ? (
            <div className="watch-line"><span className="watch-meta">{intent.nextStepText}</span></div>
          ) : null}
          <div className="watch-actions">
            <button className="watch-btn watch-remove" type="button" disabled={busy} onClick={cancelIntent}>
              退出监控意向
            </button>
            {err ? <span className="watch-err">{err}</span> : null}
          </div>
        </div>
      );
    }
    return (
      <div className="watch-ctl" onClick={(e) => e.stopPropagation()}>
        <button className="watch-btn watch-join" type="button" disabled={busy} onClick={join}>
          加入监控
        </button>
        {err ? <span className="watch-err">{err}</span> : null}
      </div>
    );
  }

  const inactive = !!target && target.monitoringStatus === 'inactive';
  if (!target || inactive) {
    return (
      <div className="watch-ctl" onClick={(e) => e.stopPropagation()}>
        <button className="watch-btn watch-join" type="button" disabled={busy} onClick={join}>
          加入监控
        </button>
        {inactive ? <span className="watch-meta">曾加入过监控（已移出，历史保留），再次加入将恢复原对象</span> : null}
        {err ? <span className="watch-err">{err}</span> : null}
      </div>
    );
  }

  const paused = target.monitoringStatus === 'paused';
  const degraded = target.monitoringStatus === 'degraded';
  // §9 能力门槛：只展示当前品牌真实可用的直接监控范围，不让用户误以为全部信号都在监控
  const supported = target.supportedSignals || target.enabledSignals || [];
  const covBad = target.lastWindow && (target.lastWindow.coverage !== 'full' || target.lastWindow.partialScan);
  return (
    <div className="watch-ctl" onClick={(e) => e.stopPropagation()}>
      <div className="watch-line">
        <span className={'watch-badge ' + (paused ? 'is-paused' : 'is-active')}>
          {paused ? '已暂停' : degraded ? '降级巡检中' : '已监控'}
        </span>
        <span className="watch-meta">
          信号：{(target.enabledSignals || []).map((s) => SIGNAL_ZH[s] || s).join('、')}
          {(target.enabledSignals || []).some((s) => !supported.includes(s))
            ? '（含暂无直接源、尚无法持续巡检的信号）'
            : ''}
          {target.lastSuccessAt ? ` ｜ 最近成功检查 ${String(target.lastSuccessAt).slice(0, 16).replace('T', ' ')}` : ' ｜ 尚无成功检查'}
        </span>
      </div>
      <div className="watch-line">
        <span className="watch-meta">
          当前支持范围：{supported.length ? supported.map((s) => SIGNAL_ZH[s] || s).join('、') : '暂无（该品牌没有可用的直接监控源）'}
        </span>
      </div>
      {covBad ? (
        <div className="watch-gap">最近巡检覆盖不完整（{target.lastWindow?.slot}），该窗口结论不可作为「无变化」依据</div>
      ) : null}
      <div className="watch-actions">
        <button className="watch-btn" type="button" disabled={busy} onClick={togglePause}>
          {paused ? '恢复监控' : '暂停监控'}
        </button>
        <button className="watch-btn watch-remove" type="button" disabled={busy} onClick={remove}>
          移出监控
        </button>
        {err ? <span className="watch-err">{err}</span> : null}
      </div>
    </div>
  );
}
