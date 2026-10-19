/**
 * Skill evals (CI gate): runs every golden case of every skill against the seeded scenario with the
 * offline engine and prints a scorecard. Exit code 1 if any case fails.
 *   npm run evals                 all skills
 *   npm run evals -- bank-reconciliation transaction-coding
 * Writes a JSON report to .eval-reports/ (gitignored).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allCases, bramblewoodFixture, runEvalCase } from '../src/packs/accounting/evals/harness';

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const verbose = process.argv.includes('--verbose');
const t0 = Date.now();
const fx = await bramblewoodFixture();
const seededMs = Date.now() - t0;
const cases = allCases().filter((c) => !only.length || only.includes(c.skillKey));
let passed = 0;
let checks = 0;
let checksPassed = 0;
const report: unknown[] = [];
for (const { skillKey, case: c } of cases) {
  const r = await runEvalCase(fx, skillKey, c);
  if (r.passed) passed++;
  checks += r.expectations.length;
  checksPassed += r.expectations.filter((e) => e.passed).length;
  console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${skillKey.padEnd(22)} ${c.id.padEnd(22)} ${String(r.proposals).padStart(4)} proposals  ${String(r.durationMs).padStart(5)} ms`);
  for (const e of r.expectations) if (!e.passed || verbose) console.log(`        ${e.passed ? '✓' : '✗'} ${e.description} — ${e.detail}`);
  report.push({ skillKey, caseId: c.id, title: c.title, passed: r.passed, proposals: r.proposals, durationMs: r.durationMs, expectations: r.expectations, headline: r.run.summary.headline });
}
const dir = join(process.cwd(), '.eval-reports');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'latest.json'), JSON.stringify({ at: new Date().toISOString(), seededMs, cases: cases.length, passed, checks, checksPassed, report }, null, 2));
console.log(`\nSkill evals: ${passed}/${cases.length} cases passed, ${checksPassed}/${checks} checks (fixture seeded in ${seededMs} ms, total ${Date.now() - t0} ms)`);
process.exit(passed === cases.length ? 0 : 1);
