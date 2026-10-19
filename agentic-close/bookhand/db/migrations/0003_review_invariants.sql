-- 0003_review_invariants.sql
-- Database invariants tightened after the independent review (hand-written; mirrored by
-- src/persistence/invariants.ts for the in-memory adapter; tests/integration/conformance.ts runs the same
-- violation suite on every adapter). 0002 is left untouched: applied migrations never change.
--
--   BH-M4  a line can no longer be moved INTO a posted entry (UPDATE checked the old parent only), and posting
--          locks the period row, so a period lock and a posting into it cannot interleave.
--   BH-M2  the person who started an agent run cannot approve its output, whatever its kind or amount.
--   SEC-2  every structured audit column must equal the value in the hashed record, so time, actor type,
--          object type, IP and the rest are as tamper-evident as the record itself; the SQL verifier checks
--          the same.

-- ---------------------------------------------------------------------------------------------------
-- Journal entries: posting locks the period row (FOR UPDATE) before checking its status
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

  IF TG_OP = 'UPDATE' AND NEW.status = 'posted' THEN
    -- Hold the period row until this transaction ends: a concurrent lock of the period waits for the posting
    -- to commit, and a posting that waited behind a lock reads the period as locked and is refused.
    SELECT * INTO v_period FROM periods WHERE id = NEW.period_id FOR UPDATE;
  ELSE
    SELECT * INTO v_period FROM periods WHERE id = NEW.period_id;
  END IF;

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

-- ---------------------------------------------------------------------------------------------------
-- Journal lines: neither the entry a line leaves nor the entry it joins may be posted
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
    -- On INSERT and on UPDATE alike: moving a draft line into a posted entry would change posted totals.
    IF v_je.status = 'posted' THEN
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

-- ---------------------------------------------------------------------------------------------------
-- Proposals: whoever started the agent run that made a proposal never approves it
CREATE OR REPLACE FUNCTION bh_proposals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'approved' AND NEW.decided_by IS NOT NULL AND NEW.decided_by = NEW.requested_by THEN
    RAISE EXCEPTION USING ERRCODE = 'BH001',
      MESSAGE = 'the person who started an agent run cannot approve its output',
      CONSTRAINT = 'proposal_requester_independent', TABLE = 'proposals';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER proposals_guard BEFORE INSERT OR UPDATE ON proposals FOR EACH ROW EXECUTE FUNCTION bh_proposals_guard();

-- The rule's text and parameters follow (it used to allow the requester up to $10,000; it is now enforced above).
UPDATE sod_rules
   SET name = 'Agent run requester cannot approve its output',
       description = 'The person who started an agent run approves none of its output, whatever the kind or amount: someone independent must. Enforced by the database as well.',
       params = '{}'::jsonb, enabled = true, severity = 'block', version = version + 1, updated_at = now()
 WHERE code = 'SOD-002' AND kind = 'requester_limit';

-- ---------------------------------------------------------------------------------------------------
-- Audit log: the structured columns are the hashed record, column by column
CREATE OR REPLACE FUNCTION bh_audit_record_matches(r audit_log) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v jsonb;
BEGIN
  BEGIN
    v := r.record::jsonb;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
  RETURN jsonb_typeof(v) = 'object'
     AND (v->>'seq')::bigint IS NOT DISTINCT FROM r.seq
     AND (v->>'tenant_id') IS NOT DISTINCT FROM r.tenant_id::text
     AND (v->>'occurred_at')::timestamptz IS NOT DISTINCT FROM r.occurred_at
     AND (v->>'actor_type') IS NOT DISTINCT FROM r.actor_type
     AND (v->>'actor_id') IS NOT DISTINCT FROM r.actor_id
     AND (v->>'actor_label') IS NOT DISTINCT FROM r.actor_label
     AND (v->>'action') IS NOT DISTINCT FROM r.action
     AND (v->>'object_type') IS NOT DISTINCT FROM r.object_type
     AND (v->>'object_id') IS NOT DISTINCT FROM r.object_id
     AND (v->>'summary') IS NOT DISTINCT FROM r.summary
     AND (v->>'request_id') IS NOT DISTINCT FROM r.request_id
     AND (v->>'ip') IS NOT DISTINCT FROM r.ip;
EXCEPTION WHEN others THEN
  RETURN false;
END $$;

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
  IF NOT bh_audit_record_matches(NEW) THEN
    RAISE EXCEPTION USING ERRCODE = 'BH004',
      MESSAGE = 'audit event columns must equal the hashed record',
      CONSTRAINT = 'audit_record_columns', TABLE = 'audit_log';
  END IF;
  RETURN NEW;
END $$;

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
       OR r.hash <> encode(sha256(convert_to(r.prev_hash || E'\n' || r.record, 'UTF8')), 'hex')
       OR NOT bh_audit_record_matches(r) THEN
      RETURN r.seq;
    END IF;
    v_prev := r.hash;
  END LOOP;
  RETURN NULL;
END $$;
