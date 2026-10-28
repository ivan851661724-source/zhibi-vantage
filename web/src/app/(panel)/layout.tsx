'use client';
// 面板组布局（docs/architecture/01_前端架构规范.md §4）
// 复刻 index.html：side-nav（logo + DAILY OPS/INTELLIGENCE/SYSTEM 三组导航 + 用户区）+ topbar。
// 徽章：navRivals = competitors.length（对齐 app.js updateWbBadges L1665-1666）；
//       navPending = 未决策材料数（三动作 localStorage 记录属 Phase 2 工作台，暂以材料总数展示）。
import { Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { clearToken, getToken } from '@/lib/api';
import { ZhibiStateProvider, useZhibiState } from '@/hooks/use-zhibi-state';
import { wbLoad } from '@/lib/wb';
import { isDemoMode } from '@/lib/demo';
import { AlertsCenter } from '@/components/alerts-center';
import { ProjectPicker } from '@/components/core-ui';
import { AccountDrawer, type AccSection } from '@/components/account-drawer';
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
// 移动端底部栏「账户」入口（§三.7：固定文字，不显示截断用户名；点击打开账户抽屉）
function MobileAccountButton() {
  const [drawer, setDrawer] = useState(false);
  return (
    <>
      <button type="button" className="side-account" aria-haspopup="dialog" onClick={() => setDrawer(true)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="8" r="3.4" /><path d="M5 20c1.2-3.4 4-5 7-5s5.8 1.6 7 5" strokeLinecap="round" /></svg>
        <span>账户</span>
      </button>
      <AccountDrawer open={drawer} onClose={() => setDrawer(false)} />
    </>
  );
}

// ---------------- r4g §三：侧栏账户入口（常见 SaaS 模式） ----------------
// 整行：头像 + displayName + 邮箱次级文字 + 设置齿轮；点击在入口上方弹出菜单
//（账户设置 / 用量与套餐 / 修改密码 / 退出登录），菜单项打开同一账户抽屉（无第二套设置页）。
function UserRow() {
  const [acc, setAcc] = useState<{ name: string; email: string } | null>(null);
  const [menu, setMenu] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [focusSection, setFocusSection] = useState<AccSection | undefined>(undefined);
  const [confirmOut, setConfirmOut] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  useEffect(() => {
    let alive = true;
    fetchAccount()
      .then((a) => { if (alive) setAcc({ name: a.user.displayName || '', email: a.user.email || '' }); })
      .catch(() => { if (alive) setAcc(null); });
    return () => { alive = false; };
  }, [menu, drawer]);
  const shown = acc && acc.name.trim() ? acc.name.trim() : '已登录';
  const initial = shown !== '已登录' ? shown.slice(0, 1).toUpperCase() : 'V';
  const openSection = (sec: AccSection) => { setMenu(false); setFocusSection(sec); setDrawer(true); };
  return (
    <div className="user-row" style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        type="button"
        className="user-row-btn"
        aria-haspopup="menu"
        aria-expanded={menu}
        title={acc ? (shown + ' · ' + acc.email) : '账户菜单'}
        onClick={() => {
          const r = btnRef.current ? btnRef.current.getBoundingClientRect() : null;
          setAnchor(r ? { left: Math.max(8, Math.min(r.left, (window.innerWidth || 1440) - 246)), bottom: (window.innerHeight || 900) - r.top + 8 } : null);
          setMenu((v) => !v);
        }}
      >
        <div className="avatar">{initial}</div>
        <div className="uinfo">
          <div className="un">{shown}</div>
          <div className="ue">{acc ? acc.email : '已登录'}</div>
        </div>
        <svg className="gear" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {menu ? (
        <AccountMenu
          anchor={anchor}
          onSection={openSection}
          onLogout={() => { setMenu(false); setConfirmOut(true); }}
          onClose={() => setMenu(false)}
        />
      ) : null}
      {confirmOut ? (
        <LogoutConfirm
          onCancel={() => setConfirmOut(false)}
          onOk={() => { clearToken(); window.location.href = '/login'; }}
        />
      ) : null}
      <AccountDrawer open={drawer} onClose={() => setDrawer(false)} onNameChanged={(n) => setAcc((a) => a ? { ...a, name: n } : a)} focusSection={focusSection} />
    </div>
  );
}

// 入口上方弹出的账户菜单（portal 到 body，Escape/遮罩关闭）
function AccountMenu({ anchor, onSection, onLogout, onClose }: {
  anchor: { left: number; bottom: number } | null;
  onSection: (s: AccSection) => void;
  onLogout: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const item = (label: string, hint: string, act: () => void, k: string) => (
    <button key={k} type="button" className="accmenu-item" onClick={act}>
      <span>{label}</span>
      <span className="accmenu-hint">{hint}</span>
    </button>
  );
  return createPortal(
    <>
      <div className="accmenu-mask" onClick={onClose} />
      <div className="accmenu" ref={ref} role="menu" aria-label="账户菜单"
        style={anchor ? { left: anchor.left, bottom: anchor.bottom } : undefined}>
        {item('账户设置', '资料与团队', () => onSection('profile'), 'a')}
        {item('用量与套餐', '当前额度', () => onSection('usage'), 'b')}
        {item('修改密码', '账户安全', () => onSection('security'), 'c')}
        <div className="accmenu-sep" />
        <button type="button" className="accmenu-item is-danger" onClick={onLogout}>
          <span>退出登录</span>
        </button>
      </div>
    </>,
    document.body,
  );
}

// 退出确认（防误触）：小对话框，明确两次操作
function LogoutConfirm({ onOk, onCancel }: { onOk: () => void; onCancel: () => void }) {
  return createPortal(
    <div className="accmenu-mask" onClick={onCancel} style={{ zIndex: 1200 }}>
      <div className="acc-confirm" role="alertdialog" aria-label="退出登录确认" onClick={(e) => e.stopPropagation()}>
        <p>确定要退出登录吗？</p>
        <div className="acc-confirm-acts">
          <button type="button" className="btn-mini" onClick={onCancel}>取消</button>
          <button type="button" className="btn-mini acc-logout" onClick={onOk}>退出</button>
        </div>
      </div>
    </div>,
    document.body,
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
