/**
 * A fetch() that calls the Hono app in-process with a private cookie jar — how the zero-install
 * demo (and the HTTP integration tests) talk to the real API without a network.
 *
 * Browsers treat Cookie/Origin (requests) and Set-Cookie (responses) as forbidden headers on
 * script-built Request/Response objects and silently drop them, so the session also travels in
 * the `x-tieout-session` header, which the server honours only when created with
 * `cookieBridge: true` (the in-page demo, where there is no network boundary to protect).
 */
export interface FetchLikeApp {
  fetch(request: Request): Response | Promise<Response>;
}

const SESSION = 'tieout_session';
const BRIDGE = 'x-tieout-session';

export function inPageFetch(app: FetchLikeApp, origin = 'https://demo.tieout.local') {
  const jar = new Map<string, string>();
  return async function fetchInPage(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const url = typeof input === 'string' ? new URL(input, origin) : input instanceof URL ? input : new URL(input.url);
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const session = jar.get(SESSION);
    if (session) headers.set(BRIDGE, session);
    if (init.method && init.method !== 'GET') headers.set('origin', origin);
    const res = await app.fetch(new Request(new URL(url.pathname + url.search, origin), { ...init, headers }));
    const bridged = res.headers.get(BRIDGE);
    if (bridged !== null) {
      if (bridged) jar.set(SESSION, bridged);
      else jar.delete(SESSION);
    }
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = c.split(';');
      const [k, ...v] = pair!.split('=');
      const expired = attrs.some((a) => /max-age=0/i.test(a) || /expires=thu, 01 jan 1970/i.test(a));
      if (expired || v.join('=') === '') jar.delete(k!.trim());
      else jar.set(k!.trim(), v.join('='));
    }
    return res;
  };
}
