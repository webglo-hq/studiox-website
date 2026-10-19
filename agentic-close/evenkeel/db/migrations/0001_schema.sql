-- Evenkeel 0001: relational schema (PostgreSQL 16+). Money is bigint minor units.
-- Enumerations are text + CHECK so the domain registry and SQL agree on spelling.

CREATE TABLE tenant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  timezone text NOT NULL DEFAULT 'America/Los_Angeles',
  reporting_currency text NOT NULL DEFAULT 'USD',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text NOT NULL,
  rank integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_permission (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  permission text NOT NULL,
  UNIQUE (role_id, permission)
);

CREATE TABLE currency (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  name text NOT NULL,
  minor_units integer NOT NULL DEFAULT 2
);

CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  email text NOT NULL,
  display_name text NOT NULL,
  title text,
  password_hash text,
  status text NOT NULL DEFAULT 'active' CONSTRAINT app_user_status_check CHECK (status IN ('active','disabled','invited')),
  mfa_secret_enc text,
  mfa_enabled boolean NOT NULL DEFAULT false,
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  idp text NOT NULL DEFAULT 'password' CONSTRAINT app_user_idp_check CHECK (idp IN ('password','oidc','saml')),
  external_subject text,
  department_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, id)
);

CREATE TABLE entity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL,
  name text NOT NULL,
  legal_name text NOT NULL,
  functional_currency text NOT NULL REFERENCES currency(code),
  country text NOT NULL,
  parent_entity_id uuid REFERENCES entity(id),
  is_elimination boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

CREATE TABLE user_role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES role(id),
  entity_id uuid REFERENCES entity(id),
  granted_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role_id, entity_id)
);
CREATE INDEX user_role_user_idx ON user_role(user_id);

CREATE TABLE sod_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  kind text NOT NULL CONSTRAINT sod_rule_kind_check CHECK (kind IN ('same_actor','permission_pair')),
  permission_a text,
  permission_b text,
  severity text NOT NULL DEFAULT 'block' CONSTRAINT sod_rule_severity_check CHECK (severity IN ('block','warn')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CHECK (kind <> 'permission_pair' OR (permission_a IS NOT NULL AND permission_b IS NOT NULL AND permission_a <> permission_b))
);

CREATE TABLE session (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  rotated_from text,
  csrf_hash text NOT NULL,
  mfa_verified boolean NOT NULL DEFAULT false,
  ip text,
  user_agent text,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX session_user_idx ON session(user_id);

CREATE TABLE api_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE fx_rate (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  from_ccy text NOT NULL REFERENCES currency(code),
  to_ccy text NOT NULL REFERENCES currency(code),
  rate_date date NOT NULL,
  rate_type text NOT NULL CONSTRAINT fx_rate_rate_type_check CHECK (rate_type IN ('spot','average','closing','historical')),
  rate numeric(20,10) NOT NULL CHECK (rate > 0),
  source text NOT NULL DEFAULT 'seed',
  UNIQUE (tenant_id, from_ccy, to_ccy, rate_date, rate_type),
  CHECK (from_ccy <> to_ccy)
);

CREATE TABLE fs_line_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  statement text NOT NULL CONSTRAINT fs_line_item_statement_check CHECK (statement IN ('BS','IS')),
  code text NOT NULL,
  label text NOT NULL,
  section text NOT NULL,
  sort_order integer NOT NULL,
  xbrl_element text,
  sign text NOT NULL CONSTRAINT fs_line_item_sign_check CHECK (sign IN ('debit','credit')),
  UNIQUE (tenant_id, code)
);

CREATE TABLE account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL,
  name text NOT NULL,
  account_class text NOT NULL CONSTRAINT account_account_class_check CHECK (account_class IN ('asset','liability','equity','revenue','expense')),
  account_type text NOT NULL,
  normal_balance text NOT NULL CONSTRAINT account_normal_balance_check CHECK (normal_balance IN ('debit','credit')),
  parent_id uuid REFERENCES account(id),
  is_postable boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  fs_line_item_id uuid NOT NULL REFERENCES fs_line_item(id),
  requires_department boolean NOT NULL DEFAULT false,
  is_control_account boolean NOT NULL DEFAULT false,
  subledger text CONSTRAINT account_subledger_check CHECK (subledger IN ('ap','ar','bank','card','fixed_asset','prepaid','payroll')),
  is_intercompany boolean NOT NULL DEFAULT false,
  is_monetary boolean NOT NULL DEFAULT false,
  concept text,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id),
  -- Normal balance follows the account class except for contra accounts (ontology: ek:NormalBalance)
  CONSTRAINT account_normal_balance_class CHECK (
    account_type LIKE '%Contra%' OR account_type LIKE '%AccumulatedDepreciation%' OR account_type LIKE '%FxGainLoss%' OR
    (account_class IN ('asset','expense') AND normal_balance = 'debit') OR
    (account_class IN ('liability','equity','revenue') AND normal_balance = 'credit')
  ),
  CHECK (NOT is_control_account OR subledger IS NOT NULL)
);

CREATE TABLE dimension_type (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL CONSTRAINT dimension_type_code_check CHECK (code IN ('department','location','class','project')),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE dimension_value (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  dimension_type_id uuid NOT NULL REFERENCES dimension_type(id),
  code text NOT NULL,
  name text NOT NULL,
  parent_id uuid REFERENCES dimension_value(id),
  owner_user_id uuid REFERENCES app_user(id),
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, dimension_type_id, code)
);

CREATE TABLE fiscal_period (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  entity_id uuid NOT NULL REFERENCES entity(id),
  period_key text NOT NULL CHECK (period_key ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  fiscal_year integer NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL DEFAULT 'open' CONSTRAINT fiscal_period_status_check CHECK (status IN ('open','soft_close','hard_close')),
  soft_closed_at timestamptz,
  soft_closed_by uuid REFERENCES app_user(id),
  hard_closed_at timestamptz,
  hard_closed_by uuid REFERENCES app_user(id),
  reopened_at timestamptz,
  reopen_reason text,
  UNIQUE (tenant_id, entity_id, period_key),
  CHECK (end_date >= start_date),
  CHECK (to_char(start_date, 'YYYY-MM') = period_key)
);
CREATE INDEX fiscal_period_key_idx ON fiscal_period(period_key);

CREATE TABLE holiday (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  date date NOT NULL,
  name text NOT NULL,
  UNIQUE (tenant_id, date)
);

CREATE TABLE bank_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  entity_id uuid NOT NULL REFERENCES entity(id),
  name text NOT NULL,
  institution text NOT NULL,
  account_mask text NOT NULL,
  currency text NOT NULL REFERENCES currency(code),
  gl_account_id uuid NOT NULL REFERENCES account(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE connector (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  kind text NOT NULL CONSTRAINT connector_kind_check CHECK (kind IN ('bank_bai2','bank_camt053','bank_ofx','bank_csv','card_csv','ap_bills_csv','ar_invoices_csv','payroll_csv','gl_journal_csv','erp_gl_json')),
  name text NOT NULL,
  entity_id uuid REFERENCES entity(id),
  bank_account_id uuid REFERENCES bank_account(id),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CONSTRAINT connector_status_check CHECK (status IN ('active','paused')),
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE source_document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  connector_id uuid REFERENCES connector(id),
  filename text NOT NULL,
  media_type text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  content text,
  received_at timestamptz NOT NULL DEFAULT now(),
  received_by uuid REFERENCES app_user(id),
  parse_status text NOT NULL DEFAULT 'pending' CONSTRAINT source_document_parse_status_check CHECK (parse_status IN ('pending','parsed','failed')),
  record_count integer NOT NULL DEFAULT 0,
  error text,
  UNIQUE (tenant_id, sha256)
);

CREATE TABLE import_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  connector_id uuid REFERENCES connector(id),
  source_document_id uuid NOT NULL REFERENCES source_document(id),
  status text NOT NULL DEFAULT 'running' CONSTRAINT import_batch_status_check CHECK (status IN ('running','completed','failed')),
  created_count integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  idempotency_key text NOT NULL UNIQUE,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  started_by uuid REFERENCES app_user(id)
);

CREATE TABLE journal_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  entity_id uuid NOT NULL REFERENCES entity(id),
  period_id uuid NOT NULL REFERENCES fiscal_period(id),
  period_key text NOT NULL,
  entry_number text NOT NULL,
  entry_date date NOT NULL,
  entry_type text NOT NULL CONSTRAINT journal_entry_entry_type_check CHECK (entry_type IN ('standard','adjusting','accrual','reversing','recurring','reclass','elimination','fx_revaluation','depreciation','amortization')),
  status text NOT NULL DEFAULT 'draft' CONSTRAINT journal_entry_status_check CHECK (status IN ('draft','pending_approval','posted','rejected')),
  memo text NOT NULL,
  currency text NOT NULL REFERENCES currency(code),
  source text NOT NULL CONSTRAINT journal_entry_source_check CHECK (source IN ('manual','agent','import','system','subledger')),
  source_ref jsonb,
  reverses_entry_id uuid REFERENCES journal_entry(id),
  reversed_by_entry_id uuid REFERENCES journal_entry(id),
  auto_reverse_date date,
  prepared_by uuid REFERENCES app_user(id),
  prepared_by_agent text,
  requested_by uuid REFERENCES app_user(id),
  approved_by uuid REFERENCES app_user(id),
  approval_policy text,
  posted_at timestamptz,
  posted_by uuid REFERENCES app_user(id),
  proposal_id uuid,
  external_preparer text,
  external_approver text,
  external_posted_at timestamptz,
  total_debit bigint NOT NULL DEFAULT 0,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entry_number),
  -- Maker-checker (ontology AX-SOD-01): an approver is never the preparer or the agent requester
  CONSTRAINT journal_entry_maker_checker CHECK (approved_by IS NULL OR ((prepared_by IS NULL OR approved_by <> prepared_by) AND (requested_by IS NULL OR approved_by <> requested_by))),
  CONSTRAINT journal_entry_accrual_reverses CHECK (entry_type <> 'accrual' OR auto_reverse_date IS NOT NULL),
  CONSTRAINT journal_entry_reversal_target CHECK (reverses_entry_id IS NULL OR reverses_entry_id <> id)
);
CREATE INDEX journal_entry_period_idx ON journal_entry(tenant_id, period_key, entity_id);
CREATE INDEX journal_entry_status_idx ON journal_entry(status);
CREATE UNIQUE INDEX journal_entry_single_reversal ON journal_entry(reverses_entry_id) WHERE reverses_entry_id IS NOT NULL AND status = 'posted';

CREATE TABLE journal_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  journal_entry_id uuid NOT NULL REFERENCES journal_entry(id) ON DELETE CASCADE,
  line_no integer NOT NULL,
  account_id uuid NOT NULL REFERENCES account(id),
  debit bigint NOT NULL DEFAULT 0,
  credit bigint NOT NULL DEFAULT 0,
  memo text,
  department_id uuid REFERENCES dimension_value(id),
  location_id uuid REFERENCES dimension_value(id),
  class_id uuid REFERENCES dimension_value(id),
  project_id uuid REFERENCES dimension_value(id),
  counterparty_entity_id uuid REFERENCES entity(id),
  txn_currency text REFERENCES currency(code),
  txn_amount bigint,
  fx_rate numeric(20,10),
  source_type text,
  source_id text,
  UNIQUE (journal_entry_id, line_no),
  -- Double entry (AX-DE-02): exactly one side, positive, whole minor units
  CONSTRAINT journal_line_one_sided CHECK (debit >= 0 AND credit >= 0 AND ((debit > 0) <> (credit > 0)))
);
CREATE INDEX journal_line_entry_idx ON journal_line(journal_entry_id);
CREATE INDEX journal_line_account_idx ON journal_line(account_id);
CREATE INDEX journal_line_source_idx ON journal_line(source_id);

CREATE TABLE je_sequence (
  id text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  next_value integer NOT NULL DEFAULT 1
);

CREATE TABLE vendor (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL,
  normalized_name text NOT NULL,
  default_account_id uuid REFERENCES account(id),
  default_department_id uuid REFERENCES dimension_value(id),
  payment_terms_days integer NOT NULL DEFAULT 30,
  is_1099 boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CONSTRAINT vendor_status_check CHECK (status IN ('active','inactive')),
  remit_bank_last4 text,
  created_by uuid REFERENCES app_user(id),
  updated_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE purchase_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  entity_id uuid NOT NULL REFERENCES entity(id),
  vendor_id uuid NOT NULL REFERENCES vendor(id),
  po_number text NOT NULL,
  order_date date NOT NULL,
  description text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  currency text NOT NULL REFERENCES currency(code),
  status text NOT NULL CONSTRAINT purchase_order_status_check CHECK (status IN ('open','received','billed','closed','cancelled')),
  received_date date,
  service_start date,
  service_end date,
  account_id uuid REFERENCES account(id),
  department_id uuid REFERENCES dimension_value(id),
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, po_number)
);

CREATE TABLE bill (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  entity_id uuid NOT NULL REFERENCES entity(id),
  vendor_id uuid NOT NULL REFERENCES vendor(id),
  bill_number text NOT NULL,
  bill_date date NOT NULL,
  due_date date NOT NULL,
  received_date date,
  amount bigint NOT NULL CHECK (amount > 0),
  currency text NOT NULL REFERENCES currency(code),
  status text NOT NULL CONSTRAINT bill_status_check CHECK (status IN ('draft','open','paid','partially_paid','void')),
  service_start date,
  service_end date,
  po_id uuid REFERENCES purchase_order(id),
  account_id uuid REFERENCES account(id),
  department_id uuid REFERENCES dimension_value(id),
  memo text,
  journal_entry_id uuid REFERENCES journal_entry(id),
  source_document_id uuid REFERENCES source_document(id),
  import_batch_id uuid REFERENCES import_batch(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, vendor_id, bill_number),
  CHECK (service_end IS NULL OR service_start IS NULL OR service_end >= service_start)
);
CREATE INDEX bill_vendor_idx ON bill(vendor_id);

CREATE TABLE vendor_payment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  entity_id uuid NOT NULL REFERENCES entity(id),
  vendor_id uuid NOT NULL REFERENCES vendor(id),
  bill_id uuid REFERENCES bill(id),
  payment_date date NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  method text NOT NULL CONSTRAINT vendor_payment_method_check CHECK (method IN ('ach','wire','check','card')),
  reference text NOT NULL,
  bank_account_id uuid NOT NULL REFERENCES bank_account(id),
  journal_entry_id uuid REFERENCES journal_entry(id),
  status text NOT NULL DEFAULT 'issued' CONSTRAINT vendor_payment_status_check CHECK (status IN ('issued','cleared','void')),
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_payment_vendor_idx ON vendor_payment(vendor_id);
CREATE INDEX vendor_payment_bill_idx ON vendor_payment(bill_id);

CREATE TABLE customer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL,
  normalized_name text NOT NULL,
  terms_days integer NOT NULL DEFAULT 30,
  segment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE invoice (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  entity_id uuid NOT NULL REFERENCES entity(id),
  customer_id uuid NOT NULL REFERENCES customer(id),
  invoice_number text NOT NULL,
  invoice_date date NOT NULL,
  due_date date NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  currency text NOT NULL REFERENCES currency(code),
  status text NOT NULL CONSTRAINT invoice_status_check CHECK (status IN ('open','paid','partially_paid','void')),
  revenue_account_id uuid NOT NULL REFERENCES account(id),
  service_start date,
  service_end date,
  journal_entry_id uuid REFERENCES journal_entry(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, invoice_number)
);
CREATE INDEX invoice_customer_idx ON invoice(customer_id);

CREATE TABLE customer_receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  entity_id uuid NOT NULL REFERENCES entity(id),
  customer_id uuid NOT NULL REFERENCES customer(id),
  invoice_id uuid REFERENCES invoice(id),
  receipt_date date NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  method text NOT NULL CONSTRAINT customer_receipt_method_check CHECK (method IN ('ach','wire','check','card')),
  reference text,
  bank_account_id uuid NOT NULL REFERENCES bank_account(id),
  deposit_batch text,
  journal_entry_id uuid REFERENCES journal_entry(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_receipt_invoice_idx ON customer_receipt(invoice_id);

CREATE TABLE bank_statement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  bank_account_id uuid NOT NULL REFERENCES bank_account(id),
  period_key text NOT NULL,
  statement_start date NOT NULL,
  statement_end date NOT NULL,
  opening_balance bigint NOT NULL,
  closing_balance bigint NOT NULL,
  source_document_id uuid REFERENCES source_document(id),
  import_batch_id uuid REFERENCES import_batch(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bank_account_id, statement_end),
  CHECK (statement_end >= statement_start)
);

CREATE TABLE bank_transaction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  bank_account_id uuid NOT NULL REFERENCES bank_account(id),
  statement_id uuid REFERENCES bank_statement(id),
  posted_date date NOT NULL,
  value_date date,
  amount bigint NOT NULL CHECK (amount <> 0),
  description text NOT NULL,
  reference text,
  counterparty text,
  type_code text,
  external_id text,
  status text NOT NULL DEFAULT 'unmatched' CONSTRAINT bank_transaction_status_check CHECK (status IN ('unmatched','matched','excluded')),
  dedupe_hash text NOT NULL,
  source_document_id uuid REFERENCES source_document(id),
  import_batch_id uuid REFERENCES import_batch(id),
  source_line text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, bank_account_id, dedupe_hash)
);
CREATE INDEX bank_transaction_account_idx ON bank_transaction(bank_account_id, posted_date);

CREATE TABLE card_transaction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  entity_id uuid NOT NULL REFERENCES entity(id),
  card_last4 text NOT NULL CHECK (card_last4 ~ '^\d{4}$'),
  cardholder_name text NOT NULL,
  cardholder_user_id uuid REFERENCES app_user(id),
  cardholder_department_id uuid REFERENCES dimension_value(id),
  merchant_name text NOT NULL,
  mcc text CHECK (mcc IS NULL OR mcc ~ '^\d{4}$'),
  amount bigint NOT NULL,
  currency text NOT NULL REFERENCES currency(code),
  txn_date date NOT NULL,
  posted_date date NOT NULL,
  memo text,
  receipt_attached boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'uncoded' CONSTRAINT card_transaction_status_check CHECK (status IN ('uncoded','coded','posted','excluded')),
  account_id uuid REFERENCES account(id),
  department_id uuid REFERENCES dimension_value(id),
  location_id uuid REFERENCES dimension_value(id),
  class_id uuid REFERENCES dimension_value(id),
  project_id uuid REFERENCES dimension_value(id),
  coding_source text CONSTRAINT card_transaction_coding_source_check CHECK (coding_source IN ('cardholder','rule','history','agent','human')),
  coding_confidence numeric(5,4) CHECK (coding_confidence IS NULL OR (coding_confidence >= 0 AND coding_confidence <= 1)),
  journal_entry_id uuid REFERENCES journal_entry(id),
  external_id text NOT NULL,
  dedupe_hash text NOT NULL,
  source_document_id uuid REFERENCES source_document(id),
  import_batch_id uuid REFERENCES import_batch(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedupe_hash),
  CHECK (status = 'uncoded' OR status = 'excluded' OR account_id IS NOT NULL)
);
CREATE INDEX card_transaction_status_idx ON card_transaction(status);
CREATE INDEX card_transaction_merchant_idx ON card_transaction(merchant_name);

CREATE TABLE fixed_asset (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  entity_id uuid NOT NULL REFERENCES entity(id),
  tag text NOT NULL,
  name text NOT NULL,
  asset_class text NOT NULL CONSTRAINT fixed_asset_asset_class_check CHECK (asset_class IN ('computer_equipment','furniture','leasehold_improvements','software')),
  acquisition_date date NOT NULL,
  in_service_date date NOT NULL,
  cost bigint NOT NULL CHECK (cost > 0),
  salvage bigint NOT NULL DEFAULT 0 CHECK (salvage >= 0),
  useful_life_months integer NOT NULL CHECK (useful_life_months >= 12),
  method text NOT NULL DEFAULT 'straight_line' CONSTRAINT fixed_asset_method_check CHECK (method IN ('straight_line')),
  asset_account_id uuid NOT NULL REFERENCES account(id),
  accum_depr_account_id uuid NOT NULL REFERENCES account(id),
  depr_expense_account_id uuid NOT NULL REFERENCES account(id),
  department_id uuid REFERENCES dimension_value(id),
  status text NOT NULL DEFAULT 'in_service' CONSTRAINT fixed_asset_status_check CHECK (status IN ('in_service','disposed','pending')),
  source_ref jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, tag),
  CHECK (salvage < cost)
);

CREATE TABLE depreciation_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  fixed_asset_id uuid NOT NULL REFERENCES fixed_asset(id),
  period_key text NOT NULL,
  amount bigint NOT NULL CHECK (amount >= 0),
  journal_entry_id uuid REFERENCES journal_entry(id),
  status text NOT NULL DEFAULT 'scheduled' CONSTRAINT depreciation_line_status_check CHECK (status IN ('scheduled','posted')),
  UNIQUE (fixed_asset_id, period_key),
  CHECK (status <> 'posted' OR journal_entry_id IS NOT NULL)
);
CREATE INDEX depreciation_line_period_idx ON depreciation_line(period_key);

CREATE TABLE prepaid_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  entity_id uuid NOT NULL REFERENCES entity(id),
  description text NOT NULL,
  vendor_id uuid REFERENCES vendor(id),
  total bigint NOT NULL CHECK (total > 0),
  start_period text NOT NULL,
  months integer NOT NULL CHECK (months >= 2),
  prepaid_account_id uuid NOT NULL REFERENCES account(id),
  expense_account_id uuid NOT NULL REFERENCES account(id),
  department_id uuid REFERENCES dimension_value(id),
  source_ref jsonb,
  status text NOT NULL DEFAULT 'active' CONSTRAINT prepaid_schedule_status_check CHECK (status IN ('active','complete','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE prepaid_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  schedule_id uuid NOT NULL REFERENCES prepaid_schedule(id),
  period_key text NOT NULL,
  amount bigint NOT NULL CHECK (amount >= 0),
  journal_entry_id uuid REFERENCES journal_entry(id),
  status text NOT NULL DEFAULT 'scheduled' CONSTRAINT prepaid_line_status_check CHECK (status IN ('scheduled','posted')),
  UNIQUE (schedule_id, period_key),
  CHECK (status <> 'posted' OR journal_entry_id IS NOT NULL)
);
CREATE INDEX prepaid_line_period_idx ON prepaid_line(period_key);

CREATE TABLE payroll_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  entity_id uuid NOT NULL REFERENCES entity(id),
  provider text NOT NULL,
  pay_date date NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  gross_wages bigint NOT NULL,
  employer_taxes bigint NOT NULL,
  benefits bigint NOT NULL,
  withholdings bigint NOT NULL,
  net_pay bigint NOT NULL,
  journal_entry_id uuid REFERENCES journal_entry(id),
  source_document_id uuid REFERENCES source_document(id),
  import_batch_id uuid REFERENCES import_batch(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (net_pay = gross_wages - withholdings)
);

CREATE TABLE payroll_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  payroll_run_id uuid NOT NULL REFERENCES payroll_run(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES dimension_value(id),
  gross_wages bigint NOT NULL,
  employer_taxes bigint NOT NULL,
  benefits bigint NOT NULL,
  headcount integer NOT NULL
);

CREATE TABLE budget (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  entity_id uuid NOT NULL REFERENCES entity(id),
  name text NOT NULL,
  fiscal_year integer NOT NULL,
  kind text NOT NULL CONSTRAINT budget_kind_check CHECK (kind IN ('budget','forecast')),
  version text NOT NULL,
  status text NOT NULL CONSTRAINT budget_status_check CHECK (status IN ('draft','approved')),
  approved_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE budget_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  budget_id uuid NOT NULL REFERENCES budget(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES account(id),
  department_id uuid REFERENCES dimension_value(id),
  period_key text NOT NULL,
  amount bigint NOT NULL
);
CREATE INDEX budget_line_budget_idx ON budget_line(budget_id, period_key);

CREATE TABLE close_cycle (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  period_key text NOT NULL,
  status text NOT NULL DEFAULT 'not_started' CONSTRAINT close_cycle_status_check CHECK (status IN ('not_started','in_progress','in_review','closed')),
  target_workday integer NOT NULL DEFAULT 5,
  started_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_key)
);

CREATE TABLE close_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  close_cycle_id uuid NOT NULL REFERENCES close_cycle(id),
  entity_id uuid REFERENCES entity(id),
  code text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  category text NOT NULL CONSTRAINT close_task_category_check CHECK (category IN ('cash','ap','ar','accruals','prepaids','fixed_assets','payroll','intercompany','fx','review','reporting','controls')),
  workday integer NOT NULL,
  due_date date NOT NULL,
  owner_id uuid REFERENCES app_user(id),
  reviewer_id uuid REFERENCES app_user(id),
  status text NOT NULL DEFAULT 'not_started' CONSTRAINT close_task_status_check CHECK (status IN ('not_started','in_progress','blocked','ready_for_review','complete')),
  skill_id text,
  control_ref text,
  blocked_reason text,
  prepared_by uuid REFERENCES app_user(id),
  prepared_at timestamptz,
  reviewed_by uuid REFERENCES app_user(id),
  reviewed_at timestamptz,
  completed_at timestamptz,
  notes text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (close_cycle_id, code),
  CONSTRAINT close_task_reviewer_sod CHECK (reviewed_by IS NULL OR prepared_by IS NULL OR reviewed_by <> prepared_by)
);
CREATE INDEX close_task_cycle_idx ON close_task(close_cycle_id);

CREATE TABLE close_task_dependency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  task_id uuid NOT NULL REFERENCES close_task(id) ON DELETE CASCADE,
  depends_on_task_id uuid NOT NULL REFERENCES close_task(id) ON DELETE CASCADE,
  UNIQUE (task_id, depends_on_task_id),
  CONSTRAINT close_task_dependency_not_self CHECK (task_id <> depends_on_task_id)
);
CREATE INDEX close_task_dependency_task_idx ON close_task_dependency(task_id);

CREATE TABLE signoff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  subject_type text NOT NULL CONSTRAINT signoff_subject_type_check CHECK (subject_type IN ('close_task','reconciliation','flux_analysis','close_cycle','close_package','fiscal_period')),
  subject_id text NOT NULL,
  role text NOT NULL CONSTRAINT signoff_role_check CHECK (role IN ('preparer','reviewer','approver')),
  user_id uuid NOT NULL REFERENCES app_user(id),
  signed_at timestamptz NOT NULL DEFAULT now(),
  statement text NOT NULL,
  content_hash text,
  UNIQUE (subject_type, subject_id, role)
);
CREATE INDEX signoff_subject_idx ON signoff(subject_id);

CREATE TABLE close_package (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  period_key text NOT NULL,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'draft' CONSTRAINT close_package_status_check CHECK (status IN ('draft','final')),
  content jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  generated_by uuid REFERENCES app_user(id),
  generated_by_run uuid,
  generated_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES app_user(id),
  approved_at timestamptz,
  UNIQUE (tenant_id, period_key, version),
  CHECK (status <> 'final' OR approved_by IS NOT NULL)
);

CREATE TABLE reconciliation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  entity_id uuid NOT NULL REFERENCES entity(id),
  period_key text NOT NULL,
  account_id uuid NOT NULL REFERENCES account(id),
  rec_type text NOT NULL CONSTRAINT reconciliation_rec_type_check CHECK (rec_type IN ('bank','subledger','intercompany','balance_substantiation','card')),
  bank_account_id uuid REFERENCES bank_account(id),
  counterparty_entity_id uuid REFERENCES entity(id),
  gl_balance bigint NOT NULL DEFAULT 0,
  comparison_balance bigint NOT NULL DEFAULT 0,
  reconciling_total bigint NOT NULL DEFAULT 0,
  unexplained bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'not_started' CONSTRAINT reconciliation_status_check CHECK (status IN ('not_started','in_progress','prepared','reviewed')),
  prepared_by uuid REFERENCES app_user(id),
  prepared_at timestamptz,
  reviewed_by uuid REFERENCES app_user(id),
  reviewed_at timestamptz,
  risk text NOT NULL DEFAULT 'medium' CONSTRAINT reconciliation_risk_check CHECK (risk IN ('low','medium','high')),
  tolerance bigint NOT NULL DEFAULT 0 CHECK (tolerance >= 0),
  notes text,
  last_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_id, period_key, account_id, rec_type),
  -- AX-REC-01/03: reviewed means tied out, prepared by someone, reviewed by someone else
  CONSTRAINT reconciliation_review_sod CHECK (status <> 'reviewed' OR (reviewed_by IS NOT NULL AND prepared_by IS NOT NULL AND reviewed_by <> prepared_by AND unexplained = 0)),
  CONSTRAINT reconciliation_prepared_ties CHECK (status NOT IN ('prepared','reviewed') OR unexplained = 0)
);
CREATE INDEX reconciliation_period_idx ON reconciliation(period_key);

CREATE TABLE rec_match (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  reconciliation_id uuid NOT NULL REFERENCES reconciliation(id),
  match_type text NOT NULL CONSTRAINT rec_match_match_type_check CHECK (match_type IN ('exact','fuzzy','one_to_many','many_to_one','many_to_many','manual')),
  confidence numeric(5,4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  status text NOT NULL CONSTRAINT rec_match_status_check CHECK (status IN ('proposed','accepted','rejected')),
  rationale text NOT NULL,
  proposal_id uuid,
  accepted_by uuid REFERENCES app_user(id),
  accepted_at timestamptz,
  created_by_type text NOT NULL CONSTRAINT rec_match_created_by_type_check CHECK (created_by_type IN ('agent','user','system')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rec_match_rec_idx ON rec_match(reconciliation_id);

CREATE TABLE rec_match_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  match_id uuid NOT NULL REFERENCES rec_match(id) ON DELETE CASCADE,
  side text NOT NULL CONSTRAINT rec_match_item_side_check CHECK (side IN ('bank','ledger','subledger','counterparty')),
  record_type text NOT NULL,
  record_id text NOT NULL,
  amount bigint NOT NULL,
  active boolean NOT NULL DEFAULT false
);
CREATE INDEX rec_match_item_match_idx ON rec_match_item(match_id);
CREATE INDEX rec_match_item_record_idx ON rec_match_item(record_id);
-- An item can belong to at most one accepted match
CREATE UNIQUE INDEX rec_match_item_single_active ON rec_match_item(record_type, record_id) WHERE active;

CREATE TABLE reconciling_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  reconciliation_id uuid NOT NULL REFERENCES reconciliation(id),
  item_type text NOT NULL CONSTRAINT reconciling_item_item_type_check CHECK (item_type IN ('deposit_in_transit','outstanding_check','bank_fee','bank_interest','bank_error','book_error','timing','unexplained','fx')),
  side text NOT NULL CONSTRAINT reconciling_item_side_check CHECK (side IN ('bank','book')),
  amount bigint NOT NULL,
  description text NOT NULL,
  origin_date date NOT NULL,
  expected_clear_date date,
  status text NOT NULL DEFAULT 'open' CONSTRAINT reconciling_item_status_check CHECK (status IN ('open','cleared','resolved','written_off')),
  resolution_entry_id uuid REFERENCES journal_entry(id),
  cleared_by jsonb,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  proposal_id uuid,
  created_by_type text NOT NULL CONSTRAINT reconciling_item_created_by_type_check CHECK (created_by_type IN ('agent','user','system')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES app_user(id)
);
CREATE INDEX reconciling_item_rec_idx ON reconciling_item(reconciliation_id);

CREATE TABLE evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  kind text NOT NULL CONSTRAINT evidence_kind_check CHECK (kind IN ('statement','invoice','schedule','calculation','screenshot','note','report','export')),
  title text NOT NULL,
  media_type text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL,
  content text,
  source_document_id uuid REFERENCES source_document(id),
  uploaded_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_subject_idx ON evidence(subject_id);

CREATE TABLE flux_analysis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  entity_id uuid NOT NULL REFERENCES entity(id),
  period_key text NOT NULL,
  comparison text NOT NULL CONSTRAINT flux_analysis_comparison_check CHECK (comparison IN ('prior_month','prior_year','budget')),
  threshold_abs bigint NOT NULL CHECK (threshold_abs >= 0),
  threshold_pct numeric(8,4) NOT NULL CHECK (threshold_pct >= 0),
  status text NOT NULL DEFAULT 'draft' CONSTRAINT flux_analysis_status_check CHECK (status IN ('draft','in_review','approved')),
  run_id uuid,
  approved_by uuid REFERENCES app_user(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity_id, period_key, comparison)
);

CREATE TABLE flux_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  flux_analysis_id uuid NOT NULL REFERENCES flux_analysis(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES account(id),
  current_amount bigint NOT NULL,
  comparison_amount bigint NOT NULL,
  variance bigint NOT NULL,
  variance_pct numeric(12,6),
  is_material boolean NOT NULL,
  status text NOT NULL CONSTRAINT flux_line_status_check CHECK (status IN ('not_required','unexplained','explained','approved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flux_analysis_id, account_id),
  CHECK (variance = current_amount - comparison_amount)
);
CREATE INDEX flux_line_analysis_idx ON flux_line(flux_analysis_id);

CREATE TABLE flux_explanation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  flux_line_id uuid NOT NULL REFERENCES flux_line(id) ON DELETE CASCADE,
  narrative text NOT NULL,
  drivers jsonb NOT NULL DEFAULT '[]'::jsonb,
  coverage numeric(8,4) NOT NULL,
  author_type text NOT NULL CONSTRAINT flux_explanation_author_type_check CHECK (author_type IN ('agent','user')),
  author_id uuid REFERENCES app_user(id),
  run_id uuid,
  status text NOT NULL CONSTRAINT flux_explanation_status_check CHECK (status IN ('draft','submitted','approved','rejected')),
  approved_by uuid REFERENCES app_user(id),
  approved_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flux_explanation_sod CHECK (approved_by IS NULL OR author_id IS NULL OR approved_by <> author_id)
);
CREATE INDEX flux_explanation_line_idx ON flux_explanation(flux_line_id);

CREATE TABLE skill (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  name text NOT NULL,
  description text NOT NULL,
  domain text NOT NULL,
  current_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE skill_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id text NOT NULL REFERENCES skill(id),
  version text NOT NULL CHECK (version ~ '^\d+\.\d+\.\d+$'),
  manifest jsonb NOT NULL,
  instructions text NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, version)
);

CREATE TABLE skill_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  skill_id text NOT NULL REFERENCES skill(id),
  version integer NOT NULL CHECK (version >= 1),
  autonomy_level text NOT NULL CONSTRAINT skill_policy_autonomy_level_check CHECK (autonomy_level IN ('L0','L1','L2','L3')),
  thresholds jsonb NOT NULL DEFAULT '{}'::jsonb,
  mappings jsonb NOT NULL DEFAULT '{}'::jsonb,
  rules_text text NOT NULL DEFAULT '',
  rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  change_note text,
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  is_current boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, skill_id, version)
);
CREATE UNIQUE INDEX skill_policy_one_current ON skill_policy(tenant_id, skill_id) WHERE is_current;

CREATE TABLE eval_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id text NOT NULL REFERENCES skill(id),
  skill_version text NOT NULL,
  engine text NOT NULL,
  passed integer NOT NULL,
  failed integer NOT NULL,
  total integer NOT NULL,
  results jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (passed + failed = total)
);

CREATE TABLE agent_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  skill_id text NOT NULL,
  skill_version text NOT NULL,
  policy_version integer NOT NULL,
  entity_id uuid REFERENCES entity(id),
  period_key text,
  close_task_id uuid REFERENCES close_task(id),
  parent_run_id uuid REFERENCES agent_run(id),
  status text NOT NULL DEFAULT 'queued' CONSTRAINT agent_run_status_check CHECK (status IN ('queued','running','awaiting_approval','completed','failed','cancelled','budget_exceeded')),
  trigger text NOT NULL CONSTRAINT agent_run_trigger_check CHECK (trigger IN ('manual','orchestrator','schedule','api')),
  requested_by uuid REFERENCES app_user(id),
  engine text NOT NULL CONSTRAINT agent_run_engine_check CHECK (engine IN ('offline','anthropic','mock')),
  model text,
  idempotency_key text NOT NULL UNIQUE,
  ontology_version text NOT NULL,
  max_steps integer NOT NULL CHECK (max_steps > 0),
  max_tokens integer NOT NULL CHECK (max_tokens >= 0),
  max_cost_micros bigint NOT NULL CHECK (max_cost_micros >= 0),
  steps_used integer NOT NULL DEFAULT 0,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_micros bigint NOT NULL DEFAULT 0,
  started_at timestamptz,
  finished_at timestamptz,
  heartbeat_at timestamptz,
  error text,
  summary text,
  plan jsonb,
  checkpoint jsonb,
  stats jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_run_status_idx ON agent_run(status);
CREATE INDEX agent_run_skill_idx ON agent_run(skill_id);
CREATE INDEX agent_run_period_idx ON agent_run(period_key);

CREATE TABLE agent_step (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  run_id uuid NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  phase text NOT NULL CONSTRAINT agent_step_phase_check CHECK (phase IN ('plan','act','observe','verify','propose','gate','post','audit','finish','error')),
  title text NOT NULL,
  detail jsonb,
  status text NOT NULL CONSTRAINT agent_step_status_check CHECK (status IN ('started','ok','error','skipped')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_micros bigint NOT NULL DEFAULT 0,
  UNIQUE (run_id, seq)
);
CREATE INDEX agent_step_run_idx ON agent_step(run_id);

CREATE TABLE tool_call (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  run_id uuid NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  step_seq integer NOT NULL,
  tool_name text NOT NULL,
  input jsonb NOT NULL,
  output jsonb,
  status text NOT NULL CONSTRAINT tool_call_status_check CHECK (status IN ('ok','error','denied')),
  error text,
  duration_ms integer NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, idempotency_key)
);
CREATE INDEX tool_call_run_idx ON tool_call(run_id);

CREATE TABLE proposal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  run_id uuid NOT NULL REFERENCES agent_run(id),
  skill_id text NOT NULL,
  kind text NOT NULL CONSTRAINT proposal_kind_check CHECK (kind IN ('journal_entry','coding','rec_match','reconciling_item','flux_explanation','issue','prepaid_schedule','fixed_asset','task_update','close_package')),
  payload_class text NOT NULL,
  title text NOT NULL,
  why text NOT NULL CHECK (length(why) >= 10),
  confidence numeric(5,4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  amount bigint,
  currency text,
  materiality text NOT NULL CONSTRAINT proposal_materiality_check CHECK (materiality IN ('trivial','below_performance','material')),
  entity_id uuid REFERENCES entity(id),
  period_key text,
  status text NOT NULL CONSTRAINT proposal_status_check CHECK (status IN ('pending','approved','rejected','auto_applied','applied','superseded','failed','suggested')),
  payload jsonb NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  verification jsonb NOT NULL DEFAULT '{}'::jsonb,
  autonomy_level text NOT NULL CONSTRAINT proposal_autonomy_level_check CHECK (autonomy_level IN ('L0','L1','L2','L3')),
  gate_decision text NOT NULL CONSTRAINT proposal_gate_decision_check CHECK (gate_decision IN ('auto_post','await_approval','suggest_only')),
  requires_role text,
  requested_by uuid REFERENCES app_user(id),
  decided_by uuid REFERENCES app_user(id),
  decided_at timestamptz,
  decision_reason text,
  applied_ref jsonb,
  review_status text NOT NULL DEFAULT 'none' CONSTRAINT proposal_review_status_check CHECK (review_status IN ('none','sampled','pending_review','reviewed')),
  reviewed_by uuid REFERENCES app_user(id),
  reviewed_at timestamptz,
  idempotency_key text NOT NULL UNIQUE,
  injection_flag boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Maker-checker for agent work: the run requester never approves its proposals
  CONSTRAINT proposal_maker_checker CHECK (status NOT IN ('approved','applied') OR decided_by IS NULL OR requested_by IS NULL OR decided_by <> requested_by),
  CONSTRAINT proposal_rejection_reason CHECK (status <> 'rejected' OR (decision_reason IS NOT NULL AND length(decision_reason) >= 3))
);
CREATE INDEX proposal_status_idx ON proposal(status);
CREATE INDEX proposal_run_idx ON proposal(run_id);
CREATE INDEX proposal_period_idx ON proposal(period_key, kind);

CREATE TABLE approval (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  proposal_id uuid NOT NULL REFERENCES proposal(id),
  decision text NOT NULL CONSTRAINT approval_decision_check CHECK (decision IN ('approve','reject','review')),
  user_id uuid NOT NULL REFERENCES app_user(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approval_proposal_idx ON approval(proposal_id);

CREATE TABLE issue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  proposal_id uuid REFERENCES proposal(id),
  category text NOT NULL,
  severity text NOT NULL CONSTRAINT issue_severity_check CHECK (severity IN ('low','medium','high','critical')),
  title text NOT NULL,
  description text NOT NULL,
  amount bigint,
  entity_id uuid REFERENCES entity(id),
  period_key text,
  subject_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommended_action text NOT NULL,
  status text NOT NULL DEFAULT 'open' CONSTRAINT issue_status_check CHECK (status IN ('open','acknowledged','resolved','dismissed')),
  owner_id uuid REFERENCES app_user(id),
  resolution_note text,
  resolved_by uuid REFERENCES app_user(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('resolved','dismissed') OR (resolution_note IS NOT NULL AND resolved_by IS NOT NULL))
);
CREATE INDEX issue_period_idx ON issue(period_key);
CREATE INDEX issue_status_idx ON issue(status);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  seq bigint NOT NULL DEFAULT 0,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL CONSTRAINT audit_log_actor_type_check CHECK (actor_type IN ('user','agent','system')),
  actor_id text,
  actor_label text,
  action text NOT NULL,
  subject_type text,
  subject_id text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip text,
  prev_hash text NOT NULL DEFAULT '',
  hash text NOT NULL DEFAULT '',
  UNIQUE (tenant_id, seq)
);
CREATE INDEX audit_log_subject_idx ON audit_log(subject_id);
CREATE INDEX audit_log_action_idx ON audit_log(action);

CREATE TABLE audit_chain_head (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id),
  last_seq bigint NOT NULL,
  last_hash text NOT NULL
);
