/**
 * API client. In server mode it talks to the HTTP API (same origin, session cookie, CSRF header). In the
 * zero-install demo it talks to the same API kernel running inside the page (DemoTransport), so every
 * screen exercises identical authentication, authorization and validation code.
 */

export interface TransportResponse {
  status: number;
  body: unknown;
}

export interface Transport {
  readonly kind: 'http' | 'demo';
  request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<TransportResponse>;
}

export class HttpTransport implements Transport {
  readonly kind = 'http' as const;
  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<TransportResponse> {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { error: { code: 'INTERNAL', message: `Unexpected response (${res.status})` } };
    }
    return { status: res.status, body: parsed };
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let transport: Transport = new HttpTransport();
let csrfToken = '';
const unauthorizedListeners = new Set<() => void>();

export function setTransport(t: Transport): void {
  transport = t;
}

export function transportKind(): 'http' | 'demo' {
  return transport.kind;
}

export function setCsrfToken(token: string): void {
  csrfToken = token;
}

export function onUnauthorized(fn: () => void): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-requested-with': 'bookhand' };
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await transport.request(method, path, method === 'GET' ? undefined : (body ?? {}), headers);
  const b = res.body as { error?: { code: string; message: string; details?: unknown }; csrfToken?: string } | null;
  if (b && typeof b === 'object' && typeof b.csrfToken === 'string') csrfToken = b.csrfToken;
  if (res.status >= 400) {
    const err = b?.error ?? { code: 'INTERNAL', message: `Request failed (${res.status})` };
    if (res.status === 401 && path !== '/api/auth/login' && path !== '/api/auth/mfa') unauthorizedListeners.forEach((fn) => fn());
    throw new ApiError(res.status, err.code, err.message, err.details);
  }
  return res.body as T;
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body?: unknown) => call<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => call<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => call<T>('PATCH', path, body),
  del: <T>(path: string) => call<T>('DELETE', path),
};

export function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
