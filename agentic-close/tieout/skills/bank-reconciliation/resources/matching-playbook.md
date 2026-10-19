# Matching playbook

Order of passes (strongest evidence first):

| Pass | Shape | Typical case | Confidence |
|---|---|---|---|
| exact | 1 bank : 1 ledger | ACH, wire, card settlement, check (by number) | 0.92–0.99 |
| many_to_one | n bank : 1 ledger | payroll net pay settled in two debits | 0.84–0.95 |
| one_to_many | 1 bank : n ledger | lockbox deposit of several receipts | 0.82–0.94 |
| fuzzy | 1 : 1, wider window | late presentation, rounding | ≤ 0.90 |

Signals that raise confidence: the same reference (payment, check or invoice number), the same
counterparty name, the same day, and a bank description that states the item count ("3 ITEMS").
Deposit batches often carry their batch date in the reference (`LBX-20260915`).

## Reconciling items
- **Deposit in transit**: in the books, not yet on the statement. Positive, external side.
  Strong when the next statement shows the credit.
- **Outstanding check**: issued and recorded, not yet presented. Negative, external side.
- **Bank fee / interest**: on the statement only. Book an entry; the bank line then matches it.
- **Unexplained**: anything else on one side only. Ledger side if it is a bank-only line. Never
  book a guess; ask treasury or the bank. Certifying with unexplained items needs a written
  justification (AX-REC-04).

## The reconciliation ties out when
`statement balance + external items = GL balance + ledger items` (AX-REC-01).
