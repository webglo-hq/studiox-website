import { z } from 'zod';
import { METHODS, type MethodName } from '../app/methods';

/**
 * The tools the MCP server offers. Each one is a method of the application API, called over
 * HTTP with the person's API token, so roles, entity scope, maker-checker, segregation of
 * duties, rate limits and the audit trail are exactly those of the web app.
 */
export interface McpTool {
  name: string;
  method: MethodName;
  title: string;
  description: string;
  /** Changes data (needs a token allowed to make changes). */
  write: boolean;
}

const MONEY = 'Amounts are integers in minor units (cents or pence) of the stated currency.';

export const MCP_TOOLS: McpTool[] = [
  { name: 'whats_next', method: 'home.myClose', title: 'What to do next', write: false, description: 'The current month-end close from the point of view of the token owner: the next action, progress, items waiting for them, reconciliations, exceptions and readiness to lock.' },
  { name: 'close_calendar', method: 'close.calendar', title: 'Close calendar', write: false, description: 'Every close task for a period with owner, reviewer, due business day, status, agent runs and what each task is waiting on. Omit periodKey for the current close.' },
  { name: 'lock_readiness', method: 'close.lockReadiness', title: 'Lock readiness', write: false, description: 'The checklist that must pass before the period can be locked (tasks complete, reconciliations reviewed, variances explained, no open proposals, package final).' },
  { name: 'list_proposals', method: 'inbox.list', title: 'List agent proposals', write: false, description: `Proposals made by the close agents. tab: "mine" (waiting for this person), "waiting" (waiting for someone else), "review" (posted automatically, sampled for review), "auto", "decided" or "all". Each item has the agent's reason, confidence, materiality band and whether this person may approve it. ${MONEY}` },
  { name: 'get_proposal', method: 'inbox.get', title: 'Get a proposal', write: false, description: `One proposal with its evidence, deterministic checks, autonomy-gate reasons and a preview of what approving it will post. ${MONEY}` },
  { name: 'decide_proposals', method: 'inbox.decide', title: 'Approve or reject proposals', write: true, description: 'Approve or reject proposals as the token owner. Maker-checker and segregation of duties apply: nobody approves work prepared on their behalf, and material items need a controller or CFO. A rejection needs a reason (3+ characters). Each decision is audited.' },
  { name: 'run_close_agents', method: 'close.orchestrate', title: 'Run the close agents', write: true, description: 'Start the agents for every task that is ready, in dependency order. Needs the orchestrate permission. Proposals they make appear in list_proposals.' },
  { name: 'list_reconciliations', method: 'recs.list', title: 'List reconciliations', write: false, description: `Balance-sheet reconciliations for a period with ledger and comparison balances, unexplained difference and sign-off status. ${MONEY}` },
  { name: 'get_reconciliation', method: 'recs.get', title: 'Get a reconciliation', write: false, description: `One reconciliation workbench: balances, matched and unmatched statement and ledger lines, reconciling items and readiness to certify. ${MONEY}` },
  { name: 'flux_review', method: 'flux.view', title: 'Flux (variance) review', write: false, description: `Account-level variances against the prior month or the budget for one entity, with materiality flags and explanation status. ${MONEY}` },
  { name: 'list_exceptions', method: 'issues.list', title: 'List exceptions', write: false, description: 'Exceptions raised during the close (duplicate payments, SoD breaks, unexplained bank items, suspected prompt injection, and others) with severity and status.' },
  { name: 'search_journal_entries', method: 'journals.list', title: 'Search journal entries', write: false, description: `Journal entries filtered by period, entity (US, UK, CONSOL), status, source or free text. ${MONEY}` },
  { name: 'get_journal_entry', method: 'journals.get', title: 'Get a journal entry', write: false, description: `One entry with lines, provenance (who prepared and approved it, on what policy), source documents and its audit history. ${MONEY}` },
  { name: 'trial_balance', method: 'reports.trialBalance', title: 'Trial balance', write: false, description: `Trial balance for scope "consolidated", "US", "UK" or "CONSOL". ${MONEY}` },
  { name: 'financial_statement', method: 'reports.statement', title: 'Financial statement', write: false, description: `Balance sheet (kind "BS") or income statement (kind "IS") for a scope, with XBRL US-GAAP tags per line. ${MONEY}` },
  { name: 'agent_run_trace', method: 'runs.get', title: 'Agent run trace', write: false, description: 'The full trace of one agent run: plan, tool calls, observations, verification, gate decisions, proposals, tokens and cost.' },
  { name: 'explain_term', method: 'ontology.term', title: 'Explain a term', write: false, description: 'Definition, plain-English meaning, sources and relations of an ontology term, class, axiom or individual, e.g. "ek:Accrual" or "AX-DE-01".' },
  { name: 'search_ontology', method: 'ontology.search', title: 'Search the ontology', write: false, description: 'Search close concepts by name or synonym (e.g. "deposit in transit", "materiality").' },
  { name: 'verify_audit_chain', method: 'audit.verify', title: 'Verify the audit chain', write: false, description: 'Recompute the hash chain over every audit event and report whether it is intact.' },
];

/** JSON Schema of a tool's input, from the method's zod schema. */
export function inputSchema(method: MethodName): Record<string, unknown> {
  const schema = z.toJSONSchema(METHODS[method].input as z.ZodType, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
