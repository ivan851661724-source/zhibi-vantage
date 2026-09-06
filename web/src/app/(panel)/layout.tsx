'use client';
// 面板组布局（docs/01-前端架构规范.md §4）
// 复刻 index.html：side-nav（logo + DAILY OPS/INTELLIGENCE/SYSTEM 三组导航 + 用户区）+ topbar。
// 徽章：navRivals = competitors.length（对齐 app.js updateWbBadges L1665-1666）；
//       navPending = 未决策材料数（三动作 localStorage 记录属 Phase 2 工作台，暂以材料总数展示）。
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { clearToken, getToken } from '@/lib/api';
import { ZhibiStateProvider, useZhibiState } from '@/hooks/use-zhibi-state';
import { wbLoad } from '@/lib/wb';

const NAV_GROUPS: {
  sec: string;
  items: { href: string; label: string; icon: React.ReactNode }[];
}[] = [
  {
    sec: 'DAILY OPS · 日常',
    items: [
      {
        href: '/',
        label: '工作台',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 5h18v14H3zM3 9h18" /><path d="M7 13h4M7 16h4" /></svg>
        ),
      },
      {
        href: '/radar',
        label: '竞品雷达',
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
        href: '/intel',
        label: '情报库',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 20V9l8-5 8 5v11" /><path d="M9 20v-6h6v6M9 11h.01M15 11h.01M12 11h.01" strokeLinecap="round" /></svg>
        ),
      },
      {
        href: '/opportunity',
        label: '机会视图',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></svg>
        ),
      },
      {
        href: '/sector',
        label: '赛道档案',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 4h16v16H4zM4 9h16M9 4v16" strokeLinecap="round" /></svg>
        ),
      },
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
      {
        href: '/settings',
        label: '设置',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56h.08a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03z" /></svg>
        ),
      },
    ],
  },
];

const PANEL_TITLES: Record<string, string> = {
  '/': '工作台',
  '/radar': '竞品雷达',
  '/intel': '情报库',
  '/opportunity': '机会视图',
  '/sector': '赛道档案',
  '/history': '历史调研',
  '/assets': '算法资产',
  '/settings': '设置',
};

function SideNav() {
  const pathname = usePathname();
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
      <div className="side-logo">
        <svg viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="13" stroke="#33B98C" strokeWidth="2.4" /><circle cx="16" cy="16" r="8" stroke="#33B98C" strokeWidth="1.4" opacity="0.5" /><circle cx="16" cy="16" r="3.2" fill="#33B98C" /><line x1="16" y1="1" x2="16" y2="7" stroke="#33B98C" strokeWidth="1.6" /><line x1="16" y1="25" x2="16" y2="31" stroke="#33B98C" strokeWidth="1.6" /><line x1="1" y1="16" x2="7" y2="16" stroke="#33B98C" strokeWidth="1.6" /><line x1="25" y1="16" x2="31" y2="16" stroke="#33B98C" strokeWidth="1.6" /><circle cx="27.5" cy="16" r="2.1" fill="#D9A25C" /></svg>
        <div><div className="bn">知彼 Vantage</div><div className="sub">竞品信号雷达</div></div>
      </div>
      {NAV_GROUPS.map((g) => (
        <div key={g.sec}>
          <div className="nav-sec">{g.sec}</div>
          {g.items.map((it) => {
            const active = pathname === it.href;
            return (
              <Link key={it.href} href={it.href} className={'nav-item' + (active ? ' active' : '')}>
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
      <div className="side-foot">
        <div className="plan-pill"><span className="dot"></span><span id="planStatus">雷达运行中</span></div>
        <UserRow />
      </div>
    </nav>
  );
}

function UserRow() {
  const router = useRouter();
  return (
    <div className="user-row">
      <div className="avatar">V</div>
      <div className="uinfo"><div className="un">知彼用户</div><div className="ue">已登录</div></div>
      <button
        className="logout"
        type="button"
        onClick={() => {
          clearToken();
          router.replace('/login');
        }}
      >
        退出
      </button>
    </div>
  );
}

function TopBar() {
  const pathname = usePathname();
  const { state } = useZhibiState();
  const track = state && typeof state.track === 'string' ? state.track : '';
  return (
    <header className="topbar">
      <div className="tb-title">
        <span>知彼 Vantage</span>
        <span className="crumb">/ {PANEL_TITLES[pathname] || ''}</span>
        {track ? <span className="tb-track"><span className="track-pill">{track}</span></span> : null}
      </div>
      <div className="tb-right">
        <Link className="btn-ghost" href="/?new=1" title="换赛道：重新调研一个新的赛道">换赛道</Link>
      </div>
    </header>
  );
}

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  // 鉴权门：未登录访问面板 → 跳 /login（Phase 1 验收项）
  useEffect(() => {
    if (!getToken()) router.replace('/login');
  }, [router]);

  return (
    <ZhibiStateProvider>
      <div style={{ display: 'flex', minHeight: '100vh' }}>
        <SideNav />
        <div className="app-main">
          <TopBar />
          <main>{children}</main>
        </div>
      </div>
    </ZhibiStateProvider>
  );
}
