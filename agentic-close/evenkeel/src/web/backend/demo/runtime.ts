import { invoke, type AppEnv } from '../../../app/methods';
import { loadSkillPackages } from '../../../framework/skills/manifest';
import { setStoreClock } from '../../../framework/store/defaults';
import { AnchoredClock } from '../../../framework/util/clock';
import { isAppError } from '../../../framework/util/errors';
import { AgentEngine } from '../../../packs/accounting/agents/engine';
import { loadScenario } from '../../../packs/accounting/seed/load';
import { SCENARIO } from '../../../packs/accounting/seed/scenario';
import { createMemoryDb } from '../../../packs/accounting/store';

/**
 * The zero-install demo's backend: the real application API (same services, agents, ontology
 * checks and database invariants) on the in-memory store, seeded with the fictional Kitewell
 * Labs scenario. Runs in a Web Worker, or on the page when workers are unavailable.
 */

const SKILL_FILES = import.meta.glob('../../../../skills/**/*.{md,json}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export type DemoRequest = { type: 'personas' } | { type: 'call'; userId: string; method: string; input: unknown };

export interface DemoRuntime {
  handle(req: DemoRequest): Promise<unknown>;
}

export interface SerializedError {
  code: string;
  message: string;
  details: unknown;
}

export function serializeError(e: unknown): SerializedError {
  if (isAppError(e)) return { code: e.code, message: e.message, details: e.details ?? null };
  if (e instanceof Error) return { code: 'INTERNAL', message: e.message, details: null };
  return { code: 'INTERNAL', message: String(e), details: null };
}

export async function createDemoRuntime(progress: (stage: string) => void = () => undefined): Promise<DemoRuntime> {
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(SKILL_FILES)) files[k.replace(/^(\.\.\/)+/, '')] = v;
  const skills = loadSkillPackages(files);
  const db = createMemoryDb();
  const info = await loadScenario(db, { skills, progress });
  const clock = new AnchoredClock(SCENARIO.asOf);
  setStoreClock(clock);
  const engine = new AgentEngine({ db, tenantId: info.tenantId, clock, skills, mode: 'offline' });
  const env: AppEnv = { db, tenantId: info.tenantId, clock, engine, skills, mode: 'demo', backgroundAgents: false };
  progress('Ready');
  return {
    async handle(req) {
      if (req.type === 'personas') {
        const users = await db.find('app_user', { tenant_id: info.tenantId, status: 'active' }, { orderBy: [['display_name', 'asc']] });
        return users.map((u) => ({ id: u.id, email: u.email, name: u.display_name, title: u.title }));
      }
      return invoke(env, { userId: req.userId, ip: null }, req.method, req.input);
    },
  };
}
