// 登录页（Phase 0 功能版；Phase 1 对齐设计稿 #authScreen 视觉）
// 契约：docs/02-API契约.md §2.1 —— 注册字段为 { email, password, name }（name=品牌/工作区名）。
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { login, register, setToken } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [brand, setBrand] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
        </div>
      </div>
    </main>
  );
}
