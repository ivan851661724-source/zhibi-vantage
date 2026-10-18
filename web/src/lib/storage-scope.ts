'use client';

// This is a browser cache selector only. The server still authenticates every request.
export const SESSION_CHANGED_EVENT = 'zhibi-session-changed';
export interface BrowserSession { token: string; scope: string | null }

export function captureSession(): BrowserSession {
  let token = '';
  try {
    if (typeof window === 'undefined') return { token, scope: null };
    token = window.localStorage.getItem('zhibi_token') || window.localStorage.getItem('ci_token') || '';
    if (token === 'demo-token') return { token, scope: 'demo' };
    const encoded = token.split('.')[1];
    if (!encoded) return { token, scope: null };
    const payload = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof payload.tid !== 'string' || !payload.tid || typeof payload.sub !== 'string' || !payload.sub) return { token, scope: null };
    return { token, scope: 'tenant:' + encodeURIComponent(payload.tid) + ':user:' + encodeURIComponent(payload.sub) };
  } catch { return { token, scope: null }; }
}

export function getStorageScope(): string | null { return captureSession().scope; }
export function isSessionCurrent(session: BrowserSession): boolean {
  const now = captureSession();
  return now.token === session.token && now.scope === session.scope;
}
export function notifySessionChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
}
