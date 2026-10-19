/**
 * Browser storage that never throws. Sandboxed iframes, private modes and strict privacy
 * settings can make localStorage/sessionStorage throw on access; the app must still work.
 */
type Area = 'local' | 'session';

const memory: Record<Area, Map<string, string>> = { local: new Map(), session: new Map() };

function area(a: Area): Storage | null {
  try {
    const s = a === 'local' ? window.localStorage : window.sessionStorage;
    const probe = '__evenkeel_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export const safeStorage = {
  get(a: Area, key: string): string | null {
    try {
      const s = area(a);
      return s ? s.getItem(key) : (memory[a].get(key) ?? null);
    } catch {
      return memory[a].get(key) ?? null;
    }
  },
  set(a: Area, key: string, value: string): void {
    try {
      const s = area(a);
      if (s) s.setItem(key, value);
      else memory[a].set(key, value);
    } catch {
      memory[a].set(key, value);
    }
  },
  remove(a: Area, key: string): void {
    try {
      area(a)?.removeItem(key);
    } catch {
      /* ignore */
    }
    memory[a].delete(key);
  },
};
