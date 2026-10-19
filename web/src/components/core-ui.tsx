'use client';
// SC-04 UI 框架轮共享小组件：项目选择器 / 空状态 / 建设中维度区域。
// 纪律：不出现后端术语（adapter/attempt/payload 等）；
// 未接入维度只显示「尚未接入」，不显示 0、空图、模拟图表或占位样本。
import { useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useZhibiState } from '@/hooks/use-zhibi-state';
import { fetchProjects, type CoverageDimension, type ProjectInfo } from '@/lib/core-api';

// ---------- 项目选择器（TopBar）：projectId 随页面跳转持续传递 ----------
// r2 修复：projectId 以 URL 参数为第一来源（深链接打开项目 B 时，顶部显示、
// 选中状态、页面数据必须同指项目 B）；切换项目只替换 projectId，
// 保留当前页面全部非项目参数（tab / brandId / type / status / from / to / c 等）。
export function ProjectPicker() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { state } = useZhibiState();
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchProjects()
      .then((r) => { if (alive) setProjects(r.projects || []); })
      .catch(() => { if (alive) { setProjects([]); setFailed(true); } });
    return () => { alive = false; };
  }, []);

  const urlPid = searchParams.get('projectId') || '';
  const statePid = (state as { projectId?: string } | null)?.projectId || '';
  // URL 优先：深链接/跳转上下文指向的项目即当前项目；state 仅兜底
  const curId = urlPid || statePid;
  const cur = (projects || []).find((p) => p.id === curId);
  const curLabel = cur?.track || (urlPid ? '当前项目' : (state && typeof state.track === 'string' && state.track) || '选择项目');

  function pick(id: string) {
    if (id === urlPid) return; // 已是该项目，避免重复导航
    // 只替换 projectId，其余参数（tab/brandId/type/status/from/to/c/…）原样保留
    const sp = new URLSearchParams(searchParams.toString());
    sp.set('projectId', id);
    router.push(`${pathname}?${sp.toString()}`);
  }

  return (
    <details className="proj-picker" title="切换当前项目（项目上下文会随跳转保持）">
      <summary>
        <span className="proj-picker-label">项目</span>
        <span className="proj-picker-name">{curLabel}</span>
        <span className="proj-picker-count">{projects ? `${projects.length}` : '…'}</span>
      </summary>
      <ul className="proj-picker-menu">
        {failed ? <li className="proj-picker-empty">项目清单加载失败，可稍后重试。</li> : null}
        {!failed && projects && !projects.length ? <li className="proj-picker-empty">还没有项目——先在工作台发起一次赛道调研。</li> : null}
        {(projects || []).map((p) => (
          <li key={p.id}>
            <button type="button" className={p.id === curId ? 'on' : ''} onClick={() => pick(p.id)}>
              <span>{p.track || '(未命名)'}</span>
              <span className="proj-picker-meta">竞品 {p.total} · 完成 {p.done}{p.current ? ' · 当前档案' : ''}</span>
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

// ---------- 统一空状态 ----------
export function EmptyState({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="core-empty">
      <div className="core-empty-title">{title}</div>
      {sub ? <div className="core-empty-sub">{sub}</div> : null}
      {action ? <div className="core-empty-act">{action}</div> : null}
    </div>
  );
}

// ---------- 建设中维度区域（品牌详情 / 机会页共用；四项未接入维度统一在此表达） ----------
export function BuildingDims({ dimensions, note }: { dimensions: CoverageDimension[]; note?: string }) {
  const pending = (dimensions || []).filter((d) => d.state === 'unsupported');
  if (!pending.length) return null;
  return (
    <div className="core-building">
      <div className="core-building-head">数据覆盖与建设中维度</div>
      <p className="hint">{note || '以下维度尚未接入：当前不生成数据、估算或结论；接入后这里会展示采集状态与来源。'}</p>
      <ul className="core-building-list">
        {pending.map((d) => (
          <li key={d.code}>
            <span className="core-building-name">{d.displayName}</span>
            <span className="core-building-state">尚未接入</span>
            <span className="core-building-meta">最近观察：—</span>
            <span className="core-building-meta">来源：未接入</span>
            <span className="core-building-meta">刷新：不可用</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
