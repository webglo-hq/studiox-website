import { expect } from 'vitest';
import type { Scenario } from './scenario';

/**
 * Two eligible approvers decide the same open proposal at the same moment. Exactly one
 * decision may apply it; the other must get a clean conflict. Used by the unit suite
 * (in-memory store) and the PostgreSQL integration suite, where the two decisions run as
 * truly parallel transactions on separate connections.
 */
export async function expectSingleApplication(s: Scenario): Promise<void> {
  // An issue has no natural de-duplication downstream (unlike entries, which carry an idempotency
  // key), so only the claim stands between two approvals and two issues.
  const open = await s.db.find('proposal', { tenant_id: s.info.tenantId, kind: 'issue', status: 'pending' });
  const p = open[0]!;
  expect(p, 'an open issue proposal to decide').toBeTruthy();
  const approvers = (['casey', 'priya', 'jordan'] as const).filter((k) => s.user(k) !== p.requested_by).slice(0, 2);
  expect(approvers).toHaveLength(2);
  const [a, b] = await Promise.all(approvers.map((k) => s.engine.decide({ proposalIds: [p.id], decision: 'approve', userId: s.user(k) })));
  const outcomes = [a!.results[0]!, b!.results[0]!];
  expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
  expect(outcomes.find((o) => !o.ok)).toMatchObject({ code: 'CONFLICT' });
  expect(await s.db.count('issue', { proposal_id: p.id })).toBe(1);
  expect(await s.db.count('approval', { proposal_id: p.id })).toBe(1);
  expect((await s.db.get('proposal', p.id))!.status).toBe('applied');
}
