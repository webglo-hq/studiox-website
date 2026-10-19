import { HttpBackend } from './http';
import type { Backend } from './types';

/** Server build: the web app talks to the Evenkeel API over HTTP. */
export const BACKEND_MODE: 'server' | 'demo' = 'server';

export async function createBackend(_onProgress: (stage: string) => void): Promise<Backend> {
  return new HttpBackend();
}
