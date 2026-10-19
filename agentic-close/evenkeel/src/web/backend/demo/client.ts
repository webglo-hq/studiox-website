import type { MethodInput, MethodName, MethodOutput } from '../../../app/methods';
import { safeStorage } from '../../storage';
import { ApiError, type Backend, type Persona, type SessionInfo } from '../types';
import { createDemoRuntime, serializeError, type DemoRequest, type SerializedError } from './runtime';
import DemoWorker from './worker?worker&inline';

/**
 * Demo backend client. Prefers a Web Worker (the page stays responsive while agents run);
 * falls back to running on the page when workers are blocked, e.g. inside a sandboxed
 * iframe. No network calls are made either way.
 */

interface Transport {
  readonly kind: 'worker' | 'page';
  request(req: DemoRequest): Promise<unknown>;
}

type Reply = { id: number; ok: true; data: unknown } | { id: number; ok: false; error: SerializedError } | { progress: string };

class WorkerTransport implements Transport {
  readonly kind = 'worker' as const;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  constructor(
    private readonly worker: Worker,
    onProgress: (stage: string) => void,
  ) {
    worker.onmessage = (e: MessageEvent<Reply>) => {
      const m = e.data;
      if ('progress' in m) return onProgress(m.progress);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.data);
      else p.reject(new ApiError(m.error.code, m.error.message, 0, m.error.details));
    };
    worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new ApiError('INTERNAL', e.message || 'The demo worker stopped.'));
      this.pending.clear();
    };
  }

  send(req: unknown, timeoutMs = 0): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (timeoutMs) {
        setTimeout(() => {
          if (this.pending.delete(id)) reject(new ApiError('TIMEOUT', 'The demo worker did not answer.'));
        }, timeoutMs);
      }
      this.worker.postMessage({ id, req });
    });
  }

  request(req: DemoRequest): Promise<unknown> {
    return this.send(req);
  }
}

class PageTransport implements Transport {
  readonly kind = 'page' as const;
  constructor(private readonly runtime: { handle(req: DemoRequest): Promise<unknown> }, private readonly serialize: (e: unknown) => SerializedError) {}
  async request(req: DemoRequest): Promise<unknown> {
    try {
      // Structured-clone semantics, like the worker path, so screens never share mutable state.
      return structuredClone(await this.runtime.handle(req));
    } catch (e) {
      const s = this.serialize(e);
      throw new ApiError(s.code, s.message, 0, s.details);
    }
  }
}

const nextFrame = () => new Promise<void>((r) => setTimeout(r, 30));

async function startWorker(onProgress: (stage: string) => void): Promise<Transport | null> {
  if (typeof Worker === 'undefined') return null;
  let worker: Worker;
  try {
    worker = new DemoWorker();
  } catch {
    return null;
  }
  const t = new WorkerTransport(worker, onProgress);
  try {
    await t.send({ type: 'ping' }, 4000);
    await t.send({ type: 'boot' });
    return t;
  } catch {
    worker.terminate();
    return null;
  }
}

async function startOnPage(onProgress: (stage: string) => void): Promise<Transport> {
  onProgress('Starting on this page (background workers are not available here)');
  await nextFrame();
  const rt = await createDemoRuntime(onProgress);
  return new PageTransport(rt, serializeError);
}

const USER_KEY = 'evenkeel.demo.user';

export class DemoBackend implements Backend {
  readonly mode = 'demo' as const;
  readonly security = null;
  private personasCache: (Persona & { id: string })[] | null = null;
  private userId: string | null = safeStorage.get('session', USER_KEY);

  private constructor(readonly transport: Transport) {}

  static async start(onProgress: (stage: string) => void): Promise<DemoBackend> {
    const t = (await startWorker(onProgress)) ?? (await startOnPage(onProgress));
    return new DemoBackend(t);
  }

  private async personas(): Promise<(Persona & { id: string })[]> {
    this.personasCache ??= (await this.transport.request({ type: 'personas' })) as (Persona & { id: string })[];
    return this.personasCache;
  }

  async session(): Promise<SessionInfo> {
    const personas = await this.personas();
    const base = { mode: 'demo' as const, personas, providers: [], engine: 'offline' as const, liveAvailable: false };
    if (this.userId) {
      try {
        const user = await this.call('session.me', {});
        return { ...base, authenticated: true, mfaRequired: false, user };
      } catch {
        this.setUser(null);
      }
    }
    return { ...base, authenticated: false };
  }

  async login(email: string): Promise<{ mfaRequired: boolean }> {
    const p = (await this.personas()).find((x) => x.email === email.trim().toLowerCase());
    if (!p) throw new ApiError('UNAUTHENTICATED', 'Pick one of the demo people.');
    this.setUser(p.id);
    return { mfaRequired: false };
  }

  async verifyMfa(): Promise<void> {
    throw new ApiError('VALIDATION', 'Two-step sign-in is not used in the demo.');
  }

  async logout(): Promise<void> {
    this.setUser(null);
  }

  async call<K extends MethodName>(method: K, input: MethodInput<K>): Promise<MethodOutput<K>> {
    if (!this.userId) throw new ApiError('UNAUTHENTICATED', 'Pick a person to continue.', 401);
    return (await this.transport.request({ type: 'call', userId: this.userId, method, input: input ?? {} })) as MethodOutput<K>;
  }

  onSignedOut(): () => void {
    return () => undefined;
  }

  private setUser(id: string | null): void {
    this.userId = id;
    if (id) safeStorage.set('session', USER_KEY, id);
    else safeStorage.remove('session', USER_KEY);
  }
}
