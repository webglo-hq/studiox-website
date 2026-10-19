import { DemoBackend } from './demo/client';
import type { Backend } from './types';

/** Demo build: the whole application runs in the browser (worker, or the page as a fallback). */
export const BACKEND_MODE: 'server' | 'demo' = 'demo';

export async function createBackend(onProgress: (stage: string) => void): Promise<Backend> {
  return DemoBackend.start(onProgress);
}
