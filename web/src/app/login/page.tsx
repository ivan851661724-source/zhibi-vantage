// 登录页（Phase 0 功能版；Phase 1 对齐设计稿 #authScreen 视觉）
// 契约：docs/02-API契约.md §2.1 —— 注册字段为 { email, password, name }（name=品牌/工作区名）。
// F-04 演示模式闸门：URL 带 ?demo=1 → 查 GET /api/public-config（ZB_DEMO_ALLOWED=1 才放行）
//   · 放行：写 demo-token + sessionStorage 标记 → 进面板（mock state）
//   · 拦截：显示「演示模式未启用」屏（复刻旧版 #demoBlocked）
'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getPublicConfig, login, register, setToken } from '@/lib/api';
import { enterDemo, DEMO_TOKEN, markDemoSource } from '@/lib/demo';

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [brand, setBrand] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // F-04 演示闸门：'checking' 检查中（避免闪烁）| 'blocked' 未启用 | null 常规登录
  const [demoBlocked, setDemoBlocked] = useState<boolean | 'checking' | null>(null);
  const [exampleHint, setExampleHint] = useState('');

  const demoWanted = searchParams.get('demo') === '1';

  useEffect(() => {
    if (!demoWanted) return;
    let alive = true;
    setDemoBlocked('checking');
    getPublicConfig()
      .then((cfg) => {
        if (!alive) return;
        if (cfg && cfg.demoAllowed) {
          setToken(DEMO_TOKEN);
          enterDemo();
          router.replace('/');
        } else {
          setDemoBlocked(true); // 生产未开 ZB_DEMO_ALLOWED：拦截直进
        }
      })
      .catch(() => {
        // fail-closed（安全闸门反模式修复）：闸门查询失败 = 无法证明演示模式已启用，
        // 一律拦截。不再"查询失败按放行"（那等于后端宕机/被拦截时演示门常开）。
        if (!alive) return;
        setDemoBlocked(true);
      });
    return () => {
      alive = false;
    };
  }, [demoWanted, router]);

  // R7.2：先看个例子——加载一次真实赛道调研数据（服务端 ZB_DEMO_ALLOWED 闸门内；
  // data/sample/sample-state.json 未导入时提示，绝不喂 mock 冒充真实数据）
  async function onExample() {
    setExampleHint('');
    try {
      const cfg = await getPublicConfig();
      if (!cfg || !cfg.demoAllowed) {
        setExampleHint('示例入口未启用（需服务端设置 ZB_DEMO_ALLOWED=1 并导入示例数据）');
        return;
      }
      const r = await fetch('/api/sample');
      if (!r.ok) {
        setExampleHint('示例数据未导入（data/sample/sample-state.json）');
        return;
      }
      markDemoSource('sample');
      setToken(DEMO_TOKEN);
      enterDemo();
      router.replace('/');
    } catch {
      setExampleHint('示例暂不可用，请稍后再试');
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!email || !password) {
      setError('请填写邮箱与密码');
      return;
    }
    if (mode === 'register' && !brand.trim()) {
      setError('注册时请填写品牌 / 工作区名称');
      return;
    }
    setBusy(true);
    try {
      const res = mode === 'login'
        ? await login(email.trim(), password)
        : await register(email.trim(), password, brand.trim());
      setToken(res.token);
      router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : '请求失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  // F-04 演示模式禁用屏（复刻旧版 #demoBlocked 结构）
  if (demoBlocked === true) {
    return (
      <main className="demo-blocked">
        <div className="db-card">
          <div className="bn">知彼 Vantage</div>
          <h2>演示模式未启用</h2>
          <p className="db-sub">
            当前部署未开启演示入口（<code>?demo=1</code>）。如需 1:1 验收，请在服务端设置环境变量{' '}
            <code>ZB_DEMO_ALLOWED=1</code> 后重试。
          </p>
          <button
            className="btn-primary"
            type="button"
            onClick={() => {
              setDemoBlocked(null);
              router.replace('/login');
            }}
          >
            返回登录
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-screen">
      <div className="auth-wrap">
        <div className="auth-brand">
          <div className="bst">
            <span className="bn">知彼 Vantage</span>
            <span className="bs">COMPETITOR SIGNAL INTELLIGENCE</span>
          </div>
        </div>
        <div className="auth-card">
          <p className="auth-tagline">
            你盯着的对手一有动作——<b>降价 · 上新 · 开新店 · 差评暴涨</b>，它替你整理成一份能直接看的材料。
          </p>
          <div className="auth-tabs" id="authTabs">
            <button
              id="authTabLogin"
              className={'auth-tab' + (mode === 'login' ? ' active' : '')}
              type="button"
              onClick={() => { setMode('login'); setError(''); }}
            >
              登录
            </button>
            <button
              id="authTabRegister"
              className={'auth-tab' + (mode === 'register' ? ' active' : '')}
              type="button"
              onClick={() => { setMode('register'); setError(''); }}
            >
              注册
            </button>
          </div>
          <form id="authForm" className="auth-form" onSubmit={onSubmit}>
            {mode === 'register' && (
              <div id="authBrandField" className="auth-field">
                <label className="field-label" htmlFor="authBrand">品牌 / 工作区名称</label>
                <input
                  id="authBrand"
                  className="text-input"
                  type="text"
                  placeholder="你的品牌名（注册时必填）"
                  autoComplete="organization"
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                />
              </div>
            )}
            <div className="auth-field">
              <label className="field-label" htmlFor="authEmail">邮箱</label>
              <input
                id="authEmail"
                className="text-input"
                type="email"
                placeholder="you@brand.com"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="auth-field">
              <label className="field-label" htmlFor="authPassword">密码</label>
              <input
                id="authPassword"
                className="text-input"
                type="password"
                placeholder="至少 8 位"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <button id="authSubmit" className="btn-primary auth-submit" type="submit" disabled={busy}>
              {busy ? '请求中…' : mode === 'login' ? '进入雷达台 →' : '创建工作区 →'}
            </button>
            <p id="authError" className="auth-error">{error}</p>
          </form>
          <p className="auth-foot">注册即创建你的独立工作区，数据与其他租户隔离。</p>
          <div className="auth-example">
            <button className="btn-ghost" type="button" onClick={onExample}>先看个例子 →</button>
            {exampleHint && <p className="hint">{exampleHint}</p>}
          </div>
        </div>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="auth-screen" />}>
      <LoginPageInner />
    </Suspense>
  );
}
