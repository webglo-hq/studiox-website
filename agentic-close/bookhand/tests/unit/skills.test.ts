import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderBundle } from '../../scripts/bundle-skills';
import { closeOntology } from '../../src/packs/accounting/ontology';
import { ACCOUNTING_TOOLS, accountingPack, loadAccountingSkills } from '../../src/packs/accounting/pack';
import { compileRules } from '../../src/packs/accounting/algorithms/rules';

describe('accounting skill packages', () => {
  it('the generated bundle matches the SKILL.md and evals.json files on disk', () => {
    const current = readFileSync(join(process.cwd(), 'src/packs/accounting/skills/bundle.generated.ts'), 'utf8');
    expect(current, 'run npm run skills:bundle').toBe(renderBundle());
  });

  it('every manifest validates against the tool registry, the ontology and the permission model', () => {
    const skills = loadAccountingSkills();
    expect(skills.map((s) => s.manifest.key).sort()).toEqual([
      'accrual-detection',
      'bank-reconciliation',
      'close-orchestrator',
      'close-package',
      'fixed-asset-depreciation',
      'flux-analysis',
      'fx-revaluation',
      'intercompany',
      'intercompany-eliminations',
      'je-review',
      'prepaid-amortization',
      'subledger-tieout',
      'transaction-coding',
    ]);
    const pack = accountingPack(skills);
    for (const s of skills) {
      expect(pack.engines.some((e) => e.key === s.manifest.key), `${s.manifest.key} has an engine`).toBe(true);
      for (const r of compileRules(s.manifest.rules)) expect(r.kind, `${s.manifest.key}: "${r.text}" compiles`).not.toBe('unparsed');
    }
  });

  it('grounds every tool in ontology classes that exist', () => {
    for (const t of ACCOUNTING_TOOLS) {
      for (const id of t.ontology ?? []) expect(closeOntology.term(id), `${t.name} -> ${id}`).toBeTruthy();
      expect(t.description.length, `${t.name} describes itself`).toBeGreaterThan(30);
    }
  });
});
