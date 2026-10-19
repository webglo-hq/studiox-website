import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { changePolicy } from '../../src/agents/framework/policy';
import { App } from '../../src/app/app';
import { registerSkills } from '../../src/packs/accounting/pack';
import { SKILL_FILES } from '../../src/packs/accounting/skills/bundle.generated';
import { seedScenario, type SeedResult } from '../../src/packs/accounting/seed/loader';
import { SCENARIO } from '../../src/packs/accounting/seed/scenario';
import { MemoryDb } from '../../src/persistence/memory';
import { configurePasswordHashing, DEMO_SCRYPT } from '../../src/security/passwords';

/**
 * Skill evals. Every skill ships evals.json next to its SKILL.md: cases run the skill's offline engine on the
 * "september-close" fixture (the seeded fictional company with planted issues), each on its own fork of the
 * database, and assert what the agent must find, how the policy disposes it, and what it must not invent.
 */

configurePasswordHashing({ params: DEMO_SCRYPT });

const ProposalExpect = z
  .object({
    title: z.string(),
    kind: z.string().optional(),
    status: z.string().optional(),
    riskFlags: z.array(z.string()).optional(),
    amountMinor: z.number().int().optional(),
  })
  .strict();

const EvalFile = z
  .object({
    skill: z.string(),
    fixture: z.literal('september-close'),
    cases: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9-]+$/),
            description: z.string().min(10),
            fixture: z.literal('september-close'),
            as: z.string().optional(),
            policy: z.object({ autonomy: z.enum(['L0', 'L1', 'L2', 'L3']).optional(), rulesText: z.string().optional(), thresholds: z.record(z.string(), z.number()).optional() }).strict().optional(),
            input: z.record(z.string(), z.unknown()),
            expect: z
              .object({
                status: z.enum(['completed', 'failed', 'budget_exceeded']),
                summary: z.string().optional(),
                proposals: z.array(ProposalExpect).optional(),
                absent: z.array(z.string()).optional(),
                counts: z.partialRecord(z.enum(['total', 'pending', 'blocked', 'autoApplied', 'minAutoApplied', 'minPending']), z.number().int()).optional(),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const CONFIG = { mode: 'demo' as const, secretKey: 'test'.repeat(8), sessionIdleMinutes: 30, sessionAbsoluteHours: 12, secureCookies: false };

const suites = SKILL_FILES.filter((f) => f.evals).map((f) => ({ key: f.key, file: EvalFile.parse(JSON.parse(f.evals!)) }));

describe('skill evals', () => {
  it('every agentic skill ships eval fixtures', () => {
    const missing = SKILL_FILES.filter((f) => !f.evals && !f.skillMd.includes('execution: deterministic')).map((f) => f.key);
    expect(missing).toEqual([]);
    for (const s of suites) expect(s.file.skill).toBe(s.key);
  });
});

let base: MemoryDb;
let seed: SeedResult;

beforeAll(async () => {
  base = new MemoryDb();
  const probe = new App(base, CONFIG, { businessDate: SCENARIO.businessDate });
  seed = await seedScenario(base, { extend: (tx, ctx) => registerSkills(tx, ctx.tenantId, probe.runtime.listSkills(), ctx.clock.now()).then(() => undefined) });
}, 120_000);

for (const suite of suites) {
  describe(`${suite.key}`, () => {
    for (const c of suite.file.cases) {
      it(`${c.id}: ${c.description}`, async () => {
        const db = await base.fork();
        const app = new App(db, CONFIG, { businessDate: SCENARIO.businessDate });
        const userId = seed.dataset.ids.users[c.as ?? 'hannah']!;
        const tasks = await db.read((tx) => tx.find('close_tasks', { close_id: seed.closeId }));
        const entities = await db.read((tx) => tx.find('entities', { tenant_id: seed.tenantId }));
        const resolve = (v: unknown): unknown => {
          if (typeof v !== 'string') return v;
          if (v === '$closeId') return seed.closeId;
          if (v === '$period') return '2026-09';
          const m = /^\$task:([a-z-]+):(.+)$/.exec(v);
          if (m) {
            const entity = m[2] === '*' ? null : entities.find((e) => e.code === m[2])?.id;
            const task = tasks.find((t) => t.key === m[1] && (entity === null ? true : t.entity_id === entity));
            if (!task) throw new Error(`eval ${c.id}: no task ${v}`);
            return task.id;
          }
          return v;
        };
        const input = Object.fromEntries(Object.entries(c.input).map(([k, v]) => [k, resolve(v)]));
        const task = tasks.find((t) => t.id === input.closeTaskId);
        if (c.policy) {
          const manifest = app.runtime.skill(suite.key).pkg.manifest;
          await db.tx((tx) => changePolicy(tx, { db, tenantId: seed.tenantId, actor: { type: 'user', userId, label: 'eval' }, clock: app.clock }, manifest, { ...c.policy, reason: `eval ${c.id}` }, app.runtime.deps.pack.compileRules));
        }
        const periodId = task?.entity_id ? (await db.read((tx) => tx.findOne('periods', { entity_id: task.entity_id!, fiscal_year: 2026, period_number: 9 })))?.id ?? null : null;
        const run = await app.runtime.start(seed.tenantId, { skillKey: suite.key, input, requestedBy: userId, requestedByLabel: 'Skill eval', closeId: seed.closeId, closeTaskId: task?.id ?? null, entityId: task?.entity_id ?? null, periodId, mode: 'offline' });
        const done = await app.runtime.execute(run.id);
        const props = await db.read((tx) => tx.find('proposals', { run_id: run.id }));
        const describeAll = () => props.map((p) => `[${p.kind}/${p.status}${p.risk_flags.length ? `/${p.risk_flags.join(',')}` : ''}] ${p.title}`).join('\n');

        expect(done.status, `${done.error ?? ''}`).toBe(c.expect.status);
        if (c.expect.summary) expect(done.summary ?? '').toMatch(new RegExp(c.expect.summary));
        for (const want of c.expect.proposals ?? []) {
          const re = new RegExp(want.title);
          const hit = props.find((p) => re.test(p.title) && (!want.kind || p.kind === want.kind) && (!want.status || p.status === want.status) && (!want.amountMinor || p.amount_minor === want.amountMinor) && (want.riskFlags ?? []).every((f) => p.risk_flags.includes(f)));
          expect(hit, `expected a proposal ${JSON.stringify(want)} among:\n${describeAll()}`).toBeTruthy();
        }
        for (const pattern of c.expect.absent ?? []) {
          const re = new RegExp(pattern);
          expect(props.filter((p) => re.test(p.title)).map((p) => p.title), `must not propose /${pattern}/`).toEqual([]);
        }
        const counts = { total: props.length, pending: props.filter((p) => p.status === 'pending').length, blocked: props.filter((p) => p.status === 'blocked').length, autoApplied: props.filter((p) => p.status === 'auto_applied').length };
        for (const [k, v] of Object.entries(c.expect.counts ?? {})) {
          if (k === 'minAutoApplied') expect(counts.autoApplied).toBeGreaterThanOrEqual(v);
          else if (k === 'minPending') expect(counts.pending).toBeGreaterThanOrEqual(v);
          else expect(counts[k as keyof typeof counts], `${k}:\n${describeAll()}`).toBe(v);
        }
      }, 120_000);
    }
  });
}
