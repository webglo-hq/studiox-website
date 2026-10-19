# Accrual policy (Bramblewood Labs, fictional)

| Basis | Evidence (AX-ACR-02) | Amount | Credit |
|---|---|---|---|
| Subsequent invoice | bill dated after month-end, service period in the month | invoice amount | 2110 |
| Recurring vendor gap | bills in each of the last 3 months for monthly service | 3-month average, rounded to $1 | 2110 |
| Goods received, not invoiced | goods receipt against a PO, no bill | receipt amount (debit the PO account) | 2110 |
| Payroll earned, unpaid | payroll register and business-day calendar | daily cost × unpaid business days, by department | 2120 |

All accruals are entry type `accrual`, dated the last day of the month, and reverse automatically on
the first day of the next month (AX-ACR-01).

Approval limits: up to $25,000 Senior Accountant; up to $250,000 Controller; above that the CFO.
