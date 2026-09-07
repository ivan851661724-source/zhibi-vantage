'use client';
// 管理面板（PRD R5.4：源健康状态进管理面板）
// 平台超管专用（与租户面板分离，不复用 (panel) 布局/租户 token）：
//   · 登录：POST /api/admin/login（{key} 或 {username,password}），token 存 sessionStorage（12h 后端时效）
//   · 源健康：GET /api/admin/source-health（各 provider ok/fail/healthy/exhausted + Serper 池）
//   · 全局总览：GET /api/admin/overview（租户数/配额/计费汇总）
import { useCallback, useEffect, useState } from 'react';

const ADMIN_TOKEN_KEY = 'zhibi_admin_token';

interface ProviderStat {
  ok: number; fail: number; healthy: boolean; exhausted: boolean;
  lastFailAt: number | null; lastErr: string | null;
}
interface SourceHealth {
  providers: Record<string, ProviderStat>;
  serper: { keys: number; disabled: number };
}
interface Overview {
  global?: { tenantCount: number; suspended: number; totalBilledSearchCalls: number };
  tenants?: { id: string; name: string; email: string; plan: string; status: string; projects: number; billed: { search_calls: number; enrich_runs: number } }[];
}

async function adminGet<T>(url: string, token: string): Promise<T> {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return (await r.json()) as T;
}

export default function AdminPage() {
  const [token, setToken] = useState('');
  const [loggedIn, setLoggedIn] = useState(false);
  const [key, setKey] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<SourceHealth | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadErr, setLoadErr] = useState('');

  const loadData = useCallback(async (t: string) => {
    setLoadErr('');
    try {
      const [h, o] = await Promise.all([
        adminGet<SourceHealth>('/api/admin/source-health', t),
        adminGet<Overview>('/api/admin/overview', t),
      ]);
      setHealth(h);
      setOverview(o);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    const t = sessionStorage.getItem(ADMIN_TOKEN_KEY) || '';
    if (t) { setToken(t); setLoggedIn(true); void loadData(t); }
  }, [loadData]);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const body = username ? { username, password } : { key };
      const r = await fetch('/api/admin/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = (await r.json()) as { token?: string; error?: string };
      if (!r.ok || !j.token) { setErr(j.error || '登录失败'); return; }
      sessionStorage.setItem(ADMIN_TOKEN_KEY, j.token);
      setToken(j.token);
      setLoggedIn(true);
      await loadData(j.token);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    setToken('');
    setLoggedIn(false);
    setHealth(null);
    setOverview(null);
  }

  if (!loggedIn) {
    return (
      <main className="admin-page">
        <div className="auth-card">
          <p className="auth-tagline">平台管理面板 · 超管凭证登录</p>
          <form className="auth-form" onSubmit={login}>
            <div className="auth-field">
              <label className="field-label">单密钥（MT_ADMIN_SECRET / .admin-secret）</label>
              <input className="text-input" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="留空则用下方账号登录" />
            </div>
            <div className="auth-field">
              <label className="field-label">账号（多账号模式，可选）</label>
              <input className="text-input" type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" />
              <input className="text-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" />
            </div>
            <button className="btn-primary auth-submit" type="submit" disabled={busy}>{busy ? '登录中…' : '登录管理面板'}</button>
            {err && <p className="auth-error">{err}</p>}
          </form>
        </div>
      </main>
    );
  }

  const providers = health ? Object.entries(health.providers) : [];
  return (
    <main className="admin-page">
      <div className="admin-head">
        <h2 className="report-title">平台管理面板</h2>
        <button className="btn-ghost" type="button" onClick={logout}>退出</button>
      </div>
      {loadErr && <p className="hint">⚠ 加载失败：{loadErr}</p>}

      <section className="admin-sec">
        <h3>搜索源健康（R5.4）</h3>
        {!health && <p className="hint">加载中…</p>}
        {health && (
          <table className="md-table">
            <thead><tr><th>源</th><th>状态</th><th>成功/失败</th><th>最近失败</th></tr></thead>
            <tbody>
              {providers.map(([name, s]) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td>{s.exhausted ? <span className="badge-warn">额度耗尽（10 分钟后重试）</span> : s.healthy ? <span className="badge-ok">健康</span> : <span className="badge-warn">不健康</span>}</td>
                  <td>{s.ok}/{s.fail}</td>
                  <td>{s.lastErr ? s.lastErr.slice(0, 60) : '—'}</td>
                </tr>
              ))}
              <tr>
                <td>serper 池</td>
                <td>{health.serper.keys - health.serper.disabled}/{health.serper.keys} 个 key 可用</td>
                <td>—</td>
                <td>{health.serper.disabled ? health.serper.disabled + ' 个已标记失效/耗尽' : '—'}</td>
              </tr>
            </tbody>
          </table>
        )}
      </section>

      <section className="admin-sec">
        <h3>全局总览</h3>
        {overview && overview.global && (
          <p className="hint">
            租户 {overview.global.tenantCount} 个（暂停 {overview.global.suspended}）· 平台累计计费搜索 {overview.global.totalBilledSearchCalls} 次
          </p>
        )}
        {overview && overview.tenants && (
          <table className="md-table">
            <thead><tr><th>租户</th><th>档位</th><th>状态</th><th>项目</th><th>计费（搜索/深研）</th></tr></thead>
            <tbody>
              {overview.tenants.map((t) => (
                <tr key={t.id}>
                  <td>{t.name || t.email || t.id}</td>
                  <td>{t.plan}</td>
                  <td>{t.status === 'suspended' ? <span className="badge-warn">已暂停</span> : '正常'}</td>
                  <td>{t.projects}</td>
                  <td>{t.billed.search_calls}/{t.billed.enrich_runs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
