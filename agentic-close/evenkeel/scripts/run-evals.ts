/*
 * `npm run evals`: run every skill's evaluation cases against a full close of the planted
 * Kitewell Labs scenario (deterministic offline engine) and fail if any case fails.
 * Writes evals-report.json (gitignored) with per-case results.
 */
import { writeFileSync } from 'node:fs';
import { runSkillEvals } from '../src/packs/accounting/evals/run';
import { fromRoot } from '../src/server/paths';
import { loadSkillsFromDisk } from '../src/server/skills-fs';

const report = await runSkillEvals(loadSkillsFromDisk());
for (const r of report.skills) {
  console.log(`${r.passed === r.total ? 'PASS' : 'FAIL'}  ${r.skill.padEnd(28)} ${r.passed}/${r.total}`);
  for (const c of r.cases.filter((x) => !x.passed)) console.log(`        ✗ ${c.id}: ${c.detail}`);
}
console.log(`\nSkill evals: ${report.passed}/${report.total} cases passed across ${report.skills.length} skills (offline engine, ${report.rounds} approval rounds, ${(report.ms / 1000).toFixed(1)} s).`);
writeFileSync(fromRoot('evals-report.json'), `${JSON.stringify({ ...report, at: new Date().toISOString() }, null, 2)}\n`);
process.exit(report.passed === report.total ? 0 : 1);
