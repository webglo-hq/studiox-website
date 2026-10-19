import { describe, expect, it } from 'vitest';
import { MAX_RESUMES, SimulatedCrash, STALE_MS } from '../../src/agents/framework/runtime';
import { ApiKernel } from '../../src/api/kernel';
import { ROUTES } from '../../src/api/routes';
import { App, type AppConfig } from '../../src/app/app';
import { registerSkills } from '../../src/packs/accounting/pack';
import { seedScenario, type SeedResult } from '../../src/packs/accounting/seed/loader';
import { MemoryDb } from '../../src/persistence/memory';
import { configurePasswordHashing, DEMO_SCRYPT } from '../../src/security/passwords';
import { Client, DEMO_PASSWORD } from './api-client';

configurePasswordHashing({ params: DEMO_SCRYPT });

const CONFIG: AppConfig = { mode: 'demo', secretKey: 'test'.repeat(8), sessionIdleMinutes: 30, sessionAbsoluteHours: 12, secureCookies: false, demoPassword: DEMO_PASSWORD };

/**
 * A process that dies while the close agents run, and a new process started two seconds later (the reviewer's
 * scenario): the runs' heartbeats are still fresh at its start-up, so nothing is resumed then.
 */
async function crashAndRestart() {
  const db = new MemoryDb();
  let skew = 0;
  const clock = { now: () => new Date(Date.now() + skew).toISOString() };
  let crashed = false;
  const first = new App(db, CONFIG, {
    businessDate: '2026-10-02',
    clock,
    faultInjector: (e) => {
      if (!crashed && e.tool === 'propose_transaction_coding' && e.callNumber > 20) {
        crashed = true;
        throw new SimulatedCrash();
      }
    },
  });
  const seed: SeedResult = await seedScenario(db, { extend: async (tx, ctx) => void (await registerSkills(tx, ctx.tenantId, first.runtime.listSkills(), ctx.clock.now())) });
  const email = (key: string) => seed.logins.find((l) => l.key === key)!.email;
  const maya1 = new Client(new ApiKernel(first, ROUTES), '10.9.0.1');
  await maya1.login(email('maya'));
  const started = await maya1.ok<{ runId: string }>('POST', `/api/closes/${seed.closeId}/run`, {});
  await first.queue.idle();
  expect(crashed).toBe(true);
  const open = await db.read((tx) => tx.find('agent_runs', { status: { in: ['running', 'queued'] } }));
  expect(open.map((r) => r.skill_key).sort()).toEqual(['close-orchestrator', 'transaction-coding']);

  skew += 2_000;
  const second = new App(db, CONFIG, { businessDate: '2026-10-02', clock });
  const boot = await second.maintain();
  const maya = new Client(new ApiKernel(second, ROUTES), '10.9.0.2');
  await maya.login(email('maya'));
  return { db, second, seed, maya, boot, orchestratorId: started.runId, advance: (ms: number) => void (skew += ms) };
}

describe('crash recovery (BH-M3)', () => {
  it('BH-M3: the periodic maintenance takes over a run whose worker died, without a second restart', async () => {
    const { db, second, seed, maya, boot, orchestratorId, advance } = await crashAndRestart();
    expect(boot.resumed).toEqual([]);
    // Within the lease the run may still be alive elsewhere: the button reports it, and nothing duplicates it.
    expect(await maya.ok('POST', `/api/closes/${seed.closeId}/run`, {})).toMatchObject({ runId: orchestratorId, alreadyRunning: true });
    advance(STALE_MS);
    const tick = await second.maintain();
    expect(tick.resumed).toEqual([orchestratorId]); // its interrupted child is resumed in place by the orchestrator
    await second.queue.idle();
    expect(await db.read((tx) => tx.get('agent_runs', orchestratorId))).toMatchObject({ status: 'completed', resume_count: 1 });
    expect(await db.read((tx) => tx.count('agent_runs', { status: { in: ['running', 'queued'] } }))).toBe(0);
    const coding = await db.read((tx) => tx.find('agent_runs', { parent_run_id: orchestratorId, skill_key: 'transaction-coding' }));
    expect(coding.find((r) => r.resume_count === 1)?.status).toBe('completed');
    expect((await maya.ok<{ alreadyRunning: boolean }>('POST', `/api/closes/${seed.closeId}/run`, {})).alreadyRunning).toBe(false);
  }, 240_000);

  it('BH-M3: "Run close agents" takes over an abandoned orchestrator at once', async () => {
    const { db, second, seed, maya, orchestratorId, advance } = await crashAndRestart();
    advance(STALE_MS);
    expect(await maya.ok('POST', `/api/closes/${seed.closeId}/run`, {})).toMatchObject({ runId: orchestratorId, alreadyRunning: true, resumed: true });
    await second.queue.idle();
    expect((await db.read((tx) => tx.get('agent_runs', orchestratorId)))?.status).toBe('completed');
  }, 240_000);

  it('BH-M3: a run interrupted too often is failed, not resumed forever, and the close agents start afresh', async () => {
    const { db, second, seed, maya, orchestratorId, advance } = await crashAndRestart();
    await db.tx((tx) => tx.update('agent_runs', orchestratorId, { resume_count: MAX_RESUMES }));
    advance(STALE_MS);
    await second.maintain();
    await second.queue.idle();
    const failed = await db.read((tx) => tx.get('agent_runs', orchestratorId));
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed?.error).toMatch(/Interrupted \d+ times/);
    // Its interrupted child no longer has a live parent, so it is taken over on its own.
    await second.maintain();
    await second.queue.idle();
    expect(await db.read((tx) => tx.count('agent_runs', { status: { in: ['running', 'queued'] } }))).toBe(0);
    const again = await maya.ok<{ runId: string; alreadyRunning: boolean }>('POST', `/api/closes/${seed.closeId}/run`, {});
    expect(again.alreadyRunning).toBe(false);
    expect(again.runId).not.toBe(orchestratorId);
  }, 240_000);
});
