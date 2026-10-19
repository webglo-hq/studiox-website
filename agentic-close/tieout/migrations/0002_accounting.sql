-- =============================================================================
-- Tieout migration 0002: accounting domain pack
-- Multi-entity GL, subledgers, budgets, close management, reconciliations,
-- flux analysis, close packages. Invariants are enforced here as well as in the
-- domain layer (defense in depth). AX-* codes reference ontology axioms.
-- =============================================================================

CREATE TABLE currencies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  minor_units INT NOT NULL DEFAULT 2,
  CHECK (id ~ '^[A-Z]{3}$')
);

CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'legal' CHECK (kind IN ('legal', 'elimination')),
  country TEXT NOT NULL,
  functional_currency TEXT NOT NULL REFERENCES currencies(id),
  reporting_currency TEXT NOT NULL REFERENCES currencies(id),
  parent_id TEXT REFERENCES entities(id),
  ownership_pct NUMERIC(5,2) NOT NULL DEFAULT 100,
  holiday_calendar TEXT NOT NULL DEFAULT 'US' CHECK (holiday_calendar IN ('US', 'UK')),
  materiality JSONB NOT NULL, -- @json MaterialitySettings
  sort_order INT NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, code),
  CHECK (ownership_pct > 0 AND ownership_pct <= 100),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE TABLE fx_rates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  rate_date DATE NOT NULL,
  from_currency TEXT NOT NULL REFERENCES currencies(id),
  to_currency TEXT NOT NULL REFERENCES currencies(id),
  rate_type TEXT NOT NULL CHECK (rate_type IN ('spot', 'closing', 'average', 'historical')),
  rate NUMERIC(18,8) NOT NULL,
  period_key TEXT,
  source TEXT NOT NULL,
  UNIQUE (tenant_id, rate_date, from_currency, to_currency, rate_type),
  CHECK (rate > 0),
  CHECK (from_currency <> to_currency)
);

-- Financial-statement line items (presentation hierarchy, mapped to XBRL US-GAAP concepts)
CREATE TABLE fs_line_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  statement TEXT NOT NULL CHECK (statement IN ('BS', 'IS')),
  section TEXT NOT NULL,
  label TEXT NOT NULL,
  xbrl_concept TEXT NOT NULL,
  sort_order INT NOT NULL,
  UNIQUE (tenant_id, code)
);

-- Chart of accounts (AX-AC-*). Summary accounts (is_postable = false) group leaf accounts.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  account_class TEXT NOT NULL CHECK (account_class IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  ontology_class TEXT NOT NULL,
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  is_contra BOOLEAN NOT NULL DEFAULT false,
  parent_id TEXT REFERENCES accounts(id),
  is_postable BOOLEAN NOT NULL DEFAULT true,
  control_subledger TEXT CHECK (control_subledger IN ('ap', 'ar', 'bank', 'card', 'fixed_assets', 'prepaid', 'payroll', 'intercompany')),
  fs_line_id TEXT REFERENCES fs_line_items(id),
  xbrl_concept TEXT,
  required_dimensions JSONB NOT NULL DEFAULT '[]'::jsonb, -- @json DimensionKey[]
  is_monetary BOOLEAN NOT NULL DEFAULT false,
  is_intercompany BOOLEAN NOT NULL DEFAULT false,
  cash_flow_category TEXT CHECK (cash_flow_category IN ('cash', 'operating', 'investing', 'financing')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  description TEXT NOT NULL DEFAULT '',
  UNIQUE (tenant_id, code),
  -- AX-AC-03: normal balance follows class; contra accounts invert it
  CHECK (
    (account_class IN ('asset', 'expense') AND normal_balance = (CASE WHEN is_contra THEN 'credit' ELSE 'debit' END))
    OR (account_class IN ('liability', 'equity', 'revenue') AND normal_balance = (CASE WHEN is_contra THEN 'debit' ELSE 'credit' END))
  )
);

CREATE TABLE dimensions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  key TEXT NOT NULL CHECK (key IN ('department', 'location', 'product_class', 'project')),
  name TEXT NOT NULL,
  UNIQUE (tenant_id, key)
);

CREATE TABLE dimension_values (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  dimension_id TEXT NOT NULL REFERENCES dimensions(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  UNIQUE (dimension_id, code)
);

-- Accounting periods per entity (AX-PD-*)
CREATE TABLE periods (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  period_key TEXT NOT NULL,
  fiscal_year INT NOT NULL,
  fiscal_period INT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'future' CHECK (status IN ('future', 'open', 'soft_closed', 'locked')),
  soft_closed_at TIMESTAMPTZ,
  soft_closed_by TEXT,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  status_reason TEXT,
  reopen_count INT NOT NULL DEFAULT 0,
  UNIQUE (entity_id, period_key),
  CHECK (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CHECK (end_date >= start_date),
  CHECK (fiscal_period BETWEEN 1 AND 12)
);

-- ----------------------------------------------------------- general ledger ---
CREATE TABLE journal_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  period_id TEXT NOT NULL REFERENCES periods(id),
  je_number TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('standard', 'adjusting', 'accrual', 'reversing', 'recurring', 'reclass', 'elimination', 'fx_revaluation', 'opening')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'posted', 'rejected', 'void')),
  posting_date DATE NOT NULL,
  memo TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual', 'agent', 'subledger', 'import', 'system')),
  source_ref TEXT,
  source_document_id TEXT REFERENCES source_documents(id),
  proposal_id TEXT,
  agent_run_id TEXT,
  currency TEXT NOT NULL REFERENCES currencies(id),
  total_minor BIGINT NOT NULL DEFAULT 0,
  prepared_by TEXT NOT NULL,
  approved_by TEXT,
  approval_route TEXT CHECK (approval_route IN ('human', 'policy', 'system')),
  posted_by TEXT,
  posted_at TIMESTAMPTZ,
  reverses_je_id TEXT UNIQUE REFERENCES journal_entries(id),
  auto_reverse_on DATE,
  counterparty_entity_id TEXT REFERENCES entities(id),
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, je_number),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (total_minor >= 0),
  CHECK (reverses_je_id IS NULL OR reverses_je_id <> id),
  CHECK (auto_reverse_on IS NULL OR auto_reverse_on > posting_date),
  CHECK (status <> 'posted' OR (posted_at IS NOT NULL AND posted_by IS NOT NULL AND approval_route IS NOT NULL))
);
CREATE INDEX journal_entries_period_idx ON journal_entries (tenant_id, entity_id, period_id, status);
CREATE INDEX journal_entries_date_idx ON journal_entries (tenant_id, entity_id, posting_date);

CREATE TABLE journal_lines (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  line_no INT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  debit_minor BIGINT NOT NULL DEFAULT 0,
  credit_minor BIGINT NOT NULL DEFAULT 0,
  memo TEXT,
  department TEXT,
  location TEXT,
  product_class TEXT,
  project TEXT,
  txn_currency TEXT REFERENCES currencies(id),
  txn_amount_minor BIGINT,
  fx_rate NUMERIC(18,8),
  counterparty_entity_id TEXT REFERENCES entities(id),
  source_line_ref TEXT,
  UNIQUE (journal_entry_id, line_no),
  -- AX-DE-02: every line is one-sided and strictly positive
  CHECK (debit_minor >= 0 AND credit_minor >= 0),
  CHECK ((debit_minor > 0 AND credit_minor = 0) OR (credit_minor > 0 AND debit_minor = 0)),
  CHECK ((txn_currency IS NULL) = (txn_amount_minor IS NULL)),
  CHECK (fx_rate IS NULL OR fx_rate > 0)
);
CREATE INDEX journal_lines_je_idx ON journal_lines (journal_entry_id);
CREATE INDEX journal_lines_account_idx ON journal_lines (tenant_id, account_id);

-- AX-IM-01 / AX-DE-01 / AX-DE-03 / AX-PD-01 / AX-PD-02 / AX-SOD-01 / AX-IM-02
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
    SELECT status, start_date, end_date INTO p_status, p_start, p_end FROM periods WHERE id = NEW.period_id;
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

CREATE TRIGGER journal_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION tieout_je_guard();

-- Lines are editable only while the entry is a draft or awaiting approval (AX-IM-01)
CREATE OR REPLACE FUNCTION tieout_jl_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  je_status TEXT;
  je_id TEXT;
  acct_postable BOOLEAN;
  acct_status TEXT;
BEGIN
  je_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.journal_entry_id ELSE NEW.journal_entry_id END;
  SELECT status INTO je_status FROM journal_entries WHERE id = je_id;
  IF je_status IS NOT NULL AND je_status NOT IN ('draft', 'pending_approval') THEN
    RAISE EXCEPTION 'AX-IM-01: lines of a % journal entry cannot change', je_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  SELECT is_postable, status INTO acct_postable, acct_status FROM accounts WHERE id = NEW.account_id;
  IF NOT acct_postable OR acct_status <> 'active' THEN
    RAISE EXCEPTION 'AX-AC-01: account % is not an active postable account', NEW.account_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER journal_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION tieout_jl_guard();

-- AX-PD-03: allowed period state transitions
CREATE OR REPLACE FUNCTION tieout_period_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.status = 'future' AND NEW.status = 'open')
    OR (OLD.status = 'open' AND NEW.status = 'soft_closed')
    OR (OLD.status = 'soft_closed' AND NEW.status IN ('open', 'locked'))
    OR (OLD.status = 'locked' AND NEW.status = 'soft_closed')
  ) THEN
    RAISE EXCEPTION 'AX-PD-03: period % cannot move from % to %', OLD.period_key, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'locked' AND (NEW.status_reason IS NULL OR length(NEW.status_reason) < 10) THEN
    RAISE EXCEPTION 'AX-PD-03: unlocking period % requires a documented reason', OLD.period_key
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER periods_guard BEFORE UPDATE ON periods
  FOR EACH ROW EXECUTE FUNCTION tieout_period_guard();

-- --------------------------------------------------------------- subledgers ---
CREATE TABLE vendors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  entity_id TEXT REFERENCES entities(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  default_account_id TEXT REFERENCES accounts(id),
  default_department TEXT,
  payment_terms_days INT NOT NULL DEFAULT 30,
  bank_last4 TEXT,
  is_intercompany BOOLEAN NOT NULL DEFAULT false,
  counterparty_entity_id TEXT REFERENCES entities(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'blocked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE purchase_orders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  vendor_id TEXT NOT NULL REFERENCES vendors(id),
  po_number TEXT NOT NULL,
  order_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'partially_received', 'received', 'closed')),
  currency TEXT NOT NULL REFERENCES currencies(id),
  total_minor BIGINT NOT NULL,
  account_id TEXT REFERENCES accounts(id),
  department TEXT,
  description TEXT NOT NULL,
  requested_by_name TEXT,
  UNIQUE (tenant_id, po_number),
  CHECK (total_minor > 0)
);

CREATE TABLE goods_receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id),
  receipt_date DATE NOT NULL,
  amount_minor BIGINT NOT NULL,
  description TEXT NOT NULL,
  received_by_name TEXT,
  CHECK (amount_minor > 0)
);

CREATE TABLE bills (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  vendor_id TEXT NOT NULL REFERENCES vendors(id),
  bill_number TEXT NOT NULL,
  bill_date DATE NOT NULL,
  due_date DATE NOT NULL,
  received_date DATE NOT NULL,
  service_period_start DATE,
  service_period_end DATE,
  currency TEXT NOT NULL REFERENCES currencies(id),
  total_minor BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('received', 'pending_approval', 'approved', 'posted', 'partially_paid', 'paid', 'void')),
  purchase_order_id TEXT REFERENCES purchase_orders(id),
  journal_entry_id TEXT REFERENCES journal_entries(id),
  source_document_id TEXT REFERENCES source_documents(id),
  import_batch_id TEXT REFERENCES import_batches(id),
  external_id TEXT,
  description TEXT NOT NULL,
  UNIQUE (tenant_id, vendor_id, bill_number),
  UNIQUE (tenant_id, external_id),
  CHECK (total_minor > 0),
  CHECK (due_date >= bill_date),
  CHECK (service_period_end IS NULL OR service_period_start IS NULL OR service_period_end >= service_period_start)
);

CREATE TABLE bill_lines (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  line_no INT NOT NULL,
  description TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  account_id TEXT REFERENCES accounts(id),
  department TEXT,
  location TEXT,
  product_class TEXT,
  project TEXT,
  coding_source TEXT CHECK (coding_source IN ('human', 'rule', 'agent', 'vendor_default')),
  coding_confidence NUMERIC(4,3),
  UNIQUE (bill_id, line_no),
  CHECK (amount_minor > 0)
);

CREATE TABLE bank_accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  name TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  account_last4 TEXT NOT NULL,
  currency TEXT NOT NULL REFERENCES currencies(id),
  gl_account_id TEXT NOT NULL REFERENCES accounts(id),
  statement_format TEXT NOT NULL CHECK (statement_format IN ('bai2', 'camt053', 'ofx', 'csv')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  UNIQUE (tenant_id, gl_account_id)
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  vendor_id TEXT NOT NULL REFERENCES vendors(id),
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  payment_number TEXT NOT NULL,
  payment_date DATE NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('ach', 'wire', 'check', 'card')),
  check_number TEXT,
  amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL REFERENCES currencies(id),
  reference TEXT,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'sent', 'cleared', 'void')),
  journal_entry_id TEXT REFERENCES journal_entries(id),
  approved_by TEXT,
  UNIQUE (tenant_id, payment_number),
  CHECK (amount_minor > 0),
  CHECK (method <> 'check' OR check_number IS NOT NULL)
);

CREATE TABLE payment_applications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  bill_id TEXT NOT NULL REFERENCES bills(id),
  amount_minor BIGINT NOT NULL,
  CHECK (amount_minor > 0)
);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  entity_id TEXT REFERENCES entities(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  segment TEXT NOT NULL,
  payment_terms_days INT NOT NULL DEFAULT 30,
  is_intercompany BOOLEAN NOT NULL DEFAULT false,
  counterparty_entity_id TEXT REFERENCES entities(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  UNIQUE (tenant_id, code)
);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  invoice_number TEXT NOT NULL,
  invoice_date DATE NOT NULL,
  due_date DATE NOT NULL,
  currency TEXT NOT NULL REFERENCES currencies(id),
  total_minor BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'posted', 'partially_paid', 'paid', 'void')),
  journal_entry_id TEXT REFERENCES journal_entries(id),
  description TEXT NOT NULL,
  UNIQUE (tenant_id, invoice_number),
  CHECK (total_minor > 0),
  CHECK (due_date >= invoice_date)
);

CREATE TABLE invoice_lines (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_no INT NOT NULL,
  description TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  revenue_type TEXT NOT NULL CHECK (revenue_type IN ('subscription', 'hardware', 'services')),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  service_start DATE,
  service_end DATE,
  product_class TEXT,
  UNIQUE (invoice_id, line_no),
  CHECK (amount_minor > 0)
);

CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  receipt_date DATE NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL REFERENCES currencies(id),
  method TEXT NOT NULL CHECK (method IN ('ach', 'wire', 'check', 'card')),
  reference TEXT,
  status TEXT NOT NULL CHECK (status IN ('recorded', 'deposited', 'cleared')),
  journal_entry_id TEXT REFERENCES journal_entries(id),
  CHECK (amount_minor > 0)
);

CREATE TABLE receipt_applications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  receipt_id TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  amount_minor BIGINT NOT NULL,
  CHECK (amount_minor > 0)
);

CREATE TABLE bank_statements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  period_key TEXT NOT NULL,
  statement_date DATE NOT NULL,
  opening_balance_minor BIGINT NOT NULL,
  closing_balance_minor BIGINT NOT NULL,
  import_batch_id TEXT REFERENCES import_batches(id),
  source_document_id TEXT REFERENCES source_documents(id),
  UNIQUE (bank_account_id, period_key)
);

-- amount_minor is signed from the bank's view: + money in (credit), - money out (debit)
CREATE TABLE bank_transactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  txn_date DATE NOT NULL,
  value_date DATE,
  amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL REFERENCES currencies(id),
  description TEXT NOT NULL,
  counterparty TEXT,
  reference TEXT,
  type_code TEXT,
  status TEXT NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched', 'matched', 'excluded')),
  injection_suspected BOOLEAN NOT NULL DEFAULT false,
  import_batch_id TEXT REFERENCES import_batches(id),
  source_document_id TEXT REFERENCES source_documents(id),
  source_line INT,
  external_id TEXT NOT NULL,
  UNIQUE (tenant_id, bank_account_id, external_id),
  CHECK (amount_minor <> 0)
);
CREATE INDEX bank_transactions_date_idx ON bank_transactions (tenant_id, bank_account_id, txn_date);

CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  cardholder_name TEXT NOT NULL,
  last4 TEXT NOT NULL,
  department TEXT,
  gl_account_id TEXT NOT NULL REFERENCES accounts(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'closed'))
);

CREATE TABLE card_transactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  card_id TEXT NOT NULL REFERENCES cards(id),
  txn_date DATE NOT NULL,
  post_date DATE NOT NULL,
  merchant_name TEXT NOT NULL,
  mcc TEXT,
  amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL REFERENCES currencies(id),
  memo TEXT,
  receipt_status TEXT NOT NULL DEFAULT 'attached' CHECK (receipt_status IN ('attached', 'missing', 'not_required')),
  account_id TEXT REFERENCES accounts(id),
  department TEXT,
  location TEXT,
  product_class TEXT,
  project TEXT,
  coding_source TEXT CHECK (coding_source IN ('human', 'rule', 'agent', 'vendor_default')),
  coding_confidence NUMERIC(4,3),
  status TEXT NOT NULL CHECK (status IN ('pending_coding', 'coded', 'posted', 'excluded')),
  journal_entry_id TEXT REFERENCES journal_entries(id),
  import_batch_id TEXT REFERENCES import_batches(id),
  source_document_id TEXT REFERENCES source_documents(id),
  source_line INT,
  external_id TEXT NOT NULL,
  UNIQUE (tenant_id, external_id),
  CHECK (amount_minor <> 0),
  CHECK (status <> 'posted' OR journal_entry_id IS NOT NULL)
);
CREATE INDEX card_transactions_date_idx ON card_transactions (tenant_id, entity_id, txn_date);

CREATE TABLE fixed_assets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  asset_tag TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('computer_equipment', 'lab_equipment', 'furniture', 'leasehold_improvements')),
  in_service_date DATE NOT NULL,
  cost_minor BIGINT NOT NULL,
  salvage_minor BIGINT NOT NULL DEFAULT 0,
  useful_life_months INT NOT NULL,
  method TEXT NOT NULL DEFAULT 'straight_line' CHECK (method IN ('straight_line')),
  asset_account_id TEXT NOT NULL REFERENCES accounts(id),
  accum_depr_account_id TEXT NOT NULL REFERENCES accounts(id),
  expense_account_id TEXT NOT NULL REFERENCES accounts(id),
  department TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'fully_depreciated', 'disposed')),
  source_bill_id TEXT REFERENCES bills(id),
  UNIQUE (tenant_id, asset_tag),
  CHECK (cost_minor > 0 AND salvage_minor >= 0 AND salvage_minor < cost_minor),
  CHECK (useful_life_months > 0)
);

CREATE TABLE depreciation_lines (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  fixed_asset_id TEXT NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'posted')),
  journal_entry_id TEXT REFERENCES journal_entries(id),
  UNIQUE (fixed_asset_id, period_key),
  CHECK (amount_minor > 0)
);

CREATE TABLE prepaid_schedules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  vendor_id TEXT REFERENCES vendors(id),
  description TEXT NOT NULL,
  start_period TEXT NOT NULL,
  months INT NOT NULL,
  total_minor BIGINT NOT NULL,
  prepaid_account_id TEXT NOT NULL REFERENCES accounts(id),
  expense_account_id TEXT NOT NULL REFERENCES accounts(id),
  department TEXT,
  source_bill_id TEXT REFERENCES bills(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  CHECK (months > 0 AND total_minor > 0)
);

CREATE TABLE prepaid_lines (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  prepaid_schedule_id TEXT NOT NULL REFERENCES prepaid_schedules(id) ON DELETE CASCADE,
  period_key TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'posted')),
  journal_entry_id TEXT REFERENCES journal_entries(id),
  UNIQUE (prepaid_schedule_id, period_key),
  CHECK (amount_minor > 0)
);

CREATE TABLE payroll_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  provider TEXT NOT NULL,
  pay_date DATE NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  currency TEXT NOT NULL REFERENCES currencies(id),
  gross_minor BIGINT NOT NULL,
  employer_taxes_minor BIGINT NOT NULL,
  benefits_minor BIGINT NOT NULL,
  withholdings_minor BIGINT NOT NULL,
  net_pay_minor BIGINT NOT NULL,
  by_department JSONB NOT NULL, -- @json Record<string, number>
  journal_entry_id TEXT REFERENCES journal_entries(id),
  import_batch_id TEXT REFERENCES import_batches(id),
  source_document_id TEXT REFERENCES source_documents(id),
  external_id TEXT NOT NULL,
  UNIQUE (tenant_id, external_id),
  CHECK (period_end >= period_start),
  CHECK (net_pay_minor = gross_minor - withholdings_minor)
);

-- ------------------------------------------------------- budgets / forecasts ---
CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('budget', 'forecast')),
  fiscal_year INT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'superseded')),
  currency TEXT NOT NULL REFERENCES currencies(id),
  approved_by TEXT,
  UNIQUE (entity_id, kind, fiscal_year, version)
);

-- amounts are in the account's natural (normal-balance) direction
CREATE TABLE budget_lines (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  department TEXT,
  period_key TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  driver_note TEXT,
  UNIQUE (budget_id, account_id, department, period_key)
);

-- ---------------------------------------------------------- close management ---
CREATE TABLE close_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE close_template_tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  template_id TEXT NOT NULL REFERENCES close_templates(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  workday_offset INT NOT NULL,
  owner_role TEXT NOT NULL,
  reviewer_role TEXT,
  skill_key TEXT,
  entity_scope TEXT NOT NULL CHECK (entity_scope IN ('each_legal', 'parent', 'group')),
  depends_on JSONB NOT NULL DEFAULT '[]'::jsonb, -- @json string[]
  evidence_required BOOLEAN NOT NULL DEFAULT false,
  sort_order INT NOT NULL,
  UNIQUE (template_id, key),
  CHECK (workday_offset BETWEEN -10 AND 15 AND workday_offset <> 0)
);

CREATE TABLE close_periods (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  period_key TEXT NOT NULL,
  template_id TEXT NOT NULL REFERENCES close_templates(id),
  status TEXT NOT NULL CHECK (status IN ('not_started', 'in_progress', 'review', 'closed')),
  target_close_date DATE NOT NULL,
  started_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  closed_by TEXT,
  UNIQUE (tenant_id, period_key)
);

CREATE TABLE close_tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  close_period_id TEXT NOT NULL REFERENCES close_periods(id) ON DELETE CASCADE,
  template_task_id TEXT REFERENCES close_template_tasks(id),
  key TEXT NOT NULL,
  entity_id TEXT REFERENCES entities(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  workday_offset INT NOT NULL,
  due_date DATE NOT NULL,
  owner_id TEXT REFERENCES users(id),
  reviewer_id TEXT REFERENCES users(id),
  owner_role TEXT NOT NULL,
  reviewer_role TEXT,
  skill_key TEXT,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'blocked', 'ready_for_review', 'done', 'skipped')),
  blocked_reason TEXT,
  agent_run_id TEXT REFERENCES agent_runs(id),
  completed_by TEXT,
  completed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  notes TEXT,
  sort_order INT NOT NULL,
  UNIQUE (close_period_id, key, entity_id),
  CHECK (status <> 'blocked' OR blocked_reason IS NOT NULL),
  CHECK (reviewed_by IS NULL OR completed_by IS NULL OR reviewed_by <> completed_by)
);

CREATE TABLE close_task_dependencies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  task_id TEXT NOT NULL REFERENCES close_tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES close_tasks(id) ON DELETE CASCADE,
  UNIQUE (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

-- AX-CL-01: a task cannot be completed while any dependency is unfinished
CREATE OR REPLACE FUNCTION tieout_close_task_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  open_deps INT;
BEGIN
  IF NEW.status IN ('done', 'ready_for_review') AND OLD.status NOT IN ('done', 'ready_for_review') THEN
    SELECT count(*) INTO open_deps
      FROM close_task_dependencies d JOIN close_tasks t ON t.id = d.depends_on_task_id
     WHERE d.task_id = NEW.id AND t.status NOT IN ('done', 'skipped');
    IF open_deps > 0 THEN
      RAISE EXCEPTION 'AX-CL-01: task % has % unfinished dependencies', NEW.key, open_deps
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER close_tasks_guard BEFORE UPDATE ON close_tasks
  FOR EACH ROW EXECUTE FUNCTION tieout_close_task_guard();

CREATE TABLE signoffs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('close_task', 'reconciliation', 'flux_analysis', 'close_package', 'period')),
  subject_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('preparer', 'reviewer', 'approver')),
  user_id TEXT NOT NULL REFERENCES users(id),
  statement TEXT NOT NULL,
  content_hash TEXT,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_id, role, user_id)
);

-- ---------------------------------------------------------- reconciliations ---
CREATE TABLE reconciliations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  period_id TEXT NOT NULL REFERENCES periods(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  rec_type TEXT NOT NULL CHECK (rec_type IN ('bank', 'card', 'subledger_ap', 'subledger_ar', 'intercompany', 'prepaid', 'fixed_asset', 'balance_sheet')),
  bank_account_id TEXT REFERENCES bank_accounts(id),
  gl_balance_minor BIGINT NOT NULL DEFAULT 0,
  external_balance_minor BIGINT NOT NULL DEFAULT 0,
  external_source TEXT NOT NULL,
  unreconciled_minor BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'prepared', 'reviewed', 'reopened')),
  risk TEXT NOT NULL DEFAULT 'medium' CHECK (risk IN ('low', 'medium', 'high')),
  preparer_id TEXT REFERENCES users(id),
  prepared_at TIMESTAMPTZ,
  reviewer_id TEXT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  agent_run_id TEXT REFERENCES agent_runs(id),
  notes TEXT,
  UNIQUE (entity_id, period_id, account_id, rec_type),
  -- AX-SOD-03: preparer and reviewer must differ
  CHECK (reviewer_id IS NULL OR preparer_id IS NULL OR reviewer_id <> preparer_id),
  CHECK (status NOT IN ('prepared', 'reviewed') OR preparer_id IS NOT NULL),
  CHECK (status <> 'reviewed' OR reviewer_id IS NOT NULL)
);

CREATE TABLE rec_matches (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  reconciliation_id TEXT NOT NULL REFERENCES reconciliations(id) ON DELETE CASCADE,
  match_type TEXT NOT NULL CHECK (match_type IN ('exact', 'fuzzy', 'one_to_many', 'many_to_one', 'many_to_many', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed', 'rejected')),
  confidence NUMERIC(4,3) NOT NULL,
  difference_minor BIGINT NOT NULL DEFAULT 0,
  explanation TEXT NOT NULL,
  matched_by TEXT NOT NULL,
  proposal_id TEXT REFERENCES proposals(id),
  confirmed_by TEXT,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE TABLE rec_match_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  rec_match_id TEXT NOT NULL REFERENCES rec_matches(id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK (side IN ('external', 'ledger')),
  item_type TEXT NOT NULL CHECK (item_type IN ('bank_transaction', 'journal_line', 'card_transaction', 'bill', 'invoice')),
  item_id TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  UNIQUE (rec_match_id, item_type, item_id)
);
CREATE INDEX rec_match_items_item_idx ON rec_match_items (tenant_id, item_type, item_id);

CREATE TABLE reconciling_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  reconciliation_id TEXT NOT NULL REFERENCES reconciliations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('deposit_in_transit', 'outstanding_check', 'bank_fee', 'interest', 'bank_error', 'book_error', 'timing', 'unexplained', 'fx_difference', 'other')),
  side TEXT NOT NULL CHECK (side IN ('external', 'ledger')),
  description TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  item_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'written_off')),
  requires_adjustment BOOLEAN NOT NULL DEFAULT false,
  related_item_type TEXT,
  related_item_id TEXT,
  proposal_id TEXT REFERENCES proposals(id),
  resolution TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CHECK (amount_minor <> 0),
  CHECK (status = 'open' OR resolution IS NOT NULL)
);

-- -------------------------------------------------------------- flux / BvA ---
CREATE TABLE flux_analyses (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  period_id TEXT NOT NULL REFERENCES periods(id),
  comparison TEXT NOT NULL CHECK (comparison IN ('pop', 'yoy', 'bva')),
  threshold_abs_minor BIGINT NOT NULL,
  threshold_pct NUMERIC(6,4) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'in_review', 'approved')),
  agent_run_id TEXT REFERENCES agent_runs(id),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  UNIQUE (entity_id, period_id, comparison),
  CHECK (threshold_abs_minor >= 0 AND threshold_pct >= 0)
);

CREATE TABLE flux_lines (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  flux_analysis_id TEXT NOT NULL REFERENCES flux_analyses(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  current_minor BIGINT NOT NULL,
  comparative_minor BIGINT NOT NULL,
  budget_minor BIGINT,
  variance_minor BIGINT NOT NULL,
  variance_pct NUMERIC(12,4),
  exceeds_threshold BOOLEAN NOT NULL,
  materiality TEXT NOT NULL CHECK (materiality IN ('trivial', 'below_pm', 'material')),
  drivers JSONB NOT NULL DEFAULT '[]'::jsonb, -- @json FluxDriver[]
  status TEXT NOT NULL CHECK (status IN ('no_explanation_needed', 'needs_explanation', 'explained', 'approved')),
  UNIQUE (flux_analysis_id, account_id),
  CHECK (variance_minor = current_minor - comparative_minor)
);

CREATE TABLE flux_explanations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  flux_line_id TEXT NOT NULL REFERENCES flux_lines(id) ON DELETE CASCADE,
  version INT NOT NULL,
  text TEXT NOT NULL,
  drivers JSONB NOT NULL DEFAULT '[]'::jsonb, -- @json FluxDriver[]
  author_type TEXT NOT NULL CHECK (author_type IN ('agent', 'user')),
  author_id TEXT NOT NULL,
  proposal_id TEXT REFERENCES proposals(id),
  status TEXT NOT NULL CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (flux_line_id, version),
  CHECK (length(text) >= 20),
  CHECK (approved_by IS NULL OR approved_by <> author_id)
);

-- --------------------------------------------------------------- packages ---
CREATE TABLE close_packages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  period_key TEXT NOT NULL,
  version INT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'final')),
  content JSONB NOT NULL, -- @json ClosePackageContent
  content_hash TEXT NOT NULL,
  generated_by TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent_run_id TEXT REFERENCES agent_runs(id),
  UNIQUE (tenant_id, period_key, version)
);

CREATE OR REPLACE FUNCTION tieout_package_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'final' THEN
    RAISE EXCEPTION 'AX-AUD-01: a final close package is immutable; generate a new version'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER close_packages_guard BEFORE UPDATE OR DELETE ON close_packages
  FOR EACH ROW EXECUTE FUNCTION tieout_package_guard();
