/**
 * The accounting skill library: loads the bundled SKILL.md files (generated from skills/**) and
 * installs them into a tenant with versioned default policies — a global policy at group
 * materiality plus entity-scoped overrides where thresholds depend on an entity's materiality.
 */
import { defaultThresholds } from '../../../core/skills/policy';
import { SkillRegistry } from '../../../core/skills/skillmd';
import type { PolicyMapping, PolicyRule } from '../../../core/skills/policy-types';
import { compileRule } from '../agent/rules';
import { ACCOUNTS, DIMENSIONS, ENTITIES } from '../seed/company';
import type { SeedBuilder } from '../seed/builder';
import { skillBundles } from './bundle.generated';

let registry: SkillRegistry | null = null;

export function accountingSkills(): SkillRegistry {
  if (!registry) registry = new SkillRegistry(skillBundles);
  return registry;
}

/** Demo policy content: one Controller mapping and two plain-English rules. */
function demoPolicy(skillKey: string, controllerId: string, now: string): { mappings: PolicyMapping[]; rules: PolicyRule[] } {
  if (skillKey !== 'transaction-coding') return { mappings: [], rules: [] };
  const ctx = { accounts: ACCOUNTS.map((a) => ({ code: a.code, name: a.name, postable: a.postable !== false })), departments: DIMENSIONS.find((d) => d.key === 'department')!.values.map(([code, name]) => ({ code, name })) };
  const texts = ['Code Tessera Cloud Storage to 5000 Hosting', 'Never auto-post anything from Atrium Event Spaces'];
  return {
    mappings: [{ id: 'map-1', match: { merchant: 'Metro Rideshare' }, set: { account: '6400' }, note: 'Ground transport is travel, never meals' }],
    rules: texts.map((text, i) => {
      const c = compileRule(text, ctx);
      return { id: `rule-${i + 1}`, text, status: c.status, compiled: c.compiled, interpretation: c.interpretation, createdBy: controllerId, createdAt: now };
    }),
  };
}

export function installAccountingSkills(b: SeedBuilder, ctx: { controllerId: string; now: string }) {
  const us = ENTITIES.find((e) => e.code === 'BWL-US')!.materiality;
  for (const s of accountingSkills().all()) {
    const m = s.manifest;
    const skill = b.add('skills', { key: s.key, name: m.title, description: s.frontmatter.description, domain: 'accounting', current_version: s.version, enabled: true, installed_at: ctx.now });
    b.add('skill_versions', { skill_id: skill.id, version: s.version, manifest: m, skill_md: s.skillMd, content_hash: s.contentHash, status: 'active', installed_at: ctx.now });
    const demo = demoPolicy(s.key, ctx.controllerId, ctx.now);
    b.add('skill_policies', { skill_id: skill.id, scope_entity_id: null, version: 1, is_current: true, autonomy_level: m.autonomy.default, thresholds: defaultThresholds(m, us.clearlyTrivialMinor, us.performanceMinor), mappings: demo.mappings, rules: demo.rules, enabled: true, change_note: 'Installed with manifest defaults', changed_by: ctx.controllerId, created_at: ctx.now });
    if (m.materiality.autoPostMax === 'clearly_trivial' || m.materiality.autoPostMax === 'performance') {
      for (const e of ENTITIES.filter((x) => x.kind === 'legal' && x.code !== 'BWL-US')) {
        b.add('skill_policies', { skill_id: skill.id, scope_entity_id: b.ent(e.code), version: 1, is_current: true, autonomy_level: m.autonomy.default, thresholds: defaultThresholds(m, e.materiality.clearlyTrivialMinor, e.materiality.performanceMinor), mappings: demo.mappings, rules: demo.rules, enabled: true, change_note: `Installed with ${e.code} materiality`, changed_by: ctx.controllerId, created_at: ctx.now });
      }
    }
  }
}
