# Matching rules

| Pass | Rule | Typical confidence |
|---|---|---|
| Exact | Same amount and same reference (check number, trace) or same date; one best candidate | 0.97–0.99 |
| Fuzzy | Same amount within 7 days, description similar to the counterparty (Jaro-Winkler) | 0.80–0.93 |
| Many-to-one | Several statement lines sum to one ledger line within 5 days (split transfers) | 0.85–0.92 |
| One-to-many | One statement line equals several ledger lines (lockbox / batched deposits) | 0.85–0.92 |

Amounts are signed the same way on both sides: money in is positive.

## Reconciling items

| Type | Side | Meaning | Normal resolution |
|---|---|---|---|
| Deposit in transit | book | Receipt recorded, bank credits it next month | Clears on the next statement |
| Outstanding check | book | Check issued, not yet cashed | Clears when cashed; void after 180 days |
| Bank fee | bank | Charge on the statement | Book the fee |
| Bank interest | bank | Interest credited | Book the interest |
| Unexplained | either | No support | Investigate before certifying |

The reconciliation identity: **ledger − statement = book-side items − bank-side items**.
Anything that does not fit is *unexplained* and blocks certification.
