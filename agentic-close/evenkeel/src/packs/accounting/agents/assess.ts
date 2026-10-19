import type { Assessment, Hold, ProposalDraft } from '../../../framework/runtime/types';
import { scanForInjection, truncate } from '../../../framework/util/text';
import { conditionsMatch, type CompiledRule, type RuleFacts } from '../domain/policy-rules';
import { entityById } from '../domain/refdata';
import { CodingDecision, FixedAssetDraft, JournalEntryDraft, PrepaidScheduleDraft, RecMatch, ReconcilingItemDraft } from '../ontology/shapes';
import { materialityBand, settings, toReporting } from '../services/common';
import type { AgentCtx } from './context';

/**
 * The domain's own reading of a proposal, the same for the offline playbooks and for Claude:
 * what it moves (from its lines and the records it acts on, never the amount the agent
 * states), how material that is, which of the skill's plain-English policy rules hold it for
 * a person, and whether any record it acts on carries instruction-like text.
 */

/** Proposal kinds that move money or balances (gated by amount); the rest gate on confidence only. */
export const MONETARY: ReadonlySet<string> = new Set(['journal_entry', 'coding', 'rec_match', 'reconciling_item', 'prepaid_schedule', 'fixed_asset']);

export interface DerivedAmount {
  /** absolute minor units; null when the payload or its records do not allow computing it */
  amount: number | null;
  currency: string | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** What a proposal moves, read from its payload and the records it acts on. */
export async function proposalAmount(ctx: AgentCtx, draft: Pick<ProposalDraft, 'kind' | 'payload' | 'entityId' | 'currency'>): Promise<DerivedAmount> {
  const p = draft.payload;
  const currencyOf = async (entityId: unknown) => (typeof entityId === 'string' ? entityById(ctx.svc, entityId).then((e) => e.functional_currency).catch(() => null) : null);
  const recCurrency = async (recId: string | null | undefined) => {
    const rec = recId ? await ctx.svc.db.get('reconciliation', recId) : null;
    return rec && rec.tenant_id === ctx.svc.tenantId ? currencyOf(rec.entity_id) : null;
  };
  switch (draft.kind) {
    case 'journal_entry': {
      const d = JournalEntryDraft.safeParse(p);
      if (!d.success) return { amount: null, currency: null };
      const debits = d.data.lines.reduce((s, l) => s + (l.debit ?? 0), 0);
      return { amount: debits > 0 ? debits : null, currency: d.data.currency };
    }
    case 'coding': {
      const d = CodingDecision.safeParse(p);
      const txn = d.success ? await ctx.svc.db.get('card_transaction', d.data.subjectId) : null;
      if (!txn || txn.tenant_id !== ctx.svc.tenantId) return { amount: null, currency: null };
      return { amount: Math.abs(txn.amount), currency: await currencyOf(txn.entity_id) };
    }
    case 'rec_match': {
      const d = RecMatch.safeParse(p);
      if (!d.success || !d.data.bankItems.length) return { amount: null, currency: null };
      const ids = d.data.bankItems.map((b) => b.id);
      const txs = await ctx.svc.db.find('bank_transaction', { id: { in: ids } });
      if (txs.length !== new Set(ids).size || txs.some((t) => t.tenant_id !== ctx.svc.tenantId)) return { amount: null, currency: null };
      return { amount: Math.abs(txs.reduce((s, t) => s + t.amount, 0)), currency: await recCurrency(d.data.reconciliationId) };
    }
    case 'reconciling_item': {
      const d = ReconcilingItemDraft.safeParse(p);
      if (!d.success || d.data.amount === 0) return { amount: null, currency: null };
      return { amount: Math.abs(d.data.amount), currency: await recCurrency(d.data.reconciliationId) };
    }
    case 'prepaid_schedule': {
      const d = PrepaidScheduleDraft.safeParse(p);
      return d.success ? { amount: Math.abs(d.data.total), currency: await currencyOf(d.data.entityId) } : { amount: null, currency: null };
    }
    case 'fixed_asset': {
      const d = FixedAssetDraft.safeParse(p);
      return d.success ? { amount: Math.abs(d.data.cost), currency: await currencyOf(d.data.entityId) } : { amount: null, currency: null };
    }
    // Non-monetary kinds: the amount is for display only and never gates anything.
    case 'issue': {
      const a = num(p.amount);
      return { amount: a === null ? null : Math.abs(a), currency: draft.currency ?? (await currencyOf(p.entityId ?? draft.entityId)) };
    }
    case 'flux_explanation': {
      const v = num(p.variance);
      return { amount: v === null ? null : Math.abs(v), currency: await currencyOf(p.entityId ?? draft.entityId) };
    }
    default:
      return { amount: null, currency: null };
  }
}

type Ref = { type: string; id: string };

/** Every record a payload points at (subjects, statement lines, source records, links). */
export function referencedRecords(kind: string, payload: Record<string, unknown>): Ref[] {
  const out: Ref[] = [];
  const add = (type: unknown, id: unknown) => {
    if (typeof type === 'string' && typeof id === 'string') out.push({ type, id });
  };
  const refs = (v: unknown) => {
    if (Array.isArray(v)) for (const r of v) if (r && typeof r === 'object') add((r as Ref).type, (r as Ref).id);
  };
  const P = payload as Record<string, unknown> & { links?: { bankTransactionIds?: unknown[] }; lines?: { sourceRef?: Ref }[]; bankItems?: { id?: unknown }[]; sourceRef?: Ref };
  if (kind === 'coding') add(P.subjectType ?? 'card_transaction', P.subjectId);
  for (const b of Array.isArray(P.bankItems) ? P.bankItems : []) add('bank_transaction', b?.id);
  for (const id of Array.isArray(P.links?.bankTransactionIds) ? P.links.bankTransactionIds : []) add('bank_transaction', id);
  for (const l of Array.isArray(P.lines) ? P.lines : []) if (l?.sourceRef) add(l.sourceRef.type, l.sourceRef.id);
  refs(P.sourceRefs);
  refs(P.subjectRefs);
  refs(P.clearedBy);
  if (P.sourceRef) add(P.sourceRef.type, P.sourceRef.id);
  if (typeof P.vendorId === 'string') add('vendor', P.vendorId);
  const seen = new Set<string>();
  return out.filter((r) => (seen.has(`${r.type}:${r.id}`) ? false : (seen.add(`${r.type}:${r.id}`), true)));
}

interface RecordText {
  label: string;
  texts: string[];
  facts?: Partial<RuleFacts>;
}

/** The outside-sourced text of a referenced record (memos, descriptions, names), with rule facts. */
async function recordText(ctx: AgentCtx, ref: Ref): Promise<RecordText | null> {
  const db = ctx.svc.db;
  const mine = <T extends { tenant_id: string }>(r: T | null) => (r && r.tenant_id === ctx.svc.tenantId ? r : null);
  switch (ref.type) {
    case 'bank_transaction': {
      const t = mine(await db.get('bank_transaction', ref.id));
      return t && { label: `statement line ${t.reference ?? t.posted_date}`, texts: [t.description, t.reference ?? '', t.counterparty ?? ''], facts: { merchant: t.counterparty ?? t.description, memo: t.description } };
    }
    case 'card_transaction': {
      const t = mine(await db.get('card_transaction', ref.id));
      return t && { label: `card transaction at ${t.merchant_name}`, texts: [t.merchant_name, t.memo ?? ''], facts: { merchant: t.merchant_name, memo: t.memo ?? '', mcc: t.mcc, cardholder: t.cardholder_name } };
    }
    case 'bill': {
      const b = mine(await db.get('bill', ref.id));
      const v = b ? await db.get('vendor', b.vendor_id) : null;
      return b && { label: `bill ${b.bill_number}`, texts: [b.memo ?? '', b.bill_number, v?.name ?? ''], facts: { merchant: v?.name ?? '', memo: b.memo ?? '' } };
    }
    case 'purchase_order': {
      const po = mine(await db.get('purchase_order', ref.id));
      const v = po ? await db.get('vendor', po.vendor_id) : null;
      return po && { label: `purchase order ${po.po_number}`, texts: [po.description, v?.name ?? ''], facts: { merchant: v?.name ?? '', memo: po.description } };
    }
    case 'vendor_payment': {
      const vp = mine(await db.get('vendor_payment', ref.id));
      const v = vp ? await db.get('vendor', vp.vendor_id) : null;
      return vp && { label: `payment ${vp.reference}`, texts: [vp.reference, v?.name ?? ''], facts: { merchant: v?.name ?? '' } };
    }
    case 'vendor': {
      const v = mine(await db.get('vendor', ref.id));
      return v && { label: `vendor ${v.name}`, texts: [v.name], facts: { merchant: v.name } };
    }
    case 'customer_receipt': {
      const r = mine(await db.get('customer_receipt', ref.id));
      return r && { label: `receipt ${r.reference ?? r.receipt_date}`, texts: [r.reference ?? '', r.deposit_batch ?? ''] };
    }
    case 'journal_entry': {
      const je = mine(await db.get('journal_entry', ref.id));
      return je && { label: `entry ${je.entry_number}`, texts: [je.memo], facts: { memo: je.memo } };
    }
    case 'journal_line': {
      const l = mine(await db.get('journal_line', ref.id));
      const je = l ? await db.get('journal_entry', l.journal_entry_id) : null;
      return l && je && { label: `entry ${je.entry_number}`, texts: [je.memo, l.memo ?? ''], facts: { memo: je.memo } };
    }
    default:
      return null;
  }
}

/** Assess a draft: amount and materiality from the payload, plus the holds the server enforces. */
export async function assessProposal(ctx: AgentCtx, draft: ProposalDraft): Promise<Assessment> {
  const monetary = MONETARY.has(draft.kind);
  const derived = await proposalAmount(ctx, draft);
  const entityId = draft.entityId ?? ctx.run.entityId;
  const currency = derived.currency ?? draft.currency ?? (entityId ? (await entityById(ctx.svc, entityId)).functional_currency : (await settings(ctx.svc)).reportingCurrency);
  const holds: Hold[] = [];
  const amountReporting = monetary && derived.amount !== null ? await toReporting(ctx.svc, derived.amount, currency, draft.periodKey ?? ctx.periodKey) : 0;
  const { band, performance } = await materialityBand(ctx.svc, amountReporting);
  let materiality: Assessment['materiality'] = monetary ? band : 'trivial';
  if (monetary && derived.amount === null) {
    // Without an amount nobody can show the item is under any threshold: treat it as material.
    holds.push({ code: 'amount_unknown', reason: 'The amount could not be computed from the proposal’s lines and records, so a person must decide.' });
    materiality = 'material';
  }

  // Records the proposal acts on: instruction-like text is flagged, and their facts feed the rules.
  const facts: RuleFacts = { merchant: '', memo: '', mcc: null, cardholder: '', amount: monetary ? (derived.amount ?? 0) : 0 };
  let injectionSuspected = false;
  for (const ref of referencedRecords(draft.kind, draft.payload).slice(0, 50)) {
    const rt = await recordText(ctx, ref);
    if (!rt) continue;
    const scan = scanForInjection(rt.texts.join(' \n '));
    if (scan.suspicious) {
      injectionSuspected = true;
      holds.push({ code: 'untrusted_text', reason: `Instruction-like text in the ${rt.label}: “${truncate(scan.matches[0]!, 80)}”. It was treated as data.` });
    }
    facts.merchant ||= rt.facts?.merchant ?? '';
    facts.memo ||= rt.facts?.memo ?? '';
    facts.mcc ??= rt.facts?.mcc ?? null;
    facts.cardholder ||= rt.facts?.cardholder ?? '';
  }
  facts.memo ||= typeof draft.payload.memo === 'string' ? draft.payload.memo : typeof draft.payload.description === 'string' ? draft.payload.description : '';

  // The skill's "never auto-post" and "flag" rules, evaluated here for every draft.
  for (const r of ctx.policy.rules as CompiledRule[]) {
    if ((r.kind === 'block_auto' || r.kind === 'flag') && conditionsMatch(r.when, facts)) holds.push({ code: 'policy_rule', reason: `Policy rule: ${r.explanation}` });
  }
  return { amount: derived.amount, currency, monetary, amountReporting, materiality, performanceMateriality: performance, requiresRole: materiality === 'material' ? 'controller' : null, holds: holds.filter((h, i) => holds.findIndex((x) => x.reason === h.reason) === i), injectionSuspected };
}
