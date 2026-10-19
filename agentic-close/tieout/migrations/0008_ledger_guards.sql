-- =============================================================================
-- Tieout migration 0008: lines stay with their entry; postings hold their period
--
-- AX-IM-01. A journal line may change only while BOTH the entry it leaves and the entry it joins
-- are drafts or awaiting approval: moving a line out of a posted entry (UPDATE ... SET
-- journal_entry_id) unbalanced it without touching the entry itself. The guard also takes a share
-- lock on those entries, so a line cannot slip into an entry while another transaction posts it.
--
-- AX-PD-01. Posting takes a share lock on the period row, so a period cannot be locked while an
-- entry is being posted into it: whichever commits second sees the other's result.
-- =============================================================================

CREATE OR REPLACE FUNCTION tieout_jl_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  je_status TEXT;
  acct_postable BOOLEAN;
  acct_status TEXT;
BEGIN
  -- the entry the line belongs to now (UPDATE, DELETE)
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO je_status FROM journal_entries WHERE id = OLD.journal_entry_id FOR SHARE;
    IF je_status IS NOT NULL AND je_status NOT IN ('draft', 'pending_approval') THEN
      RAISE EXCEPTION 'AX-IM-01: lines of a % journal entry cannot change', je_status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  -- the entry it belongs to afterwards (INSERT, or an UPDATE that moves it)
  IF TG_OP = 'INSERT' OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
    SELECT status INTO je_status FROM journal_entries WHERE id = NEW.journal_entry_id FOR SHARE;
    IF je_status IS NOT NULL AND je_status NOT IN ('draft', 'pending_approval') THEN
      RAISE EXCEPTION 'AX-IM-01: lines of a % journal entry cannot change', je_status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  SELECT is_postable, status INTO acct_postable, acct_status FROM accounts WHERE id = NEW.account_id;
  IF NOT acct_postable OR acct_status <> 'active' THEN
    RAISE EXCEPTION 'AX-AC-01: account % is not an active postable account', NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- AX-IM-01 / AX-DE-01 / AX-DE-03 / AX-PD-01 / AX-PD-02 / AX-SOD-01 / AX-IM-02 (as 0002, plus the period lock)
CREATE OR REPLACE FUNCTION tieout_je_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p_status TEXT;
  p_start DATE;
  p_end DATE;
  sum_dr BIGINT;
  sum_cr BIGINT;
  n_lines INT;
  rev_status TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('posted', 'approved') THEN
      RAISE EXCEPTION 'AX-IM-01: % journal entry % cannot be deleted; reverse it instead', OLD.status, OLD.je_number
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN
    RAISE EXCEPTION 'AX-IM-01: posted journal entry % is immutable; post a reversing entry', OLD.je_number
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.status = 'posted' AND (TG_OP = 'INSERT' OR OLD.status <> 'posted') THEN
    -- held until this transaction ends: the period cannot be locked under a posting in flight
    SELECT status, start_date, end_date INTO p_status, p_start, p_end FROM periods WHERE id = NEW.period_id FOR SHARE;
    IF p_status IS NULL THEN
      RAISE EXCEPTION 'AX-PD-01: period % not found', NEW.period_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF p_status = 'locked' OR p_status = 'future'
       OR (p_status = 'soft_closed' AND NEW.entry_type IN ('standard', 'recurring')) THEN
      RAISE EXCEPTION 'AX-PD-01: cannot post % entry % into a % period', NEW.entry_type, NEW.je_number, p_status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.posting_date < p_start OR NEW.posting_date > p_end THEN
      RAISE EXCEPTION 'AX-PD-02: posting date % is outside period % to %', NEW.posting_date, p_start, p_end
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT COALESCE(sum(debit_minor), 0), COALESCE(sum(credit_minor), 0), count(*)
      INTO sum_dr, sum_cr, n_lines FROM journal_lines WHERE journal_entry_id = NEW.id;
    IF n_lines < 2 THEN
      RAISE EXCEPTION 'AX-DE-03: journal entry % needs at least two lines (has %)', NEW.je_number, n_lines
        USING ERRCODE = 'check_violation';
    END IF;
    IF sum_dr <> sum_cr OR sum_dr = 0 THEN
      RAISE EXCEPTION 'AX-DE-01: journal entry % does not balance (debits % <> credits %)', NEW.je_number, sum_dr, sum_cr
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.total_minor <> sum_dr THEN
      RAISE EXCEPTION 'AX-DE-01: journal entry % header total % disagrees with lines %', NEW.je_number, NEW.total_minor, sum_dr
        USING ERRCODE = 'check_violation';
    END IF;
    -- Maker-checker is enforced for native entries; legacy imports are detected by the JE review skill.
    IF NEW.source IN ('manual', 'agent') AND NEW.approval_route = 'human'
       AND (NEW.approved_by IS NULL OR NEW.approved_by = NEW.prepared_by) THEN
      RAISE EXCEPTION 'AX-SOD-01: journal entry % must be approved by someone other than its preparer', NEW.je_number
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.reverses_je_id IS NOT NULL THEN
      SELECT status INTO rev_status FROM journal_entries WHERE id = NEW.reverses_je_id;
      IF rev_status IS DISTINCT FROM 'posted' THEN
        RAISE EXCEPTION 'AX-IM-02: only posted entries can be reversed' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
