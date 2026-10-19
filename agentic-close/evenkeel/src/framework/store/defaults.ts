import type { Clock } from '../util/clock';
import { SystemClock } from '../util/clock';
import { systemIds, type IdGenerator } from '../util/ids';

/**
 * Process-wide providers for column defaults (ids and timestamps). The application sets the
 * business clock at start-up so that rows created during the seeded scenario carry scenario
 * time; seeds swap in a deterministic id generator.
 */
let clock: Clock = new SystemClock();
let ids: IdGenerator = systemIds;

export function setStoreClock(c: Clock): void {
  clock = c;
}

export function setIdGenerator(g: IdGenerator): void {
  ids = g;
}

export function storeClock(): Clock {
  return clock;
}

export function currentIdGenerator(): IdGenerator {
  return ids;
}

export function newId(): string {
  return ids.next();
}

export function nowIso(): string {
  return clock.nowIso();
}
