import { parseSkillMd, SkillManifestError, type SkillPackage, validateManifest, defaultThresholds } from '../../agents/framework/manifest';
import { resolvePolicy } from '../../agents/framework/policy';
import type { PackRuntime } from '../../agents/framework/runtime';
import type { PolicyRule } from '../../agents/framework/types';
import { appendAudit } from '../../audit/audit';
import type { Tx } from '../../persistence/db';
import { SYSTEM_ACTOR } from '../../shared/context';
import { compileRules, ruleMatches } from './algorithms/rules';
import { closeOntology, ONTOLOGY_VERSION } from './ontology';
import { ACCOUNTING_HANDLERS, maybeCompleteTask } from './proposals';
import { buildAccountingScope, materialityFor, type AccountingScope } from './scope';
import { SKILL_FILES } from './skills/bundle.generated';
import { ACCOUNTING_ENGINES } from './skills/engines';
import { bankTools } from './tools/bank';
import { cardTools } from './tools/cards';
import { commonTools } from './tools/common';
import { groupTools } from './tools/group';
import { periodEndTools } from './tools/period-end';
import { proposeTools } from './tools/propose';
import { reviewTools } from './tools/review';

/** The accounting domain pack: ontology-grounded tools, proposal kinds, skills and their offline engines. */

export const ACCOUNTING_TOOLS = [...commonTools, ...proposeTools, ...cardTools, ...bankTools, ...periodEndTools, ...groupTools, ...reviewTools];

const PROPOSAL_TOOL_KINDS = new Map<string, string>([
  ['propose_journal_entry', 'journal_entry'],
  ['propose_reversal', 'journal_entry'],
  ['propose_transaction_coding', 'transaction_coding'],
  ['propose_rec_match', 'rec_match'],
  ['propose_reconciling_item', 'reconciling_item'],
  ['propose_flux_explanation', 'flux_explanation'],
  ['propose_anomaly', 'anomaly'],
  ['propose_prepaid_schedule', 'schedule'],
  ['propose_capitalize_asset', 'schedule'],
  ['propose_close_package', 'task_update'],
]);

export function loadAccountingSkills(): SkillPackage[] {
  const tools = new Set(ACCOUNTING_TOOLS.map((t) => t.name));
  const problems: string[] = [];
  const skills = SKILL_FILES.map((f) => {
    const pkg = parseSkillMd(f.skillMd, `${f.key}/SKILL.md`);
    if (pkg.manifest.key !== f.key) problems.push(`${f.key}: manifest key ${pkg.manifest.key} does not match its folder`);
    problems.push(...validateManifest(pkg, { tools, ontology: closeOntology, proposalTools: PROPOSAL_TOOL_KINDS }).map((p) => `${f.key}: ${p}`));
    return pkg;
  });
  if (problems.length) throw new SkillManifestError(`Invalid skill packages:\n${problems.join('\n')}`, problems);
  return skills;
}

const compile = (lines: string[]) => compileRules(lines) as unknown as PolicyRule[];

/** Stable ontology grounding for a skill's system prompt: definitions of the classes it reads and writes. */
function grounding(skill: SkillPackage): string {
  const ids = new Set<string>();
  for (const i of Object.values(skill.manifest.inputs)) ids.add(i.type);
  for (const o of skill.manifest.outputs) ids.add(o.type);
  for (const t of ACCOUNTING_TOOLS.filter((x) => skill.manifest.tools.includes(x.name))) for (const c of t.ontology ?? []) ids.add(c);
  const lines = [...ids]
    .sort()
    .map((id) => closeOntology.getClass(id))
    .filter((c): c is NonNullable<typeof c> => !!c)
    .map((c) => `- ${c.label} (${c.id}): ${c.definition}${c.normalBalance ? ` Normal balance: ${c.normalBalance}.` : ''}`);
  const axioms = closeOntology
    .axiomsFor('bh:JournalEntry')
    .filter((a) => a.severity === 'error')
    .map((a) => `- ${a.id} ${a.label}: ${a.plainEnglish}`);
  return [`Ontology ${closeOntology.spec.iri} v${ONTOLOGY_VERSION}. Terms used by this skill:`, ...lines, '', 'Every proposed journal entry is checked against these executable axioms before anyone can approve it:', ...axioms].join('\n');
}

export function accountingPack(skills: SkillPackage[] = loadAccountingSkills()): PackRuntime<AccountingScope> {
  return {
    key: 'accounting',
    ontologyVersion: ONTOLOGY_VERSION,
    tools: ACCOUNTING_TOOLS,
    handlers: ACCOUNTING_HANDLERS,
    engines: ACCOUNTING_ENGINES,
    skills,
    buildScope: buildAccountingScope,
    compileRules: compile,
    ruleMatches,
    async materiality(tx, tenantId, run) {
      const period = run.period_id ? await tx.get('periods', run.period_id) : null;
      const close = !period && run.close_id ? await tx.get('closes', run.close_id) : null;
      const tenant = await tx.get('tenants', tenantId);
      const year = period?.fiscal_year ?? close?.fiscal_year ?? Number((tenant?.business_date ?? new Date().toISOString()).slice(0, 4));
      return materialityFor(tx, tenantId, year);
    },
    grounding,
    async onRunFinished(scope, run) {
      if (run.close_task_id && run.status === 'completed') await maybeCompleteTask(scope, run.close_task_id, run.id);
    },
    async onProposalSettled(scope, proposal) {
      if (proposal.close_task_id) await maybeCompleteTask(scope, proposal.close_task_id, null);
    },
  };
}

/** Publish skill packages to the catalog and install default policies for a tenant (idempotent). */
export async function registerSkills(tx: Tx, tenantId: string, skills: SkillPackage[], nowIso: string): Promise<{ published: number; policies: number }> {
  let published = 0;
  let policies = 0;
  for (const pkg of skills) {
    const m = pkg.manifest;
    let skill = await tx.findOne('skills', { key: m.key });
    if (!skill) skill = await tx.insert('skills', { key: m.key, name: m.name, description: m.summary, category: m.category, domain: m.domain, current_version: m.version });
    else if (skill.current_version !== m.version) skill = await tx.update('skills', skill.id, { current_version: m.version, name: m.name, description: m.summary });
    const existing = await tx.findOne('skill_versions', { skill_id: skill.id, version: m.version });
    if (!existing) {
      await tx.insert('skill_versions', { skill_id: skill.id, version: m.version, manifest: m as unknown as Record<string, unknown>, instructions: pkg.instructions, content_hash: pkg.contentHash, published_at: nowIso });
      published++;
    }
    const hasPolicy = await tx.findOne('skill_policies', { tenant_id: tenantId, skill_key: m.key, entity_id: null, version: 1 });
    if (!hasPolicy) {
      const resolved = resolvePolicy(m, null, compile);
      await tx.insert('skill_policies', {
        tenant_id: tenantId,
        skill_key: m.key,
        entity_id: null,
        version: 1,
        autonomy_level: m.autonomy.default,
        thresholds: defaultThresholds(m) as Record<string, number>,
        rules_text: m.rules,
        rules: resolved.rules,
        change_reason: 'Installed with the skill package defaults',
        created_by: null,
        created_at: nowIso,
      });
      policies++;
    }
  }
  if (published || policies) {
    await appendAudit(tx, tenantId, SYSTEM_ACTOR, { action: 'skills.register', objectType: 'skill', summary: `Published ${published} skill version(s) and installed ${policies} default polic${policies === 1 ? 'y' : 'ies'}`, details: { skills: skills.map((s) => `${s.manifest.key}@${s.manifest.version}`) } }, nowIso);
  }
  return { published, policies };
}
