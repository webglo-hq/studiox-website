import { createContext, useContext, type ReactNode } from 'react';
import type { SessionInfo } from '../backend/types';

export interface SessionApi {
  info: SessionInfo & { authenticated: true; user: NonNullable<SessionInfo['user']> };
  can(permission: string): boolean;
  refresh(): Promise<void>;
  signOut(): Promise<void>;
}

const SessionContext = createContext<SessionApi | null>(null);

export function SessionProvider({ value, children }: { value: SessionApi; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionApi {
  const s = useContext(SessionContext);
  if (!s) throw new Error('SessionProvider missing');
  return s;
}

export function makeCan(permissions: string[]): (p: string) => boolean {
  const set = new Set(permissions);
  return (p) => set.has('*') || set.has(p);
}
