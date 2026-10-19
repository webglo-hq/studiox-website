/* Developer tool: print volumes and key balances of the generated scenario. */
import { generateScenario } from '../../src/packs/accounting/seed/generate';

const t0 = Date.now();
const d = generateScenario();
console.log('generated in ms', Date.now() - t0, '| journal entries', d.journal.length, '| lines', d.journal.reduce((s, j) => s + j.lines.length, 0), '| bank events', d.bankEvents.length);
for (const [k, v] of Object.entries(d.rows)) console.log(`  ${k}: ${v.length}`);
console.log(d.files.map((f) => `${f.filename} (${f.content.length} bytes)`).join('\n'));
const sumBy = (entity: string, pred: (acct: string) => boolean, sign: 1 | -1) => {
  const out: Record<string, number> = {};
  for (const j of d.journal) if (j.entity === entity) for (const l of j.lines) if (pred(l.acct)) out[j.periodKey] = (out[j.periodKey] ?? 0) + sign * (l.dr - l.cr);
  return out;
};
const fmt = (o: Record<string, number>, cumulative = false) => {
  let run = 0;
  return Object.keys(o)
    .sort()
    .map((p) => {
      run += o[p]!;
      return `${p}:${Math.round((cumulative ? run : o[p]!) / 100)}`;
    })
    .join(' ');
};
console.log('US cash 1000 (cumulative):', fmt(sumBy('US', (a) => a === '1000', 1), true));
console.log('US payroll cash 1010 (cumulative):', fmt(sumBy('US', (a) => a === '1010', 1), true));
console.log('UK cash 1050 (cumulative):', fmt(sumBy('UK', (a) => a === '1050', 1), true));
console.log('US net income by month:', fmt(sumBy('US', (a) => /^[4-8]/.test(a), -1)));
console.log('US marketing 6400 by month:', fmt(sumBy('US', (a) => a === '6400', 1)));
console.log('US prof fees 6500 by month:', fmt(sumBy('US', (a) => a === '6500', 1)));
console.log('US revenue 4000 by month:', fmt(sumBy('US', (a) => a === '4000', -1)));
console.log('US AP 2000 (cumulative):', fmt(sumBy('US', (a) => a === '2000', -1), true));
console.log('US AR 1100 (cumulative):', fmt(sumBy('US', (a) => a === '1100', 1), true));
// bank vs GL for history months (should tie)
for (const bank of ['US-OP', 'US-PAY', 'UK-OP'] as const) {
  const acct = bank === 'US-OP' ? '1000' : bank === 'US-PAY' ? '1010' : '1050';
  const ent = bank === 'UK-OP' ? 'UK' : 'US';
  const gl = sumBy(ent, (a) => a === acct, 1);
  const bk: Record<string, number> = {};
  for (const e of d.bankEvents.filter((x) => x.bank === bank)) bk[e.date.slice(0, 7)] = (bk[e.date.slice(0, 7)] ?? 0) + e.amount;
  bk['2025-09'] = (bk['2025-09'] ?? 0) + d.bankOpening[bank];
  let gr = 0;
  let br = 0;
  const diffs: string[] = [];
  for (const p of Object.keys({ ...gl, ...bk }).sort()) {
    gr += gl[p] ?? 0;
    br += bk[p] ?? 0;
    if (gr !== br) diffs.push(`${p}:${gr - br}`);
  }
  console.log(`${bank} GL−bank cumulative differences:`, diffs.join(' ') || 'none');
}
