import { createDemoRuntime, serializeError, type DemoRequest, type DemoRuntime } from './runtime';

/** Demo backend worker: boots the in-memory Evenkeel and answers requests from the page. */

type Incoming = { id: number; req: DemoRequest | { type: 'boot' } | { type: 'ping' } };
const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent<Incoming>) => void) | null };

let runtime: Promise<DemoRuntime> | null = null;

scope.onmessage = (event) => {
  void respond(event.data);
};

async function respond({ id, req }: Incoming): Promise<void> {
  try {
    if (req.type === 'ping') {
      scope.postMessage({ id, ok: true, data: 'pong' });
      return;
    }
    if (req.type === 'boot') {
      runtime ??= createDemoRuntime((stage) => scope.postMessage({ progress: stage }));
      await runtime;
      scope.postMessage({ id, ok: true, data: null });
      return;
    }
    if (!runtime) throw new Error('The demo is still starting.');
    const rt = await runtime;
    const data = await rt.handle(req);
    scope.postMessage({ id, ok: true, data });
  } catch (e) {
    scope.postMessage({ id, ok: false, error: serializeError(e) });
  }
}
