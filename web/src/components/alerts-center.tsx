'use client';
// 异动提醒中心（F-03，复刻旧版 alerts.js 的 AlertsUI + index.html 铃铛/面板结构）
// 行为对齐：
//   · 铃铛在顶栏，未读数角标（>99 显示 99+）
//   · 点击开右侧滑入面板（alert-panel.open）+ 背景遮罩，Escape/点遮罩关闭
//   · 「全部已读」：本地落盘 + POST /api/alerts/read（带真实服务端 id——旧版发空数组被后端 400 静默吞掉）
//   · 挂载时拉 GET /api/alerts?limit=50 合并服务端站内信（雷达 sweep 的竞品动作预警）
//   · SSE discover_complete / discover_error → 本地推送（复刻 app.js L775/L798）
import { useCallback, useEffect, useRef, useState } from 'react';
import { getAlerts, markAlertsRead } from '@/lib/api';
import { useZhibiState } from '@/hooks/use-zhibi-state';
import { alertsPush, alertsMarkAllRead, startAlertsRefresh, fmtAlertWhen, useAlerts, type ZbAlert } from '@/lib/alerts';
import { isDemoMode } from '@/lib/demo';
import { captureSession, isSessionCurrent, SESSION_CHANGED_EVENT } from '@/lib/storage-scope';

export function AlertsCenter() {
  const { state, subscribe } = useZhibiState();
  const { alerts, unread, refresh } = useAlerts();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [sessionRevision, setSessionRevision] = useState(0);
  const pollingRef = useRef<ReturnType<typeof startAlertsRefresh> | null>(null);
  // 服务端提醒 id 集（全部已读时回传后端；本地 complete/error 推送不在服务端，无需回传）
  const serverIdsRef = useRef<string[]>([]);

  // Account changes invalidate pending reads before starting the next account's inbox.
  useEffect(() => {
    const changed = () => {
      pollingRef.current?.close();
      serverIdsRef.current = [];
      setSessionRevision(value => value + 1);
      setError('');
    };
    const storage = (event: StorageEvent) => {
      if (!event.key || event.key === 'zhibi_token' || event.key === 'ci_token') changed();
    };
    window.addEventListener('storage', storage);
    window.addEventListener(SESSION_CHANGED_EVENT, changed);
    return () => {
      window.removeEventListener('storage', storage);
      window.removeEventListener(SESSION_CHANGED_EVENT, changed);
    };
  }, []);

  useEffect(() => {
    if (isDemoMode()) return;
    const polling = startAlertsRefresh({
      read: () => getAlerts(50),
      onUpdate: serverIds => {
        serverIdsRef.current = serverIds;
        refresh();
      },
      onError: failure => setError(failure ? '提醒暂时无法更新，已显示的提醒可能不是最新。' : ''),
    });
    pollingRef.current = polling;
    return () => {
      polling.close();
      if (pollingRef.current === polling) pollingRef.current = null;
    };
  }, [refresh, sessionRevision]);

  useEffect(() => { if (open) void pollingRef.current?.request(); }, [open]);

  // SSE 接线：调研完成/失败 → 本地推送（复刻 app.js L775/L798）
  // track 经 ref 读取：订阅依赖里不放 state——否则每次 state 推送都会退订/重订 SSE（订阅抖动）
  const trackRef = useRef('');
  useEffect(() => {
    trackRef.current = (state && state.track) || '赛道';
  }, [state]);
  useEffect(() => {
    const session = captureSession();
    return subscribe((evt) => {
        if (!isSessionCurrent(session)) return;
        if (evt.type === 'discover_complete') {
          alertsPush({ type: 'complete', title: '调研已就绪', body: `「${trackRef.current}」竞争品牌材料已整理完成，请前往工作台处理。` }, session);
          refresh();
        } else if (evt.type === 'discover_error') {
          const msg = (evt.message as string | undefined) || '请稍后重试';
          alertsPush({ type: 'error', title: '研究未完成', body: msg }, session);
          refresh();
        }
      });
  }, [subscribe, refresh, sessionRevision]);

  // Escape 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const onMarkAllRead = useCallback(() => {
    alertsMarkAllRead();
    refresh();
    // 服务端同步已读（仅真实服务端 id；空数组后端会 400）
    const ids = serverIdsRef.current;
    if (ids.length) {
      const session = captureSession();
      markAlertsRead(ids).then(() => {
        if (isSessionCurrent(session)) void pollingRef.current?.request();
      }).catch(() => { if (isSessionCurrent(session)) setError('已读状态尚未同步，请稍后重试。'); });
    }
  }, [refresh]);

  return (
    <>
      <button
        className="btn-ghost btn-bell"
        type="button"
        title="异动提醒"
        aria-label="异动提醒中心"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {unread > 0 && <span className="bell-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>

      {open && (
        <>
          <div className="alert-backdrop" onClick={() => setOpen(false)} />
          <aside className="alert-panel open" aria-hidden="false" aria-label="异动提醒中心">
            <div className="alert-head">
              <span className="at">异动提醒</span>
              <button className="link-btn" type="button" onClick={onMarkAllRead}>全部已读</button>
              <button className="alert-x" type="button" aria-label="关闭" onClick={() => setOpen(false)}>✕</button>
            </div>
            <div className="alert-list">
              {error && <p className="hint" role="alert">{error} <button className="link-btn" type="button" onClick={() => void pollingRef.current?.request()}>重试</button></p>}
              {alerts.length === 0 ? (
                <p className="alert-empty muted">暂无异动。竞争品牌发生价格、上新、渠道或口碑变化时，会出现在这里。</p>
              ) : (
                alerts.map((a: ZbAlert) => (
                  <div key={a.id} className={'alert-item' + (a.read ? ' read' : '')}>
                    <span className={'ai-dot ' + (a.type || '')} />
                    <div className="ai-body">
                      <div className="ai-title">{a.title || '提醒'}</div>
                      {a.body ? <div className="ai-text">{a.body}</div> : null}
                      <div className="ai-time">{fmtAlertWhen(a)}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </aside>
        </>
      )}
    </>
  );
}
