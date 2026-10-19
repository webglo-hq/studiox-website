import type { AppEnv } from '../../src/app/methods';
import { setStoreClock } from '../../src/framework/store/defaults';
import { ManualClock } from '../../src/framework/util/clock';
import { AgentEngine, type EngineOptions } from '../../src/packs/accounting/agents/engine';
import { loadScenario, type ScenarioInfo } from '../../src/packs/accounting/seed/load';
import { SCENARIO, USERS, type UserKey } from '../../src/packs/accounting/seed/scenario';
import { createMemoryDb, type EkDb } from '../../src/packs/accounting/store';
import { hashPassword } from '../../src/server/auth/password';
import { loadSkillsFromDisk } from '../../src/server/skills-fs';

/** The fictional Kitewell Labs scenario on the in-memory store, with a controllable clock. */
export interface Scenario {
  db: EkDb;
  info: ScenarioInfo;
  clock: ManualClock;
  engine: AgentEngine;
  env: AppEnv;
  user(k: UserKey): string;
}

export const TEST_PASSWORD = 'kitewell-test-password';

export async function loadTestScenario(opts: { passwords?: boolean; db?: EkDb; engine?: Partial<EngineOptions> } = {}): Promise<Scenario> {
  const db = opts.db ?? createMemoryDb();
  const skills = loadSkillsFromDisk();
  let passwordHashes: Partial<Record<UserKey, string>> | undefined;
  if (opts.passwords) {
    const hash = await hashPassword(TEST_PASSWORD);
    passwordHashes = Object.fromEntries(USERS.map((u) => [u.key, hash])) as Record<UserKey, string>;
  }
  const info = await loadScenario(db, { skills, passwordHashes });
  const clock = new ManualClock(SCENARIO.asOf);
  setStoreClock(clock);
  const engine = new AgentEngine({ db, tenantId: info.tenantId, clock, skills, ...opts.engine });
  const env: AppEnv = { db, tenantId: info.tenantId, clock, engine, skills, mode: 'server', backgroundAgents: false };
  return { db, info, clock, engine, env, user: (k) => info.users[k] };
}
