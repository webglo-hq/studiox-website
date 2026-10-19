import { useSyncExternalStore } from 'react';

/**
 * Hash routing (#/path/segments?query). Works from any static host, from a file and inside
 * sandboxed iframes, with no server rewrites.
 */
export interface Route {
  path: string[];
  query: URLSearchParams;
  raw: string;
}

function current(): string {
  return typeof window === 'undefined' ? '' : window.location.hash;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [p = '/', q = ''] = raw.split('?');
  return { path: p.split('/').filter(Boolean).map((s) => decodeURIComponent(s)), query: new URLSearchParams(q), raw };
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

let cachedHash: string | null = null;
let cachedRoute: Route = parseHash('');

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, current, () => '');
  if (hash !== cachedHash) {
    cachedHash = hash;
    cachedRoute = parseHash(hash);
  }
  return cachedRoute;
}

export function href(path: string, query?: Record<string, string | number | boolean | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '' && v !== false) q.set(k, String(v));
  const qs = q.toString();
  return `#${path.startsWith('/') ? path : `/${path}`}${qs ? `?${qs}` : ''}`;
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const target = to.startsWith('#') ? to : `#${to}`;
  if (opts.replace) {
    try {
      window.history.replaceState(null, '', target);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      return;
    } catch {
      /* sandboxed contexts may block history; fall back to assignment */
    }
  }
  window.location.hash = target;
}

/** Update one query parameter on the current route. */
export function setQuery(route: Route, key: string, value: string | null): void {
  const q = new URLSearchParams(route.query);
  if (value === null || value === '') q.delete(key);
  else q.set(key, value);
  const qs = q.toString();
  navigate(`#/${route.path.map(encodeURIComponent).join('/')}${qs ? `?${qs}` : ''}`, { replace: true });
}
