/** Hash router: works from file:// and inside sandboxed iframes (no server rewrites needed). */
import { useEffect, useState } from 'react';

export interface Route {
  path: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [p, q] = raw.split('?');
  return { path: (p ?? '').split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q ?? '') };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function href(path: string, query?: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v) q.set(k, v);
  const s = q.toString();
  return `#/${path.replace(/^\//, '')}${s ? `?${s}` : ''}`;
}

export function navigate(path: string, query?: Record<string, string | null | undefined>) {
  window.location.hash = href(path, query).slice(1);
}

/** Update one query parameter without adding history noise for filters. */
export function setQuery(key: string, value: string | null) {
  const r = parse();
  if (value) r.query.set(key, value);
  else r.query.delete(key);
  const s = r.query.toString();
  window.history.replaceState(null, '', `#/${r.path.map(encodeURIComponent).join('/')}${s ? `?${s}` : ''}`);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}
