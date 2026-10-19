/** The accounting domain pack: what the domain-agnostic agent runtime needs to run close skills. */
import type { DomainPack } from '../../../core/agent/runtime';
import { periodLabel } from '../../../core/util/time';
import { closeOntology } from '../ontology';
import { AccountingServices } from '../services';
import { applyProposal } from './apply';
import { assessDraft } from './assess';
import { OFFLINE_BRAINS } from './brains';
import { ACCOUNTING_TOOLS, PROPOSAL_PERMISSION } from './tools';
import { verifyDraft } from './verify';

export const accountingPack: DomainPack<AccountingServices> = {
  key: 'accounting',
  ontology: closeOntology(),
  tools: ACCOUNTING_TOOLS,
  services: (tx, actor, clock) => new AccountingServices(tx, actor, clock),
  verify: verifyDraft,
  assess: assessDraft,
  apply: applyProposal,
  async afterPropose(svc, proposal) {
    // a variance explained again (the ledger moved the figures) replaces the drafts written for the old figures
    if (proposal.kind === 'flux_explanation' && proposal.entity_id && proposal.period_key)
      await svc.flux.supersedeDrafts(proposal.entity_id, proposal.period_key, (proposal.payload as { accountCode: string }).accountCode, { except: proposal.id, by: null, reason: `Replaced by ${proposal.ref}: the variance changed since this draft.` });
  },
  offlineBrains: OFFLINE_BRAINS,
  proposalPermission: (kind) => PROPOSAL_PERMISSION[kind],
  taskPrompt(skill, input) {
    const scope = input.entityId ? `entity id ${input.entityId}` : 'the whole group (all entities)';
    return [
      `Run the ${skill.manifest.title} skill for ${scope}, period ${input.periodKey ?? 'n/a'}${input.periodKey ? ` (${periodLabel(input.periodKey)})` : ''}.`,
      'Start by calling close.status for the period to learn the entities, then follow the skill instructions.',
      'Propose only what the evidence supports, cite record ids, and call finish when done.',
    ].join('\n');
  },
};
