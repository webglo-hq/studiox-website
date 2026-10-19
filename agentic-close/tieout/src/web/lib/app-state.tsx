/** Session, preferences (theme), toasts and a small data-loading hook. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, setCsrf, type Me } from '../api';

// ------------------------------------------------------------------ storage (sandbox-safe)
export function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(`tieout.${key}`);
  } catch {
    return null;
  }
}
export function writePref(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(`tieout.${key}`);
    else window.localStorage.setItem(`tieout.${key}`, value);
  } catch {
    /* storage unavailable (private mode / sandboxed iframe): preferences just don't persist */
  }
}

// ------------------------------------------------------------------ theme
export type Theme = 'system' | 'light' | 'dark';
export function applyTheme(t: Theme) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

// ------------------------------------------------------------------ toasts
export interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'bad';
}

interface AppState {
  me: Me | null;
  loading: boolean;
  mfaPending: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  period: string;
  setPeriod: (p: string) => void;
  entityId: string | null;
  setEntityId: (id: string | null) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  toasts: Toast[];
  toast: (text: string, tone?: Toast['tone']) => void;
  dismiss: (id: number) => void;
  version: number;
  bump: () => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [mfaPending, setMfaPending] = useState(false);
  const [period, setPeriodState] = useState<string>(() => readPref('period') ?? '2026-09');
  const [entityId, setEntityState] = useState<string | null>(() => readPref('entity'));
  const [theme, setThemeState] = useState<Theme>(() => (readPref('theme') as Theme | null) ?? 'system');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [version, setVersion] = useState(0);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const r = await api<Me & { mfa?: 'pending'; csrfToken: string | null }>('/auth/me');
      if (r.mfa === 'pending') {
        setCsrf(r.csrfToken);
        setMfaPending(true);
        setMe(null);
      } else {
        setCsrf(r.csrfToken);
        setMfaPending(false);
        setMe(r);
        if (r.tenant.activeCloseKey && !readPref('period')) setPeriodState(r.tenant.activeCloseKey);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setMe(null);
        setMfaPending(!!(e.details as { mfa?: string }).mfa);
      } else throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => applyTheme(theme), [theme]);

  const toast = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'bad' ? 9000 : 5000);
  }, []);

  const value = useMemo<AppState>(
    () => ({
      me,
      loading,
      mfaPending,
      refresh,
      logout: async () => {
        await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
        setCsrf(null);
        setMe(null);
      },
      period,
      setPeriod: (p) => {
        setPeriodState(p);
        writePref('period', p);
      },
      entityId,
      setEntityId: (id) => {
        setEntityState(id);
        writePref('entity', id);
      },
      theme,
      setTheme: (t) => {
        setThemeState(t);
        writePref('theme', t === 'system' ? null : t);
      },
      toasts,
      toast,
      dismiss: (id) => setToasts((t) => t.filter((x) => x.id !== id)),
      version,
      bump: () => setVersion((v) => v + 1),
    }),
    [me, loading, mfaPending, refresh, period, entityId, theme, toasts, toast, version],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

export function useMe(): Me {
  const { me } = useApp();
  if (!me) throw new Error('not signed in');
  return me;
}

export function can(me: Me | null, permission: string): boolean {
  return !!me && me.user.permissions.includes(permission);
}

/**
 * Load data for a screen. Refetching keeps the previous data on screen (dimmed by the caller)
 * instead of flashing a skeleton. Reloads when `deps` or the global data version change.
 */
export function useData<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: Error | null; loading: boolean; reload: () => void } {
  const { version } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    load()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are supplied by the caller
  }, [...deps, version, nonce]);
  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}
