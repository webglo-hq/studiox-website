/**
 * Verify an exported audit chain (Audit log → Export chain) outside the application:
 *   npm run verify:audit -- tieout-audit-chain.json
 * Recomputes every hash from genesis; exits 1 on the first broken link.
 */
import { readFileSync } from 'node:fs';
import { verifyAuditChain } from '../src/core/audit/chain';
import type { AuditRecord } from '../src/core/store/types';

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run verify:audit -- <tieout-audit-chain.json>');
  process.exit(2);
}
const doc = JSON.parse(readFileSync(file, 'utf8')) as { format?: string; count?: number; head?: string | null; records?: AuditRecord[] };
if (doc.format !== 'tieout.audit-chain.v1' || !Array.isArray(doc.records)) {
  console.error(`${file}: not a Tieout audit chain export`);
  process.exit(2);
}
const v = verifyAuditChain(doc.records);
const head = doc.records.at(-1)?.hash ?? null;
const consistent = doc.count === doc.records.length && doc.head === head;
if (v.ok && consistent) {
  console.log(`OK: ${v.checked} events, chain intact from genesis; head ${head}`);
} else {
  console.error(v.ok ? `MISMATCH: the header says ${doc.count} events / head ${doc.head}, the records give ${doc.records.length} / ${head}` : `BROKEN at seq ${v.firstBadSeq}: ${v.reason}`);
  process.exit(1);
}
