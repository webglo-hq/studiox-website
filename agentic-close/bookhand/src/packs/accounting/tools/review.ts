import { z } from 'zod';
import { addMonths } from '../../../shared/dates';
import { DomainError } from '../../../shared/errors';
import { benford, detectDuplicatePayments, reviewEntries, type ReviewEntry, type ReviewPayment } from '../algorithms/anomaly';
import { decomposeDrivers, draftExplanation, type FluxLineResult } from '../algorithms/flux';
import { closeProgress, taskStates } from '../domain/close';
import { ensureFluxAnalysis, fluxDetail } from '../services/flux';
import { closeBlockers } from '../services/periods';
import { PeriodKey, periodOf, type Tool, type X } from './common';

/** Journal-entry review, flux analysis and close orchestration. */

/** Entries whose amounts are computed, not incurred, so they do not belong in a Benford population. */
const BENFORD_EXCLUDED_TYPES = ['reversing', 'elimination', 'revaluation', 'depreciation', 'amortization', 'opening'] as const;

export const reviewTools: Tool[] = [
  {
    name: 'je_scan_anomalies',
    title: 'Scan journal entries for red flags',
    description: 'Journal-entry testing (PCAOB AS 2401 style) over the period for every entity: segregation-of-duties breaks (including those recorded by a source ERP), manual entries to control or revenue accounts, weekend/holiday postings, round amounts, amounts just below approval limits, duplicate entries, duplicate vendor payments (normalized invoice numbers) and Benford first-digit conformity.',
    input: z.object({ period: PeriodKey }).strict(),
    permission: 'je.view',
    mutation: false,
    untrustedOutput: true,
    ontology: ['bh:JournalEntry', 'bh:SegregationOfDutiesRule', 'bh:MakerChecker'],
    async execute(input: { period: string }, x: X) {
      const { lookups } = x.pack;
      const entries: ReviewEntry[] = [];
      const payments: ReviewPayment[] = [];
      const vendors = new Map((await x.tx.find('vendors', { tenant_id: x.ctx.tenantId })).map((v) => [v.id, v]));
      for (const e of lookups.operatingEntities()) {
        const p = periodOf(x, e.id, input.period);
        const rows = (await x.tx.find('journal_entries', { entity_id: e.id, period_id: p.id, status: 'posted' })).filter((j) => j.source === 'manual' || j.source === 'import' || j.source === 'agent');
        const lines = rows.length ? await x.tx.find('journal_lines', { journal_entry_id: { in: rows.map((r) => r.id) } }) : [];
        for (const j of rows) {
          entries.push({
            id: j.id,
            entryNumber: j.entry_number,
            entityId: j.entity_id,
            date: j.entry_date,
            type: j.entry_type,
            source: j.source,
            description: j.description,
            total: j.total_minor,
            lines: lines.filter((l) => l.journal_entry_id === j.id).map((l) => {
              const a = lookups.accountsById.get(l.account_id)!;
              return { accountNumber: a.number, accountName: a.name, accountClass: a.account_class, isControlAccount: a.is_control_account, debit: l.debit_minor, credit: l.credit_minor };
            }),
            preparedBy: j.prepared_by,
            approvedBy: j.approved_by,
            externalPreparedBy: j.external_prepared_by,
            externalApprovedBy: j.external_approved_by,
            preparedByRunId: j.prepared_by_run_id,
            currency: e.functional_currency,
          });
        }
        const lookbackStart = (() => {
          const m = addMonths(p.fiscal_year, p.period_number, -1);
          return `${m.year}-${String(m.month).padStart(2, '0')}-01`;
        })();
        const pays = (await x.tx.find('vendor_payments', { entity_id: e.id, payment_date: { between: [lookbackStart, p.end_date] } })).filter((v) => v.status !== 'void');
        for (const pay of pays) {
          const apps = await x.tx.find('payment_applications', { payment_id: pay.id });
          const bills = apps.length ? await x.tx.find('bills', { id: { in: apps.map((a) => a.bill_id) } }) : [];
          const billLines = bills.length ? await x.tx.find('bill_lines', { bill_id: { in: bills.map((b) => b.id) } }) : [];
          payments.push({
            id: pay.id,
            vendorId: pay.vendor_id,
            vendorName: vendors.get(pay.vendor_id)?.name ?? '',
            date: pay.payment_date,
            amount: pay.amount_minor,
            reference: pay.reference,
            currency: pay.currency,
            bills: bills.map((b) => {
              const bl = billLines.find((l) => l.bill_id === b.id);
              return { id: b.id, billNumber: b.bill_number, amount: b.amount_minor, billDate: b.bill_date, accountNumber: bl ? lookups.accountsById.get(bl.account_id)?.number : undefined, departmentCode: bl?.department_id ? (lookups.departments.get(bl.department_id)?.code ?? null) : null, entity: e.code };
            }),
          });
        }
      }
      const roles = await x.tx.find('roles', {});
      const limits = [...new Set(roles.map((r) => r.approval_limit_minor).filter((l): l is number => !!l && l > 0))];
      const findings = [...detectDuplicatePayments(payments).filter((f) => payments.find((p) => p.id === f.subjectIds[1])?.date.slice(0, 7) === input.period), ...reviewEntries(entries, { calendar: x.pack.calendar, roundAmountMinMinor: 1_000_000, approvalLimits: limits })];
      // Benford's law describes a population of individual amounts, not a few dozen account totals: test every posted
      // line of the twelve months ending with this period (mechanical entries such as depreciation, reversals and
      // eliminations left out); below the sample floor the result is "insufficient".
      const amounts: number[] = [];
      for (const e of lookups.operatingEntities()) {
        const end = periodOf(x, e.id, input.period);
        const periodIds = Array.from({ length: 12 }, (_, k) => addMonths(end.fiscal_year, end.period_number, -k))
          .map((m) => lookups.period(e.id, m.year, m.month)?.id)
          .filter((id): id is string => !!id);
        const posted = new Set((await x.tx.find('journal_entries', { entity_id: e.id, period_id: { in: periodIds }, status: 'posted', entry_type: { notIn: BENFORD_EXCLUDED_TYPES } })).map((j) => j.id));
        for (const l of await x.tx.find('journal_lines', { entity_id: e.id, period_id: { in: periodIds } })) if (posted.has(l.journal_entry_id)) amounts.push(Math.max(l.debit_minor, l.credit_minor));
      }
      return {
        period: input.period,
        population: { entriesTested: entries.length, paymentsTested: payments.length },
        findings: findings.map((f) => ({ ...f, payments: f.kind === 'duplicate_payment' ? payments.filter((p) => f.subjectIds.includes(p.id)) : undefined, entry: f.kind !== 'duplicate_payment' ? entries.find((e) => e.id === f.subjectIds[0]) : undefined })),
        benford: { ...benford(amounts), population: 'posted journal lines, trailing 12 months' },
        accounts: { refundReceivable: lookups.accountsBySubtype('bh:OtherReceivable')[0]?.number ?? '' },
      };
    },
    summarize: (o: { findings: unknown[]; population: { entriesTested: number } }) => `${o.findings.length} finding(s) in ${o.population.entriesTested} entries`,
  },
  {
    name: 'flux_compute',
    title: 'Compute flux analysis',
    description: 'Builds or refreshes the flux workpaper (bh:FluxAnalysis): consolidated income-statement activity for the close month versus prior month (or an entity versus budget), with the materiality thresholds from policy (bh:FluxThreshold). Returns every line with variance and whether it needs an explanation.',
    input: z.object({ closeId: z.string().uuid(), comparison: z.enum(['prior_month', 'budget']).default('prior_month') }).strict(),
    permission: 'flux.view',
    mutation: false,
    ontology: ['bh:FluxAnalysis', 'bh:Variance', 'bh:FluxThreshold'],
    async execute(input: { closeId: string; comparison: 'prior_month' | 'budget' }, x: X) {
      const policy = x.run.policy_id ? await x.tx.get('skill_policies', x.run.policy_id) : null;
      const t = (policy?.thresholds ?? {}) as Record<string, number | boolean>;
      const rules = (policy?.rules ?? []) as Array<Record<string, unknown>>;
      const r = rules.find((x) => x.kind === 'flux_threshold');
      const thresholds = { pct: Number(r?.pct ?? t.fluxPct ?? 0.1), minor: Number(r?.amountMinor ?? t.fluxMinor ?? 2_500_000), combine: (t.combineOr ? 'or' : 'and') as 'and' | 'or' };
      const { analysis, lines } = await ensureFluxAnalysis(x.tx, x.ctx, x.pack, input.closeId, input.comparison, thresholds, x.run.id);
      return {
        analysisId: analysis.id,
        status: analysis.status,
        comparison: input.comparison,
        thresholds,
        lines: lines
          .map((l) => {
            const a = x.pack.lookups.accountsById.get(l.account_id)!;
            return { id: l.id, account: a.number, name: a.name, fsLine: l.fs_line, current: l.current_minor, comparison: l.comparison_minor, variance: l.variance_minor, variancePct: l.variance_pct, material: l.is_material, explanationStatus: l.explanation_status };
          })
          .sort((a, b) => Number(b.material) - Number(a.material) || Math.abs(b.variance) - Math.abs(a.variance)),
      };
    },
    summarize: (o: { lines: Array<{ material: boolean }> }) => `${o.lines.filter((l) => l.material).length} material of ${o.lines.length}`,
  },
  {
    name: 'flux_drivers',
    title: 'Decompose a variance into drivers',
    description: 'For one flux line, compares line-level detail between the two periods grouped by vendor, merchant, department or revenue stream, and returns the fewest drivers (bh:VarianceDriver) explaining at least 80% of the variance, plus a draft explanation and confidence.',
    input: z.object({ fluxLineId: z.string().uuid() }).strict(),
    permission: 'flux.view',
    mutation: false,
    untrustedOutput: true,
    ontology: ['bh:VarianceDriver', 'bh:FluxExplanation'],
    async execute(input: { fluxLineId: string }, x: X) {
      const line = await x.tx.get('flux_lines', input.fluxLineId);
      if (!line) throw new DomainError('NOT_FOUND', 'flux line not found');
      const analysis = (await x.tx.get('flux_analyses', line.analysis_id))!;
      const close = (await x.tx.get('closes', analysis.close_id))!;
      const account = x.pack.lookups.accountsById.get(line.account_id)!;
      const current = await fluxDetail(x.tx, x.pack, account.id, close.fiscal_year, close.period_number);
      const prev = addMonths(close.fiscal_year, close.period_number, -1);
      const comparison = analysis.comparison === 'prior_month' ? await fluxDetail(x.tx, x.pack, account.id, prev.year, prev.month) : [];
      const { drivers, coverage } = decomposeDrivers(current, comparison, line.variance_minor);
      const result: FluxLineResult = { accountId: account.id, number: account.number, name: account.name, accountClass: account.account_class, fsLine: account.fs_line, current: line.current_minor, comparison: line.comparison_minor, variance: line.variance_minor, variancePct: line.variance_pct, isMaterial: line.is_material, direction: line.variance_minor > 0 ? 'up' : line.variance_minor < 0 ? 'down' : 'flat' };
      const draft = draftExplanation(result, drivers, coverage, analysis.comparison === 'prior_month' ? 'prior month' : 'budget');
      return { fluxLineId: line.id, account: `${account.number} ${account.name}`, variance: line.variance_minor, drivers, coverage: Number(coverage.toFixed(3)), draft: draft.text, confidence: draft.confidence };
    },
    summarize: (o: { account: string; coverage: number }) => `${o.account}: ${(o.coverage * 100).toFixed(0)}% explained by drivers`,
  },
  {
    name: 'close_ready_tasks',
    title: 'Find tasks ready for agents',
    description: 'Close checklist tasks (bh:CloseTask) whose dependencies (bh:TaskDependency) are satisfied, that have an agent skill and are not finished or waiting on approvals, in calendar order (bh:Workday).',
    input: z.object({ closeId: z.string().uuid() }).strict(),
    permission: 'close.view',
    mutation: false,
    ontology: ['bh:CloseTask', 'bh:TaskDependency', 'bh:CloseCalendar'],
    async execute(input: { closeId: string }, x: X) {
      const close = await x.tx.get('closes', input.closeId);
      if (!close) throw new DomainError('NOT_FOUND', 'close not found');
      const states = await taskStates(x.tx, input.closeId);
      const out = [];
      for (const s of states) {
        const t = s.task;
        if (!t.skill_key || !s.ready || ['done', 'skipped', 'ready_for_review'].includes(t.status)) continue;
        const pending = await x.tx.count('proposals', { close_task_id: t.id, status: { in: ['pending', 'blocked'] } });
        if (pending > 0) continue;
        if (t.last_run_id) {
          const last = await x.tx.get('agent_runs', t.last_run_id);
          if (last && (last.status === 'running' || last.status === 'queued')) continue;
        }
        const entity = t.entity_id ? x.pack.lookups.entitiesById.get(t.entity_id) : null;
        out.push({ id: t.id, key: t.key, title: t.title, skillKey: t.skill_key, dueWorkday: t.due_workday, dueDate: t.due_date, entity: entity?.code ?? null, entityId: entity?.id ?? null, period: `${close.fiscal_year}-${String(close.period_number).padStart(2, '0')}`, periodId: entity ? x.pack.lookups.period(entity.id, close.fiscal_year, close.period_number)?.id ?? null : null });
      }
      return { closeId: close.id, tasks: out.sort((a, b) => a.dueWorkday - b.dueWorkday) };
    },
    summarize: (o: { tasks: unknown[] }) => `${o.tasks.length} task(s) ready`,
  },
  {
    name: 'close_status',
    title: 'Read close status',
    description: 'Progress of the close (tasks done, in review, blocked) and everything still blocking the period lock.',
    input: z.object({ closeId: z.string().uuid() }).strict(),
    permission: 'close.view',
    mutation: false,
    ontology: ['bh:Close', 'bh:HardClose'],
    async execute(input: { closeId: string }, x: X) {
      const states = await taskStates(x.tx, input.closeId);
      const blockers = await closeBlockers(x.tx, x.pack.lookups, input.closeId);
      return { progress: closeProgress(states), blockers: blockers.slice(0, 40), tasks: states.map((s) => ({ key: s.task.key, title: s.task.title, status: s.task.status, ready: s.ready })) };
    },
    summarize: (o: { progress: { done: number; total: number }; blockers: unknown[] }) => `${o.progress.done}/${o.progress.total} done, ${o.blockers.length} blocker(s)`,
  },
];
