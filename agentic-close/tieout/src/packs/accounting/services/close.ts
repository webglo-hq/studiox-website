/**
 * Close management: the checklist with dependencies and workday due dates, readiness to lock
 * (AX-CL-02) and the close package (trial balances, statements, commentary, reconciliations,
 * open items, agent activity).
 */
import { invariant } from '../../../core/util/errors';
import { periodEnd, periodLabel } from '../../../core/util/time';
import type { CloseTaskRow, ProposalRow } from '../../../schema';
import { formatWorkday, workdayOffset } from '../close/workdays';
import { balancesAsOf, trialBalanceRows } from '../ledger/balances';
import { consolidatedStatements, incomeStatementTies, type IncomeStatementTie } from '../ledger/statements';
import type { ClosePackageContent } from '../model/types';
import { closeOntology } from '../ontology';
import { BankService } from './bank';
import type { AcctContext } from './context';
import { FluxService, isExplained, staleExplanationMessage } from './flux';
import { SubledgerService } from './subledgers';

export interface TaskView extends CloseTaskRow {
  /** prerequisite task keys (for agents and the MCP server) */
  dependsOn: string[];
  openDependencies: string[];
  /** the same prerequisites by title, for people */
  dependsOnTitles: string[];
  waitingOn: string[];
  dueLabel: string;
  overdue: boolean;
  ownerName: string | null;
  reviewerName: string | null;
}

export interface Readiness {
  pendingProposals: number;
  openRecs: number;
  unexplainedFlux: number;
  openTasks: number;
  finalPackage: boolean;
  /** the approved package was signed for figures or explanations the books have since left behind */
  stalePackage: boolean;
  /** income statements (each entity's and the consolidated one) whose net income differs from the ledger (AX-FS-01) */
  untiedStatements: number;
  ready: boolean;
  messages: string[];
}

const PENDING: ProposalRow['status'][] = ['pending_approval', 'suggested', 'approved'];
/** reconciling items that are exceptions, not routine timing differences */
const EXCEPTIONS = new Set(['unexplained', 'bank_error', 'book_error', 'other']);

export class CloseService {
  constructor(private readonly c: AcctContext) {}

  async tasks(periodKey: string): Promise<{ closePeriod: Awaited<ReturnType<CloseService['closePeriod']>>; tasks: TaskView[]; businessDate: string; workday: string | null }> {
    const cp = await this.closePeriod(periodKey);
    const businessDate = await this.c.businessDate();
    const wd = workdayOffset(periodKey, businessDate);
    if (!cp) return { closePeriod: null, tasks: [], businessDate, workday: wd === null ? null : formatWorkday(wd) };
    const rows = await this.c.tx.find('close_tasks', { close_period_id: cp.id }, { orderBy: [['sort_order', 'asc']] });
    const deps = await this.c.tx.find('close_task_dependencies', { task_id: { in: rows.map((r) => r.id) } });
    const users = new Map((await this.c.tx.find('users', {})).map((u) => [u.id, u.display_name]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const tasks = rows.map((t) => {
      const mine = deps.filter((d) => d.task_id === t.id).map((d) => byId.get(d.depends_on_task_id)!).filter(Boolean);
      return {
        ...t,
        dependsOn: mine.map((d) => d.key),
        openDependencies: mine.filter((d) => d.status !== 'done' && d.status !== 'skipped').map((d) => d.key),
        dependsOnTitles: mine.map((d) => d.title),
        waitingOn: mine.filter((d) => d.status !== 'done' && d.status !== 'skipped').map((d) => d.title),
        dueLabel: formatWorkday(t.workday_offset),
        overdue: t.status !== 'done' && t.status !== 'skipped' && t.due_date < businessDate,
        ownerName: t.owner_id ? (users.get(t.owner_id) ?? null) : null,
        reviewerName: t.reviewer_id ? (users.get(t.reviewer_id) ?? null) : null,
      };
    });
    return { closePeriod: cp, tasks, businessDate, workday: wd === null ? null : formatWorkday(wd) };
  }

  async closePeriod(periodKey: string) {
    return (await this.c.tx.findOne('close_periods', { period_key: periodKey })) ?? null;
  }

  /**
   * AX-CL-02. `forPackage`: the conditions a close package reports on, i.e. every lock condition
   * except the package itself and its own checklist task (a package cannot wait for its own approval).
   */
  async readiness(periodKey: string, opts: { forPackage?: boolean } = {}): Promise<Readiness> {
    const legal = await this.c.legalEntities();
    const pendingProposals = (await this.c.tx.find('proposals', { period_key: periodKey, status: { in: PENDING } })).length;
    let openRecs = 0;
    const bank = new BankService(this.c);
    for (const ba of await bank.accounts()) {
      const st = await bank.state(ba.id, periodKey);
      if (st.reconciliation?.status !== 'reviewed') openRecs++;
    }
    for (const e of legal) {
      const period = await this.c.period(e.id, periodKey);
      for (const t of ['subledger_ap', 'subledger_ar'] as const) {
        const r = await this.c.tx.findOne('reconciliations', { entity_id: e.id, period_id: period.id, rec_type: t });
        if (r?.status !== 'reviewed') openRecs++;
      }
    }
    let unexplainedFlux = 0;
    const flux = new FluxService(this.c);
    for (const e of legal) {
      const f = await flux.compute(e.id, periodKey);
      // an explanation approved for a variance the ledger has since moved does not count (AX-FLX-01)
      unexplainedFlux += f.lines.filter((l) => l.exceeds && !isExplained(l)).length;
    }
    const cp = await this.closePeriod(periodKey);
    const tasks = cp ? await this.c.tx.find('close_tasks', { close_period_id: cp.id }) : [];
    const openTasks = tasks.filter((t) => t.key !== 'lock' && !(opts.forPackage && t.key === 'close-package') && t.status !== 'done' && t.status !== 'skipped').length;
    const final = opts.forPackage ? undefined : (await this.c.tx.find('close_packages', { period_key: periodKey, status: 'final' }, { orderBy: [['version', 'desc']], limit: 1 }))[0];
    const ties = await incomeStatementTies(this.c.tx, await this.c.chart(), periodKey);
    const untied = ties.filter((t) => !t.ties);
    // a package signed before the books moved (a later posting, a variance explained again) no longer
    // describes them, nor does one drafted while other lock conditions were still open
    const staleBecause = final ? [...(await this.commentaryProblems(periodKey, final.content)), ...netIncomeProblems(final.content, ties), ...(final.content.readiness?.ready === false ? [`it was drafted while the close still had open work (${final.content.readiness.messages.join('; ')})`] : [])] : [];
    const out = closeOntology().check('AX-CL-02', { pendingProposals, openRecs, unexplainedFlux, openTasks, finalPackage: opts.forPackage ? undefined : !!final, untiedStatements: untied.length, stalePackage: staleBecause.length > 0 });
    return { pendingProposals, openRecs, unexplainedFlux, openTasks, finalPackage: !!final, stalePackage: staleBecause.length > 0, untiedStatements: untied.length, ready: out.passed, messages: [...out.messages, ...untied.map((t) => t.message ?? `${t.statement} does not tie to the ledger`), ...staleBecause.map((m) => `Package v${final!.version}: ${m}`)] };
  }

  /**
   * AX-FLX-01 against a package: every significant variance has an approved explanation of the
   * variance as it stands, and the package carries exactly that explanation for exactly that variance.
   */
  async commentaryProblems(periodKey: string, content: ClosePackageContent): Promise<string[]> {
    const problems: string[] = [];
    const flux = new FluxService(this.c);
    for (const e of await this.c.legalEntities()) {
      const lines = (await flux.compute(e.id, periodKey)).lines;
      for (const l of lines.filter((x) => x.exceeds)) {
        const label = `${e.code} ${l.code} ${l.name}`;
        const c = content.commentary.find((x) => x.entityCode === e.code && x.accountCode === l.code);
        if (!isExplained(l)) problems.push(`${label}: ${l.explanation?.stale ? 'the ledger moved after its explanation was approved' : 'no approved explanation'}`);
        else if (!c || (c.status ?? (c.approvedBy ? 'approved' : 'pending')) !== 'approved') problems.push(`${label}: ${c?.status === 'out_of_date' ? 'the package carries an out-of-date explanation' : 'the package has no approved explanation'}`);
        else if (c.varianceMinor !== l.varianceMinor || c.text !== l.explanation!.text) problems.push(`${label}: the package explains a different change than the ledger now shows`);
      }
      // commentary for a variance the ledger has since moved below the threshold is out of date too
      for (const c of content.commentary.filter((x) => x.entityCode === e.code)) {
        const l = lines.find((x) => x.code === c.accountCode);
        if (!l?.exceeds && (l?.varianceMinor ?? 0) !== c.varianceMinor) problems.push(`${e.code} ${c.accountCode} ${c.accountName}: the package explains a different change than the ledger now shows`);
      }
    }
    return problems;
  }

  /** AX-FLX-01 at sign-off: nobody approves a package whose commentary no longer explains the books. */
  async assertVariancesExplained(periodKey: string, content: ClosePackageContent) {
    const problems = await this.commentaryProblems(periodKey, content);
    if (problems.length) throw invariant('AX-FLX-01', `${problems.length} significant variance${problems.length === 1 ? ' has' : 's have'} no current approved explanation in this package (${problems.join('; ')}). Explain ${problems.length === 1 ? 'it' : 'them'}, then draft a new version of the package.`, { problems });
  }

  /** AX-FS-01 before anything is signed: every entity's income statement and the consolidated one tie to the ledger. */
  async assertStatementsTie(periodKey: string) {
    const ties = await incomeStatementTies(this.c.tx, await this.c.chart(), periodKey);
    const bad = ties.filter((t) => !t.ties);
    if (bad.length) throw invariant('AX-FS-01', bad.map((t) => t.message ?? `${t.statement} does not tie to the ledger`).join('; '), { statements: bad.map((t) => t.statement) });
    return ties;
  }

  async packageContent(periodKey: string, generatedBy: string): Promise<ClosePackageContent> {
    const chart = await this.c.chart();
    const legal = chart.legalEntities();
    const end = periodEnd(periodKey);
    // a package never carries an income statement that disagrees with the ledger
    const ties = await this.assertStatementsTie(periodKey);
    const trialBalances: ClosePackageContent['trialBalances'] = [];
    for (const e of chart.entities) {
      const tb = trialBalanceRows(chart, await balancesAsOf(this.c.tx, [e.id], end));
      trialBalances.push({ entityCode: e.code, currency: e.functional_currency, rows: tb.rows.map((r) => ({ code: r.code, name: r.name, debitMinor: r.debitMinor, creditMinor: r.creditMinor })), totalDebitMinor: tb.totalDebitMinor, totalCreditMinor: tb.totalCreditMinor });
    }
    const cons = await consolidatedStatements(this.c.tx, chart, periodKey, 'USD');
    const users = new Map((await this.c.tx.find('users', {})).map((u) => [u.id, u.display_name]));
    const flux = new FluxService(this.c);
    const commentary: ClosePackageContent['commentary'] = [];
    for (const e of legal) {
      const f = await flux.compute(e.id, periodKey);
      for (const l of f.lines.filter((x) => x.exceeds)) {
        // only an approved explanation of the variance as it stands goes into the package
        const current = isExplained(l);
        const status = current ? 'approved' : l.explanation?.stale ? 'out_of_date' : 'pending';
        const text = current ? l.explanation!.text : status === 'out_of_date' ? staleExplanationMessage(l.explanation!.covered, l, e.functional_currency) : 'Explanation pending.';
        commentary.push({ accountCode: l.code, accountName: l.name, entityCode: e.code, currency: e.functional_currency, varianceMinor: l.varianceMinor, variancePct: l.variancePct, text, status, approvedBy: current && l.explanation!.approved_by ? (users.get(l.explanation!.approved_by) ?? l.explanation!.approved_by) : null });
      }
    }
    const reconciliations: ClosePackageContent['reconciliations'] = [];
    const bank = new BankService(this.c);
    for (const ba of await bank.accounts()) {
      const st = await bank.state(ba.id, periodKey);
      reconciliations.push({ entityCode: chart.entity(ba.entity_id).code, account: `${chart.account(ba.gl_account_id).code} ${ba.name}`, recType: 'bank', status: st.reconciliation?.status ?? 'not_started', unreconciledMinor: st.unreconciledMinor, preparer: st.reconciliation?.preparer_id ? (users.get(st.reconciliation.preparer_id) ?? null) : null, reviewer: st.reconciliation?.reviewer_id ? (users.get(st.reconciliation.reviewer_id) ?? null) : null });
    }
    const sub = new SubledgerService(this.c);
    for (const e of legal) {
      const period = await this.c.period(e.id, periodKey);
      for (const kind of ['ap', 'ar'] as const) {
        const t = await sub.tieOut(e.id, kind, end);
        const r = await this.c.tx.findOne('reconciliations', { entity_id: e.id, period_id: period.id, rec_type: kind === 'ap' ? 'subledger_ap' : 'subledger_ar' });
        reconciliations.push({ entityCode: e.code, account: `${t.accountCode} ${kind === 'ap' ? 'Accounts payable' : 'Accounts receivable'}`, recType: kind === 'ap' ? 'subledger_ap' : 'subledger_ar', status: r?.status ?? 'not_started', unreconciledMinor: t.differenceMinor, preparer: r?.preparer_id ? (users.get(r.preparer_id) ?? null) : null, reviewer: r?.reviewer_id ? (users.get(r.reviewer_id) ?? null) : null });
      }
    }
    const pending = await this.c.tx.find('proposals', { period_key: periodKey, status: { in: PENDING } }, { orderBy: [['ref', 'asc']] });
    const openItems: ClosePackageContent['openItems'] = pending.map((p) => ({ kind: p.kind, ref: p.ref, title: p.title, amountMinor: p.amount_minor, currency: p.currency ?? 'USD', entityCode: p.entity_id ? chart.entity(p.entity_id).code : null }));
    // reconciling exceptions still open at month-end (an unexplained bank debit, a bank or book error) are open items too
    for (const ba of await bank.accounts()) {
      const rec = (await bank.state(ba.id, periodKey)).reconciliation;
      const items = rec ? await this.c.tx.find('reconciling_items', { reconciliation_id: rec.id, status: 'open' }, { orderBy: [['item_date', 'asc']] }) : [];
      for (const i of items.filter((x) => EXCEPTIONS.has(x.kind) || x.requires_adjustment)) {
        const code = chart.entity(ba.entity_id).code;
        const ref = i.proposal_id ? (await this.c.tx.get('proposals', i.proposal_id))?.ref : undefined;
        openItems.push({ kind: 'reconciling_item', ref: ref ?? `${code}-${i.item_date}`, title: `${i.description} (${ba.name}, open since ${i.item_date})`.slice(0, 300), amountMinor: i.amount_minor, currency: ba.currency, entityCode: code });
      }
    }
    const runs = await this.c.tx.find('agent_runs', { period_key: periodKey });
    const props = await this.c.tx.find('proposals', { period_key: periodKey });
    const kpi = (codes: string[]) => cons.incomeStatement.filter((l) => codes.some((c) => l.code.startsWith(c)) && !l.isTotal).reduce((s, l) => s + l.amountMinor, 0);
    const revenue = kpi(['IS.REV']);
    const cor = kpi(['IS.COR']);
    const opex = kpi(['IS.OPEX']);
    const cash = cons.balanceSheet.find((l) => l.code === 'BS.CA.CASH')?.amountMinor ?? 0;
    return {
      periodKey,
      periodLabel: periodLabel(periodKey),
      reportingCurrency: 'USD',
      generatedAt: this.c.clock.now().toISOString(),
      generatedBy,
      entities: chart.entities.map((e) => ({ id: e.id, code: e.code, name: e.name, currency: e.functional_currency })),
      trialBalances,
      balanceSheet: cons.balanceSheet,
      incomeStatement: cons.incomeStatement,
      consolidation: { eliminationsMinor: cons.eliminationsMinor, ctaMinor: cons.ctaMinor, closingRate: cons.closingRate, averageRate: cons.averageRate },
      commentary,
      reconciliations,
      openItems,
      agentActivity: {
        runs: runs.length,
        proposals: props.length,
        autoApplied: props.filter((p) => p.route === 'auto_post' || p.route === 'auto_post_sampled').filter((p) => p.status === 'applied').length,
        approved: props.filter((p) => p.status === 'applied' && p.route === 'human_approval').length,
        rejected: props.filter((p) => p.status === 'rejected').length,
        costMicros: runs.reduce((s, r) => s + r.cost_micros, 0),
        mode: runs.some((r) => r.mode === 'live') ? 'live' : 'offline',
      },
      signoffs: [],
      kpis: { revenueMinor: revenue, grossMarginPct: revenue ? Math.round(((revenue - cor) / revenue) * 1000) / 10 : null, opexMinor: opex, netIncomeMinor: cons.netIncomeMinor, cashMinor: cash },
      statementChecks: ties.map((t) => ({ statement: t.statement, currency: t.currency, netIncomeMinor: t.netIncomeMinor!, ledgerNetIncomeMinor: t.ledgerNetIncomeMinor! })),
    };
  }
}

/** The consolidated net income a package was signed for, against the ledger as it stands. */
function netIncomeProblems(content: ClosePackageContent, ties: IncomeStatementTie[]): string[] {
  const now = ties.find((t) => t.statement === 'Consolidated income statement')?.netIncomeMinor;
  const signed = content.kpis?.netIncomeMinor;
  if (now === undefined || now === null || signed === undefined || signed === now) return [];
  const usd = (m: number) => `${m < 0 ? '−' : ''}$${(Math.abs(m) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return [`it shows consolidated net income of ${usd(signed)}; the ledger now gives ${usd(now)}`];
}
