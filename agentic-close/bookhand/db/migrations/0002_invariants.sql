-- 0002_invariants.sql
-- Business invariants enforced by the database itself (hand-written; mirrored by src/persistence/invariants.ts
-- for the in-memory adapter and proven equivalent by tests/integration/invariant-parity.test.ts).
--
-- Custom SQLSTATEs:  BH001 invariant violated | BH002 period locked | BH003 immutable row | BH004 audit chain

-- ---------------------------------------------------------------------------------------------------
-- Append-only tables: no UPDATE, DELETE or TRUNCATE
CREATE OR REPLACE FUNCTION bh_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'BH003',
    MESSAGE = 'append-only table: rows cannot be updated or deleted',
    CONSTRAINT = TG_TABLE_NAME || '_append_only', TABLE = TG_TABLE_NAME;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_log','signoffs','skill_versions','skill_policies','agent_steps','agent_tool_calls','approvals','ontology_versions']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION bh_forbid_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION bh_forbid_mutation()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------
-- Journal entries: posting is a validated state transition; posted entries are immutable
CREATE OR REPLACE FUNCTION bh_journal_entries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_period periods%ROWTYPE;
  v_target journal_entries%ROWTYPE;
  v_debit bigint;
  v_credit bigint;
  v_count integer;
  v_bad integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' THEN
      RAISE EXCEPTION USING ERRCODE = 'BH003', MESSAGE = 'posted journal entries cannot be deleted',
        CONSTRAINT = 'je_posted_no_delete', TABLE = 'journal_entries';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.status = 'posted' THEN
    RAISE EXCEPTION USING ERRCODE = 'BH001',
      MESSAGE = 'journal entries must be created as draft or pending_approval and posted by a state transition',
      CONSTRAINT = 'je_insert_not_posted', TABLE = 'journal_entries';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN
    RAISE EXCEPTION USING ERRCODE = 'BH003',
      MESSAGE = 'posted journal entries are immutable; correct them with a reversing entry',
      CONSTRAINT = 'je_posted_immutable', TABLE = 'journal_entries';
  END IF;

  SELECT * INTO v_period FROM periods WHERE id = NEW.period_id;

  IF TG_OP = 'UPDATE' AND NEW.status = 'posted' THEN
    SELECT COALESCE(SUM(debit_minor), 0), COALESCE(SUM(credit_minor), 0), COUNT(*)
      INTO v_debit, v_credit, v_count
      FROM journal_lines WHERE journal_entry_id = NEW.id;
    IF v_count < 2 THEN
      RAISE EXCEPTION USING ERRCODE = 'BH001', MESSAGE = 'a journal entry needs at least two lines',
        CONSTRAINT = 'je_post_min_lines', TABLE = 'journal_entries';
    END IF;
    SELECT COUNT(*) INTO v_bad
      FROM journal_lines l JOIN accounts a ON a.id = l.account_id
     WHERE l.journal_entry_id = NEW.id AND (NOT a.is_postable OR a.status <> 'active');
    IF v_bad > 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'BH001', MESSAGE = 'lines may only post to active, postable (leaf) accounts',
        CONSTRAINT = 'je_post_accounts', TABLE = 'journal_entries';
    END IF;
    IF v_debit <> v_credit OR v_debit <= 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'BH001',
        MESSAGE = 'journal entry does not balance: total debits must equal total credits',
        DETAIL = format('debits=%s credits=%s', v_debit, v_credit),
        CONSTRAINT = 'je_post_balanced', TABLE = 'journal_entries';
    END IF;
    IF NEW.total_minor <> v_debit OR NEW.line_count <> v_count THEN
      RAISE EXCEPTION USING ERRCODE = 'BH001', MESSAGE = 'header totals must equal the sum of the lines',
        CONSTRAINT = 'je_post_totals', TABLE = 'journal_entries';
    END IF;
    IF v_period.id IS NULL OR v_period.entity_id <> NEW.entity_id THEN
      RAISE EXCEPTION USING ERRCODE = 'BH001', MESSAGE = 'the period belongs to a different entity',
        CONSTRAINT = 'je_post_period', TABLE = 'journal_entries';
    END IF;
    IF NEW.entry_date < v_period.start_date OR NEW.entry_date > v_period.end_date THEN
      RAISE EXCEPTION USING ERRCODE = 'BH001', MESSAGE = 'entry date falls outside the accounting period',
        CONSTRAINT = 'je_post_date', TABLE = 'journal_entries';
    END IF;
    IF v_period.status IN ('locked', 'future') THEN
      RAISE EXCEPTION USING ERRCODE = 'BH002',
        MESSAGE = 'the accounting period is locked or not yet open; no postings are allowed',
        CONSTRAINT = 'je_post_period_open', TABLE = 'journal_entries';
    END IF;
    IF v_period.status = 'soft_closed' AND NEW.entry_type NOT IN
       ('adjusting','accrual','reclass','elimination','revaluation','depreciation','amortization','reversing') THEN
      RAISE EXCEPTION USING ERRCODE = 'BH002',
        MESSAGE = 'the period is soft-closed; only adjusting-type entries may be posted',
        CONSTRAINT = 'je_post_soft_close', TABLE = 'journal_entries';
    END IF;
    IF NEW.reverses_entry_id IS NOT NULL THEN
      SELECT * INTO v_target FROM journal_entries WHERE id = NEW.reverses_entry_id;
      IF v_target.id IS NULL OR v_target.status <> 'posted' OR v_target.entity_id <> NEW.entity_id
         OR v_target.total_minor <> v_debit THEN
        RAISE EXCEPTION USING ERRCODE = 'BH001',
          MESSAGE = 'a reversal must reference a posted entry of the same entity with equal totals',
          CONSTRAINT = 'je_post_reversal', TABLE = 'journal_entries';
      END IF;
    END IF;
  END IF;

  IF v_period.id IS NOT NULL AND v_period.entity_id <> NEW.entity_id THEN
    RAISE EXCEPTION USING ERRCODE = 'BH001', MESSAGE = 'the period belongs to a different entity',
      CONSTRAINT = 'je_period_entity', TABLE = 'journal_entries';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_entries_guard
  BEFORE INSERT OR UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION bh_journal_entries_guard();

-- ---------------------------------------------------------------------------------------------------
-- Journal lines: frozen once the header is posted; must agree with the header
CREATE OR REPLACE FUNCTION bh_journal_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_je journal_entries%ROWTYPE;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT * INTO v_je FROM journal_entries WHERE id = OLD.journal_entry_id;
    IF v_je.id IS NOT NULL AND v_je.status = 'posted' THEN
      RAISE EXCEPTION USING ERRCODE = 'BH003',
        MESSAGE = 'lines of a posted journal entry cannot be added, changed or removed',
        CONSTRAINT = 'jl_parent_posted', TABLE = 'journal_lines';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
  END IF;

  SELECT * INTO v_je FROM journal_entries WHERE id = NEW.journal_entry_id;
  IF v_je.id IS NOT NULL THEN
    IF TG_OP = 'INSERT' AND v_je.status = 'posted' THEN
      RAISE EXCEPTION USING ERRCODE = 'BH003',
        MESSAGE = 'lines of a posted journal entry cannot be added, changed or removed',
        CONSTRAINT = 'jl_parent_posted', TABLE = 'journal_lines';
    END IF;
    IF v_je.entity_id <> NEW.entity_id OR v_je.period_id <> NEW.period_id OR v_je.entry_date <> NEW.entry_date THEN
      RAISE EXCEPTION USING ERRCODE = 'BH001',
        MESSAGE = 'line entity, period and date must match the journal entry header',
        CONSTRAINT = 'jl_header_match', TABLE = 'journal_lines';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION bh_journal_lines_guard();

-- ---------------------------------------------------------------------------------------------------
-- Period state machine: future -> open -> soft_closed -> locked (reopen: locked -> soft_closed, counted)
CREATE OR REPLACE FUNCTION bh_periods_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'future' AND NEW.status = 'open')
      OR (OLD.status = 'open' AND NEW.status = 'soft_closed')
      OR (OLD.status = 'soft_closed' AND NEW.status IN ('open', 'locked'))
      OR (OLD.status = 'locked' AND NEW.status = 'soft_closed')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'BH001',
        MESSAGE = format('invalid period status transition: %s -> %s', OLD.status, NEW.status),
        CONSTRAINT = 'period_transition', TABLE = 'periods';
    END IF;
    IF OLD.status = 'locked' AND NEW.reopened_count <> OLD.reopened_count + 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'BH001', MESSAGE = 'reopening a locked period must increment reopened_count',
        CONSTRAINT = 'period_reopen_count', TABLE = 'periods';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER periods_guard BEFORE UPDATE ON periods FOR EACH ROW EXECUTE FUNCTION bh_periods_guard();

-- ---------------------------------------------------------------------------------------------------
-- Audit log hash chain: every insert must continue the tenant's chain exactly
CREATE OR REPLACE FUNCTION bh_audit_chain_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_last audit_log%ROWTYPE;
  v_prev text;
  v_seq bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bh_audit:' || NEW.tenant_id::text, 0));
  SELECT * INTO v_last FROM audit_log WHERE tenant_id = NEW.tenant_id ORDER BY seq DESC LIMIT 1;
  IF v_last.id IS NULL THEN
    v_prev := repeat('0', 64);
    v_seq := 1;
  ELSE
    v_prev := v_last.hash;
    v_seq := v_last.seq + 1;
  END IF;
  IF NEW.seq <> v_seq OR NEW.prev_hash <> v_prev
     OR NEW.hash <> encode(sha256(convert_to(NEW.prev_hash || E'\n' || NEW.record, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION USING ERRCODE = 'BH004',
      MESSAGE = 'audit log chain broken: prev_hash/seq/hash do not continue the chain',
      CONSTRAINT = 'audit_chain', TABLE = 'audit_log';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION bh_audit_chain_guard();

-- Verify a tenant's whole chain in SQL (for auditors with database access): returns the first bad seq or NULL.
CREATE OR REPLACE FUNCTION bh_verify_audit_chain(p_tenant uuid) RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE
  r audit_log%ROWTYPE;
  v_prev text := repeat('0', 64);
  v_seq bigint := 0;
BEGIN
  FOR r IN SELECT * FROM audit_log WHERE tenant_id = p_tenant ORDER BY seq LOOP
    v_seq := v_seq + 1;
    IF r.seq <> v_seq OR r.prev_hash <> v_prev
       OR r.hash <> encode(sha256(convert_to(r.prev_hash || E'\n' || r.record, 'UTF8')), 'hex') THEN
      RETURN r.seq;
    END IF;
    v_prev := r.hash;
  END LOOP;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------------------------------
-- Posted subledger documents: amounts are frozen once a journal entry exists
CREATE OR REPLACE FUNCTION bh_posted_amount_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.journal_entry_id IS NOT NULL AND NEW.amount_minor IS DISTINCT FROM OLD.amount_minor THEN
    RAISE EXCEPTION USING ERRCODE = 'BH003',
      MESSAGE = 'the amount of a posted document cannot change; reverse and re-enter it',
      CONSTRAINT = TG_TABLE_NAME || '_posted_amount', TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bills','invoices','vendor_payments','customer_receipts']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION bh_posted_amount_guard()', t || '_posted_amount', t);
  END LOOP;
END $$;
