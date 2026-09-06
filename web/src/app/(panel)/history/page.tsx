'use client';
// 历史调研（Phase 3，复刻 renderHistoryTab L4195-4225 + switchProject L4170-4183 + deleteProject L4184-4192）
// 数据源 GET /api/projects（清单层：db 与文件态在此汇合）；切换 POST /api/projects/switch
//   → 返回装饰后的完整 state → patch() 即时生效 + 回工作台；删除 POST /api/projects/delete
//   → 返回 { ok, projects } 刷新清单；若删的是当前档案 → refresh() 拉回 { track: null } 空态。
// 注：演示模式（?demo=1）下本页由 DemoPageGuard 拦截（依赖真实会话，见 F-04）。
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useZhibiState } from '@/hooks/use-zhibi-state';
import { apiGet, apiPost } from '@/lib/api';
import { isDemoMode } from '@/lib/demo';
import { DemoPageGuard } from '@/components/demo-page-guard';
import type { ZhibiState } from '@/types/state';

interface ProjectItem {
  id: string;
  track?: string;
  current?: boolean;
  discoveredAt?: string | number;
  total?: number | null;
  done?: number | null;
  hasBrief?: boolean;
}

function fmtMeta(p: ProjectItem): string {
  const when = p.discoveredAt ? new Date(p.discoveredAt).toLocaleString('zh-CN') : '时间未知';
  const counts = `${p.total != null ? p.total : '—'} 个品牌（${p.done != null ? p.done : '—'} 家已深研）`;
  return `${when} · ${counts}${p.hasBrief ? ' · 已生成调研报告' : ''}`;
}

export default function HistoryPage() {
  // 演示模式：本页依赖 /api/projects 真实会话，替换为提示屏（F-04 配套）
  if (isDemoMode()) return <DemoPageGuard label="历史调研" />;
  return <HistoryPageInner />;
}

function HistoryPageInner() {
  const { patch, refresh } = useZhibiState();
  const router = useRouter();
  const [list, setList] = useState<ProjectItem[] | null>(null); // null = 加载中
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState<string>('');

  const load = useCallback(() => {
    setErr('');
    apiGet<{ projects?: ProjectItem[] }>('/api/projects')
      .then((r) => setList(r.projects || []))
      .catch((e: Error) => {
        setList([]);
        setErr('加载失败：' + (e.message || String(e)));
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 打开（复刻 switchProject：POST → patch(state) → 回工作台；track 为空则工作台自然落 onboarding）
  const open = async (id: string) => {
    setBusyId(id);
    setErr('');
    try {
      const s = await apiPost<ZhibiState>('/api/projects/switch', { id });
      patch(s);
      router.push('/');
    } catch (e) {
      setErr('切换失败：' + ((e as Error).message || String(e)));
    } finally {
      setBusyId('');
    }
  };

  // 删除（复刻 deleteProject：confirm → POST → 刷新清单；删当前 → refresh() 拉空态）
  const del = async (p: ProjectItem) => {
    if (!window.confirm('确定删除调研「' + (p.track || '') + '」？档案将被移除，不可恢复。')) return;
    setBusyId(p.id);
    setErr('');
    try {
      const r = await apiPost<{ ok?: boolean; projects?: ProjectItem[] }>('/api/projects/delete', { id: p.id });
      setList(r.projects || []);
      if (p.current) await refresh(); // 当前档案被删：/api/state 返回 { track: null }
    } catch (e) {
      setErr('删除失败：' + ((e as Error).message || String(e)));
    } finally {
      setBusyId('');
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>历史调研</h2>
          <p className="desc">你的全部调研档案。切换即加载该赛道的工作台，删除不可恢复。</p>
        </div>
      </div>

      {err ? <p className="err">{err}</p> : null}

      {list === null ? (
        <p className="muted">加载中…</p>
      ) : !list.length ? (
        <div className="empty">
          <div className="big">还没有任何调研档案</div>
          <div className="sub">搜索一个赛道即可创建第一份。</div>
        </div>
      ) : (
        <div>
          {list.map((p) => (
            <div className={'history-item' + (p.current ? ' cur' : '')} key={p.id}>
              <div className="hi-main">
                <div className="hi-track">
                  {p.track}
                  {p.current ? <> <span className="hi-cur">当前</span></> : null}
                </div>
                <div className="hi-meta">{fmtMeta(p)}</div>
              </div>
              <div className="hi-actions">
                {p.current ? null : (
                  <button className="btn-ghost hi-open" type="button" disabled={busyId === p.id} onClick={() => void open(p.id)}>
                    打开
                  </button>
                )}
                <button className="btn-ghost hi-del" type="button" disabled={busyId === p.id} onClick={() => void del(p)}>
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
