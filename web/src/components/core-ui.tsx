'use client';
// SC-04 UI 框架轮共享小组件：项目选择器 / 空状态 / 建设中维度区域。
// 纪律：不出现后端术语（adapter/attempt/payload 等）；
// 未接入维度只显示「尚未接入」，不显示 0、空图、模拟图表或占位样本。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useZhibiState } from '@/hooks/use-zhibi-state';
import { fetchProjects, type CoverageDimension, type ProjectInfo } from '@/lib/core-api';

// ---------- 项目切换导航规则（r3：集中在一个函数，禁止散落字符串拼接） ----------
// 跨项目切换时，项目内资源上下文不得跟着走：
// - 资源详情页（/brands/:brandId、/report/:reportId）：brandId/reportId 属于原项目，
//   带到新项目只会得到「顶部显示 B、内容还是 A」或 404 → 一律跳回对应列表页，只带 projectId。
// - 列表页（/brands /intel /opportunity /report）：保留与项目无关的参数
//   （时间范围 from/to、类型 type、状态 status 等），清除项目内资源参数
//   （brandId、reportId、品牌详情 tab），否则会留下指向原项目的筛选造成假空结果。
// - 非核心页面（如 /radar）：维持原行为，仅替换 projectId。
export function projectSwitchUrl(pathname: string, searchParams: URLSearchParams, nextProjectId: string): string {
  const seg = pathname.split('/').filter(Boolean);
  const root = '/' + (seg[0] || '');
  const CORE_ROOTS = ['/brands', '/intel', '/opportunity', '/report'];
  const pid = encodeURIComponent(nextProjectId);
  // 详情页（二级路径）→ 跳回该模块列表页，不带任何原项目资源
  if (seg.length > 1 && CORE_ROOTS.includes(root)) {
    return `${root}?projectId=${pid}`;
  }
  // r2：跨项目只带 projectId——品牌/资源 ID 与筛选条件（brandId/dimension/status/from/to/tab…）
  // 都属于原项目上下文，带过去会得到「顶部是 B、内容是 A」或假空结果。
  void searchParams;
  return `${root}?projectId=${pid}`;
}

// ---------- 项目选择器（TopBar）：projectId 随页面跳转持续传递 ----------
// r2 修复：projectId 以 URL 参数为第一来源（深链接打开项目 B 时，顶部显示、
// 选中状态、页面数据必须同指项目 B）。
// r3 修复：切换项目按页面类型导航（见 projectSwitchUrl）——资源详情页跳回列表页，
// 列表页清除项目内资源参数；不再「保留全部参数」造成跨项目错误上下文。
export function ProjectPicker() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { state } = useZhibiState();
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  // r2：菜单按触发按钮位置自动靠左/靠右，宽度不超 calc(100vw - 24px)
  const boxRef = useRef<HTMLDetailsElement | null>(null);
  const [align, setAlign] = useState<'left' | 'right'>('left');
  const updateAlign = () => {
    const el = boxRef.current;
    if (!el || typeof window === 'undefined') return;
    const r = el.getBoundingClientRect();
    const want = Math.min(340, window.innerWidth - 24);
    setAlign(window.innerWidth - r.left >= want ? 'left' : 'right');
  };

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
    router.push(projectSwitchUrl(pathname, searchParams, id));
  }

  return (
    <details
      className="proj-picker"
      ref={boxRef}
      title="切换当前项目（切换后不保留原项目的品牌与筛选）"
      onToggle={updateAlign}
    >
      <summary>
        <span className="proj-picker-label">项目</span>
        <span className="proj-picker-name">{curLabel}</span>
        <span className="proj-picker-count">{projects ? `${projects.length}` : '…'}</span>
      </summary>
      <ul className="proj-picker-menu" data-align={align} style={{ maxWidth: 'calc(100vw - 24px)' }}>
        {failed ? <li className="proj-picker-empty">项目清单加载失败，可稍后重试。</li> : null}
        {!failed && projects && !projects.length ? <li className="proj-picker-empty">还没有项目——先在工作台发起一次赛道调研。</li> : null}
        {(projects || []).map((p) => (
          <li key={p.id}>
            <button type="button" className={p.id === curId ? 'on' : ''} onClick={() => pick(p.id)} title={p.track || '(未命名)'}>
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

// ---------- 建设中维度区域（品牌详情 / 机会页 / 情报库共用） ----------
// 覆盖语义（P0-2 整改 r2）：unsupported = 未接入；pending_config = 数据服务暂不可用。
// SC-06 r2：pending_verification = 能力已实现但尚无真实成功采集（待验证，不显示「已采集」）。
// 两者都只显示覆盖状态本身——不生成 0 值、空图、模拟图表、时间戳或占位样本；
// 凭据/环境变量等技术细节只在管理员健康接口可见，不进用户页面。
export function BuildingDims({ dimensions, note }: { dimensions: CoverageDimension[]; note?: string }) {
  const pending = (dimensions || []).filter((d) => d.state === 'unsupported' || d.state === 'pending_config' || d.state === 'pending_verification');
  if (!pending.length) return null;
  return (
    <div className="core-building">
      <div className="core-building-head">数据覆盖与建设中维度</div>
      <p className="hint">{note || '以下维度当前不生成数据、估算或结论；数据服务可用后这里会展示采集状态与来源。'}</p>
      <ul className="core-building-list">
        {pending.map((d) => (
          <li key={d.code}>
            <span className="core-building-name">{d.displayName}</span>
            <span className="core-building-state">{d.stateText || (d.state === 'pending_config' ? '数据服务暂不可用' : (d.state === 'pending_verification' ? '待验证' : '尚未接入'))}</span>
            <span className="core-building-meta">最近观察：—</span>
            <span className="core-building-meta">来源：未接入</span>
            <span className="core-building-meta">刷新：不可用</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
