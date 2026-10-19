-- Evenkeel 0002: database-enforced invariants (defence in depth behind the domain layer).
-- Every RAISE carries an "EK-…" code naming the ontology axiom it enforces.

-- ---------------------------------------------------------------- journal entries
CREATE OR REPLACE FUNCTION ek_je_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tmp journal_entry%ROWTYPE;
  p fiscal_period%ROWTYPE;
  d bigint;
  c bigint;
  n integer;
  bad text;
  elim boolean;
  o journal_entry%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' THEN
      RAISE EXCEPTION 'EK-JE-IMMUTABLE: posted entry % cannot be deleted; post a reversing entry instead', OLD.entry_number;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'posted' THEN
      RAISE EXCEPTION 'EK-JE-POST-VIA-DRAFT: insert entry % as draft, add its lines, then post it', NEW.entry_number;
    END IF;
    SELECT * INTO p FROM fiscal_period WHERE id = NEW.period_id;
    IF p.status = 'hard_close' THEN
      RAISE EXCEPTION 'EK-PERIOD-LOCKED: % is hard-closed; no new entries', NEW.period_key;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD.status = 'posted' THEN
    tmp := NEW;
    tmp.reversed_by_entry_id := OLD.reversed_by_entry_id;
    IF tmp IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'EK-JE-IMMUTABLE: posted entry % cannot be changed; post a reversing entry instead', OLD.entry_number;
    END IF;
    IF OLD.reversed_by_entry_id IS NOT NULL AND NEW.reversed_by_entry_id IS DISTINCT FROM OLD.reversed_by_entry_id THEN
      RAISE EXCEPTION 'EK-JE-IMMUTABLE: entry % is already reversed', OLD.entry_number;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'posted' THEN
    SELECT * INTO p FROM fiscal_period WHERE id = NEW.period_id;
    IF p.entity_id <> NEW.entity_id OR p.period_key <> NEW.period_key THEN
      RAISE EXCEPTION 'EK-PER-02: entry % period record does not match its entity/period', NEW.entry_number;
    END IF;
    IF p.status = 'hard_close' THEN
      RAISE EXCEPTION 'EK-PERIOD-LOCKED: % is hard-closed; post the correction in an open period', NEW.period_key;
    END IF;
    IF p.status = 'soft_close' AND NEW.entry_type NOT IN ('adjusting','accrual','reclass','elimination','fx_revaluation','depreciation','amortization','reversing') THEN
      RAISE EXCEPTION 'EK-PERIOD-SOFT-CLOSE: % is soft-closed; % entries are not allowed', NEW.period_key, NEW.entry_type;
    END IF;
    IF NEW.entry_date < p.start_date OR NEW.entry_date > p.end_date THEN
      RAISE EXCEPTION 'EK-PER-02: entry date % is outside %', NEW.entry_date, NEW.period_key;
    END IF;

    SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*) INTO d, c, n
      FROM journal_line WHERE journal_entry_id = NEW.id;
    IF n < 2 THEN
      RAISE EXCEPTION 'EK-DE-03: entry % needs at least one debit and one credit line', NEW.entry_number;
    END IF;
    IF d <> c OR d = 0 THEN
      RAISE EXCEPTION 'EK-DE-01: entry % is unbalanced (debits %, credits %)', NEW.entry_number, d, c;
    END IF;

    SELECT string_agg(a.code, ', ') INTO bad
      FROM journal_line l JOIN account a ON a.id = l.account_id
     WHERE l.journal_entry_id = NEW.id AND (NOT a.is_postable OR NOT a.is_active OR a.tenant_id <> NEW.tenant_id);
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'EK-ACC-01: entry % posts to non-postable, inactive or foreign accounts: %', NEW.entry_number, bad;
    END IF;

    SELECT is_elimination INTO elim FROM entity WHERE id = NEW.entity_id;
    IF (NEW.entry_type = 'elimination' AND NOT elim)
       OR (elim AND NEW.entry_type <> 'elimination' AND NOT (NEW.entry_type = 'reversing' AND NEW.reverses_entry_id IS NOT NULL)) THEN
      RAISE EXCEPTION 'EK-JE-04: elimination entries belong only to the elimination entity (entry %)', NEW.entry_number;
    END IF;

    IF NEW.approved_by IS NOT NULL AND (NEW.approved_by = NEW.prepared_by OR NEW.approved_by = NEW.requested_by) THEN
      RAISE EXCEPTION 'EK-SOD-01: the preparer or requester of % cannot approve it', NEW.entry_number;
    END IF;

    IF NEW.reverses_entry_id IS NOT NULL THEN
      SELECT * INTO o FROM journal_entry WHERE id = NEW.reverses_entry_id;
      IF o.status <> 'posted' OR o.reversed_by_entry_id IS NOT NULL OR o.entity_id <> NEW.entity_id OR NEW.entry_date < o.entry_date THEN
        RAISE EXCEPTION 'EK-JE-02: % cannot reverse % (must be posted, unreversed, same entity, not earlier)', NEW.entry_number, o.entry_number;
      END IF;
      IF EXISTS (
        (SELECT account_id, credit, debit FROM journal_line WHERE journal_entry_id = o.id
         EXCEPT ALL
         SELECT account_id, debit, credit FROM journal_line WHERE journal_entry_id = NEW.id)
        UNION ALL
        (SELECT account_id, debit, credit FROM journal_line WHERE journal_entry_id = NEW.id
         EXCEPT ALL
         SELECT account_id, credit, debit FROM journal_line WHERE journal_entry_id = o.id)
      ) THEN
        RAISE EXCEPTION 'EK-JE-02: reversal % must mirror % with debits and credits swapped', NEW.entry_number, o.entry_number;
      END IF;
    END IF;

    NEW.total_debit := d;
    IF NEW.posted_at IS NULL THEN
      NEW.posted_at := now();
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_entry_guard
  BEFORE INSERT OR UPDATE OR DELETE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION ek_je_guard();

-- Link the original when a reversal posts (the only permitted change to a posted entry).
CREATE OR REPLACE FUNCTION ek_je_link_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'posted' AND OLD.status <> 'posted' AND NEW.reverses_entry_id IS NOT NULL THEN
    UPDATE journal_entry SET reversed_by_entry_id = NEW.id
     WHERE id = NEW.reverses_entry_id AND reversed_by_entry_id IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'EK-JE-02: original of % is already reversed', NEW.entry_number;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_entry_link_reversal
  AFTER UPDATE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION ek_je_link_reversal();

CREATE OR REPLACE FUNCTION ek_jl_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  st text;
  tn uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO st FROM journal_entry WHERE id = OLD.journal_entry_id;
    IF st = 'posted' THEN
      RAISE EXCEPTION 'EK-JE-IMMUTABLE: lines of a posted entry cannot change';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status, tenant_id INTO st, tn FROM journal_entry WHERE id = NEW.journal_entry_id;
    IF st = 'posted' THEN
      RAISE EXCEPTION 'EK-JE-IMMUTABLE: lines cannot be added to a posted entry';
    END IF;
    IF tn <> NEW.tenant_id THEN
      RAISE EXCEPTION 'EK-TENANT: journal line tenant differs from its entry';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER journal_line_guard
  BEFORE INSERT OR UPDATE OR DELETE ON journal_line
  FOR EACH ROW EXECUTE FUNCTION ek_jl_guard();

-- ------------------------------------------------------------------ fiscal periods
CREATE OR REPLACE FUNCTION ek_period_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF (OLD.status = 'open' AND NEW.status = 'soft_close') OR (OLD.status = 'soft_close' AND NEW.status = 'hard_close') THEN
    RETURN NEW;
  END IF;
  IF (OLD.status = 'hard_close' AND NEW.status = 'soft_close') OR (OLD.status = 'soft_close' AND NEW.status = 'open') THEN
    IF NEW.reopen_reason IS NULL OR length(NEW.reopen_reason) < 10 THEN
      RAISE EXCEPTION 'EK-PERIOD-REOPEN: reopening % requires a documented reason', NEW.period_key;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'EK-PERIOD-TRANSITION: % → % is not allowed (open → soft_close → hard_close)', OLD.status, NEW.status;
END $$;

CREATE TRIGGER fiscal_period_guard
  BEFORE UPDATE ON fiscal_period
  FOR EACH ROW EXECUTE FUNCTION ek_period_guard();

-- -------------------------------------------------------------------- audit chain
CREATE OR REPLACE FUNCTION ek_audit_hash(prev text, seq bigint, tenant uuid, at timestamptz, atype text, aid text, act text, stype text, sid text, payload jsonb)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(
    prev || '|' || seq::text || '|' || tenant::text || '|' ||
    to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|' ||
    atype || '|' || coalesce(aid, '') || '|' || act || '|' || coalesce(stype, '') || '|' || coalesce(sid, '') || '|' ||
    coalesce(payload::text, 'null'),
  'UTF8')), 'hex')
$$;

CREATE OR REPLACE FUNCTION ek_audit_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  head audit_chain_head%ROWTYPE;
BEGIN
  INSERT INTO audit_chain_head (tenant_id, last_seq, last_hash)
  VALUES (NEW.tenant_id, 0, repeat('0', 64))
  ON CONFLICT (tenant_id) DO NOTHING;
  SELECT * INTO head FROM audit_chain_head WHERE tenant_id = NEW.tenant_id FOR UPDATE;
  NEW.occurred_at := date_trunc('milliseconds', NEW.occurred_at);
  NEW.seq := head.last_seq + 1;
  NEW.prev_hash := head.last_hash;
  NEW.hash := ek_audit_hash(NEW.prev_hash, NEW.seq, NEW.tenant_id, NEW.occurred_at, NEW.actor_type, NEW.actor_id, NEW.action, NEW.subject_type, NEW.subject_id, NEW.data);
  UPDATE audit_chain_head SET last_seq = NEW.seq, last_hash = NEW.hash WHERE tenant_id = NEW.tenant_id;
  RETURN NEW;
END $$;

CREATE TRIGGER audit_log_chain
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION ek_audit_chain();

CREATE OR REPLACE FUNCTION ek_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'EK-AUDIT-APPEND-ONLY: % is append-only', TG_TABLE_NAME;
END $$;

CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION ek_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION ek_append_only();
CREATE TRIGGER signoff_append_only BEFORE UPDATE OR DELETE ON signoff FOR EACH ROW EXECUTE FUNCTION ek_append_only();
CREATE TRIGGER approval_append_only BEFORE UPDATE OR DELETE ON approval FOR EACH ROW EXECUTE FUNCTION ek_append_only();

CREATE OR REPLACE FUNCTION ek_verify_audit_chain(t uuid)
RETURNS TABLE (ok boolean, checked bigint, first_bad_seq bigint) LANGUAGE plpgsql STABLE AS $$
DECLARE
  r record;
  prev text := repeat('0', 64);
  n bigint := 0;
BEGIN
  FOR r IN SELECT * FROM audit_log WHERE tenant_id = t ORDER BY seq LOOP
    n := n + 1;
    IF r.seq <> n OR r.prev_hash <> prev OR r.hash <> ek_audit_hash(r.prev_hash, r.seq, r.tenant_id, r.occurred_at, r.actor_type, r.actor_id, r.action, r.subject_type, r.subject_id, r.data) THEN
      RETURN QUERY SELECT false, n, r.seq;
      RETURN;
    END IF;
    prev := r.hash;
  END LOOP;
  RETURN QUERY SELECT true, n, NULL::bigint;
END $$;

-- ------------------------------------------------------------- close management
CREATE OR REPLACE FUNCTION ek_task_dep_acyclic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE reach(id) AS (
      SELECT depends_on_task_id FROM close_task_dependency WHERE task_id = NEW.depends_on_task_id
      UNION
      SELECT d.depends_on_task_id FROM close_task_dependency d JOIN reach r ON d.task_id = r.id
    )
    SELECT 1 FROM reach WHERE id = NEW.task_id
  ) THEN
    RAISE EXCEPTION 'EK-CLS-01: dependency would create a cycle';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER close_task_dependency_acyclic
  BEFORE INSERT OR UPDATE ON close_task_dependency
  FOR EACH ROW EXECUTE FUNCTION ek_task_dep_acyclic();

CREATE OR REPLACE FUNCTION ek_package_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EK-PACKAGE: close packages are never deleted';
  END IF;
  IF OLD.status = 'final' THEN
    RAISE EXCEPTION 'EK-PACKAGE-FINAL: the % close package is final and cannot change', OLD.period_key;
  END IF;
  IF NEW.content IS DISTINCT FROM OLD.content OR NEW.content_hash IS DISTINCT FROM OLD.content_hash THEN
    RAISE EXCEPTION 'EK-PACKAGE: package content is immutable; generate a new version';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER close_package_guard
  BEFORE UPDATE OR DELETE ON close_package
  FOR EACH ROW EXECUTE FUNCTION ek_package_guard();

-- ------------------------------------------------------------------ proposals
CREATE OR REPLACE FUNCTION ek_proposal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payload IS DISTINCT FROM OLD.payload OR NEW.why IS DISTINCT FROM OLD.why OR NEW.confidence IS DISTINCT FROM OLD.confidence
     OR NEW.evidence IS DISTINCT FROM OLD.evidence OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.run_id IS DISTINCT FROM OLD.run_id THEN
    RAISE EXCEPTION 'EK-PRP-IMMUTABLE: a proposal''s content cannot change after it is made';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('approved','rejected','applied','auto_applied','superseded','failed'))
    OR (OLD.status = 'approved' AND NEW.status IN ('applied','failed'))
    OR (OLD.status = 'suggested' AND NEW.status IN ('approved','applied','rejected','superseded'))
    OR (OLD.status = 'failed' AND NEW.status IN ('superseded','pending'))
  ) THEN
    RAISE EXCEPTION 'EK-PRP-TRANSITION: proposal cannot move from % to %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER proposal_guard
  BEFORE UPDATE ON proposal
  FOR EACH ROW EXECUTE FUNCTION ek_proposal_guard();
