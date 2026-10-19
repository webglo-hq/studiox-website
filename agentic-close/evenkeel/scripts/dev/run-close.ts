/* Developer tool: run the whole close in memory (the same path as the evals and the PostgreSQL integration test), approving as the right people, and list every proposal. `--lock` continues to the locked period. */
import { runFullClose } from '../../src/packs/accounting/evals/close-run';
import { loadSkillsFromDisk } from '../../src/server/skills-fs';

const t0 = Date.now();
const r = await runFullClose({ skills: loadSkillsFromDisk(), through: process.argv.includes('--lock') ? 'lock' : 'proposals', log: (s) => console.log(s) });
for (const p of r.proposals) {
  const pl = p.payload as Record<string, unknown>;
  const extra = [pl.itemType, pl.category, pl.entryType, pl.treatment, pl.matchType, pl.comparison].filter(Boolean).join(',');
  console.log(`${p.skill_id.padEnd(28)} ${p.kind.padEnd(18)} ${p.status.padEnd(12)} ${String(p.amount ?? '').padStart(10)} ${extra.padEnd(28)} ${p.title.slice(0, 110)}`);
}
console.log('rounds', r.rounds, 'locked', r.locked, r.lockFailures, 'audit', r.auditOk, r.auditChecked, 'ms', Date.now() - t0);
console.log('issues', r.issues.map((i) => `${i.severity}:${i.category}:${i.status}`).join(' '));
