import type { MethodInput, MethodName, MethodOutput } from '../../app/methods';
import { ApiError, type Backend, type SecurityApi, type SessionInfo } from './types';

/** The server backend: JSON over fetch, session cookie (HttpOnly) and a CSRF header. */
export class HttpBackend implements Backend {
  readonly mode = 'server' as const;
  private csrf: string | null = null;
  private readonly listeners = new Set<() => void>();

  async session(): Promise<SessionInfo> {
    const res = await fetch('api/auth/session', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!res.ok) throw new ApiError('NETWORK', `The server answered ${res.status}.`, res.status);
    const json = (await res.json()) as SessionInfo & { csrfToken?: string };
    this.csrf = json.csrfToken ?? null;
    return json;
  }

  async login(email: string, password: string): Promise<{ mfaRequired: boolean }> {
    const json = (await this.post('api/auth/login', { email, password })) as { mfaRequired: boolean; csrfToken?: string };
    this.csrf = json.csrfToken ?? null;
    return { mfaRequired: json.mfaRequired };
  }

  async verifyMfa(code: string): Promise<void> {
    const json = (await this.post('api/auth/mfa', { code })) as { csrfToken?: string };
    this.csrf = json.csrfToken ?? this.csrf;
  }

  async logout(): Promise<void> {
    await this.post('api/auth/logout', {}).catch(() => undefined);
    this.csrf = null;
  }

  async call<K extends MethodName>(method: K, input: MethodInput<K>): Promise<MethodOutput<K>> {
    const json = (await this.post(`api/rpc/${method}`, input ?? {})) as { data: MethodOutput<K> };
    return json.data;
  }

  readonly security: SecurityApi = {
    setupMfa: async () => (await this.post('api/auth/mfa/setup', {})) as { secret: string; otpauthUri: string },
    enableMfa: async (code) => {
      const j = (await this.post('api/auth/mfa/enable', { code })) as { csrfToken?: string };
      this.csrf = j.csrfToken ?? this.csrf;
    },
    disableMfa: async (code) => {
      const j = (await this.post('api/auth/mfa/disable', { code })) as { csrfToken?: string };
      this.csrf = j.csrfToken ?? this.csrf;
    },
    changePassword: async (current, next) => {
      const j = (await this.post('api/auth/password', { current, next })) as { csrfToken?: string };
      this.csrf = j.csrfToken ?? this.csrf;
    },
  };

  onSignedOut(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}) },
        body: JSON.stringify(body ?? {}),
      });
    } catch {
      throw new ApiError('NETWORK', 'Could not reach the Evenkeel server. Check your connection and try again.');
    }
    let json: Record<string, unknown>;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new ApiError('NETWORK', `The server returned an unexpected response (${res.status}).`, res.status);
    }
    if (!res.ok || json.ok === false) {
      const e = (json.error ?? {}) as { code?: string; message?: string; details?: unknown };
      if (res.status === 401 && path.startsWith('api/rpc/')) for (const l of this.listeners) l();
      throw new ApiError(e.code ?? 'ERROR', e.message ?? `Request failed (${res.status}).`, res.status, e.details ?? null);
    }
    return json;
  }
}
