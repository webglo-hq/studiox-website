import type { Db } from '../persistence/db';

/** Who is acting. Agents always act on behalf of an accountable requester (or the system orchestrator). */
export interface Actor {
  type: 'user' | 'agent' | 'system';
  userId: string | null;
  label: string;
  runId?: string;
  roleKeys?: string[];
  requestId?: string;
  ip?: string;
}

export interface Clock {
  /** Real wall-clock time (security, sessions, audit timestamps). */
  now(): string;
  /** Accounting business date for the close calendar (may be a scenario date). */
  businessDate(): string;
}

export function systemClock(businessDate?: () => string): Clock {
  return {
    now: () => new Date().toISOString(),
    businessDate: businessDate ?? (() => new Date().toISOString().slice(0, 10)),
  };
}

export function fixedClock(nowIso: string, businessDate: string): Clock {
  return { now: () => nowIso, businessDate: () => businessDate };
}

/** Everything a domain operation needs besides its transaction. */
export interface DomainContext {
  db: Db;
  tenantId: string;
  actor: Actor;
  clock: Clock;
}

export const SYSTEM_ACTOR: Actor = { type: 'system', userId: null, label: 'Bookhand system' };
