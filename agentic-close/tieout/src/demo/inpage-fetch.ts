/**
 * A fetch() that calls the Hono app in-process with a private cookie jar — how the zero-install
 * demo (and the HTTP integration tests) talk to the real API without a network.
 */
export interface FetchLikeApp {
  fetch(request: Request): Response | Promise<Response>;
}

export function inPageFetch(app: FetchLikeApp, origin = 'https://demo.tieout.local') {
  const jar = new Map<string, string>();
  return async function fetchInPage(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const url = typeof input === 'string' ? new URL(input, origin) : input instanceof URL ? input : new URL(input.url);
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    if (init.method && init.method !== 'GET') headers.set('origin', origin);
    const res = await app.fetch(new Request(new URL(url.pathname + url.search, origin), { ...init, headers }));
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
