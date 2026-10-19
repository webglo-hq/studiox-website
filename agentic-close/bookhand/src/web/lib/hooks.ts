import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, ApiError } from './api';

// ------------------------------------------------------------------ hash router

function readHash(): string {
  const h = window.location.hash.replace(/^#/, '');
  return h || '/';
}

function subscribeHash(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

export interface Route {
  path: string;
  segments: string[];
  query: URLSearchParams;
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribeHash, readHash, () => '/');
  const [path, search] = hash.split('?');
  return { path: path || '/', segments: (path || '/').split('/').filter(Boolean), query: new URLSearchParams(search ?? '') };
}

export function navigate(to: string): void {
  const target = to.startsWith('#') ? to : `#${to}`;
  if (window.location.hash !== target) window.location.hash = target;
}

// ------------------------------------------------------------------ data fetching with invalidation

const listeners = new Set<() => void>();

/** Ask every mounted query to refetch (after a mutation). */
export function invalidate(): void {
  listeners.forEach((fn) => fn());
}

export interface Query<T> {
  data: T | undefined;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

export function useApi<T>(path: string | null, opts: { pollMs?: number } = {}): Query<T> {
  const [state, setState] = useState<{ data: T | undefined; error: ApiError | null; loading: boolean; key: string | null }>({ data: undefined, error: null, loading: !!path, key: path });
  const [tick, setTick] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const fn = () => setTick((t) => t + 1);
    listeners.add(fn);
    return () => {
      mounted.current = false;
      listeners.delete(fn);
    };
  }, []);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, key: path, ...(s.key !== path ? { data: undefined, error: null } : {}) }));
    api
      .get<T>(path)
      .then((data) => {
        if (!cancelled && mounted.current) setState({ data, error: null, loading: false, key: path });
      })
      .catch((e: unknown) => {
        if (!cancelled && mounted.current) setState((s) => ({ ...s, error: e instanceof ApiError ? e : new ApiError(0, 'NETWORK', e instanceof Error ? e.message : 'Network error'), loading: false }));
      });
    return () => {
      cancelled = true;
    };
  }, [path, tick]);
  useEffect(() => {
    if (!opts.pollMs || !path) return;
    const t = setInterval(() => setTick((x) => x + 1), opts.pollMs);
    return () => clearInterval(t);
  }, [opts.pollMs, path]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data: state.key === path ? state.data : undefined, error: state.error, loading: state.loading, reload };
}

// ------------------------------------------------------------------ toasts

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
}

export interface ToastApi {
  toasts: Toast[];
  push(message: string, tone?: Toast['tone']): void;
  dismiss(id: number): void;
}

export const ToastContext = createContext<ToastApi>({ toasts: [], push: () => undefined, dismiss: () => undefined });

export function useToasts(): ToastApi {
  return useContext(ToastContext);
}

export function useToastState(): ToastApi {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (message: string, tone: Toast['tone'] = 'info') => {
      const id = ++idRef.current;
      setToasts((t) => [...t.slice(-3), { id, message, tone }]);
      setTimeout(() => dismiss(id), tone === 'error' ? 8000 : 4500);
    },
    [dismiss],
  );
  return { toasts, push, dismiss };
}

/** Run a mutation with toast feedback and global invalidation. */
export function useAction() {
  const toasts = useToasts();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T>(fn: () => Promise<T>, success?: string | ((r: T) => string)): Promise<T | undefined> => {
      setBusy(true);
      try {
        const r = await fn();
        if (success) toasts.push(typeof success === 'function' ? success(r) : success);
        invalidate();
        return r;
      } catch (e) {
        toasts.push(e instanceof Error ? e.message : String(e), 'error');
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toasts],
  );
  return { run, busy };
}

// ------------------------------------------------------------------ session

export interface Me {
  user: { id: string; name: string; email: string; title: string | null; hue: number; mfaEnabled: boolean };
  roles: Array<{ key: string; name: string; entity: string | null }>;
  permissions: string[];
  approvalLimit: number | null;
  readOnly: boolean;
  tenant: { id: string; name: string; reportingCurrency: string; isDemo: boolean; businessDate: string } | null;
  csrfToken: string;
  mode: { app: 'server' | 'demo'; live: boolean; model: string | null };
}

export const SessionContext = createContext<{ me: Me | null; refresh: () => Promise<void>; signOut: () => Promise<void> }>({ me: null, refresh: async () => undefined, signOut: async () => undefined });

export function useMe(): Me {
  const { me } = useContext(SessionContext);
  if (!me) throw new Error('useMe outside a signed-in session');
  return me;
}

export function useCan(): (permission: string) => boolean {
  const { me } = useContext(SessionContext);
  return (p: string) => !!me?.permissions.includes(p);
}

// ------------------------------------------------------------------ safe storage (sandboxed iframes may throw)

export const storage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* storage unavailable: preference lasts for this page only */
    }
  },
};

// ------------------------------------------------------------------ keyboard shortcuts

export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, enabled = true): void {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    let prefix = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = prefix ? `${prefix} ${e.key}` : e.key;
      if (ref.current[key]) {
        e.preventDefault();
        prefix = '';
        ref.current[key]!(e);
        return;
      }
      if (e.key === 'g') {
        prefix = 'g';
        clearTimeout(timer);
        timer = setTimeout(() => (prefix = ''), 1200);
      } else prefix = '';
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      clearTimeout(timer);
    };
  }, [enabled]);
}
