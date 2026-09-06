// 知彼 Vantage · API 契约层（docs/02-API契约.md 的实现）
// 纪律：前端所有数据入口必须经本文件，禁止组件内裸写 fetch。
// 行为对齐：app.js 的 api()/apiAdmin()（token 注入 / JSON 解析 / 错误上抛携带 status）。
'use client';

const TOKEN_KEY = 'zhibi_token';
const LEGACY_TOKEN_KEY = 'ci_token'; // 兼容旧前端（行为等价，防老用户被登出）

export function getToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(TOKEN_KEY) || window.localStorage.getItem(LEGACY_TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
    window.localStorage.removeItem(LEGACY_TOKEN_KEY); // 统一到新键，旧键清掉
  } catch {
    /* localStorage 不可用时静默（隐私模式等） */
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    /* 同上 */
  }
}

/** 后端错误模型（docs/02 §1.3）：{ error: 机器码, message: 人类可读 } */
export interface ApiErrorBody {
  error?: string;
  message?: string;
}

export class ApiError extends Error {
  status: number;
  body: ApiErrorBody | null;

  constructor(status: number, url: string, body: ApiErrorBody | null) {
    // 错误文案口径对齐旧版 api()（app.js L292）：message 优先，其次 error 机器码，最后 HTTP 状态
    super((body && (body.message || body.error)) || 'HTTP ' + status + ' @ ' + url);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** 统一请求封装：注入 Bearer token；401 清 token 跳登录；错误抛 ApiError */
async function request<T>(url: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...((opts.headers as Record<string, string>) || {}),
  };
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;

  const res = await fetch(url, { ...opts, headers });

  if (!res.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      body = null;
    }
    // 401 仅在鉴权失败时清 token 跳登录。注意后端业务错误也可能用 401
    // （如 discover 的 NO_KEYS——密钥未配置，docs/02-API契约.md），不能误杀会话。
    const code = body && body.error;
    if (res.status === 401 && (code === 'AUTH_REQUIRED' || code === 'ADMIN_AUTH_REQUIRED' || !code)) {
      clearToken();
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    throw new ApiError(res.status, url, body);
  }
  return (await res.json()) as T;
}

export function apiGet<T>(url: string): Promise<T> {
  return request<T>(url);
}

export function apiPost<T>(url: string, body?: unknown): Promise<T> {
  return request<T>(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
}

// ---------- 账号（public，docs/02 §2.1） ----------

export interface AuthResponse {
  token: string;
  user: { id: string; email?: string; name?: string } & Record<string, unknown>;
  tenantId: string;
}

export function login(email: string, password: string): Promise<AuthResponse> {
  return apiPost<AuthResponse>('/api/login', { email, password });
}

export function register(email: string, password: string, name: string): Promise<AuthResponse> {
  return apiPost<AuthResponse>('/api/register', { email, password, name });
}

// ---------- 系统（public，docs/02 §2.2） ----------

export function getVersion(): Promise<{ version?: string } & Record<string, unknown>> {
  return apiGet<{ version?: string }>('/api/version');
}
