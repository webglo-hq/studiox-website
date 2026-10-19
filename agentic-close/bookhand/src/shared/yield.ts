/**
 * Give the event loop a turn. Embedded databases (PGlite in the server, the in-memory engine in the browser
 * demo) resolve queries without real I/O, so a long agent run would otherwise be one unbroken chain of
 * microtasks: HTTP requests (server) or rendering (browser) would wait until the run finished. The runtime
 * yields before every tool call, which keeps the API and the UI responsive while agents work.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    const g = globalThis as { setImmediate?: (fn: () => void) => unknown; MessageChannel?: typeof MessageChannel };
    if (typeof g.setImmediate === 'function') {
      g.setImmediate(resolve);
      return;
    }
    if (typeof g.MessageChannel === 'function') {
      const channel = new g.MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
      return;
    }
    setTimeout(resolve, 0);
  });
}
