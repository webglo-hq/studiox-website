/**
 * Schedule roll-forward: depreciation (tie:DepreciationSchedule, ASC 360) and prepaid
 * amortization (tie:PrepaidSchedule, ASC 340). Finds scheduled lines that are due but have no
 * journal entry, and validates each schedule (AX-SCH-01 exact allocation, AX-SCH-02 bounded by
 * the depreciable base).
 */
import { periodEnd } from '../../../core/util/time';
import { closeOntology } from '../ontology';
import type { AcctContext } from './context';

export interface DueDepreciation {
  lineId: string;
  assetId: string;
  assetTag: string;
  description: string;
  category: string;
  department: string | null;
  amountMinor: number;
  periodKey: string;
  expenseAccount: string;
  accumAccount: string;
}

export interface DuePrepaid {
  lineId: string;
  scheduleId: string;
  description: string;
  vendorName: string | null;
  amountMinor: number;
  periodKey: string;
  expenseAccount: string;
  prepaidAccount: string;
  department: string | null;
  remainingAfterMinor: number;
}

export interface ScheduleIssue {
  scheduleType: 'depreciation' | 'prepaid';
  id: string;
  label: string;
  axiomId: string;
  message: string;
}

export class ScheduleService {
  constructor(private readonly c: AcctContext) {}

  async status(entityId: string, periodKey: string): Promise<{ depreciation: DueDepreciation[]; prepaid: DuePrepaid[]; issues: ScheduleIssue[]; postedThisPeriod: { depreciation: number; prepaid: number } }> {
    const chart = await this.c.chart();
    const onto = closeOntology();
    const assets = await this.c.tx.find('fixed_assets', { entity_id: entityId });
    const depreciation: DueDepreciation[] = [];
    const issues: ScheduleIssue[] = [];
    let postedDep = 0;
    for (const a of assets) {
      const lines = await this.c.tx.find('depreciation_lines', { fixed_asset_id: a.id }, { orderBy: [['period_key', 'asc']] });
      const bound = onto.check('AX-SCH-02', { costMinor: a.cost_minor, salvageMinor: a.salvage_minor, accumulatedMinor: lines.filter((l) => l.period_key <= periodKey).reduce((s, l) => s + l.amount_minor, 0) });
      if (!bound.passed) issues.push({ scheduleType: 'depreciation', id: a.id, label: `${a.asset_tag} ${a.description}`, axiomId: 'AX-SCH-02', message: bound.messages.join('; ') });
      for (const l of lines) {
        if (l.period_key > periodKey) continue;
        if (l.status === 'posted' && l.period_key === periodKey) postedDep++;
        if (l.status !== 'scheduled' || l.journal_entry_id) continue;
        depreciation.push({ lineId: l.id, assetId: a.id, assetTag: a.asset_tag, description: a.description, category: a.category, department: a.department, amountMinor: l.amount_minor, periodKey: l.period_key, expenseAccount: chart.account(a.expense_account_id).code, accumAccount: chart.account(a.accum_depr_account_id).code });
      }
    }
    const schedules = await this.c.tx.find('prepaid_schedules', { entity_id: entityId, status: 'active' });
    const vendors = new Map((await this.c.tx.find('vendors', {})).map((v) => [v.id, v]));
    const prepaid: DuePrepaid[] = [];
    let postedPre = 0;
    for (const s of schedules) {
      const lines = await this.c.tx.find('prepaid_lines', { prepaid_schedule_id: s.id }, { orderBy: [['period_key', 'asc']] });
      const exact = onto.check('AX-SCH-01', { totalMinor: s.total_minor, scheduledMinor: lines.map((l) => l.amount_minor), periodKeys: lines.map((l) => l.period_key) });
      if (!exact.passed) issues.push({ scheduleType: 'prepaid', id: s.id, label: s.description, axiomId: 'AX-SCH-01', message: exact.messages.join('; ') });
      for (const l of lines) {
        if (l.period_key > periodKey) continue;
        if (l.status === 'posted' && l.period_key === periodKey) postedPre++;
        if (l.status !== 'scheduled' || l.journal_entry_id) continue;
        const remaining = lines.filter((x) => x.period_key > l.period_key).reduce((t, x) => t + x.amount_minor, 0);
        prepaid.push({ lineId: l.id, scheduleId: s.id, description: s.description, vendorName: s.vendor_id ? (vendors.get(s.vendor_id)?.name ?? null) : null, amountMinor: l.amount_minor, periodKey: l.period_key, expenseAccount: chart.account(s.expense_account_id).code, prepaidAccount: chart.account(s.prepaid_account_id).code, department: s.department, remainingAfterMinor: remaining });
      }
    }
    return { depreciation, prepaid, issues, postedThisPeriod: { depreciation: postedDep, prepaid: postedPre } };
  }

  /** Expected GL balance of a prepaid account at period end from the schedules (sub-ledger view). */
  async prepaidRollforward(entityId: string, periodKey: string) {
    const schedules = await this.c.tx.find('prepaid_schedules', { entity_id: entityId });
    let remaining = 0;
    for (const s of schedules) {
      const lines = await this.c.tx.find('prepaid_lines', { prepaid_schedule_id: s.id });
      remaining += lines.filter((l) => l.period_key > periodKey).reduce((t, l) => t + l.amount_minor, 0);
    }
    return { remainingMinor: remaining, asOf: periodEnd(periodKey) };
  }
}
