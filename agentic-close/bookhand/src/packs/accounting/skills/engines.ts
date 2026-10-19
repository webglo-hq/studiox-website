import type { AgentHandle, EvidenceRef, ProposeResult, SkillEngine } from '../../../agents/framework/types';
import { ToolCallError } from '../../../agents/framework/runtime';
import { formatMoney } from '../../../shared/money';
import type { AccrualCandidate } from '../algorithms/accruals';
import type { AnomalyFinding } from '../algorithms/anomaly';
import type { Match, TimingItem, BankOnlyItem } from '../algorithms/matching';
import type { BankWorkspace } from '../tools/bank';

/**
 * Deterministic offline engines: the "brain" used when no model is configured. Each drives exactly the same
 * typed tools a live model would (so permissions, verification, autonomy and tracing are identical) and
 * writes rationales a reviewer can check.
 */

const money = (minor: number, currency = 'USD') => formatMoney(minor, { currency });

interface RunInput {
  closeId: string;
  closeTaskId?: string;
  entity?: string;
  period: string;
  ledger?: 'ap' | 'ar';
  comparison?: 'prior_month' | 'budget';
}

interface CloseContext {
  close: { id: string; name: string; periodEnd: string; fiscalYear: number; periodNumber: number };
  businessDate: string;
  reportingCurrency: string;
  entities: Array<{ id: string; code: string; kind: string; currency: string; period: { id: string; key: string; start: string; end: string; status: string } | null }>;
}

function input(agent: AgentHandle): RunInput {
  return agent.input as unknown as RunInput;
}

async function tryPropose(agent: AgentHandle, tool: string, args: Record<string, unknown>): Promise<ProposeResult | null> {
  try {
    return await agent.call<ProposeResult>(tool, args);
  } catch (e) {
    if (e instanceof ToolCallError) {
      await agent.note(`Could not propose: ${e.message.slice(0, 200)}`, { tool, error: e.message }, 'decision');
      return null;
    }
    throw e;
  }
}

function tally(agent: AgentHandle): string {
  const ps = agent.proposals();
  const auto = ps.filter((p) => p.status === 'auto_applied').length;
  const pending = ps.filter((p) => p.status === 'pending').length;
  const blocked = ps.filter((p) => p.status === 'blocked').length;
  const suggested = ps.filter((p) => p.status === 'suggested').length;
  const parts = [`${ps.length} proposal${ps.length === 1 ? '' : 's'}`];
  if (auto) parts.push(`${auto} auto-applied under policy`);
  if (pending) parts.push(`${pending} waiting for approval`);
  if (blocked) parts.push(`${blocked} blocked by verification`);
  if (suggested) parts.push(`${suggested} suggestion${suggested === 1 ? '' : 's'}`);
  return parts.join(', ');
}

// ------------------------------------------------------------------ transaction coding

interface Suggestion {
  id: string;
  date: string;
  merchant: string;
  memo: string | null;
  amount: number;
  currency: string;
  cardholder: string | null;
  entity: string;
  suggestion: { accountNumber: string; accountName: string; departmentCode: string | null; confidence: number; why: string; signals: string[] } | null;
}

const transactionCoding: SkillEngine = {
  key: 'transaction-coding',
  brief: (a) => `Code the ${input(a).entity} card feed for ${input(a).period}.`,
  async offline(agent) {
    const inp = input(agent);
    await agent.plan(['Read the close context', 'List uncoded card transactions', 'Get coding suggestions (policy rules, company history, ontology)', 'Propose coding for each transaction', 'Re-check posted coding for capitalizable purchases', 'Summarize']);
    const ctx = await agent.call<CloseContext>('close_context', { closeId: inp.closeId, closeTaskId: inp.closeTaskId });
    const uncoded = await agent.call<{ count: number; transactions: Array<{ id: string }> }>('cards_uncoded', { entity: inp.entity, period: inp.period });
    let skipped = 0;
    for (let i = 0; i < uncoded.transactions.length; i += 100) {
      const ids = uncoded.transactions.slice(i, i + 100).map((t) => t.id);
      const { suggestions } = await agent.call<{ suggestions: Suggestion[] }>('cards_suggest_coding', { cardTransactionIds: ids });
      for (const s of suggestions) {
        if (!s.suggestion) {
          skipped++;
          await agent.note(`No confident coding for ${s.merchant} ${money(s.amount, s.currency)}; left for a person`, { cardTransactionId: s.id }, 'decision');
          continue;
        }
        const sg = s.suggestion;
        const source = sg.signals.includes('policy rule') ? 'rule' : sg.signals.some((x) => x.startsWith('history')) ? 'history' : 'agent';
        await tryPropose(agent, 'propose_transaction_coding', {
          title: `Code ${s.merchant} ${money(s.amount, s.currency)} to ${sg.accountNumber} ${sg.accountName}${sg.departmentCode ? ` (${sg.departmentCode})` : ''}`,
          why: `${sg.why}${s.memo ? ` Memo: "${s.memo}".` : ''} Cardholder ${s.cardholder ?? 'unknown'}.`,
          confidence: sg.confidence,
          evidence: [{ type: 'card_transaction', id: s.id, label: `${s.merchant} ${s.date} ${money(s.amount, s.currency)}` }],
          key: `code:${s.id}`,
          cardTransactionId: s.id,
          accountNumber: sg.accountNumber,
          departmentCode: sg.departmentCode,
          source,
        });
      }
    }
    const review = await agent.call<{ findings: Array<{ id: string; date: string; merchant: string; memo: string | null; amount: number; codedAccount: string; codedNumber: string; codedBy: string | null; suggestedAccount: string; suggestedNumber: string; capitalizable: boolean; confidence: number; why: string; journalEntryId: string | null; journalEntryNumber: string | null; departmentCode: string | null; entity: string; assetClass: 'computer_equipment' | 'furniture_fixtures' | 'leasehold_improvements'; usefulLifeMonths: number }> }>('cards_review_posted', { entity: inp.entity, period: inp.period });
    const end = ctx.entities.find((e) => e.code === inp.entity)?.period?.end ?? ctx.close.periodEnd;
    const cur = ctx.entities.find((e) => e.code === inp.entity)?.currency ?? ctx.reportingCurrency;
    for (const f of review.findings) {
      const evidence: EvidenceRef[] = [{ type: 'card_transaction', id: f.id, label: `${f.merchant} ${f.date} ${money(f.amount, cur)}` }, ...(f.journalEntryId ? [{ type: 'journal_entry', id: f.journalEntryId, label: `${f.journalEntryNumber} (posted to ${f.codedAccount})` }] : [])];
      const description = f.memo ? `${f.memo} (${f.merchant})` : f.merchant;
      if (f.capitalizable) {
        await tryPropose(agent, 'propose_capitalize_asset', {
          title: `Capitalize ${f.merchant} ${money(f.amount, cur)}: expensed to ${f.codedAccount}, belongs in ${f.suggestedAccount}`,
          why: `This ${money(f.amount, cur)} purchase on ${f.date} was ${f.codedBy === 'human' ? 'coded by a person' : 'coded'} to ${f.codedAccount} and posted (${f.journalEntryNumber}). ${f.why} It is above the capitalization threshold (ASC 360 policy), so it should be recorded as an asset and depreciated over ${f.usefulLifeMonths} months instead of expensed this month; operating expense is overstated by ${money(f.amount, cur)}.`,
          confidence: 0.92,
          evidence,
          key: `capitalize:${f.id}`,
          asset: {
            type: 'capitalize',
            entity: f.entity,
            description,
            assetClass: f.assetClass,
            usefulLifeMonths: f.usefulLifeMonths,
            inServiceDate: f.date,
            costMinor: f.amount,
            assetAccount: f.suggestedNumber,
            department: f.departmentCode,
            vendorId: null,
            sourceCardTransactionId: f.id,
            reclass: {
              entity: f.entity,
              date: end,
              type: 'reclass',
              description: `Reclassify ${f.merchant} purchase to ${f.suggestedAccount}`,
              lines: [
                { account: f.suggestedNumber, debit: f.amount, department: f.departmentCode, memo: `Capitalize ${description}` },
                { account: f.codedNumber, credit: f.amount, department: f.departmentCode, memo: `Reverse expense coded ${f.date}` },
              ],
            },
          },
        });
      } else {
        await tryPropose(agent, 'propose_journal_entry', {
          title: `Reclass ${f.merchant} ${money(f.amount, cur)} from ${f.codedAccount} to ${f.suggestedAccount}`,
          why: `${f.why} The posted coding (${f.codedAccount}) disagrees with rules and history.`,
          confidence: Math.min(0.85, f.confidence),
          evidence,
          key: `reclass:${f.id}`,
          entry: { entity: f.entity, date: end, type: 'reclass', description: `Reclass ${f.merchant} to ${f.suggestedAccount}`, lines: [{ account: f.suggestedNumber, debit: f.amount, department: f.departmentCode, memo: f.merchant }, { account: f.codedNumber, credit: f.amount, department: f.departmentCode, memo: f.merchant }] },
          sourceModule: 'card',
        });
      }
    }
    return `Coded ${inp.entity} card spend for ${inp.period}: ${uncoded.count} uncoded transaction(s) reviewed, ${skipped} left for a person, ${review.findings.length} posted item(s) flagged on re-check. ${tally(agent)}.`;
  },
};

// ------------------------------------------------------------------ bank reconciliation

interface MatchResult {
  bankAccountId: string;
  reconciliationId: string;
  period: { key: string; end: string };
  matches: Match[];
  timing: TimingItem[];
  bankOnly: BankOnlyItem[];
  unmatchedLedger: Array<{ id: string; date: string; amount: number; description: string }>;
  ledgerLines: BankWorkspace['ledgerLines'];
  bankLines: BankWorkspace['bankLines'];
  stats: { bankItems: number; ledgerItems: number; matchedBank: number; matchedLedger: number; autoMatchRate: number };
  accounts: { bankFees: string; interestIncome: string };
}

const bankReconciliation: SkillEngine = {
  key: 'bank-reconciliation',
  brief: (a) => `Reconcile every ${input(a).entity} bank account for ${input(a).period}.`,
  async offline(agent) {
    const inp = input(agent);
    await agent.plan(['Open the reconciliation workspace (statement, open bank and ledger lines, carried items)', 'Run the matching engine per bank account', 'Propose matches', 'Prove timing differences with next-period bank activity', 'Book bank fees and interest', 'Isolate unexplained items', 'Summarize the reconciled position']);
    await agent.call('close_context', { closeId: inp.closeId, closeTaskId: inp.closeTaskId });
    const ws = await agent.call<{ accounts: BankWorkspace[] }>('bank_reconciliation_workspace', { entity: inp.entity, period: inp.period });
    const lines: string[] = [];
    for (const acct of ws.accounts) {
      const r = await agent.call<MatchResult>('bank_suggest_matches', { bankAccountId: acct.bankAccount.id, period: inp.period });
      const ledgerById = new Map(r.ledgerLines.map((l) => [l.id, l]));
      const bankById = new Map(r.bankLines.map((b) => [b.id, b]));
      const cur = acct.bankAccount.currency;
      for (const m of r.matches) {
        const b = m.bankIds.map((id) => bankById.get(id)).filter(Boolean);
        const l = m.ledgerIds.map((id) => ledgerById.get(id)).filter(Boolean);
        const carried = l.some((x) => x!.carriedFromPriorPeriod);
        await tryPropose(agent, 'propose_rec_match', {
          title: `${m.type === 'exact' ? 'Match' : m.type === 'fuzzy' ? 'Fuzzy match' : m.type === 'one_to_many' ? 'Match 1 bank line to several entries' : 'Match several bank lines to 1 entry'} ${money(Math.abs(m.bankAmount), cur)}: ${b[0]?.description.slice(0, 60) ?? ''}`,
          why: `${m.explanation}${carried ? ' This clears an item outstanding at last month end.' : ''}`,
          confidence: m.confidence,
          evidence: [...b.map((x) => ({ type: 'bank_transaction', id: x!.id, label: `${x!.date} ${x!.description.slice(0, 80)}` })), ...l.map((x) => ({ type: 'journal_line', id: x!.id, label: `${x!.entryNumber} ${x!.date}` }))],
          key: `match:${[...m.bankIds].sort().join(',')}`,
          bankAccountId: r.bankAccountId,
          period: inp.period,
          matchType: m.type,
          rule: m.rule,
          bankTransactionIds: m.bankIds,
          journalLineIds: m.ledgerIds,
        });
      }
      for (const t of r.timing) {
        const l = ledgerById.get(t.ledgerId);
        const isCheck = /\bcheck\b|\bchk\b/i.test(`${l?.description ?? ''} ${l?.memo ?? ''}`);
        const kind = t.amount > 0 ? 'deposit_in_transit' : isCheck ? 'outstanding_check' : 'timing_difference';
        await tryPropose(agent, 'propose_reconciling_item', {
          title: `${kind === 'deposit_in_transit' ? 'Deposit in transit' : kind === 'outstanding_check' ? 'Outstanding check' : 'Payment in transit'} ${money(Math.abs(t.amount), cur)} (${l?.entryNumber ?? ''})`,
          why: `${t.explanation} Booked ${t.date}; ${t.clearedDate ? `the bank shows it on ${t.clearedDate}, after period end, so it is a timing difference, not an error.` : 'no clearing yet; follow up if it does not clear within 10 days.'}`,
          confidence: t.confidence,
          evidence: [{ type: 'journal_line', id: t.ledgerId, label: `${l?.entryNumber ?? ''} ${t.date}` }, ...(t.clearedBankId ? [{ type: 'bank_transaction', id: t.clearedBankId, label: `Cleared ${t.clearedDate}` }] : [])],
          key: `recitem:${t.ledgerId}`,
          bankAccountId: r.bankAccountId,
          account: acct.bankAccount.glAccount.split(' ')[0],
          entity: acct.bankAccount.entity,
          period: inp.period,
          kind,
          description: `${l?.description ?? 'Book item'} (${l?.entryNumber ?? ''})`,
          amountMinor: t.amount,
          itemDate: t.date,
          expectedClearDate: t.clearedDate,
          journalLineId: t.ledgerId,
        });
      }
      for (const b of r.bankOnly) {
        const bank = bankById.get(b.bankId);
        if (b.kind === 'bank_fee' || b.kind === 'interest') {
          const fee = b.kind === 'bank_fee';
          const amount = Math.abs(b.amount);
          await tryPropose(agent, 'propose_journal_entry', {
            title: `Book ${fee ? 'bank fee' : 'interest income'} ${money(amount, cur)} (${b.description.slice(0, 40)})`,
            why: `${b.explanation} The bank recorded it on ${b.date}; the books do not have it yet.`,
            confidence: b.confidence,
            evidence: [{ type: 'bank_transaction', id: b.bankId, label: `${b.date} ${b.description}` }],
            key: `bankonly:${b.bankId}`,
            entry: {
              entity: acct.bankAccount.entity,
              date: r.period.end,
              type: 'adjusting',
              description: `${fee ? 'Bank fee' : 'Interest credit'} ${r.period.key} (${acct.bankAccount.name})`,
              lines: fee
                ? [{ account: r.accounts.bankFees, debit: amount, memo: b.description }, { account: acct.bankAccount.glAccount.split(' ')[0], credit: amount, memo: b.description }]
                : [{ account: acct.bankAccount.glAccount.split(' ')[0], debit: amount, memo: b.description }, { account: r.accounts.interestIncome, credit: amount, memo: b.description }],
            },
            sourceModule: 'bank',
            links: { bankTransactionIds: [b.bankId] },
          });
        } else {
          await tryPropose(agent, 'propose_reconciling_item', {
            title: `Investigate unexplained bank ${b.amount < 0 ? 'debit' : 'credit'} ${money(Math.abs(b.amount), cur)}: ${b.description.slice(0, 60)}`,
            why: `${b.explanation} No ledger entry, invoice, bill or payroll record explains it and no reference ties it to a counterparty. Leave it as an unexplained reconciling item and ask the bank for the originator details before booking anything.`,
            confidence: b.confidence,
            evidence: [{ type: 'bank_transaction', id: b.bankId, label: `${b.date} ${b.description}` }],
            key: `recitem:${b.bankId}`,
            riskFlags: ['unexplained_cash_movement'],
            bankAccountId: r.bankAccountId,
            account: acct.bankAccount.glAccount.split(' ')[0],
            entity: acct.bankAccount.entity,
            period: inp.period,
            kind: 'unexplained',
            description: b.description,
            amountMinor: -b.amount,
            itemDate: b.date,
            bankTransactionId: b.bankId,
          });
          void bank;
        }
      }
      for (const u of r.unmatchedLedger) await agent.note(`Book item with no bank activity yet: ${u.description.slice(0, 80)} ${money(u.amount, cur)}`, { journalLineId: u.id }, 'observation');
      lines.push(`${acct.bankAccount.name} (${acct.bankAccount.glAccount.split(' ')[0]}): ${r.matches.length} matches, ${r.timing.length} timing items, ${r.bankOnly.length} bank-only items, auto-match rate ${(r.stats.autoMatchRate * 100).toFixed(0)}%`);
    }
    return `Bank reconciliation ${inp.entity} ${inp.period}. ${lines.join('; ')}. ${tally(agent)}.`;
  },
};

// ------------------------------------------------------------------ subledger tie-out

const subledgerTieout: SkillEngine = {
  key: 'subledger-tieout',
  brief: (a) => `Tie out ${input(a).ledger?.toUpperCase()} for ${input(a).entity} ${input(a).period}.`,
  async offline(agent) {
    const inp = input(agent);
    const ledger = inp.ledger ?? 'ap';
    await agent.plan([`Compare the ${ledger.toUpperCase()} subledger with its control account`, 'Trace any difference to entries that bypassed the subledger', 'Raise a finding if it does not tie']);
    const t = await agent.call<{ reconciliationId: string; currency: string; controlAccount: string; gl: number; subledger: number; difference: number; openDocuments: number; directEntriesToControlAccount: Array<{ id: string; entryNumber: string; date: string; description: string; total: number; source: string; externalRef: string | null; externalPreparedBy: string | null; externalApprovedBy: string | null; net: number }> }>('subledger_tieout', { entity: inp.entity, period: inp.period, ledger });
    if (t.difference === 0) return `${t.controlAccount} ties to the ${ledger.toUpperCase()} subledger at ${money(Math.abs(t.gl), t.currency)} (${t.openDocuments} open documents). No differences.`;
    const explaining = t.directEntriesToControlAccount.filter((e) => e.net !== 0);
    const explained = explaining.reduce((s, e) => s + e.net, 0) === t.difference;
    await tryPropose(agent, 'propose_anomaly', {
      title: `${t.controlAccount} is ${money(Math.abs(t.difference), t.currency)} ${t.difference > 0 ? 'above' : 'below'} the ${ledger.toUpperCase()} subledger`,
      why: `The GL control account shows ${money(Math.abs(t.gl), t.currency)} but open ${ledger === 'ap' ? 'bills' : 'invoices'} total ${money(Math.abs(t.subledger), t.currency)}. ${explained ? `The difference is exactly ${explaining.map((e) => `${e.entryNumber}${e.externalRef ? ` (${e.externalRef})` : ''} "${e.description}" posted ${e.date} by ${e.source}${e.externalPreparedBy ? `, prepared by ${e.externalPreparedBy} and approved by ${e.externalApprovedBy}` : ''}`).join('; ')}, which posted straight to the control account with no subledger document.` : 'Entries posted directly to the control account do not fully explain it; investigate.'}`,
      confidence: explained ? 0.9 : 0.6,
      evidence: [{ type: 'reconciliation', id: t.reconciliationId, label: `${ledger.toUpperCase()} tie-out ${inp.entity} ${inp.period}` }, ...explaining.map((e) => ({ type: 'journal_entry', id: e.id, label: e.entryNumber }))],
      key: `tieout:${inp.entity}:${ledger}:${inp.period}`,
      amountMinor: Math.abs(t.difference),
      entity: inp.entity ?? null,
      period: inp.period,
      category: 'tieout_difference',
      severity: Math.abs(t.difference) >= 1_000_000 ? 'high' : 'medium',
      subjectIds: [t.reconciliationId, ...explaining.map((e) => e.id)],
      recommendedAction: explained ? 'Support the entry with a subledger document (invoice or bill) or reverse it; journal-entry review raises the reversal for an independent approver.' : 'Investigate the difference before certifying the tie-out.',
      resolution: { type: 'none' },
    });
    return `${t.controlAccount} differs from the ${ledger.toUpperCase()} subledger by ${money(t.difference, t.currency)}. ${tally(agent)}.`;
  },
};

// ------------------------------------------------------------------ accruals

const accrualDetection: SkillEngine = {
  key: 'accrual-detection',
  brief: (a) => `Find unrecorded liabilities for ${input(a).entity} ${input(a).period}.`,
  async offline(agent) {
    const inp = input(agent);
    await agent.plan(['Collect cutoff, received-not-invoiced and recurring-vendor signals', 'Propose auto-reversing accruals', 'Summarize']);
    const s = await agent.call<{ currency: string; periodEnd: string; reversalDate: string | null; accrualAccount: string | null; candidates: AccrualCandidate[]; alreadyAccrued: Array<{ description: string }> }>('ap_accrual_signals', { entity: inp.entity, period: inp.period });
    const min = Number(agent.policy.thresholds.minAccrualMinor ?? 100_000);
    let total = 0;
    for (const c of s.candidates) {
      if (c.amount < min) {
        await agent.note(`Skipped ${c.vendorName} ${money(c.amount, s.currency)}: below the ${money(min, s.currency)} accrual minimum`, {}, 'decision');
        continue;
      }
      if (s.alreadyAccrued.some((a) => a.description.includes(c.vendorName))) continue;
      total += c.amount;
      const label = c.signal === 'cutoff' ? 'late invoice (cutoff)' : c.signal === 'grni' ? 'received not invoiced' : 'recurring bill missing';
      await tryPropose(agent, 'propose_journal_entry', {
        title: `Accrue ${c.vendorName} ${money(c.amount, s.currency)}: ${label}`,
        why: `${c.why} Accrue at ${s.periodEnd} and reverse on ${s.reversalDate ?? 'the first day of next period'} so the real bill is not double counted.`,
        confidence: c.signal === 'recurring_gap' ? Math.min(c.confidence, 0.85) : c.confidence,
        evidence: c.evidence,
        key: `accrual:${inp.entity}:${inp.period}:${c.vendorId}:${c.accountNumber}`,
        entry: {
          entity: inp.entity,
          date: s.periodEnd,
          type: 'accrual',
          description: c.memo,
          autoReverseDate: s.reversalDate,
          lines: [
            { account: c.accountNumber, debit: c.amount, department: c.departmentCode, vendorId: c.vendorId, memo: c.memo },
            { account: s.accrualAccount ?? '2100', credit: c.amount, vendorId: c.vendorId, memo: c.memo },
          ],
        },
        sourceModule: 'ap',
      });
    }
    return `Unrecorded-liability search ${inp.entity} ${inp.period}: ${s.candidates.length} candidate(s), ${money(total, s.currency)} proposed for accrual with automatic reversal. ${tally(agent)}.`;
  },
};

// ------------------------------------------------------------------ prepaids

const prepaidAmortization: SkillEngine = {
  key: 'prepaid-amortization',
  brief: (a) => `Amortize prepaids for ${input(a).entity} ${input(a).period}.`,
  async offline(agent) {
    const inp = input(agent);
    await agent.plan(['Post scheduled amortization (including missed months)', 'Find prepaid balances without a schedule', 'Propose schedules with catch-up', 'Summarize']);
    const due = await agent.call<{ currency: string; periodEnd: string; schedules: Array<{ scheduleId: string; description: string; balanceAccount: string; plAccount: string; department: string | null; vendorId: string | null; lines: Array<{ id: string; period: string; amount: number; missed: boolean }> }> }>('prepaid_schedules_due', { entity: inp.entity, period: inp.period });
    for (const s of due.schedules) {
      const total = s.lines.reduce((t, l) => t + l.amount, 0);
      const missed = s.lines.filter((l) => l.missed);
      await tryPropose(agent, 'propose_journal_entry', {
        title: `Amortize ${s.description} ${money(total, due.currency)}${missed.length ? ` incl. ${missed.length} missed month(s)` : ''}`,
        why: `Straight-line schedule: ${s.lines.map((l) => `${l.period} ${money(l.amount, due.currency)}`).join(', ')}. ${missed.length ? 'Earlier months were never posted, so they are caught up now.' : 'Routine monthly amortization.'}`,
        confidence: missed.length ? 0.9 : 0.99,
        evidence: [{ type: 'schedule', id: s.scheduleId, label: s.description }, ...s.lines.map((l) => ({ type: 'amortization_line', id: l.id, label: `${l.period} ${money(l.amount, due.currency)}` }))],
        key: `amort:${s.scheduleId}:${inp.period}`,
        entry: { entity: inp.entity, date: due.periodEnd, type: 'amortization', description: `Amortize ${s.description} (${inp.period})`, lines: [{ account: s.plAccount, debit: total, department: s.department, vendorId: s.vendorId, memo: s.description }, { account: s.balanceAccount, credit: total, vendorId: s.vendorId, memo: s.description }] },
        sourceModule: 'prepaid',
        links: { amortizationLineIds: s.lines.map((l) => l.id) },
      });
    }
    const un = await agent.call<{ currency: string; periodEnd: string; accounts: Array<{ account: string; accountName: string; glBalance: number; scheduledRemaining: number; unexplained: number; suggestedExpenseAccount: string | null; candidates: Array<{ billId: string; billNumber: string; vendorId: string; vendor: string; amount: number; serviceStart: string; serviceEnd: string; months: number; monthsElapsedThroughPeriod: number; monthly: number; catchUpAmount: number; department: string | null }> }> }>('prepaid_unscheduled_balances', { entity: inp.entity, period: inp.period });
    for (const a of un.accounts) {
      if (!a.candidates.length) {
        await agent.note(`${a.account} ${a.accountName} carries ${money(a.unexplained, un.currency)} that no schedule or bill explains`, { account: a.account }, 'observation');
        continue;
      }
      for (const c of a.candidates) {
        await tryPropose(agent, 'propose_prepaid_schedule', {
          title: `Create prepaid schedule for ${c.vendor} ${c.billNumber} and catch up ${c.monthsElapsedThroughPeriod} month(s) (${money(c.catchUpAmount, un.currency)})`,
          why: `${a.account} ${a.accountName} carries ${money(a.glBalance, un.currency)} but schedules only explain ${money(a.scheduledRemaining, un.currency)}. Bill ${c.billNumber} from ${c.vendor} (${money(c.amount, un.currency)}, service ${c.serviceStart} to ${c.serviceEnd}) was coded to prepaid without an amortization schedule, so ${c.monthsElapsedThroughPeriod} month(s) of expense through ${inp.period} were never recognized. Create a ${c.months}-month straight-line schedule (${money(c.monthly, un.currency)} per month) and post the catch-up now.`,
          confidence: 0.93,
          evidence: [{ type: 'bill', id: c.billId, label: `${c.billNumber} ${money(c.amount, un.currency)}` }, { type: 'account', id: null, label: `${a.account} balance ${money(a.glBalance, un.currency)}` }],
          key: `prepaid:${c.billId}`,
          schedule: {
            type: 'prepaid',
            entity: inp.entity,
            vendorId: c.vendorId,
            billId: c.billId,
            description: `${c.vendor} ${c.billNumber} (${c.serviceStart} to ${c.serviceEnd})`,
            balanceAccount: a.account,
            plAccount: a.suggestedExpenseAccount ?? '6700',
            department: c.department,
            totalMinor: c.amount,
            startDate: c.serviceStart,
            months: c.months,
            catchUpThrough: inp.period,
            catchUpEntry: c.catchUpAmount
              ? { entity: inp.entity, date: un.periodEnd, type: 'amortization', description: `Catch-up amortization ${c.vendor} ${c.billNumber} (${c.monthsElapsedThroughPeriod} months)`, lines: [{ account: a.suggestedExpenseAccount ?? '6700', debit: c.catchUpAmount, department: c.department, vendorId: c.vendorId, memo: `Catch-up ${c.billNumber}` }, { account: a.account, credit: c.catchUpAmount, vendorId: c.vendorId, memo: `Catch-up ${c.billNumber}` }] }
              : null,
          },
        });
      }
    }
    return `Prepaids ${inp.entity} ${inp.period}: ${due.schedules.length} schedule(s) amortized, ${un.accounts.length} prepaid account(s) with unscheduled balances. ${tally(agent)}.`;
  },
};

// ------------------------------------------------------------------ depreciation

const depreciation: SkillEngine = {
  key: 'fixed-asset-depreciation',
  brief: (a) => `Post depreciation for ${input(a).entity} ${input(a).period}.`,
  async offline(agent) {
    const inp = input(agent);
    await agent.plan(['Read depreciation due from the asset register', 'Propose the depreciation entry by department']);
    const d = await agent.call<{ currency: string; periodEnd: string; total: number; lines: Array<{ id: string; assetNumber: string; description: string; amount: number; department: string | null; expenseAccount: string; accumulatedAccount: string }> }>('fa_depreciation_due', { entity: inp.entity, period: inp.period });
    if (!d.lines.length) return `No depreciation due for ${inp.entity} ${inp.period}.`;
    const byDept = new Map<string, number>();
    for (const l of d.lines) byDept.set(l.department ?? '', (byDept.get(l.department ?? '') ?? 0) + l.amount);
    await tryPropose(agent, 'propose_journal_entry', {
      title: `Depreciation ${inp.entity} ${inp.period} ${money(d.total, d.currency)} (${d.lines.length} assets)`,
      why: `Straight-line depreciation from the fixed-asset register: ${d.lines.map((l) => `${l.assetNumber} ${money(l.amount, d.currency)}`).join(', ')}.`,
      confidence: 0.99,
      evidence: d.lines.map((l) => ({ type: 'depreciation_line', id: l.id, label: `${l.assetNumber} ${l.description}` })),
      key: `depr:${inp.entity}:${inp.period}`,
      entry: {
        entity: inp.entity,
        date: d.periodEnd,
        type: 'depreciation',
        description: `Depreciation ${inp.period} (${d.lines.length} assets)`,
        lines: [...[...byDept.entries()].map(([dept, amount]) => ({ account: d.lines[0]!.expenseAccount, debit: amount, department: dept || null, memo: 'Monthly depreciation' })), { account: d.lines[0]!.accumulatedAccount, credit: d.total, memo: 'Accumulated depreciation' }],
      },
      sourceModule: 'fixed_assets',
      links: { depreciationLineIds: d.lines.map((l) => l.id) },
    });
    return `Depreciation ${inp.entity} ${inp.period}: ${money(d.total, d.currency)} across ${d.lines.length} assets. ${tally(agent)}.`;
  },
};

// ------------------------------------------------------------------ intercompany

interface IcResult {
  pairs: Array<{ reference: string; status: string; difference: number; receivable: { entityCode: string; counterpartyCode: string; amountTxn: number; txnCurrency: string; date: string; journalEntryId: string; description: string } | null; payable: { entityCode: string; counterpartyCode: string; amountTxn: number; txnCurrency: string; date: string; journalEntryId: string } | null; entries: Array<{ entity: string; entryId: string; entryNumber: string; memo: string | null; amountTxn: number; currency: string; date: string }> }>;
  balances: { receivableEntity: string; receivable: number; payableEntity: string; payableInAgreementCurrency: number; difference: number };
  accounts: { receivable: string; payable: string; revenue: string; expense: string };
}

const intercompany: SkillEngine = {
  key: 'intercompany',
  brief: (a) => `Reconcile intercompany for ${input(a).period}.`,
  async offline(agent) {
    const inp = input(agent);
    await agent.plan(['Pair intercompany charges by reference', 'Explain mismatches from the entry memos', 'Propose the true-up on the under-recorded side', 'Summarize']);
    const r = await agent.call<IcResult>('ic_reconcile', { period: inp.period });
    const fxQuote = await agent.call<{ entities: CloseContext['entities'] }>('close_context', { closeId: inp.closeId });
    for (const p of r.pairs.filter((x) => x.status !== 'matched')) {
      const memo = p.entries.map((e) => `${e.entity} ${e.entryNumber}: ${e.memo ?? ''}`).join(' | ');
      if ((p.status === 'amount_mismatch' && p.difference > 0) || p.status === 'missing_payable') {
        const rec = p.receivable!;
        const payEntity = rec.counterpartyCode;
        const target = fxQuote.entities.find((e) => e.code === payEntity);
        const rate = await spotRate(agent, rec.txnCurrency, target?.currency ?? rec.txnCurrency, rec.date);
        const functional = Math.round(p.difference * rate);
        await tryPropose(agent, 'propose_journal_entry', {
          title: `True up ${p.reference}: ${payEntity} recorded ${money(p.payable?.amountTxn ?? 0, rec.txnCurrency)}, ${rec.entityCode} billed ${money(rec.amountTxn, rec.txnCurrency)}`,
          why: `${rec.entityCode} billed ${money(rec.amountTxn, rec.txnCurrency)} under ${p.reference} but ${payEntity} recorded ${money(p.payable?.amountTxn ?? 0, rec.txnCurrency)}; difference ${money(p.difference, rec.txnCurrency)}. The billing entry explains it: ${memo}. ${payEntity} should record the missing ${money(p.difference, rec.txnCurrency)} so both sides agree before elimination.`,
          confidence: 0.82,
          evidence: p.entries.map((e) => ({ type: 'journal_entry', id: e.entryId, label: `${e.entity} ${e.entryNumber} ${money(e.amountTxn, e.currency)}` })),
          key: `ic-trueup:${p.reference}`,
          entry: {
            entity: payEntity,
            date: target?.period?.end ?? rec.date,
            type: 'adjusting',
            description: `Record ${p.reference} difference billed by ${rec.entityCode}`,
            currency: rec.txnCurrency,
            fxRate: Number(rate.toFixed(8)),
            icReference: p.reference,
            counterpartyEntity: rec.entityCode,
            lines: [
              { account: r.accounts.expense, debit: functional, counterpartyEntity: rec.entityCode, txnCurrency: rec.txnCurrency, txnAmount: p.difference, memo: `${p.reference} true-up (spot ${rate.toFixed(6)} on ${rec.date})` },
              { account: r.accounts.payable, credit: functional, counterpartyEntity: rec.entityCode, txnCurrency: rec.txnCurrency, txnAmount: -p.difference, memo: `${p.reference} true-up` },
            ],
          },
          sourceModule: 'intercompany',
        });
      } else {
        await tryPropose(agent, 'propose_anomaly', {
          title: `Intercompany ${p.reference}: ${p.status.replace('_', ' ')} ${money(Math.abs(p.difference))}`,
          why: `Both sides of ${p.reference} must agree. ${memo}`,
          confidence: 0.7,
          evidence: p.entries.map((e) => ({ type: 'journal_entry', id: e.entryId, label: e.entryNumber })),
          key: `ic:${p.reference}`,
          amountMinor: Math.abs(p.difference),
          entity: null,
          period: inp.period,
          category: 'ic_mismatch',
          severity: 'medium',
          subjectIds: p.entries.map((e) => e.entryId),
          recommendedAction: 'Have the billing entity confirm the charge and the other side record or dispute it.',
          resolution: { type: 'none' },
        });
      }
    }
    const matched = r.pairs.filter((p) => p.status === 'matched').length;
    return `Intercompany ${inp.period}: ${matched} of ${r.pairs.length} charge(s) agree; receivable ${money(r.balances.receivable)} vs payable ${money(r.balances.payableInAgreementCurrency)} (difference ${money(r.balances.difference)}). ${tally(agent)}.`;
  },
};

/** Spot rate quote via the entity's FX table (functional per one unit of `from`). */
async function spotRate(agent: AgentHandle, from: string, to: string, date: string): Promise<number> {
  if (from === to) return 1;
  const q = await agent.call<{ rate: number }>('fx_rate', { from, to, date, type: 'spot' });
  return q.rate;
}

// ------------------------------------------------------------------ FX revaluation

const fxRevaluation: SkillEngine = {
  key: 'fx-revaluation',
  brief: (a) => `Remeasure foreign-currency balances for ${input(a).period}.`,
  async offline(agent) {
    const inp = input(agent);
    await agent.plan(['Find foreign-currency monetary balances per entity', 'Remeasure at the closing rate', 'Propose the revaluation entries']);
    const ctx = await agent.call<CloseContext>('close_context', { closeId: inp.closeId });
    const parts: string[] = [];
    for (const e of ctx.entities.filter((x) => x.kind === 'operating')) {
      const b = await agent.call<{ entity: string; functionalCurrency: string; periodEnd: string; gainLossAccount: string; currencies: Array<{ currency: string; closingRate: number; adjustments: Array<{ accountNumber: string; accountName: string; txnBalance: number; carrying: number; remeasured: number; adjustment: number }> }>; postedRevaluations: unknown[] }>('fx_monetary_balances', { entity: e.code, period: inp.period });
      if (b.postedRevaluations.length) continue;
      for (const c of b.currencies) {
        for (const adj of c.adjustments) {
          const amt = Math.abs(adj.adjustment);
          const loss = adj.adjustment < 0;
          const counterparty = ctx.entities.find((x) => x.code !== e.code && x.kind === 'operating')?.code ?? null;
          const isIc = /intercompany|due to|due from/i.test(adj.accountName);
          await tryPropose(agent, 'propose_journal_entry', {
            title: `Revalue ${e.code} ${c.currency} ${adj.accountName}: unrealized ${loss ? 'loss' : 'gain'} ${money(amt, b.functionalCurrency)}`,
            why: `${adj.accountName} holds ${money(Math.abs(adj.txnBalance), c.currency)} carried at ${money(Math.abs(adj.carrying), b.functionalCurrency)}. At the ${b.periodEnd} closing rate (${c.closingRate} ${b.functionalCurrency} per ${c.currency}) it is ${money(Math.abs(adj.remeasured), b.functionalCurrency)}, so ASC 830 remeasurement books an unrealized ${loss ? 'loss' : 'gain'} of ${money(amt, b.functionalCurrency)}.`,
            confidence: 0.97,
            evidence: [{ type: 'account', id: null, label: `${adj.accountNumber} ${adj.accountName}` }, { type: 'fx_rate', id: null, label: `${c.currency}/${b.functionalCurrency} closing ${c.closingRate}` }],
            key: `reval:${e.code}:${inp.period}:${adj.accountNumber}:${c.currency}`,
            entry: {
              entity: e.code,
              date: b.periodEnd,
              type: 'revaluation',
              description: `Remeasure ${c.currency} ${adj.accountName} at ${c.closingRate} (${inp.period})`,
              lines: loss
                ? [{ account: b.gainLossAccount, debit: amt, memo: 'Unrealized FX loss' }, { account: adj.accountNumber, credit: amt, txnCurrency: c.currency, txnAmount: 0, counterpartyEntity: isIc ? counterparty : null, memo: 'Remeasure at closing rate' }]
                : [{ account: adj.accountNumber, debit: amt, txnCurrency: c.currency, txnAmount: 0, counterpartyEntity: isIc ? counterparty : null, memo: 'Remeasure at closing rate' }, { account: b.gainLossAccount, credit: amt, memo: 'Unrealized FX gain' }],
            },
            sourceModule: 'fx',
          });
          parts.push(`${e.code} ${adj.accountNumber} ${loss ? '-' : '+'}${money(amt, b.functionalCurrency)}`);
        }
      }
    }
    return `FX revaluation ${inp.period}: ${parts.length ? parts.join(', ') : 'no adjustments needed'}. ${tally(agent)}.`;
  },
};

// ------------------------------------------------------------------ eliminations

const eliminations: SkillEngine = {
  key: 'intercompany-eliminations',
  brief: (a) => `Prepare consolidation eliminations for ${input(a).period}.`,
  async offline(agent) {
    const inp = input(agent);
    await agent.plan(['Compute eliminations with translation differences', 'Propose the income-statement and balance-sheet eliminations']);
    const e = await agent.call<{ rates: { average: number; closing: number }; revenue: number; expenseUsd: number; receivable: number; payableUsd: number; entries: { income: Record<string, unknown> | null; balance: Record<string, unknown> | null }; alreadyPosted: unknown[] }>('elim_candidates', { period: inp.period });
    if (e.alreadyPosted.length) return `Eliminations for ${inp.period} are already posted.`;
    if (e.entries.income) {
      await tryPropose(agent, 'propose_journal_entry', {
        title: `Eliminate intercompany fees ${inp.period}: revenue ${money(e.revenue)} vs expense ${money(e.expenseUsd)}`,
        why: `Intercompany revenue (${money(e.revenue)}) and the subsidiary's expense translated at the ${inp.period} average rate ${e.rates.average.toFixed(4)} (${money(e.expenseUsd)}) are eliminated in consolidation; the ${money(Math.abs(e.revenue - e.expenseUsd))} difference is translation (ASC 830), presented in FX.`,
        confidence: 0.97,
        evidence: [{ type: 'calc', id: null, label: `Average rate ${e.rates.average.toFixed(4)}` }],
        key: `elim:is:${inp.period}`,
        entry: e.entries.income,
        sourceModule: 'intercompany',
      });
    }
    if (e.entries.balance) {
      await tryPropose(agent, 'propose_journal_entry', {
        title: `Eliminate intercompany balances ${inp.period}: ${money(e.receivable)} receivable vs ${money(e.payableUsd)} payable`,
        why: `The parent's intercompany receivable (${money(e.receivable)}) and the subsidiary's payable translated at the closing rate ${e.rates.closing.toFixed(4)} (${money(e.payableUsd)}) eliminate; the difference goes to CTA. Reverses on the first day of next period.`,
        confidence: 0.97,
        evidence: [{ type: 'calc', id: null, label: `Closing rate ${e.rates.closing.toFixed(4)}` }],
        key: `elim:bs:${inp.period}`,
        entry: e.entries.balance,
        sourceModule: 'intercompany',
      });
    }
    return `Eliminations ${inp.period} proposed. ${tally(agent)}.`;
  },
};

// ------------------------------------------------------------------ JE review

interface ReviewFinding extends AnomalyFinding {
  payments?: Array<{ id: string; vendorId: string; vendorName: string; date: string; amount: number; reference: string; bills: Array<{ id: string; billNumber: string; amount: number; billDate: string; accountNumber?: string; departmentCode?: string | null; entity?: string }> }>;
  entry?: { id: string; entryNumber: string; entityId: string; date: string; description: string; total: number; source: string; lines: Array<{ accountNumber: string; accountClass: string; debit: number; credit: number }> };
}

const jeReview: SkillEngine = {
  key: 'je-review',
  brief: (a) => `Review journal entries and payments for ${input(a).period}.`,
  async offline(agent) {
    const inp = input(agent);
    await agent.plan(['Test the population of manual, imported and agent entries and vendor payments', 'Raise findings with a recommended resolution', 'Report Benford conformity']);
    const ctx = await agent.call<CloseContext>('close_context', { closeId: inp.closeId });
    const s = await agent.call<{ population: { entriesTested: number; paymentsTested: number }; findings: ReviewFinding[]; benford: { n: number; mad: number; conformity: string; population?: string }; accounts: { refundReceivable: string } }>('je_scan_anomalies', { period: inp.period });
    const minSeverity = Number(agent.policy.thresholds.minSeverity ?? 2);
    const rank = { low: 1, medium: 2, high: 3 } as const;
    for (const f of s.findings) {
      if (rank[f.severity] < minSeverity) {
        await agent.note(`Noted (below review threshold): ${f.title}`, { why: f.why }, 'observation');
        continue;
      }
      if (f.kind === 'duplicate_payment' && f.payments?.length === 2) {
        const dup = f.payments[1]!;
        const bill = dup.bills[0];
        const entity = bill?.entity ?? ctx.entities.find((e) => e.kind === 'operating')!.code;
        const end = ctx.entities.find((e) => e.code === entity)?.period?.end ?? ctx.close.periodEnd;
        await tryPropose(agent, 'propose_anomaly', {
          title: `Duplicate payment to ${dup.vendorName}: ${money(dup.amount, ctx.entities.find((x) => x.code === entity)?.currency)} paid twice for one invoice`,
          why: `${f.why} The second bill (${bill?.billNumber}) was entered from the AP inbox with a reformatted invoice number, so the system treated it as new. Recover the cash: reclassify the duplicate payment to vendor refunds receivable, void the duplicate bill and ask ${dup.vendorName} for the refund.`,
          confidence: f.score,
          evidence: f.evidence,
          key: `anomaly:duplicate_payment:${[...f.subjectIds].sort().join(',')}`,
          amountMinor: dup.amount,
          entity,
          period: inp.period,
          category: 'duplicate_payment',
          severity: f.severity,
          subjectIds: f.subjectIds,
          vendorIds: [dup.vendorId],
          recommendedAction: f.recommendedAction,
          resolution: {
            type: 'journal_entry',
            entry: { entity, date: end, type: 'reclass', description: `Reclassify duplicate payment ${dup.reference} to ${dup.vendorName} as refund receivable`, lines: [{ account: s.accounts.refundReceivable, debit: dup.amount, vendorId: dup.vendorId, memo: `Refund due: duplicate of ${f.payments[0]!.bills[0]?.billNumber ?? ''}` }, { account: bill?.accountNumber ?? '6510', credit: dup.amount, department: bill?.departmentCode ?? 'GA', vendorId: dup.vendorId, memo: `Reverse duplicate bill ${bill?.billNumber ?? ''}` }] },
            voidBillIds: bill ? [bill.id] : [],
          },
        });
        continue;
      }
      if (f.flags.includes('sod_break') && f.entry) {
        const e = f.entry;
        await tryPropose(agent, 'propose_anomaly', {
          title: `Reverse ${e.entryNumber}: ${money(e.total, ctx.entities.find((x) => x.id === e.entityId)?.currency)} entry ${f.flags.includes('revenue_manual') ? 'crediting revenue ' : ''}prepared and approved by the same person`,
          why: `${f.why} Manual entries need an independent approver (maker-checker); this one had none, credits revenue with no invoice behind it, and posts straight to a control account. Reverse it until someone independent reviews support for the adjustment.`,
          confidence: f.score,
          evidence: f.evidence,
          key: `anomaly:reverse:${e.id}`,
          amountMinor: e.total,
          entity: ctx.entities.find((x) => x.id === e.entityId)?.code ?? null,
          period: inp.period,
          category: 'sod_break',
          severity: f.severity,
          subjectIds: f.subjectIds,
          recommendedAction: f.recommendedAction,
          resolution: { type: 'reverse_entry', entryId: e.id, reason: 'Self-approved manual revenue adjustment without support (SoD break); reversed pending independent review' },
        });
        continue;
      }
      await tryPropose(agent, 'propose_anomaly', {
        title: f.title,
        why: f.why,
        confidence: f.score,
        evidence: f.evidence,
        key: `anomaly:${f.kind}:${[...f.subjectIds].sort().join(',')}`,
        amountMinor: f.amount,
        entity: f.entry ? (ctx.entities.find((x) => x.id === f.entry!.entityId)?.code ?? null) : null,
        period: inp.period,
        category: f.kind,
        severity: f.severity,
        subjectIds: f.subjectIds,
        recommendedAction: f.recommendedAction,
        resolution: { type: 'none' },
      });
    }
    await agent.note(`Benford first-digit test: ${s.benford.conformity} (MAD ${s.benford.mad}, n = ${s.benford.n}${s.benford.population ? ` ${s.benford.population}` : ''})`, { benford: s.benford }, 'observation');
    return `Reviewed ${s.population.entriesTested} entries and ${s.population.paymentsTested} payments for ${inp.period}: ${s.findings.length} red flag(s). Benford ${s.benford.conformity}. ${tally(agent)}.`;
  },
};

// ------------------------------------------------------------------ flux

const fluxAnalysis: SkillEngine = {
  key: 'flux-analysis',
  brief: (a) => `Explain material variances for ${input(a).period}.`,
  async offline(agent) {
    const inp = input(agent);
    await agent.plan(['Compute the flux workpaper', 'Decompose each material variance into drivers', 'Draft explanations for FP&A']);
    const f = await agent.call<{ analysisId: string; comparison: string; lines: Array<{ id: string; account: string; name: string; variance: number; variancePct: number | null; material: boolean; explanationStatus: string }> }>('flux_compute', { closeId: inp.closeId, comparison: inp.comparison ?? 'prior_month' });
    const material = f.lines.filter((l) => l.material);
    for (const l of material.filter((x) => x.explanationStatus === 'missing' || x.explanationStatus === 'rejected')) {
      const d = await agent.call<{ drivers: Array<{ kind: string; label: string; amount_minor: number; evidence?: Array<{ type: string; id: string; label: string }> }>; coverage: number; draft: string; confidence: number }>('flux_drivers', { fluxLineId: l.id });
      const evidence: EvidenceRef[] = [{ type: 'flux_line', id: l.id, label: `${l.account} ${l.name}` }, ...d.drivers.flatMap((x) => (x.evidence ?? []).slice(0, 2))].slice(0, 12);
      await tryPropose(agent, 'propose_flux_explanation', {
        title: `Explain ${l.account} ${l.name}: ${l.variance > 0 ? '+' : '-'}${money(Math.abs(l.variance))}${l.variancePct === null ? '' : ` (${(l.variancePct * 100).toFixed(0)}%)`}`,
        why: `Variance exceeds the policy thresholds. Drivers account for ${(d.coverage * 100).toFixed(0)}% of the change.`,
        confidence: d.confidence,
        evidence,
        key: `flux:${l.id}`,
        fluxLineId: l.id,
        explanation: d.draft,
        drivers: d.drivers,
        coverage: d.coverage,
      });
    }
    return `Flux ${inp.period} (${f.comparison.replace('_', ' ')}): ${material.length} material variance(s) of ${f.lines.length} lines. ${tally(agent)}.`;
  },
};

// ------------------------------------------------------------------ close package & orchestrator

const closePackage: SkillEngine = {
  key: 'close-package',
  brief: () => 'Assemble the close package.',
  async offline(agent) {
    const inp = input(agent);
    await agent.plan(['Check close status', 'Assemble and propose the close package']);
    const ctx = await agent.call<CloseContext>('close_context', { closeId: inp.closeId });
    const st = await agent.call<{ progress: { done: number; total: number }; blockers: Array<{ message: string }> }>('close_status', { closeId: inp.closeId });
    const open = st.blockers.filter((b) => !/close package|Lock the period|Prepare the close package/i.test(b.message));
    // Not tryPropose: without a package this run must fail rather than complete the task.
    await agent.call('propose_close_package', {
      title: `Close package: ${ctx.close.name}`,
      why: `Consolidated statements, entity trial balances, flux commentary, reconciliation sign-offs, exceptions and the agent/approval record for ${ctx.close.name}. ${st.progress.done} of ${st.progress.total} tasks done.${open.length ? ` Still open: ${open.slice(0, 4).map((b) => b.message).join('; ')}.` : ' Nothing else is open.'}`,
      confidence: open.length ? 0.8 : 0.96,
      evidence: [{ type: 'close', id: ctx.close.id, label: ctx.close.name }],
      key: `package:${ctx.close.id}`,
      closeId: ctx.close.id,
    });
    return `Close package for ${ctx.close.name} proposed for approval. ${tally(agent)}.`;
  },
};

const TASK_INPUTS: Record<string, Record<string, unknown>> = {
  'ap-tieout': { ledger: 'ap' },
  'ar-tieout': { ledger: 'ar' },
  flux: { comparison: 'prior_month' },
};

const closeOrchestrator: SkillEngine = {
  key: 'close-orchestrator',
  async offline(agent) {
    const inp = input(agent);
    await agent.plan(['Find tasks whose dependencies are satisfied', 'Start each task\'s agent', 'Repeat until only human decisions remain']);
    const maxWaves = Number(agent.policy.thresholds.maxWaves ?? 8);
    const attempted = new Set<string>();
    const skipped: string[] = [];
    let runs = 0;
    let proposals = 0;
    let auto = 0;
    let pending = 0;
    for (let wave = 1; wave <= maxWaves; wave++) {
      const ready = await agent.call<{ tasks: Array<{ id: string; key: string; title: string; skillKey: string; entity: string | null; entityId: string | null; period: string; periodId: string | null }> }>('close_ready_tasks', { closeId: inp.closeId });
      const todo = ready.tasks.filter((t) => !attempted.has(t.id));
      if (!todo.length) break;
      await agent.note(`Wave ${wave}: ${todo.map((t) => t.title).join(', ')}`, { tasks: todo.map((t) => t.key) }, 'decision');
      for (const t of todo) {
        attempted.add(t.id);
        const res = await agent.spawn({ skillKey: t.skillKey, input: { closeId: inp.closeId, closeTaskId: t.id, entity: t.entity, period: t.period, ...(TASK_INPUTS[t.key] ?? {}) }, closeTaskId: t.id, entityId: t.entityId, periodId: t.periodId, label: t.title });
        if (res.status === 'skipped') {
          skipped.push(`${t.title} (${res.summary})`);
          continue;
        }
        runs++;
        proposals += res.proposals;
        auto += res.autoApplied;
        pending += res.pending;
      }
    }
    const st = await agent.call<{ progress: { done: number; total: number; review: number } }>('close_status', { closeId: inp.closeId });
    return `Ran ${runs} agent${runs === 1 ? '' : 's'}: ${proposals} proposal(s), ${auto} auto-applied under policy, ${pending} waiting for your approval. Close progress: ${st.progress.done}/${st.progress.total} tasks done, ${st.progress.review} with reviewers.${skipped.length ? ` Left for someone with the right role: ${skipped.join('; ')}.` : ''}`;
  },
};

export const ACCOUNTING_ENGINES: SkillEngine[] = [transactionCoding, bankReconciliation, subledgerTieout, accrualDetection, prepaidAmortization, depreciation, intercompany, fxRevaluation, eliminations, jeReview, fluxAnalysis, closePackage, closeOrchestrator];
