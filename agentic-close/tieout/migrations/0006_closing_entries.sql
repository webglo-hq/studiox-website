-- =============================================================================
-- Tieout migration 0006: closing entries
--
-- The year-end close moves the year's income and expense balances into retained earnings. It is
-- not income or expense of the month it is dated in, so it is its own entry type: period income
-- statements and variance analysis leave it out (AX-FS-01), balances and the balance sheet keep it.
-- Like other adjustments it may post into a soft-closed period (AX-PD-01).
-- =============================================================================

ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_entry_type_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_entry_type_check CHECK (entry_type IN ('standard', 'adjusting', 'accrual', 'reversing', 'recurring', 'reclass', 'elimination', 'fx_revaluation', 'opening', 'closing'));
