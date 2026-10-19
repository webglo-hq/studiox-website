import { appendAudit } from '../../audit/audit';
import type { Row } from '../../persistence/schema';
import { certificationProblems, ensureReconciliation, recTypeFor, refreshReconciliation, reopenReconciliation, signReconciliation } from '../../packs/accounting/services/recon';
import { canOn, canSeeEntity, requirePermission, requirePermissionOn, type Principal } from '../../security/principal';
import { DomainError } from '../../shared/errors';
import type { App, RequestMeta } from '../app';
import { currentClose } from './close';

/** Reconciliation workbench: list, detail (matches, items, open lines), certification and manual matching. */

export async function listRecs(app: App, p: Principal, closeId?: string) {
  requirePermission(p, 'rec.view');
  const close = closeId ? await app.read((tx) => tx.get('closes', closeId)) : await currentClose(app, p.tenantId);
  if (!close || close.tenant_id !== p.tenantId) app.notFound('Close');
  return app.read(async (tx) => {
    const lookups = await app.lookups(tx, p.tenantId);
    const users = new Map((await tx.find('users', { tenant_id: p.tenantId })).map((u) => [u.id, u.display_name]));
    const rows = [];
    for (const e of lookups.operatingEntities().filter((x) => canSeeEntity(p, x.id))) {
      const period = lookups.period(e.id, close.fiscal_year, close.period_number);
      if (!period) continue;
      const recs = await tx.find('reconciliations', { period_id: period.id });
      const accounts = [...lookups.accountsById.values()].filter((a) => recTypeFor(a)).sort((a, b) => a.number.localeCompare(b.number));
      for (const a of accounts) {
        const used = (await tx.sumLines({ tenantId: p.tenantId, entityIds: [e.id], accountIds: [a.id], dateTo: period.end_date, groupBy: ['account_id'] })).some((s) => s.line_count > 0);
        const mine = recs.filter((r) => r.account_id === a.id);
        if (!used && !mine.length) continue;
        const required = ['bank', 'subledger_ap', 'subledger_ar'].includes(recTypeFor(a)!);
        if (!mine.length) {
          rows.push({ id: null, entity: e.code, entityId: e.id, periodId: period.id, account: `${a.number} ${a.name}`, accountNumber: a.number, type: recTypeFor(a), required, status: 'not_started', gl: null, external: null, items: null, difference: null, risk: null, preparedBy: null, reviewedBy: null, pending: 0 });
          continue;
        }
        for (const r of mine) {
          const items = (await tx.find('reconciling_items', { reconciliation_id: r.id })).filter((i) => !i.cleared_date || i.cleared_date > period.end_date);
          const bank = r.bank_account_id ? await tx.get('bank_accounts', r.bank_account_id) : null;
          rows.push({
            id: r.id,
            entity: e.code,
            entityId: e.id,
            periodId: period.id,
            account: `${a.number} ${a.name}${bank ? ` (${bank.name})` : ''}`,
            accountNumber: a.number,
            type: r.rec_type,
            required,
            status: r.status,
            gl: r.gl_balance_minor,
            external: r.external_balance_minor,
            items: items.length,
            difference: r.difference_minor,
            risk: r.risk,
            currency: r.currency,
            preparedBy: r.prepared_by ? users.get(r.prepared_by) ?? null : null,
            reviewedBy: r.reviewed_by ? users.get(r.reviewed_by) ?? null : null,
            pending: await tx.count('proposals', { tenant_id: p.tenantId, status: 'pending', entity_id: e.id, period_id: period.id, kind: { in: ['rec_match', 'reconciling_item'] } }),
          });
        }
      }
    }
    return { close: { id: close.id, name: close.name, periodEnd: close.period_end }, recs: rows };
  });
}

export async function recDetail(app: App, p: Principal, recId: string) {
  requirePermission(p, 'rec.view');
  const visible = await app.read(async (tx) => {
    const r = await tx.get('reconciliations', recId);
    return !!r && r.tenant_id === p.tenantId && canSeeEntity(p, r.entity_id);
  });
  if (!visible) app.notFound('Reconciliation');
  await app.tx((tx) => refreshReconciliation(tx, recId).catch(() => null));
  return app.read(async (tx) => {
    const rec = await tx.get('reconciliations', recId);
    if (!rec || rec.tenant_id !== p.tenantId) app.notFound('Reconciliation');
    const lookups = await app.lookups(tx, p.tenantId);
    const period = lookups.periodsById.get(rec.period_id)!;
    const account = lookups.accountsById.get(rec.account_id)!;
    const users = new Map((await tx.find('users', { tenant_id: p.tenantId })).map((u) => [u.id, u.display_name]));
    const bank = rec.bank_account_id ? await tx.get('bank_accounts', rec.bank_account_id) : null;
    const statement = bank ? (await tx.find('bank_statements', { bank_account_id: bank.id, period_end: period.end_date }))[0] ?? null : null;
    const matches = await tx.find('rec_matches', { reconciliation_id: rec.id }, { orderBy: [['created_at', 'asc']] });
    const items = matches.length ? await tx.find('rec_match_items', { match_id: { in: matches.map((m) => m.id) } }) : [];
    const bankIds = items.map((i) => i.bank_transaction_id).filter((x): x is string => !!x);
    const lineIds = items.map((i) => i.journal_line_id).filter((x): x is string => !!x);
    const bankRows = new Map((bankIds.length ? await tx.find('bank_transactions', { id: { in: bankIds } }) : []).map((b) => [b.id, b]));
    const lineRows = new Map((lineIds.length ? await tx.find('journal_lines', { id: { in: lineIds } }) : []).map((l) => [l.id, l]));
    const entryIds = [...new Set([...lineRows.values()].map((l) => l.journal_entry_id))];
    const entries = new Map((entryIds.length ? await tx.find('journal_entries', { id: { in: entryIds } }) : []).map((e) => [e.id, e]));
    const recItems = await tx.find('reconciling_items', { reconciliation_id: rec.id }, { orderBy: [['item_date', 'asc']] });
    const claimedBank = new Set(items.filter((i) => matches.find((m) => m.id === i.match_id && m.status !== 'rejected')).map((i) => i.bank_transaction_id));
    const claimedLines = new Set(items.filter((i) => matches.find((m) => m.id === i.match_id && m.status !== 'rejected')).map((i) => i.journal_line_id));
    for (const i of recItems) {
      if (i.bank_transaction_id) claimedBank.add(i.bank_transaction_id);
      if (i.journal_line_id) claimedLines.add(i.journal_line_id);
    }
    const openBank = bank ? (await tx.find('bank_transactions', { bank_account_id: bank.id, booking_date: { between: [period.start_date, period.end_date] } })).filter((b) => b.status === 'unmatched' && !claimedBank.has(b.id)) : [];
    const periodLines = bank ? await tx.find('journal_lines', { entity_id: rec.entity_id, account_id: rec.account_id, period_id: period.id }) : [];
    const periodEntries = new Map((periodLines.length ? await tx.find('journal_entries', { id: { in: [...new Set(periodLines.map((l) => l.journal_entry_id))] } }) : []).map((e) => [e.id, e]));
    const openLedger = periodLines.filter((l) => periodEntries.get(l.journal_entry_id)?.status === 'posted' && !claimedLines.has(l.id));
    const pending = await tx.find('proposals', { tenant_id: p.tenantId, status: 'pending', entity_id: rec.entity_id, period_id: rec.period_id, kind: { in: ['rec_match', 'reconciling_item'] } });
    const signoffs = await tx.find('signoffs', { object_type: 'reconciliation', object_id: rec.id }, { orderBy: [['signed_at', 'asc']] });
    const problems = await certificationProblems(tx, rec);
    return {
      rec: { id: rec.id, type: rec.rec_type, status: rec.status, risk: rec.risk, currency: rec.currency, gl: rec.gl_balance_minor, external: rec.external_balance_minor, reconcilingTotal: rec.reconciling_total_minor, difference: rec.difference_minor, notes: rec.notes, preparedBy: rec.prepared_by ? users.get(rec.prepared_by) ?? null : null, preparedAt: rec.prepared_at, reviewedBy: rec.reviewed_by ? users.get(rec.reviewed_by) ?? null : null, reviewedAt: rec.reviewed_at },
      entity: lookups.entitiesById.get(rec.entity_id)!.code,
      period: { id: period.id, name: period.name, start: period.start_date, end: period.end_date, status: period.status },
      account: { number: account.number, name: account.name, subtype: account.subtype },
      bankAccount: bank ? { id: bank.id, name: bank.name, institution: bank.institution, last4: bank.account_last4 } : null,
      statement: statement ? { opening: statement.opening_balance_minor, closing: statement.closing_balance_minor, start: statement.period_start, end: statement.period_end } : null,
      matches: matches.map((m) => ({
        id: m.id,
        type: m.match_type,
        status: m.status,
        confidence: m.confidence,
        rule: m.rule,
        explanation: m.explanation,
        proposalId: m.proposal_id,
        acceptedBy: m.accepted_by ? users.get(m.accepted_by) ?? null : m.status === 'accepted' ? 'Autonomy policy' : null,
        bank: items.filter((i) => i.match_id === m.id && i.bank_transaction_id).map((i) => {
          const b = bankRows.get(i.bank_transaction_id!)!;
          return { id: b.id, date: b.booking_date, amount: b.amount_minor, description: b.description };
        }),
        ledger: items.filter((i) => i.match_id === m.id && i.journal_line_id).map((i) => {
          const l = lineRows.get(i.journal_line_id!)!;
          const e = entries.get(l.journal_entry_id);
          return { id: l.id, date: l.entry_date, amount: l.debit_minor - l.credit_minor, entryNumber: e?.entry_number, entryId: e?.id, description: e?.description };
        }),
      })),
      items: recItems.map((i) => ({ id: i.id, kind: i.kind, description: i.description, amount: i.amount_minor, itemDate: i.item_date, expectedClearDate: i.expected_clear_date, clearedDate: i.cleared_date, status: i.status, ageDays: Math.max(0, Math.round((Date.parse(period.end_date) - Date.parse(i.item_date)) / 86_400_000)) })),
      openBank: openBank.map((b) => ({ id: b.id, date: b.booking_date, amount: b.amount_minor, description: b.description, reference: b.reference })),
      openLedger: openLedger.map((l) => ({ id: l.id, date: l.entry_date, amount: l.debit_minor - l.credit_minor, entryNumber: periodEntries.get(l.journal_entry_id)?.entry_number, entryId: l.journal_entry_id, description: periodEntries.get(l.journal_entry_id)?.description, memo: l.memo })),
      pendingProposals: pending.map((x) => ({ id: x.id, kind: x.kind, title: x.title, confidence: x.confidence })),
      signoffs: signoffs.map((s) => ({ role: s.role, action: s.action, user: users.get(s.user_id) ?? s.user_id, at: s.signed_at, comment: s.comment })),
      certification: { problems, canPrepare: canOn(p, 'rec.prepare', rec.entity_id) && problems.length === 0 && rec.status !== 'reviewed' && rec.status !== 'prepared', canReview: canOn(p, 'rec.review', rec.entity_id) && rec.status === 'prepared' && rec.prepared_by !== p.user.id, canReopen: canOn(p, 'rec.review', rec.entity_id) && (rec.status === 'reviewed' || rec.status === 'prepared') },
    };
  });
}

export async function signRec(app: App, p: Principal, recId: string, role: 'preparer' | 'reviewer', comment: string | undefined, meta: RequestMeta = {}) {
  return app.tx((tx) => signReconciliation(tx, app.ctx(p, meta), p, recId, role, comment));
}

export async function reopenRec(app: App, p: Principal, recId: string, reason: string, meta: RequestMeta = {}) {
  return app.tx((tx) => reopenReconciliation(tx, app.ctx(p, meta), p, recId, reason));
}

/** A preparer matches lines by hand (workpaper only; no posting). Recorded as a manual match with audit. */
export async function manualMatch(app: App, p: Principal, recId: string, bankIds: string[], ledgerIds: string[], note: string, meta: RequestMeta = {}) {
  requirePermission(p, 'rec.prepare', 'match reconciliation lines');
  if (!bankIds.length || !ledgerIds.length) throw new DomainError('VALIDATION', 'Pick at least one bank line and one ledger line.');
  if (!note || note.trim().length < 5) throw new DomainError('VALIDATION', 'Say why these lines belong together.');
  return app.tx(async (tx) => {
    const rec = await tx.get('reconciliations', recId);
    if (!rec || rec.tenant_id !== p.tenantId || !rec.bank_account_id || !canSeeEntity(p, rec.entity_id)) app.notFound('Bank reconciliation');
    requirePermissionOn(p, 'rec.prepare', rec.entity_id, 'match reconciliation lines');
    let bankTotal = 0;
    let ledgerTotal = 0;
    const bank: Row<'bank_transactions'>[] = [];
    for (const id of bankIds) {
      const b = await tx.get('bank_transactions', id);
      if (!b || b.bank_account_id !== rec.bank_account_id || b.status !== 'unmatched') throw new DomainError('CONFLICT', 'A bank line is already matched or belongs to another account.');
      bank.push(b);
      bankTotal += b.amount_minor;
    }
    for (const id of ledgerIds) {
      const l = await tx.get('journal_lines', id);
      if (!l || l.account_id !== rec.account_id) throw new DomainError('CONFLICT', 'A ledger line is not on this cash account.');
      ledgerTotal += l.debit_minor - l.credit_minor;
    }
    if (bankTotal !== ledgerTotal) throw new DomainError('VALIDATION', `Bank lines total ${bankTotal / 100} but ledger lines total ${ledgerTotal / 100}; amounts must agree (book the difference separately).`);
    const now = app.clock.now();
    const match = await tx.insert('rec_matches', { tenant_id: p.tenantId, reconciliation_id: rec.id, match_type: 'manual', status: 'accepted', confidence: 1, rule: 'manual match', explanation: note.trim(), accepted_by: p.user.id, accepted_at: now });
    for (const b of bank) {
      await tx.insert('rec_match_items', { tenant_id: p.tenantId, match_id: match.id, side: 'external', bank_transaction_id: b.id, amount_minor: b.amount_minor });
      await tx.update('bank_transactions', b.id, { status: 'matched' });
    }
    for (const id of ledgerIds) {
      const l = (await tx.get('journal_lines', id))!;
      await tx.insert('rec_match_items', { tenant_id: p.tenantId, match_id: match.id, side: 'ledger', journal_line_id: id, amount_minor: l.debit_minor - l.credit_minor });
    }
    await refreshReconciliation(tx, rec.id);
    await appendAudit(tx, p.tenantId, app.actorOf(p, meta), { action: 'reconciliation.manual_match', objectType: 'reconciliation', objectId: rec.id, summary: `Manually matched ${bank.length} bank line(s) to ${ledgerIds.length} ledger line(s): ${note.trim()}` }, now);
    return match;
  });
}

/** Start a reconciliation workpaper for an account (e.g. a balance-sheet account with no agent). */
export async function startRec(app: App, p: Principal, entityId: string, periodId: string, accountNumber: string, meta: RequestMeta = {}) {
  requirePermission(p, 'rec.prepare', 'prepare reconciliations');
  return app.tx(async (tx) => {
    const lookups = await app.lookups(tx, p.tenantId);
    const entity = lookups.entitiesById.get(entityId);
    const period = lookups.periodsById.get(periodId);
    if (!entity || !period || period.entity_id !== entity.id || !canSeeEntity(p, entity.id)) app.notFound('Entity period');
    requirePermissionOn(p, 'rec.prepare', entity.id, 'prepare reconciliations');
    const account = lookups.account(accountNumber);
    if (!account) app.notFound('Account');
    const type = recTypeFor(account) ?? 'balance_sheet';
    const bank = type === 'bank' ? (await tx.find('bank_accounts', { gl_account_id: account.id, entity_id: entityId }))[0] : null;
    const rec = await ensureReconciliation(tx, app.ctx(p, meta), lookups, { entityId, periodId, recType: type, accountId: account.id, bankAccountId: bank?.id ?? null });
    return refreshReconciliation(tx, rec.id);
  });
}
