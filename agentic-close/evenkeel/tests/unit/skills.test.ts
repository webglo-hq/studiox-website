import { describe, expect, it } from 'vitest';
import { loadSkillPackages, parseSkillMarkdown } from '../../src/framework/skills/manifest';
import { validateSkills } from '../../src/packs/accounting/agents/engine';
import { parseCases } from '../../src/packs/accounting/evals/evaluate';
import { readSkillFiles } from '../../src/server/skills-fs';

/**
 * The skill library as packages: every SKILL.md parses, its manifest is consistent with the
 * ontology, the tool registry and the permission catalogue, and its evaluation cases parse.
 * Broken manifests are refused with a reason.
 */
const files = readSkillFiles();
const skills = loadSkillPackages(files);

describe('skill library', () => {
  it('ships the twelve close skills, each valid against the ontology, tools and permissions', () => {
    expect(skills.map((s) => s.id).sort()).toEqual([
      'accrual-detection',
      'bank-reconciliation',
      'close-orchestrator',
      'close-package',
      'fixed-asset-depreciation',
      'flux-analysis',
      'fx-revaluation',
      'intercompany-reconciliation',
      'je-review',
      'prepaid-amortization',
      'subledger-tieout',
      'transaction-coding',
    ]);
    expect(validateSkills(skills)).toEqual([]);
  });

  it('gives every skill instructions, least-privilege tools, controls, budgets and evaluation cases', () => {
    for (const s of skills) {
      expect(s.instructions.length, s.id).toBeGreaterThan(400);
      expect(s.manifest.tools.length, s.id).toBeGreaterThan(0);
      expect(s.manifest.tools.length, s.id).toBeLessThan(25);
      expect(s.manifest.budgets.maxSteps, s.id).toBeGreaterThan(0);
      expect(s.manifest.outputs.length, s.id).toBeGreaterThan(0);
      expect(s.contentHash, s.id).toMatch(/^[0-9a-f]{64}$/);
      const cases = parseCases(s.id, s.evalCases);
      expect(cases.length, s.id).toBeGreaterThanOrEqual(3);
    }
  });

  it('refuses manifests that name unknown tools, types or permissions, or exceed their own autonomy', () => {
    const path = Object.keys(files).find((p) => p.endsWith('bank-reconciliation/SKILL.md'))!;
    const tampered = files[path]!.replace('tools: [get_close_context,', 'tools: [wire_money_out, get_close_context,').replace('permissions: [rec.prepare,', 'permissions: [payments.release, rec.prepare,').replace('max: L3', 'max: L1');
    expect(tampered).not.toBe(files[path]);
    const broken = loadSkillPackages({ ...files, [path]: tampered }).find((s) => s.id === 'bank-reconciliation')!;
    const problems = validateSkills([broken]).join('\n');
    expect(problems).toMatch(/tool wire_money_out is not registered/);
    expect(problems).toMatch(/permission payments.release is not defined/);
    expect(problems).toMatch(/default autonomy exceeds the maximum/);
    expect(() => parseSkillMarkdown('no front matter here', 'x/SKILL.md')).toThrow();
  });
});
