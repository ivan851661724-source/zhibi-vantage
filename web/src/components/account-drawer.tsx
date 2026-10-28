'use client';
// 账户抽屉（r4 §十）：账户资料 / 用量与套餐 / 账户安全
// · 用户名可改（持久化）；邮箱默认只读（无验证/换绑流程前不提供修改入口）；
// · 无真实支付能力 → 用量区只说明「额度由系统分配」，不放「充值/升级」按钮；
// · 修改密码：当前密码 + 强度校验 + 确认新密码；限流提示；成功后用返回的新 token 续签；
// · Escape / 点击遮罩关闭；焦点圈禁在抽屉内；375/390/1440 不产生横向滚动。
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clearToken, setToken } from '@/lib/api';
import { changePassword, fetchAccount, updateDisplayName, type AccountView } from '@/lib/core-api';

const ERR_TEXT: Record<string, string> = {
  INVALID_CREDENTIALS: '当前密码不正确。',
  PASSWORD_TOO_SHORT: '新密码至少 8 位。',
  PASSWORD_WEAK: '新密码需同时包含字母和数字。',
  PASSWORD_TOO_LONG: '新密码最长 128 位。',
  CONFIRM_MISMATCH: '两次输入的新密码不一致。',
  RATE_LIMITED: '尝试次数过多，请 15 分钟后再试。',
  NAME_REQUIRED: '请输入用户名。',
  NAME_TOO_LONG: '用户名最长 40 个字符。',
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('zh-CN'); } catch { return String(iso).slice(0, 10); }
}

export function AccountDrawer({ open, onClose, onNameChanged }: { open: boolean; onClose: () => void; onNameChanged?: (name: string) => void }) {
  const [account, setAccount] = useState<AccountView | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [nameMsg, setNameMsg] = useState<string | null>(null);
  const [nameBusy, setNameBusy] = useState(false);
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [cfmPw, setCfmPw] = useState('');
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoadErr(null); setNameMsg(null); setPwMsg(null); setPwErr(null);
    fetchAccount()
      .then((a) => { setAccount(a); setName(a.user.displayName || ''); })
      .catch(() => setLoadErr('账户资料暂时无法加载，请稍后重试。'));
  }, [open]);

  // Escape 关闭 + 简易焦点圈禁（Tab 循环在抽屉内）
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'Tab' && panelRef.current) {
        const els = panelRef.current.querySelectorAll<HTMLElement>('button, input, select, a[href], [tabindex]:not([tabindex="-1"])');
        if (!els.length) return;
        const list = Array.from(els).filter(el => !el.hasAttribute('disabled'));
        const first = list[0], last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    const t = setTimeout(() => {
      const el = panelRef.current?.querySelector<HTMLElement>('input, button');
      if (el) el.focus();
    }, 50);
    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(t);
      if (prev && prev.focus) prev.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  const saveName = async () => {
    if (nameBusy) return;
    setNameBusy(true); setNameMsg(null);
    try {
      const r = await updateDisplayName(name.trim());
      setName(r.user.displayName);
      setNameMsg('已保存。');
      if (onNameChanged) onNameChanged(r.user.displayName);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setNameMsg(/NAME_/.test(msg) ? (ERR_TEXT[msg.trim()] || msg) : '保存失败，请稍后再试。');
    } finally { setNameBusy(false); }
  };

  const submitPw = async () => {
    if (pwBusy) return;
    setPwErr(null); setPwMsg(null);
    if (!curPw || !newPw) { setPwErr('请填写当前密码与新密码。'); return; }
    if (newPw !== cfmPw) { setPwErr(ERR_TEXT.CONFIRM_MISMATCH); return; }
    setPwBusy(true);
    try {
      const r = await changePassword({ currentPassword: curPw, newPassword: newPw, confirmPassword: cfmPw });
      setToken(r.token); // 当前会话续签（其他会话已失效）
      setPwMsg(r.message || '密码已修改。');
      setCurPw(''); setNewPw(''); setCfmPw('');
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const key = Object.keys(ERR_TEXT).find(k => raw.indexOf(k) >= 0);
      setPwErr(key ? ERR_TEXT[key] : '修改失败，请稍后再试。');
    } finally { setPwBusy(false); }
  };

  const logout = () => { clearToken(); window.location.href = '/login'; };

  const usage = account && account.usage ? account.usage : null;
  const remaining = usage ? Math.max(0, usage.dailyDiscover.limit - usage.dailyDiscover.used) : null;

  // r4：经 portal 挂到 body——移动端底栏（fixed + 变换上下文）内的 fixed 抽屉
  // 会被裁剪成一条细条，portal 根治。
  return createPortal(
    <>
      <div className="drawer-mask on" onClick={onClose} />
      <div className="drawer on account-drawer" role="dialog" aria-modal="true" aria-label="账户设置">
        <div className="dr-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="dr-title">账户设置</div>
            <div className="dr-sub">账户资料 · 用量 · 安全</div>
          </div>
          <button className="dr-close" aria-label="关闭" type="button" onClick={onClose}>✕</button>
        </div>
        <div className="dr-body" ref={panelRef}>
          {loadErr ? <p className="core-err">{loadErr}</p> : null}
          {account ? (
            <>
              <div className="sec">
                <div className="sec-h"><span className="n">1</span>账户资料</div>
                <div className="sec-b acc-form">
                  <label className="acc-row">
                    <span className="k">用户名</span>
                    <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-label="用户名" />
                  </label>
                  <div className="acc-acts">
                    <button className="btn-mini" type="button" disabled={nameBusy || !name.trim() || name.trim() === account.user.displayName} onClick={saveName}>
                      {nameBusy ? '保存中…' : '保存用户名'}
                    </button>
                    {nameMsg ? <span className="acc-msg">{nameMsg}</span> : null}
                  </div>
                  <label className="acc-row">
                    <span className="k">邮箱</span>
                    <input value={account.user.email} readOnly aria-label="邮箱（只读）" className="is-readonly" />
                  </label>
                  <p className="hint">邮箱当前不可修改（验证与换绑流程上线前不提供该功能）。</p>
                  <div className="acc-meta">
                    <span>所属团队：{account.tenant.name || '—'}</span>
                    <span>注册时间：{fmtDate(account.user.createdAt)}</span>
                  </div>
                </div>
              </div>

              <div className="sec">
                <div className="sec-h"><span className="n">2</span>用量与套餐</div>
                <div className="sec-b">
                  {usage ? (
                    <div className="acc-meta acc-usage">
                      <span>当前套餐：{usage.plan === 'free' ? '免费版' : usage.plan}</span>
                      <span>今日剩余调研额度：<b>{remaining}</b> / {usage.dailyDiscover.limit}</span>
                      <span>已用：<b>{usage.dailyDiscover.used}</b> 次</span>
                      <span>重置时间：{usage.resetsAtText}</span>
                    </div>
                  ) : (
                    <p className="hint">用量信息暂时不可用。</p>
                  )}
                  <p className="hint">当前额度由系统分配。暂不提供充值或升级入口。</p>
                </div>
              </div>

              <div className="sec">
                <div className="sec-h"><span className="n">3</span>账户安全</div>
                <div className="sec-b acc-form">
                  <label className="acc-row">
                    <span className="k">当前密码</span>
                    <input type="password" value={curPw} autoComplete="current-password" onChange={(e) => setCurPw(e.target.value)} aria-label="当前密码" />
                  </label>
                  <label className="acc-row">
                    <span className="k">新密码</span>
                    <input type="password" value={newPw} autoComplete="new-password" onChange={(e) => setNewPw(e.target.value)} aria-label="新密码" />
                  </label>
                  <p className="hint">至少 8 位，需同时包含字母和数字。</p>
                  <label className="acc-row">
                    <span className="k">确认新密码</span>
                    <input type="password" value={cfmPw} autoComplete="new-password" onChange={(e) => setCfmPw(e.target.value)} aria-label="确认新密码" />
                  </label>
                  {pwErr ? <p className="core-err" role="alert">{pwErr}</p> : null}
                  {pwMsg ? <p className="acc-msg" role="status">{pwMsg}</p> : null}
                  <div className="acc-acts">
                    <button className="btn-mini" type="button" disabled={pwBusy} onClick={submitPw}>
                      {pwBusy ? '提交中…' : '修改密码'}
                    </button>
                    <button className="btn-mini acc-logout" type="button" onClick={logout}>退出登录</button>
                  </div>
                  <p className="hint">修改密码后，其他设备与浏览器会话将自动退出登录。</p>
                </div>
              </div>
            </>
          ) : !loadErr ? (
            <p className="hint">正在加载账户资料…</p>
          ) : null}
        </div>
      </div>
    </>,
    document.body,
  );
}
