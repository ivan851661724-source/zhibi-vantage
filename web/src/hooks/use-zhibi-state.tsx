'use client';
// REST is authoritative; SSE only invalidates it. See architecture/01 §5 and baseline §30–31.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { connectStream, type SseEvent } from '@/lib/sse';
import { isDemoMode, buildDemoState, getDemoSource } from '@/lib/demo';
import { wbHydrateFromServer, WB_MUTATION_EVENT } from '@/lib/wb';
import { captureSession, isSessionCurrent, SESSION_CHANGED_EVENT } from '@/lib/storage-scope';
import { createStateRefresh, stateSignature } from '@/lib/state-refresh';
import type { ZhibiState } from '@/types/state';
import { createStateOwnership, type StateOperation } from '@/lib/state-ownership';

interface ZhibiStateContextValue {
  state: ZhibiState | null;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
  patch: (next: ZhibiState, operation: StateOperation) => boolean;
  captureOperation: (projectId: string | null, alive: () => boolean) => StateOperation;
  switchProject: (projectId: string, alive: () => boolean) => Promise<boolean>;
  subscribe: (fn: (evt: SseEvent) => void) => () => void;
}
const ZhibiStateContext = createContext<ZhibiStateContextValue | null>(null);

export function ZhibiStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ZhibiState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sessionRevision, setSessionRevision] = useState(0);
  const signature = useRef('');
  const stateOwner = useRef<string | null>(null);
  const workerRef = useRef<ReturnType<typeof createStateRefresh<ZhibiState>> | null>(null);
  const listeners = useRef(new Set<(evt: SseEvent) => void>());
  const ownership = useRef(createStateOwnership());
  const providerAlive = useRef(true);
  const switches = useRef<Promise<unknown>>(Promise.resolve());
  const refresh = useCallback(() => workerRef.current?.request() || Promise.resolve(), []);
  const subscribe = useCallback((fn: (evt: SseEvent) => void) => {
    listeners.current.add(fn);
    return () => { listeners.current.delete(fn); };
  }, []);

  const publish = useCallback((raw: ZhibiState) => {
    const sig = stateSignature(raw);
    if (sig !== signature.current) {
      signature.current = sig;
      setState(raw);
    }
  }, []);
  const apply = useCallback((next: ZhibiState) => {
    ownership.current.adopt(typeof next.projectId === 'string' ? next.projectId : null);
    wbHydrateFromServer(next.decisions, typeof next.projectId === 'string' ? next.projectId : null);
    publish(next);
  }, [publish]);
  const patch = useCallback((next: ZhibiState, operation: StateOperation) => {
    if (!providerAlive.current || !operation.isCurrent() || (next.projectId || null) !== operation.projectId) return false;
    workerRef.current?.invalidate();
    if (operation.kind === 'switch') {
      apply(next);
    } else {
      // Local responses can contain an older whole-project snapshot, even in the same project.
      // Reconcile private corrections server-side against latest source data too; do not replay
      // old field objects or duplicate correction/quarantine policy in the browser.
      void workerRef.current?.request();
    }
    return true;
  }, [apply]);
  const captureOperation = useCallback((projectId: string | null, alive: () => boolean) => ownership.current.capture(projectId, () => providerAlive.current && alive()), []);
  const switchProject = useCallback((projectId: string, alive: () => boolean) => {
    const session = captureSession();
    const operation = ownership.current.beginSwitch(projectId, () => providerAlive.current && alive());
    workerRef.current?.invalidate();
    // Preserve server pointer ordering too: a later switch is dispatched after the old one returns.
    const task = switches.current.catch(() => {}).then(async () => {
      if (!operation.isCurrent()) return false;
      try {
        const next = await apiPost<ZhibiState>('/api/projects/switch', { id: projectId });
        return patch(next, operation);
      } finally {
        // An issued switch can change the server pointer even after its caller unmounts.
        // Recover the still-mounted Provider without permitting the old consumer to patch/navigate.
        if (providerAlive.current && isSessionCurrent(session)) {
          workerRef.current?.invalidate();
          void workerRef.current?.request();
        }
      }
    });
    switches.current = task;
    return task;
  }, [patch]);

  useEffect(() => {
    const invalidated = () => {
      workerRef.current?.invalidate();
      void workerRef.current?.request();
    };
    window.addEventListener(WB_MUTATION_EVENT, invalidated);
    return () => window.removeEventListener(WB_MUTATION_EVENT, invalidated);
  }, []);

  useEffect(() => {
    const changed = () => {
      ownership.current.reset();
      workerRef.current?.close();
      workerRef.current = null;
      // Hide the old account immediately, before effects establish the new subscription.
      setState(null);
      signature.current = '';
      setSessionRevision(v => v + 1);
    };
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === 'zhibi_token' || event.key === 'ci_token') changed();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(SESSION_CHANGED_EVENT, changed);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(SESSION_CHANGED_EVENT, changed);
    };
  }, []);

  useEffect(() => {
    providerAlive.current = true;
    const owner = ownership.current;
    const session = captureSession();
    let alive = true;
    const current = () => alive && isSessionCurrent(session);
    if (stateOwner.current !== session.scope) {
      setState(null);
      signature.current = '';
    }
    stateOwner.current = session.scope;
    setLoading(true);
    setError('');
    if (isDemoMode()) {
      const load = getDemoSource() === 'sample'
        ? apiGet<ZhibiState>('/api/sample').catch(() => buildDemoState())
        : buildDemoState();
      void load.then(next => {
        if (!current()) return;
        apply(next as ZhibiState);
        setLoading(false);
      }).catch(() => {
        if (current()) { setError('示例暂时无法读取，请重试。'); setLoading(false); }
      });
      return () => { alive = false; };
    }
    if (!session.token) {
      setLoading(false);
      return () => { alive = false; };
    }
    const worker = createStateRefresh<ZhibiState>({
      read: () => apiGet<ZhibiState>('/api/state?private_view=1'),
      apply,
      onError: failure => setError(failure ? '最新资料暂时无法读取。已显示的资料可能不是最新，请重试。' : ''),
      onSettled: () => setLoading(false),
      isCurrent: current,
    });
    workerRef.current = worker;
    void worker.request();
    const stream = connectStream({
      onEvent: evt => {
        if (!current()) return;
        for (const fn of listeners.current) {
          try { fn(evt); } catch { /* One subscriber must not prevent REST recovery. */ }
        }
      },
      onChange: () => { if (current()) void worker.request(); },
    });
    return () => {
      alive = false;
      providerAlive.current = false;
      owner.reset();
      worker.close();
      stream.close();
      if (workerRef.current === worker) workerRef.current = null;
    };
  }, [apply, sessionRevision]);

  const value = useMemo(() => ({ state, loading, error, refresh, patch, captureOperation, switchProject, subscribe }), [state, loading, error, refresh, patch, captureOperation, switchProject, subscribe]);
  return (
    <ZhibiStateContext.Provider value={value}>
      {error && <div className="hint" role="alert">{error} <button className="link-btn" type="button" onClick={() => void refresh()}>重试读取</button></div>}
      {children}
    </ZhibiStateContext.Provider>
  );
}

export function useZhibiState(): ZhibiStateContextValue {
  const ctx = useContext(ZhibiStateContext);
  if (!ctx) throw new Error('useZhibiState 必须在 ZhibiStateProvider 内使用（面板路由应位于 (panel)/ 布局下）');
  return ctx;
}

/** Every async local consumer captures both the rendered project and its mounted lifetime. */
export function useStateOperation() {
  const { state, captureOperation } = useZhibiState();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const projectId = typeof state?.projectId === 'string' ? state.projectId : null;
  return useCallback(() => captureOperation(projectId, () => alive.current), [captureOperation, projectId]);
}
