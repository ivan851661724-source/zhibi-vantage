'use client';
// 面板组布局（docs/architecture/01_前端架构规范.md §4）
// 复刻 index.html：side-nav（logo + DAILY OPS/INTELLIGENCE/SYSTEM 三组导航 + 用户区）+ topbar。
// 徽章：navRivals = competitors.length（对齐 app.js updateWbBadges L1665-1666）；
//       navPending = 未决策材料数（三动作 localStorage 记录属 Phase 2 工作台，暂以材料总数展示）。
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { clearToken, getToken } from '@/lib/api';
import { ZhibiStateProvider, useZhibiState } from '@/hooks/use-zhibi-state';
import { wbLoad } from '@/lib/wb';
import { isDemoMode } from '@/lib/demo';
import { AlertsCenter } from '@/components/alerts-center';
import { ProjectPicker } from '@/components/core-ui';
import { AccountDrawer } from '@/components/account-drawer';
import { fetchAccount } from '@/lib/core-api';

const NAV_GROUPS: {
  sec: string;
  items: { href: string; label: string; desc?: string; icon: React.ReactNode }[];
}[] = [
  {
    sec: 'DAILY OPS · 日常',
    items: [
      {
        href: '/',
        label: '工作台',
        desc: '今天需要关注和处理的事项',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 5h18v14H3zM3 9h18" /><path d="M7 13h4M7 16h4" /></svg>
        ),
      },
      {
        href: '/radar',
        label: '竞品监控',
        desc: '监控哪些品牌、哪些信号、巡检是否完整',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.6" fill="currentColor" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" strokeLinecap="round" /></svg>
        ),
      },
    ],
  },
  {
    sec: 'INTELLIGENCE · 情报',
    items: [
      {
        href: '/brands',
        label: '竞品数据库',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7h16M4 12h16M4 17h10" strokeLinecap="round" /><circle cx="19" cy="17" r="2" /></svg>
        ),
      },
      {
        href: '/intel',
        label: '每日变化',
        desc: '今天及近期真实发生的竞争变化',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 20V9l8-5 8 5v11" /><path d="M9 20v-6h6v6M9 11h.01M15 11h.01M12 11h.01" strokeLinecap="round" /></svg>
        ),
      },
      {
        href: '/opportunity',
        label: '市场机会',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></svg>
        ),
      },
      {
        href: '/report',
        label: '分析报告',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 2h9l5 5v15H6z" /><path d="M9 12h6M9 16h6M9 8h2" strokeLinecap="round" /></svg>
        ),
      },
      // SC-06 信息架构收敛：/sector（赛道档案）与竞品数据库职责重叠，从主导航
      // 移除重复入口；路由与页面保留（旧深链接不 404），可从竞品数据库内到达。
    ],
  },
  {
    sec: 'SYSTEM · 系统',
    items: [
      {
        href: '/history',
        label: '历史调研',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg>
        ),
      },
      {
        href: '/assets',
        label: '算法资产',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg>
        ),
      },
      // /demo 不入主导航（比赛演示走直达 URL），路由与页面保留
    ],
  },
];

const PANEL_TITLES: Record<string, string> = {
  '/': '工作台',
  '/radar': '竞品监控',
  '/brands': '竞品数据库',
  '/intel': '每日变化',
  '/opportunity': '市场机会',
  '/report': '分析报告',
  '/sector': '赛道档案',
  '/history': '历史调研',
  '/assets': '算法资产',
  '/demo': '产品演示',
};

// r2 修复：四个核心情报入口（竞品数据库/情报库/机会视图/调研报告）在当前 URL
// 存在 projectId 时携带同一 projectId——侧栏、顶部选择器、页面数据三者一致；
// 没有 projectId 时保持原始链接，不制造空参数。
const CORE_PID_HREFS = new Set(['/brands', '/intel', '/opportunity', '/report']);

function NavGroups({ projectId, pending, rivals }: { projectId: string | null; pending: number; rivals: number }) {
  const pathname = usePathname();
  const withPid = (href: string) => {
    if (projectId && CORE_PID_HREFS.has(href)) return `${href}?projectId=${encodeURIComponent(projectId)}`;
    return href;
  };
  return (
    <>
      {NAV_GROUPS.map((g) => (
        <div key={g.sec}>
          <div className="nav-sec">{g.sec}</div>
          {g.items.map((it) => {
            const active = pathname === it.href;
            return (
              <Link
                key={it.href}
                href={withPid(it.href)}
                className={'nav-item' + (active ? ' active' : '')}
                title={it.desc || undefined}
              >
                {it.icon}
                <span>{it.label}</span>
                {it.href === '/' && (
                  <span className={'badge' + (pending === 0 ? ' gray' : '')} id="navPending">{pending}</span>
                )}
                {it.href === '/radar' && (
                  <span className="badge gray" id="navRivals">{rivals}</span>
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </>
  );
}

function SideNav() {
  const { state } = useZhibiState();
  // 待批 badge（对齐 app.js updateWbBadges L1658-1667：未决策材料数）
  const [pending, setPending] = useState(0);
  useEffect(() => {
    const d = wbLoad();
    setPending(((state && state.materials) || []).filter((m) => !d[m.id]).length);
  }, [state]);
  const rivals = (state && state.competitors && state.competitors.length) || 0;

  return (
    <nav className="side-nav" id="sideNav">
      {/* useSearchParams 需要 Suspense 边界；回退渲染无参导航（水合后立即带参） */}
      <Suspense fallback={<NavGroups projectId={null} pending={pending} rivals={rivals} />}>
        <SideNavLinks pending={pending} rivals={rivals} />
      </Suspense>
      {/* r4 §十：移动端（≤820px 侧栏转底栏）原本没有账户入口——补一个「账户」标签 */}
      <MobileAccountButton />
      <div className="side-foot">
        <div className="plan-pill"><span className="dot"></span><span id="planStatus">雷达运行中</span></div>
        <UserRow />
      </div>
    </nav>
  );
}

function SideNavLinks({ pending, rivals }: { pending: number; rivals: number }) {
  const searchParams = useSearchParams();
  const projectId = searchParams.get('projectId') || '';
  return <NavGroups projectId={projectId || null} pending={pending} rivals={rivals} />;
}

// r4 §十：用户名来自当前登录账号的真实资料（displayName；无则回退邮箱 @ 前缀），
// 不再固定显示「知彼用户」；点击打开账户抽屉（资料/用量/安全），退出入口移入抽屉。
// 移动端底部栏的账户入口（桌面隐藏；点击打开账户抽屉）
function MobileAccountButton() {
  const [name, setName] = useState('');
  const [drawer, setDrawer] = useState(false);
  useEffect(() => {
    let alive = true;
    fetchAccount()
      .then((a) => { if (alive) setName(a.user.displayName || '账户'); })
      .catch(() => { if (alive) setName('账户'); });
    return () => { alive = false; };
  }, [drawer]);
  return (
    <>
      <button type="button" className="side-account" aria-haspopup="dialog" onClick={() => setDrawer(true)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="8" r="3.4" /><path d="M5 20c1.2-3.4 4-5 7-5s5.8 1.6 7 5" strokeLinecap="round" /></svg>
        <span>{name || '账户'}</span>
      </button>
      <AccountDrawer open={drawer} onClose={() => setDrawer(false)} onNameChanged={(n) => setName(n)} />
    </>
  );
}

function UserRow() {
  const [name, setName] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => {
    let alive = true;
    fetchAccount()
      .then((a) => { if (alive) setName(a.user.displayName || ''); })
      .catch(() => { if (alive) setName(null); });
    return () => { alive = false; };
  }, [drawer]);
  const shown = name && name.trim() ? name.trim() : '已登录';
  const initial = shown && shown !== '已登录' ? shown.slice(0, 1).toUpperCase() : 'V';
  return (
    <div className="user-row">
      <button
        type="button"
        className="user-row-btn"
        aria-haspopup="dialog"
        aria-expanded={drawer}
        onClick={() => setDrawer(true)}
        title="账户设置"
      >
        <div className="avatar">{initial}</div>
        <div className="uinfo">
          <div className="un" id="userDisplayName">{shown}</div>
          <div className="ue">账户设置</div>
        </div>
      </button>
      <AccountDrawer open={drawer} onClose={() => setDrawer(false)} onNameChanged={(n) => setName(n)} />
    </div>
  );
}

function TopBar() {
  const pathname = usePathname();
  const { state } = useZhibiState();
  const track = state && typeof state.track === 'string' ? state.track : '';
  // demo 态在 effect 后注入：渲染期直接读 sessionStorage 会造成 SSR/CSR 水合不一致
  const [demo, setDemo] = useState(false);
  useEffect(() => {
    setDemo(isDemoMode());
  }, []);
  return (
    <header className="topbar">
      <div className="tb-brand">
        <svg viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="13" stroke="#6EE7A0" strokeWidth="2.4" /><circle cx="16" cy="16" r="8" stroke="#6EE7A0" strokeWidth="1.4" opacity="0.5" /><circle cx="16" cy="16" r="3.2" fill="#33B98C" /><line x1="16" y1="1" x2="16" y2="7" stroke="#6EE7A0" strokeWidth="1.6" /><line x1="16" y1="25" x2="16" y2="31" stroke="#6EE7A0" strokeWidth="1.6" /><line x1="1" y1="16" x2="7" y2="16" stroke="#6EE7A0" strokeWidth="1.6" /><line x1="25" y1="16" x2="31" y2="16" stroke="#6EE7A0" strokeWidth="1.6" /><circle cx="27.5" cy="16" r="2.1" fill="#D9A25C" /></svg>
        <div><div className="bn">知彼 Vantage</div><div className="sub">AI 竞争情报分析师</div></div>
      </div>
      <div className="tb-title">
        {track ? <span className="tb-track"><span className="track-pill">{track}</span></span> : null}
        {/* SC-04 UI 框架轮：全局项目选择入口（r2：URL projectId 优先，切换保留非项目参数） */}
        <Suspense fallback={<span className="hint">项目…</span>}>
          <ProjectPicker />
        </Suspense>
      </div>
      <div className="tb-right">
        {/* 演示态隐藏换赛道（避免误触 onboarding → 401 踢出演示） */}
        {!demo && <Link className="btn-ghost" href="/?new=1" title="换赛道：重新调研一个新的赛道">换赛道</Link>}
        <AlertsCenter />
      </div>
    </header>
  );
}

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  // 鉴权门：校验完成前不渲染面板内容——防受保护页闪现，也防子页未登录就发数据请求（401 噪音）
  const [authed, setAuthed] = useState(false);
  // demo 态同样 effect 后注入（hydration 安全）
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    setDemo(isDemoMode());
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    setAuthed(true);
  }, [router]);

  if (!authed) {
    return <div className="logged-in" style={{ display: 'flex', minHeight: '100vh' }} aria-busy="true" />;
  }

  return (
    <ZhibiStateProvider>
      {/* .logged-in：F-07 响应式钩子（≤820px 侧栏转底部标签栏） */}
      {/* 顶部贯穿标题栏 + 下方（侧栏 + 内容区）横向并排 */}
      <div className="logged-in" style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
        <TopBar />
        <div className="logged-in-body">
          <SideNav />
          <div className="app-main">
            <main>{children}</main>
          </div>
        </div>
        {/* F-04 演示模式运行时提示条：数据来自本地 mock，非真实后端（复刻旧版 demoBanner） */}
        {demo && (
          <div className="demo-banner">⚠ <b>演示模式</b> · 数据来自本地 mock（/api/state 契约）· 仅呈现已落地功能</div>
        )}
      </div>
    </ZhibiStateProvider>
  );
}
