# Journal-entry risk tests

Modelled on journal-entry testing under PCAOB AS 2401 (consideration of fraud).

| Test | Why it matters | Weight |
|---|---|---|
| Self-approval | No second person saw it; the most direct SoD failure | 50 |
| Threshold skirting | Amounts just under an approval limit avoid escalation | 20 |
| Weekend or holiday | Manual entries outside business days are unusual | 15 |
| Round amount | Estimates and plugs are often round | 10 |
| Duplicate payment | The same bill paid twice, or the same vendor and amount within a week | finding |
| Benford first digit | Population-level screen (Nigrini MAD thresholds) | note only |

Severity: critical at 60 or more, high at 40 or more, otherwise medium. Recommended actions must be
concrete: who reviews, what support, which control to fix.
