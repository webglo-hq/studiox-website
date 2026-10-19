# Bookhand data model (ERD)

Generated from `src/persistence/schema` by `scripts/gen-erd.ts`; do not edit by hand. 78 tables in 16 areas. Every business table is scoped by `tenant_id`; the tenant edges are omitted from the diagrams for readability.

Invariants enforced by the database itself (`db/migrations/0002_invariants.sql` and `0003_review_invariants.sql`, mirrored by the in-memory adapter): balanced, immutable posted journals whose lines can be neither added, changed, moved in nor moved out; posting only into open periods, with the period row locked while posting; reversal-only corrections; append-only audit, approvals, sign-offs, skill versions and agent traces; a hash-chained audit log whose every shown column must equal the hashed record; maker-checker on human approvals; nobody approves the output of an agent run they started.

## Tenancy & security

```mermaid
erDiagram
  tenants {
    uuid id PK
    text name
    text slug UK
    text reporting_currency
    int fiscal_year_start_month
    date business_date
    bool is_demo
    jsonb settings
    timestamptz created_at
  }
  entities {
    uuid id PK
    uuid tenant_id FK
    text code
    text name
    text legal_name
    enum kind
    text functional_currency
    text country
    uuid parent_entity_id FK
    numeric ownership_pct
    enum status
    timestamptz created_at
  }
  users {
    uuid id PK
    uuid tenant_id FK
    text email
    text display_name
    text title
    text password_hash
    enum identity_provider
    text external_subject
    enum status
    bool mfa_enabled
    text mfa_secret_enc
    text mfa_pending_secret_enc
    int failed_login_count
    timestamptz locked_until
    timestamptz last_login_at
    int avatar_hue
    timestamptz created_at
    timestamptz updated_at
  }
  roles {
    uuid id PK
    text key UK
    text name
    text description
    jsonb permissions
    bigint approval_limit_minor
    bool is_read_only
    int sort_order
  }
  user_roles {
    uuid id PK
    uuid tenant_id FK
    uuid user_id FK
    uuid role_id FK
    uuid entity_id FK
    uuid granted_by FK
    timestamptz granted_at
  }
  sessions {
    uuid id PK
    uuid tenant_id FK
    uuid user_id FK
    text token_hash UK
    text csrf_token
    enum auth_method
    bool mfa_verified
    enum state
    timestamptz created_at
    timestamptz last_seen_at
    timestamptz idle_expires_at
    timestamptz absolute_expires_at
    timestamptz rotated_at
    timestamptz revoked_at
    text revoked_reason
    uuid rotated_from_id FK
    text ip
    text user_agent
  }
  api_tokens {
    uuid id PK
    uuid tenant_id FK
    uuid user_id FK
    text name
    text token_hash UK
    jsonb scopes
    timestamptz created_at
    timestamptz expires_at
    timestamptz last_used_at
    timestamptz revoked_at
  }
  sod_rules {
    uuid id PK
    uuid tenant_id FK
    text code
    text name
    text description
    enum kind
    jsonb params
    enum severity
    bool enabled
    int version
    uuid updated_by FK
    timestamptz updated_at
  }
  holidays {
    uuid id PK
    uuid tenant_id FK
    date holiday_date
    text name
  }
  idempotency_keys {
    uuid id PK
    uuid tenant_id FK
    text scope
    text key
    text request_hash
    int status_code
    jsonb response
    timestamptz created_at
  }
  access_requests {
    uuid id PK
    uuid tenant_id FK
    enum kind
    uuid target_user_id FK
    uuid sod_rule_id FK
    jsonb payload
    text summary
    text reason
    enum status
    uuid requested_by FK
    timestamptz requested_at
    uuid decided_by FK
    timestamptz decided_at
    text decision_reason
  }
  credential_tokens {
    uuid id PK
    uuid tenant_id FK
    uuid user_id FK
    enum purpose
    text token_hash UK
    uuid created_by FK
    timestamptz created_at
    timestamptz expires_at
    timestamptz used_at
    timestamptz revoked_at
  }
  outbox_messages {
    uuid id PK
    uuid tenant_id FK
    uuid to_user_id FK
    text to_email
    enum kind
    text subject
    text body
    text link
    text transport
    enum status
    timestamptz created_at
    timestamptz delivered_at
    int opened_count
    timestamptz last_opened_at
  }
  entities |o--o{ entities : "parent_entity_id"
  users ||--o{ user_roles : "user_id"
  roles ||--o{ user_roles : "role_id"
  entities |o--o{ user_roles : "entity_id"
  users |o--o{ user_roles : "granted_by"
  users ||--o{ sessions : "user_id"
  sessions |o--o{ sessions : "rotated_from_id"
  users ||--o{ api_tokens : "user_id"
  users |o--o{ sod_rules : "updated_by"
  users |o--o{ access_requests : "target_user_id"
  sod_rules |o--o{ access_requests : "sod_rule_id"
  users ||--o{ access_requests : "requested_by"
  users |o--o{ access_requests : "decided_by"
  users ||--o{ credential_tokens : "user_id"
  users |o--o{ credential_tokens : "created_by"
  users |o--o{ outbox_messages : "to_user_id"
```

| Table | Ontology class | Notes |
|---|---|---|
| `tenants` | `bh:Organization` | A customer organization. Every business row is scoped to one tenant. |
| `entities` | `bh:ReportingEntity` | A legal or reporting entity with its own functional currency and set of books. |
| `users` | `bh:Person` | A person who signs in. Passwords are scrypt hashes (PHC string); TOTP seeds are encrypted at rest. |
| `roles` | `bh:Role` | A named bundle of permissions with an approval limit (RBAC). |
| `user_roles` |  | Role assignment, optionally scoped to one entity. |
| `sessions` |  | Server-side session (cookie holds an opaque random token). |
| `api_tokens` |  | Personal access token for API/MCP clients; acts with the owner's roles. |
| `sod_rules` | `bh:SegregationOfDutiesRule` | Segregation-of-duties rule enforced by the runtime and checked by the JE review skill. |
| `holidays` |  | Company holidays added to the bank-holiday calendar for workday math. |
| `idempotency_keys` |  | Stored responses for retried mutating requests (Idempotency-Key header). |
| `access_requests` | `bh:AccessRequest` | A change to access or controls held for a second person: a role grant that carries approval authority, or a segregation-of-duties rule change. Applied only when someone other than the requester and the grantee approves it. |
| `credential_tokens` | `bh:CredentialLink` | Single-use, expiring enrolment or password-reset link for one person; only its hash is stored and nobody but the addressee receives it. |
| `outbox_messages` | `bh:OutboxMessage` | Messages Bookhand sends people (enrolment and reset links, lockout notices), queued for the configured transport; a demo organization reads them in its delivery log. |

## Audit

```mermaid
erDiagram
  audit_log {
    uuid id PK
    uuid tenant_id FK
    bigint seq
    timestamptz occurred_at
    enum actor_type
    text actor_id
    text actor_label
    text action
    text object_type
    text object_id
    text summary
    text record
    text prev_hash
    text hash UK
    text request_id
    text ip
  }
```

| Table | Ontology class | Notes |
|---|---|---|
| `audit_log` | `bh:AuditEvent` | Tamper-evident, append-only event log. hash = sha256(prev_hash // "\n" // record); the database rejects UPDATE/DELETE and any insert that breaks the chain. **Append-only.** |

## General ledger

```mermaid
erDiagram
  accounts {
    uuid id PK
    uuid tenant_id FK
    text number
    text name
    enum account_class
    text subtype
    enum normal_balance
    uuid parent_id FK
    bool is_postable
    text fs_line
    text xbrl_element
    bool is_reconcilable
    bool is_control_account
    bool is_intercompany
    bool is_monetary
    bool requires_department
    enum status
    text description
    timestamptz created_at
  }
  periods {
    uuid id PK
    uuid tenant_id FK
    uuid entity_id FK
    int fiscal_year
    int period_number
    text name
    date start_date
    date end_date
    enum status
    timestamptz soft_closed_at
    uuid soft_closed_by FK
    timestamptz locked_at
    uuid locked_by FK
    int reopened_count
  }
  journal_entries {
    uuid id PK
    uuid tenant_id FK
    uuid entity_id FK
    uuid period_id FK
    text entry_number
    date entry_date
    enum entry_type
    enum status
    text description
    enum source
    enum source_module
    uuid source_document_id FK
    uuid import_batch_id FK
    text source_locator
    text external_ref
    text external_prepared_by
    text external_approved_by
    text currency
    numeric fx_rate
    uuid prepared_by FK
    uuid prepared_by_run_id FK
    uuid proposal_id FK
    enum approval_basis
    uuid approved_by FK
    timestamptz approved_at
    timestamptz posted_at
    uuid posted_by FK
    uuid posted_by_run_id FK
    uuid reverses_entry_id FK
    date auto_reverse_date
    text ic_reference
    uuid counterparty_entity_id FK
    text idempotency_key UK
    bigint total_minor
    int line_count
    timestamptz created_at
    timestamptz updated_at
  }
  journal_lines {
    uuid id PK
    uuid tenant_id FK
    uuid journal_entry_id FK
    int line_number
    uuid entity_id FK
    uuid period_id FK
    date entry_date
    uuid account_id FK
    bigint debit_minor
    bigint credit_minor
    text txn_currency
    bigint txn_amount_minor
    uuid department_id FK
    uuid location_id FK
    uuid class_id FK
    uuid project_id FK
    uuid counterparty_entity_id FK
    uuid vendor_id FK
    uuid customer_id FK
    text memo
    timestamptz created_at
  }
  recurring_templates {
    uuid id PK
    uuid tenant_id FK
    uuid entity_id FK
    text name
    text description
    enum frequency
    jsonb lines
    bool auto_reverse
    date next_run_date
    enum status
    uuid created_by FK
    timestamptz created_at
  }
  agent_runs {
    uuid id PK
  }
  classes {
    uuid id PK
  }
  customers {
    uuid id PK
  }
  departments {
    uuid id PK
  }
  entities {
    uuid id PK
  }
  import_batches {
    uuid id PK
  }
  locations {
    uuid id PK
  }
  projects {
    uuid id PK
  }
  proposals {
    uuid id PK
  }
  source_documents {
    uuid id PK
  }
  users {
    uuid id PK
  }
  vendors {
    uuid id PK
  }
  accounts |o--o{ accounts : "parent_id"
  entities ||--o{ periods : "entity_id"
  users |o--o{ periods : "soft_closed_by"
  users |o--o{ periods : "locked_by"
  entities ||--o{ journal_entries : "entity_id"
  periods ||--o{ journal_entries : "period_id"
  source_documents |o--o{ journal_entries : "source_document_id"
  import_batches |o--o{ journal_entries : "import_batch_id"
  users |o--o{ journal_entries : "prepared_by"
  agent_runs |o--o{ journal_entries : "prepared_by_run_id"
  proposals |o--o{ journal_entries : "proposal_id"
  users |o--o{ journal_entries : "approved_by"
  users |o--o{ journal_entries : "posted_by"
  agent_runs |o--o{ journal_entries : "posted_by_run_id"
  journal_entries |o--o{ journal_entries : "reverses_entry_id"
  entities |o--o{ journal_entries : "counterparty_entity_id"
  journal_entries ||--o{ journal_lines : "journal_entry_id"
  entities ||--o{ journal_lines : "entity_id"
  periods ||--o{ journal_lines : "period_id"
  accounts ||--o{ journal_lines : "account_id"
  departments |o--o{ journal_lines : "department_id"
  locations |o--o{ journal_lines : "location_id"
  classes |o--o{ journal_lines : "class_id"
  projects |o--o{ journal_lines : "project_id"
  entities |o--o{ journal_lines : "counterparty_entity_id"
  vendors |o--o{ journal_lines : "vendor_id"
  customers |o--o{ journal_lines : "customer_id"
  entities ||--o{ recurring_templates : "entity_id"
  users |o--o{ recurring_templates : "created_by"
```

| Table | Ontology class | Notes |
|---|---|---|
| `accounts` | `bh:Account` | Chart of accounts (tenant-wide, shared by entities). Leaf accounts are postable; headers roll up. |
| `periods` | `bh:AccountingPeriod` | Accounting period per entity with its state machine: future -> open -> soft_closed -> locked. |
| `journal_entries` | `bh:JournalEntry` | Journal entry header. Posting is a state transition the database validates (>= 2 lines, debits = credits, period open, dates in period). Posted entries are immutable; corrections are reversing entries. |
| `journal_lines` | `bh:JournalLine` | Journal line: exactly one side positive (debit XOR credit), functional-currency amounts plus the transaction-currency amount. |
| `recurring_templates` | `bh:RecurringEntry` | Template for recurring journal entries (e.g. rent, management fee). |

## Dimensions

```mermaid
erDiagram
  departments {
    uuid id PK
    uuid tenant_id FK
    text code
    text name
    uuid parent_id FK
    uuid owner_user_id FK
    enum status
  }
  locations {
    uuid id PK
    uuid tenant_id FK
    text code
    text name
    uuid parent_id FK
    uuid owner_user_id FK
    enum status
  }
  classes {
    uuid id PK
    uuid tenant_id FK
    text code
    text name
    uuid parent_id FK
    uuid owner_user_id FK
    enum status
  }
  projects {
    uuid id PK
    uuid tenant_id FK
    text code
    text name
    uuid parent_id FK
    uuid owner_user_id FK
    enum status
  }
  users {
    uuid id PK
  }
  departments |o--o{ departments : "parent_id"
  users |o--o{ departments : "owner_user_id"
  locations |o--o{ locations : "parent_id"
  users |o--o{ locations : "owner_user_id"
  classes |o--o{ classes : "parent_id"
  users |o--o{ classes : "owner_user_id"
  projects |o--o{ projects : "parent_id"
  users |o--o{ projects : "owner_user_id"
```

| Table | Ontology class | Notes |
|---|---|---|
| `departments` | `bh:Department` | Cost-center dimension (who spent it). |
| `locations` | `bh:Location` | Geographic dimension (where). |
| `classes` | `bh:BusinessClass` | Classification dimension, e.g. product line. |
| `projects` | `bh:Project` | Project dimension for capitalizable or tracked work. |

## FX

```mermaid
erDiagram
  fx_rates {
    uuid id PK
    uuid tenant_id FK
    text base_currency
    text quote_currency
    date rate_date
    enum rate_type
    numeric rate
    text source
  }
```

| Table | Ontology class | Notes |
|---|---|---|
| `fx_rates` | `bh:ExchangeRate` | Exchange rates: spot (daily), average (month) and closing (month end). |

## Planning

```mermaid
erDiagram
  budgets {
    uuid id PK
    uuid tenant_id FK
    uuid entity_id FK
    text name
    int fiscal_year
    enum kind
    int version
    enum status
    uuid created_by FK
    uuid approved_by FK
    timestamptz approved_at
    timestamptz created_at
  }
  budget_lines {
    uuid id PK
    uuid tenant_id FK
    uuid budget_id FK
    uuid account_id FK
    uuid department_id FK
    int period_number
    bigint amount_minor
    text driver
  }
  accounts {
    uuid id PK
  }
  departments {
    uuid id PK
  }
  entities {
    uuid id PK
  }
  users {
    uuid id PK
  }
  entities ||--o{ budgets : "entity_id"
  users |o--o{ budgets : "created_by"
  users |o--o{ budgets : "approved_by"
  budgets ||--o{ budget_lines : "budget_id"
  accounts ||--o{ budget_lines : "account_id"
  departments |o--o{ budget_lines : "department_id"
```

| Table | Ontology class | Notes |
|---|---|---|
| `budgets` | `bh:Budget` | Budget or forecast version for an entity and fiscal year. |
| `budget_lines` |  | Budget amount per account, department and month. |

## Controls

```mermaid
erDiagram
  materiality_settings {
    uuid id PK
    uuid tenant_id FK
    int fiscal_year
    int version
    enum benchmark
    bigint benchmark_minor
    numeric overall_pct
    bigint overall_minor
    numeric performance_pct
    bigint performance_minor
    numeric trivial_pct
    bigint trivial_minor
    text rationale
    uuid set_by FK
    uuid approved_by FK
    timestamptz created_at
  }
  users {
    uuid id PK
  }
  users |o--o{ materiality_settings : "set_by"
  users |o--o{ materiality_settings : "approved_by"
```

| Table | Ontology class | Notes |
|---|---|---|
| `materiality_settings` | `bh:Materiality` | Materiality: overall, performance and clearly-trivial thresholds (AS 2105 / ISA 320). |

## Accounts payable

```mermaid
erDiagram
  vendors {
    uuid id PK
    uuid tenant_id FK
    text code
    text name
    text legal_name
    text category
    uuid default_account_id FK
    uuid default_department_id FK
    int payment_terms_days
    text currency
    bool is_1099
    enum status
    text tax_id_last4
    text remit_bank_last4
    uuid created_by FK
    uuid updated_by FK
    timestamptz created_at
    timestamptz updated_at
  }
  purchase_orders {
    uuid id PK
    uuid tenant_id FK
    uuid entity_id FK
    uuid vendor_id FK
    text po_number
    date order_date
    enum status
    text currency
    bigint total_minor
    text description
    uuid requested_by FK
    uuid approved_by FK
    timestamptz created_at
  }
  purchase_order_lines {
    uuid id PK
    uuid tenant_id FK
    uuid purchase_order_id FK
    int line_number
    text description
    uuid account_id FK
    uuid department_id FK
    numeric quantity
    bigint unit_price_minor
    bigint amount_minor
    bigint received_amount_minor
    bigint billed_amount_minor
    date service_start
    date service_end
  }
  goods_receipts {
    uuid id PK
    uuid tenant_id FK
    uuid entity_id FK
    uuid purchase_order_id FK
    uuid purchase_order_line_id FK
    date receipt_date
    numeric quantity
    bigint amount_minor
    uuid received_by FK
    text note
    timestamptz created_at
  }
  bills {
    uuid id PK
    uuid tenant_id FK
    uuid entity_id FK
    uuid vendor_id FK
    text bill_number
    date bill_date
    date received_date
    date due_date
    text currency
    bigint amount_minor
    enum status
    uuid purchase_order_id FK
    date service_start
    date service_end
    text description
    uuid journal_entry_id FK
    uuid source_document_id FK
    uuid import_batch_id FK
    text source_locator
    uuid created_by FK
    uuid approved_by FK
    timestamptz created_at
  }
  bill_lines {
    uuid id PK
    uuid tenant_id FK
    uuid bill_id FK
    int line_number
    uuid account_id FK
    uuid department_id FK
    uuid location_id FK
    uuid class_id FK
    uuid project_id FK
    text description
    bigint amount_minor
    date service_start
    date service_end
  }
  vendor_payments {
    uuid id PK
    uuid tenant_id FK
    uuid entity_id FK
    uuid vendor_id FK
    uuid bank_account_id FK
    date payment_date
    enum method
    text reference
    bigint amount_minor
    text currency
    enum status
    uuid journal_entry_id FK
    uuid created_by FK
    uuid approved_by FK
    timestamptz created_at
  }
  payment_applications {
    uuid id PK
    uuid tenant_id FK
    uuid payment_id FK
    uuid bill_id FK
    bigint amount_minor
  }
  accounts {
    uuid id PK
  }
  bank_accounts {
    uuid id PK
  }
  classes {
    uuid id PK
  }
  departments {
    uuid id PK
  }
  entities {
    uuid id PK
  }
  import_batches {
    uuid id PK
  }
  journal_entries {
    uuid id PK
  }
  locations {
    uuid id PK
  }
  projects {
    uuid id PK
  }
  source_documents {
    uuid id PK
  }
  users {
    uuid id PK
  }
  accounts |o--o{ vendors : "default_account_id"
  departments |o--o{ vendors : "default_department_id"
  users |o--o{ vendors : "created_by"
  users |o--o{ vendors : "updated_by"
  entities ||--o{ purchase_orders : "entity_id"
  vendors ||--o{ purchase_orders : "vendor_id"
  users |o--o{ purchase_orders : "requested_by"
  users |o--o{ purchase_orders : "approved_by"
  purchase_orders ||--o{ purchase_order_lines : "purchase_order_id"
  accounts ||--o{ purchase_order_lines : "account_id"
  departments |o--o{ purchase_order_lines : "department_id"
  entities ||--o{ goods_receipts : "entity_id"
  purchase_orders ||--o{ goods_receipts : "purchase_order_id"
  purchase_order_lines ||--o{ goods_receipts : "purchase_order_line_id"
  users |o--o{ goods_receipts : "received_by"
  entities ||--o{ bills : "entity_id"
  vendors ||--o{ bills : "vendor_id"
  purchase_orders |o--o{ bills : "purchase_order_id"
  journal_entries |o--o{ bills : "journal_entry_id"
  source_documents |o--o{ bills : "source_document_id"
  import_batches |o--o{ bills : "import_batch_id"
  users |o--o{ bills : "created_by"
  users |o--o{ bills : "approved_by"
  bills ||--o{ bill_lines : "bill_id"
  accounts ||--o{ bill_lines : "account_id"
  departments |o--o{ bill_lines : "department_id"
  locations |o--o{ bill_lines : "location_id"
  classes |o--o{ bill_lines : "class_id"
  projects |o--o{ bill_lines : "project_id"
  entities ||--o{ vendor_payments : "entity_id"
  vendors ||--o{ vendor_payments : "vendor_id"
  bank_accounts ||--o{ vendor_payments : "bank_account_id"
  journal_entries |o--o{ vendor_payments : "journal_entry_id"
  users |o--o{ vendor_payments : "created_by"
  users |o--o{ vendor_payments : "approved_by"
  vendor_payments ||--o{ payment_applications : "payment_id"
  bills ||--o{ payment_applications : "bill_id"
```

| Table | Ontology class | Notes |
|---|---|---|
| `vendors` | `bh:Vendor` | Vendor master (supplier). |
| `purchase_orders` | `bh:PurchaseOrder` | Purchase order (commitment, REA). |
| `purchase_order_lines` |  | Purchase order line. |
| `goods_receipts` | `bh:GoodsReceipt` | Goods or services received against a PO line (evidence for GRNI accruals). |
| `bills` | `bh:VendorBill` | Vendor bill (invoice received). Posting credits AP and debits the coded accounts. |
| `bill_lines` |  | Bill line with GL coding and dimensions. |
| `vendor_payments` | `bh:VendorPayment` | Outgoing payment to a vendor (economic event: cash disbursement). |
| `payment_applications` |  | Allocation of a payment to the bills it settles. |

## Accounts receivable

```mermaid
erDiagram
  customers {
    uuid id PK
    uuid tenant_id FK
    text code
    text name
    text segment
    text currency
    int payment_terms_days
    enum status
    timestamptz created_at
  }
  invoices {
    uuid id PK
    uuid tenant_id FK
    uuid entity_id FK
    uuid customer_id FK
    text invoice_number
    date invoice_date
    date due_date
    text currency
    bigint amount_minor
    enum status
    date service_start
    date service_end
    text description
    uuid journal_entry_id FK
    timestamptz created_at
  }
  invoice_lines {
    uuid id PK
    uuid tenant_id FK
    uuid invoice_id FK
    int line_number
    text description
    uuid revenue_account_id FK
    uuid class_id FK
    bigint amount_minor
    date service_start
    date service_end
    bool deferred
  }
  customer_receipts {
    uuid id PK
    uuid tenant_id FK
    uuid entity_id FK
    uuid customer_id FK
    uuid bank_account_id FK
    date receipt_date
    enum method
    text reference
    bigint amount_minor
    text currency
    enum status
    uuid journal_entry_id FK
    timestamptz created_at
  }
  receipt_applications {
    uuid id PK
    uuid tenant_id FK
    uuid receipt_id FK
    uuid invoice_id FK
    bigint amount_minor
  }
  accounts {
    uuid id PK
  }
  bank_accounts {
    uuid id PK
  }
  classes {
    uuid id PK
  }
  entities {
    uuid id PK
  }
  journal_entries {
    uuid id PK
  }
  entities ||--o{ invoices : "entity_id"
  customers ||--o{ invoices : "customer_id"
  journal_entries |o--o{ invoices : "journal_entry_id"
  invoices ||--o{ invoice_lines : "invoice_id"
  accounts ||--o{ invoice_lines : "revenue_account_id"
  classes |o--o{ invoice_lines : "class_id"
  entities ||--o{ customer_receipts : "entity_id"
  customers ||--o{ customer_receipts : "customer_id"
  bank_accounts ||--o{ customer_receipts : "bank_account_id"
  journal_entries |o--o{ customer_receipts : "journal_entry_id"
  customer_receipts ||--o{ receipt_applications : "receipt_id"
  invoices ||--o{ receipt_applications : "invoice_id"
```

| Table | Ontology class | Notes |
|---|---|---|
| `customers` | `bh:Customer` | Customer master. |
| `invoices` | `bh:CustomerInvoice` | Customer invoice. Subscription invoices create deferred revenue recognized over the service period (ASC 606). |
| `invoice_lines` |  | Invoice line (performance obligation). |
| `customer_receipts` | `bh:CustomerReceipt` | Cash received from a customer. |
| `receipt_applications` |  | Allocation of a receipt to invoices. |

## Cash & cards

```mermaid
erDiagram
  bank_accounts {
    uuid id PK
    uuid tenant_id FK
    uuid entity_id FK
    text name
    text institution
    text account_last4
    text currency
    uuid gl_account_id FK
    enum status
    timestamptz created_at
  }
  bank_statements {
    uuid id PK
    uuid tenant_id FK
    uuid bank_account_id FK
    date statement_date
    date period_start
    date period_end
    bigint opening_balance_minor
    bigint closing_balance_minor
    text currency
    uuid source_document_id FK
    uuid import_batch_id FK
    text source_locator
    timestamptz created_at
  }
  bank_transactions {
    uuid id PK
    uuid tenant_id FK
    uuid entity_id FK
    uuid bank_account_id FK
    uuid statement_id FK
    date booking_date
    date value_date
    bigint amount_minor
    text currency
    text description
    text counterparty
    text reference
    text bank_reference
    text type_code
    enum status
    text dedupe_key
    uuid source_document_id FK
    uuid import_batch_id FK
    text source_locator
    timestamptz created_at
  }
  cards {
    uuid id PK
    uuid tenant_id FK
    uuid entity_id FK
    text cardholder_name
    uuid cardholder_user_id FK
    text last4
    uuid department_id FK
    uuid liability_account_id FK
    enum status
    timestamptz created_at
  }
  card_transactions {
    uuid id PK
    uuid tenant_id FK
    uuid entity_id FK
    uuid card_id FK
    date transaction_date
    date posted_date
    text merchant_name
    text mcc
    bigint amount_minor
    text currency
    text memo
    uuid receipt_document_id FK
    enum status
    uuid coded_account_id FK
    uuid coded_department_id FK
    enum coding_source
    numeric coding_confidence
    uuid journal_entry_id FK
    text external_id
    uuid import_batch_id FK
    text source_locator
    timestamptz created_at
  }
  accounts {
    uuid id PK
  }
  departments {
    uuid id PK
  }
  entities {
    uuid id PK
  }
  import_batches {
    uuid id PK
  }
  journal_entries {
    uuid id PK
  }
  source_documents {
    uuid id PK
  }
  users {
    uuid id PK
  }
  entities ||--o{ bank_accounts : "entity_id"
  accounts ||--o{ bank_accounts : "gl_account_id"
  bank_accounts ||--o{ bank_statements : "bank_account_id"
  source_documents |o--o{ bank_statements : "source_document_id"
  import_batches |o--o{ bank_statements : "import_batch_id"
  entities ||--o{ bank_transactions : "entity_id"
  bank_accounts ||--o{ bank_transactions : "bank_account_id"
  bank_statements |o--o{ bank_transactions : "statement_id"
  source_documents |o--o{ bank_transactions : "source_document_id"
  import_batches |o--o{ bank_transactions : "import_batch_id"
  entities ||--o{ cards : "entity_id"
  users |o--o{ cards : "cardholder_user_id"
  departments |o--o{ cards : "department_id"
  accounts ||--o{ cards : "liability_account_id"
  entities ||--o{ card_transactions : "entity_id"
  cards ||--o{ card_transactions : "card_id"
  source_documents |o--o{ card_transactions : "receipt_document_id"
  accounts |o--o{ card_transactions : "coded_account_id"
  departments |o--o{ card_transactions : "coded_department_id"
  journal_entries |o--o{ card_transactions : "journal_entry_id"
  import_batches |o--o{ card_transactions : "import_batch_id"
```

| Table | Ontology class | Notes |
|---|---|---|
| `bank_accounts` | `bh:BankAccount` | Bank account mapped to a GL cash account. |
| `bank_statements` | `bh:BankStatement` | Bank statement (period with opening and closing balances). |
| `bank_transactions` | `bh:BankTransaction` | Bank statement line. Imports are idempotent on (bank account, dedupe key). |
| `cards` | `bh:CorporateCard` | Corporate card. |
| `card_transactions` | `bh:CardTransaction` | Card transaction from the card feed; coded to an account and department before posting. |

## Schedules & payroll

```mermaid
erDiagram
  fixed_assets {
    uuid id PK
    uuid tenant_id FK
    uuid entity_id FK
    text asset_number
    text description
    enum asset_class
    date acquisition_date
    date in_service_date
    bigint cost_minor
    bigint salvage_minor
    int useful_life_months
    enum method
    uuid asset_account_id FK
    uuid accumulated_depreciation_account_id FK
    uuid depreciation_expense_account_id FK
    uuid department_id FK
    uuid location_id FK
    uuid vendor_id FK
    uuid bill_id FK
    enum status
    date disposal_date
    timestamptz created_at
  }
  depreciation_lines {
    uuid id PK
    uuid tenant_id FK
    uuid fixed_asset_id FK
    uuid period_id FK
    int fiscal_year
    int period_number
    bigint amount_minor
    bigint accumulated_minor
    bigint net_book_value_minor
    enum status
    uuid journal_entry_id FK
  }
  amortization_schedules {
    uuid id PK
    uuid tenant_id FK
    uuid entity_id FK
    enum kind
    text description
    uuid vendor_id FK
    uuid customer_id FK
    uuid bill_id FK
    uuid invoice_id FK
    uuid balance_account_id FK
    uuid pl_account_id FK
    uuid department_id FK
    bigint total_minor
    date start_date
    date end_date
    int months
    enum method
    enum status
    uuid created_by FK
    uuid created_by_run_id FK
    timestamptz created_at
  }
  amortization_lines {
    uuid id PK
    uuid tenant_id FK
    uuid schedule_id FK
    uuid period_id FK
    date period_end
    bigint amount_minor
    enum status
    uuid journal_entry_id FK
  }
  payroll_runs {
    uuid id PK
    uuid tenant_id FK
    uuid entity_id FK
    text provider
    text external_id
    date pay_period_start
    date pay_period_end
    date pay_date
    text currency
    bigint gross_minor
    bigint employer_tax_minor
    bigint benefits_minor
    bigint withholding_minor
    bigint net_pay_minor
    int headcount
    uuid journal_entry_id FK
    uuid source_document_id FK
    uuid import_batch_id FK
    timestamptz created_at
  }
  payroll_lines {
    uuid id PK
    uuid tenant_id FK
    uuid payroll_run_id FK
    uuid department_id FK
    enum category
    bigint amount_minor
  }
  accounts {
    uuid id PK
  }
  agent_runs {
    uuid id PK
  }
  bills {
    uuid id PK
  }
  customers {
    uuid id PK
  }
  departments {
    uuid id PK
  }
  entities {
    uuid id PK
  }
  import_batches {
    uuid id PK
  }
  invoices {
    uuid id PK
  }
  journal_entries {
    uuid id PK
  }
  locations {
    uuid id PK
  }
  periods {
    uuid id PK
  }
  source_documents {
    uuid id PK
  }
  users {
    uuid id PK
  }
  vendors {
    uuid id PK
  }
  entities ||--o{ fixed_assets : "entity_id"
  accounts ||--o{ fixed_assets : "asset_account_id"
  accounts ||--o{ fixed_assets : "accumulated_depreciation_account_id"
  accounts ||--o{ fixed_assets : "depreciation_expense_account_id"
  departments |o--o{ fixed_assets : "department_id"
  locations |o--o{ fixed_assets : "location_id"
  vendors |o--o{ fixed_assets : "vendor_id"
  bills |o--o{ fixed_assets : "bill_id"
  fixed_assets ||--o{ depreciation_lines : "fixed_asset_id"
  periods ||--o{ depreciation_lines : "period_id"
  journal_entries |o--o{ depreciation_lines : "journal_entry_id"
  entities ||--o{ amortization_schedules : "entity_id"
  vendors |o--o{ amortization_schedules : "vendor_id"
  customers |o--o{ amortization_schedules : "customer_id"
  bills |o--o{ amortization_schedules : "bill_id"
  invoices |o--o{ amortization_schedules : "invoice_id"
  accounts ||--o{ amortization_schedules : "balance_account_id"
  accounts ||--o{ amortization_schedules : "pl_account_id"
  departments |o--o{ amortization_schedules : "department_id"
  users |o--o{ amortization_schedules : "created_by"
  agent_runs |o--o{ amortization_schedules : "created_by_run_id"
  amortization_schedules ||--o{ amortization_lines : "schedule_id"
  periods ||--o{ amortization_lines : "period_id"
  journal_entries |o--o{ amortization_lines : "journal_entry_id"
  entities ||--o{ payroll_runs : "entity_id"
  journal_entries |o--o{ payroll_runs : "journal_entry_id"
  source_documents |o--o{ payroll_runs : "source_document_id"
  import_batches |o--o{ payroll_runs : "import_batch_id"
  payroll_runs ||--o{ payroll_lines : "payroll_run_id"
  departments |o--o{ payroll_lines : "department_id"
```

| Table | Ontology class | Notes |
|---|---|---|
| `fixed_assets` | `bh:FixedAsset` | Fixed asset register (ASC 360). |
| `depreciation_lines` | `bh:DepreciationScheduleLine` | Depreciation schedule line per asset per period. |
| `amortization_schedules` | `bh:AmortizationSchedule` | Amortization schedule for a prepaid expense (ASC 340) or deferred revenue (ASC 606). |
| `amortization_lines` | `bh:AmortizationScheduleLine` | Monthly amortization amount. |
| `payroll_runs` | `bh:PayrollRun` | Payroll run summary from the payroll provider. |
| `payroll_lines` |  | Payroll cost by department and category. |

## Integration & documents

```mermaid
erDiagram
  connectors {
    uuid id PK
    uuid tenant_id FK
    enum kind
    text adapter
    text name
    uuid entity_id FK
    uuid bank_account_id FK
    jsonb config
    enum status
    timestamptz last_sync_at
    text last_sync_status
    timestamptz created_at
  }
  source_documents {
    uuid id PK
    uuid tenant_id FK
    enum kind
    text filename
    text media_type
    text sha256
    int size_bytes
    bytea content
    text text_content
    text storage_key
    uuid connector_id FK
    uuid uploaded_by FK
    timestamptz uploaded_at
    jsonb metadata
  }
  import_batches {
    uuid id PK
    uuid tenant_id FK
    uuid connector_id FK
    uuid source_document_id FK
    enum format
    text target
    enum status
    timestamptz started_at
    timestamptz finished_at
    int records_total
    int records_created
    int records_duplicate
    int records_failed
    jsonb errors
    uuid imported_by FK
    text idempotency_key UK
  }
  attachments {
    uuid id PK
    uuid tenant_id FK
    text object_type
    uuid object_id
    uuid source_document_id FK
    text note
    uuid attached_by FK
    timestamptz attached_at
  }
  comments {
    uuid id PK
    uuid tenant_id FK
    text object_type
    uuid object_id
    uuid author_id FK
    text body
    timestamptz created_at
  }
  bank_accounts {
    uuid id PK
  }
  entities {
    uuid id PK
  }
  users {
    uuid id PK
  }
  entities |o--o{ connectors : "entity_id"
  bank_accounts |o--o{ connectors : "bank_account_id"
  connectors |o--o{ source_documents : "connector_id"
  users |o--o{ source_documents : "uploaded_by"
  connectors |o--o{ import_batches : "connector_id"
  source_documents ||--o{ import_batches : "source_document_id"
  users |o--o{ import_batches : "imported_by"
  source_documents ||--o{ attachments : "source_document_id"
  users |o--o{ attachments : "attached_by"
  users ||--o{ comments : "author_id"
```

| Table | Ontology class | Notes |
|---|---|---|
| `connectors` | `bh:Connector` | A configured source system (bank feed, ERP export, card feed, payroll...). |
| `source_documents` | `bh:SourceDocument` | Immutable source document (file) identified by its SHA-256; every imported record links back to one. |
| `import_batches` | `bh:ImportBatch` | One import of one source document (idempotent; tracks created/duplicate/failed counts). |
| `attachments` | `bh:Evidence` | Evidence attached to any object (rec, task, JE, proposal). |
| `comments` |  | Discussion on an object. |

## Close management

```mermaid
erDiagram
  closes {
    uuid id PK
    uuid tenant_id FK
    int fiscal_year
    int period_number
    text name
    date period_end
    int target_workday
    enum status
    timestamptz started_at
    timestamptz closed_at
    uuid closed_by FK
    timestamptz created_at
  }
  checklist_templates {
    uuid id PK
    uuid tenant_id FK
    text name
    int version
    enum status
    timestamptz created_at
  }
  checklist_template_tasks {
    uuid id PK
    uuid tenant_id FK
    uuid template_id FK
    text key
    text title
    text description
    enum category
    int workday
    enum scope
    text owner_role
    text reviewer_role
    text skill_key
    jsonb depends_on
    bool evidence_required
    int sort_order
  }
  close_tasks {
    uuid id PK
    uuid tenant_id FK
    uuid close_id FK
    text key
    uuid entity_id FK
    text title
    text description
    enum category
    int due_workday
    date due_date
    uuid owner_id FK
    uuid reviewer_id FK
    enum status
    text skill_key
    uuid last_run_id FK
    text blocked_reason
    timestamptz started_at
    timestamptz completed_at
    uuid completed_by FK
    uuid completed_by_run_id FK
    timestamptz reviewed_at
    uuid reviewed_by FK
    bool evidence_required
    int sort_order
  }
  close_task_dependencies {
    uuid id PK
    uuid tenant_id FK
    uuid task_id FK
    uuid depends_on_task_id FK
  }
  signoffs {
    uuid id PK
    uuid tenant_id FK
    enum object_type
    uuid object_id
    enum role
    enum action
    uuid user_id FK
    timestamptz signed_at
    text comment
    text evidence_hash
  }
  close_packages {
    uuid id PK
    uuid tenant_id FK
    uuid close_id FK
    int version
    enum status
    timestamptz generated_at
    uuid generated_by FK
    uuid generated_by_run_id FK
    jsonb content
    text content_hash
    uuid source_document_id FK
    uuid approved_by FK
    timestamptz approved_at
  }
  agent_runs {
    uuid id PK
  }
  entities {
    uuid id PK
  }
  source_documents {
    uuid id PK
  }
  users {
    uuid id PK
  }
  users |o--o{ closes : "closed_by"
  checklist_templates ||--o{ checklist_template_tasks : "template_id"
  closes ||--o{ close_tasks : "close_id"
  entities |o--o{ close_tasks : "entity_id"
  users |o--o{ close_tasks : "owner_id"
  users |o--o{ close_tasks : "reviewer_id"
  agent_runs |o--o{ close_tasks : "last_run_id"
  users |o--o{ close_tasks : "completed_by"
  agent_runs |o--o{ close_tasks : "completed_by_run_id"
  users |o--o{ close_tasks : "reviewed_by"
  close_tasks ||--o{ close_task_dependencies : "task_id"
  close_tasks ||--o{ close_task_dependencies : "depends_on_task_id"
  users ||--o{ signoffs : "user_id"
  closes ||--o{ close_packages : "close_id"
  users |o--o{ close_packages : "generated_by"
  agent_runs |o--o{ close_packages : "generated_by_run_id"
  source_documents |o--o{ close_packages : "source_document_id"
  users |o--o{ close_packages : "approved_by"
```

| Table | Ontology class | Notes |
|---|---|---|
| `closes` | `bh:Close` | A month-end close across all entities for one fiscal period. |
| `checklist_templates` | `bh:CloseChecklist` | Versioned close checklist template. |
| `checklist_template_tasks` |  | Task definition in a checklist template. |
| `close_tasks` | `bh:CloseTask` | A task in a specific close, assigned to an owner and reviewer, due on a workday. |
| `close_task_dependencies` |  | Directed dependency between close tasks (must be acyclic). |
| `signoffs` | `bh:SignOff` | Append-only sign-off ledger (preparer/reviewer/approver) for any closeable object. **Append-only.** |
| `close_packages` | `bh:ClosePackage` | Generated close package (TB, statements, commentary, rec and exception status). |

## Reconciliation

```mermaid
erDiagram
  reconciliations {
    uuid id PK
    uuid tenant_id FK
    uuid entity_id FK
    uuid period_id FK
    uuid close_task_id FK
    enum rec_type
    uuid account_id FK
    uuid bank_account_id FK
    uuid counterparty_entity_id FK
    text currency
    bigint gl_balance_minor
    bigint external_balance_minor
    bigint reconciling_total_minor
    bigint difference_minor
    enum status
    enum risk
    uuid prepared_by FK
    timestamptz prepared_at
    uuid reviewed_by FK
    timestamptz reviewed_at
    uuid last_run_id FK
    text notes
    timestamptz created_at
    timestamptz updated_at
  }
  rec_matches {
    uuid id PK
    uuid tenant_id FK
    uuid reconciliation_id FK
    enum match_type
    enum status
    numeric confidence
    text rule
    text explanation
    uuid proposal_id FK
    uuid accepted_by FK
    timestamptz accepted_at
    timestamptz created_at
  }
  rec_match_items {
    uuid id PK
    uuid tenant_id FK
    uuid match_id FK
    enum side
    uuid bank_transaction_id FK
    uuid journal_line_id FK
    bigint amount_minor
  }
  reconciling_items {
    uuid id PK
    uuid tenant_id FK
    uuid reconciliation_id FK
    enum kind
    text description
    bigint amount_minor
    date item_date
    date expected_clear_date
    date cleared_date
    enum status
    uuid bank_transaction_id FK
    uuid journal_line_id FK
    uuid resolution_entry_id FK
    uuid proposal_id FK
    uuid created_by FK
    uuid created_by_run_id FK
    timestamptz created_at
  }
  accounts {
    uuid id PK
  }
  agent_runs {
    uuid id PK
  }
  bank_accounts {
    uuid id PK
  }
  bank_transactions {
    uuid id PK
  }
  close_tasks {
    uuid id PK
  }
  entities {
    uuid id PK
  }
  journal_entries {
    uuid id PK
  }
  journal_lines {
    uuid id PK
  }
  periods {
    uuid id PK
  }
  proposals {
    uuid id PK
  }
  users {
    uuid id PK
  }
  entities ||--o{ reconciliations : "entity_id"
  periods ||--o{ reconciliations : "period_id"
  close_tasks |o--o{ reconciliations : "close_task_id"
  accounts ||--o{ reconciliations : "account_id"
  bank_accounts |o--o{ reconciliations : "bank_account_id"
  entities |o--o{ reconciliations : "counterparty_entity_id"
  users |o--o{ reconciliations : "prepared_by"
  users |o--o{ reconciliations : "reviewed_by"
  agent_runs |o--o{ reconciliations : "last_run_id"
  reconciliations ||--o{ rec_matches : "reconciliation_id"
  proposals |o--o{ rec_matches : "proposal_id"
  users |o--o{ rec_matches : "accepted_by"
  rec_matches ||--o{ rec_match_items : "match_id"
  bank_transactions |o--o{ rec_match_items : "bank_transaction_id"
  journal_lines |o--o{ rec_match_items : "journal_line_id"
  reconciliations ||--o{ reconciling_items : "reconciliation_id"
  bank_transactions |o--o{ reconciling_items : "bank_transaction_id"
  journal_lines |o--o{ reconciling_items : "journal_line_id"
  journal_entries |o--o{ reconciling_items : "resolution_entry_id"
  proposals |o--o{ reconciling_items : "proposal_id"
  users |o--o{ reconciling_items : "created_by"
  agent_runs |o--o{ reconciling_items : "created_by_run_id"
```

| Table | Ontology class | Notes |
|---|---|---|
| `reconciliations` | `bh:Reconciliation` | Account reconciliation for one period: GL vs. external balance, reconciling items, certification. |
| `rec_matches` | `bh:ReconciliationMatch` | A match group between external items and ledger items. |
| `rec_match_items` |  | Member of a match group (exactly one referenced item). |
| `reconciling_items` | `bh:ReconcilingItem` | Explained difference between GL and external balance (timing or error), with aging. |

## Flux & variance

```mermaid
erDiagram
  flux_analyses {
    uuid id PK
    uuid tenant_id FK
    uuid close_id FK
    uuid entity_id FK
    enum comparison
    numeric threshold_pct
    bigint threshold_minor
    enum status
    uuid generated_by_run_id FK
    uuid prepared_by FK
    uuid approved_by FK
    timestamptz approved_at
    timestamptz created_at
  }
  flux_lines {
    uuid id PK
    uuid tenant_id FK
    uuid analysis_id FK
    uuid account_id FK
    text fs_line
    bigint current_minor
    bigint comparison_minor
    bigint variance_minor
    numeric variance_pct
    bool is_material
    jsonb drivers
    text explanation
    enum explanation_status
    uuid explained_by FK
    uuid explained_by_run_id FK
    numeric confidence
    uuid proposal_id FK
    uuid reviewed_by FK
    timestamptz reviewed_at
  }
  accounts {
    uuid id PK
  }
  agent_runs {
    uuid id PK
  }
  closes {
    uuid id PK
  }
  entities {
    uuid id PK
  }
  proposals {
    uuid id PK
  }
  users {
    uuid id PK
  }
  closes ||--o{ flux_analyses : "close_id"
  entities |o--o{ flux_analyses : "entity_id"
  agent_runs |o--o{ flux_analyses : "generated_by_run_id"
  users |o--o{ flux_analyses : "prepared_by"
  users |o--o{ flux_analyses : "approved_by"
  flux_analyses ||--o{ flux_lines : "analysis_id"
  accounts ||--o{ flux_lines : "account_id"
  users |o--o{ flux_lines : "explained_by"
  agent_runs |o--o{ flux_lines : "explained_by_run_id"
  proposals |o--o{ flux_lines : "proposal_id"
  users |o--o{ flux_lines : "reviewed_by"
```

| Table | Ontology class | Notes |
|---|---|---|
| `flux_analyses` | `bh:FluxAnalysis` | Flux (variance) analysis for a close: current vs. comparison with materiality thresholds. |
| `flux_lines` | `bh:FluxLine` | Variance on one account with drivers and an explanation. |

## Agent runtime

```mermaid
erDiagram
  skills {
    uuid id PK
    text key UK
    text name
    text description
    text category
    text domain
    text current_version
    enum status
    timestamptz created_at
  }
  skill_versions {
    uuid id PK
    uuid skill_id FK
    text version
    jsonb manifest
    text instructions
    jsonb resources
    text content_hash
    timestamptz published_at
    text published_by
    jsonb eval_summary
  }
  skill_policies {
    uuid id PK
    uuid tenant_id FK
    text skill_key
    uuid entity_id FK
    int version
    enum autonomy_level
    jsonb thresholds
    jsonb rules_text
    jsonb rules
    text change_reason
    uuid created_by FK
    timestamptz created_at
    uuid supersedes_id FK
  }
  agent_runs {
    uuid id PK
    uuid tenant_id FK
    text skill_key
    text skill_version
    uuid policy_id FK
    text ontology_version
    uuid close_id FK
    uuid close_task_id FK
    uuid entity_id FK
    uuid period_id FK
    uuid parent_run_id FK
    enum status
    enum phase
    enum mode
    text provider
    text model
    uuid requested_by FK
    text requested_by_label
    enum trigger
    jsonb input
    jsonb plan
    text summary
    text error
    jsonb budget
    int steps_used
    int tool_calls_used
    int tokens_in
    int tokens_out
    int cache_read_tokens
    bigint cost_usd_micros
    int proposals_count
    text idempotency_key UK
    timestamptz heartbeat_at
    int resume_count
    timestamptz started_at
    timestamptz finished_at
    timestamptz created_at
  }
  agent_steps {
    uuid id PK
    uuid tenant_id FK
    uuid run_id FK
    int seq
    enum phase
    enum kind
    text title
    jsonb detail
    int tokens_in
    int tokens_out
    bigint cost_usd_micros
    int duration_ms
    timestamptz created_at
  }
  agent_tool_calls {
    uuid id PK
    uuid tenant_id FK
    uuid run_id FK
    uuid step_id FK
    text tool_name
    jsonb input
    jsonb output
    enum status
    bool is_mutation
    text idempotency_key UK
    text error
    int duration_ms
    timestamptz created_at
  }
  proposals {
    uuid id PK
    uuid tenant_id FK
    uuid run_id FK
    text skill_key
    enum kind
    enum status
    enum disposition
    text title
    text why
    numeric confidence
    bigint amount_minor
    text currency
    uuid entity_id FK
    uuid period_id FK
    uuid close_task_id FK
    jsonb payload
    jsonb evidence
    jsonb verification
    jsonb risk_flags
    enum autonomy_level
    uuid policy_id FK
    text required_permission
    enum maker_type
    uuid maker_user_id FK
    uuid requested_by FK
    uuid decided_by FK
    timestamptz decided_at
    text decision_reason
    jsonb effect
    uuid posted_entry_id FK
    bool sampled_for_review
    enum post_hoc_status
    uuid post_hoc_reviewed_by FK
    timestamptz post_hoc_reviewed_at
    text idempotency_key UK
    timestamptz created_at
    timestamptz updated_at
  }
  approvals {
    uuid id PK
    uuid tenant_id FK
    uuid proposal_id FK
    enum decision
    uuid user_id FK
    text role_key
    text reason
    timestamptz created_at
  }
  ontology_versions {
    uuid id PK
    text version UK
    text content_hash
    int class_count
    int axiom_count
    timestamptz published_at
  }
  close_tasks {
    uuid id PK
  }
  closes {
    uuid id PK
  }
  entities {
    uuid id PK
  }
  journal_entries {
    uuid id PK
  }
  periods {
    uuid id PK
  }
  users {
    uuid id PK
  }
  skills ||--o{ skill_versions : "skill_id"
  entities |o--o{ skill_policies : "entity_id"
  users |o--o{ skill_policies : "created_by"
  skill_policies |o--o{ skill_policies : "supersedes_id"
  skill_policies |o--o{ agent_runs : "policy_id"
  closes |o--o{ agent_runs : "close_id"
  close_tasks |o--o{ agent_runs : "close_task_id"
  entities |o--o{ agent_runs : "entity_id"
  periods |o--o{ agent_runs : "period_id"
  agent_runs |o--o{ agent_runs : "parent_run_id"
  users |o--o{ agent_runs : "requested_by"
  agent_runs ||--o{ agent_steps : "run_id"
  agent_runs ||--o{ agent_tool_calls : "run_id"
  agent_steps |o--o{ agent_tool_calls : "step_id"
  agent_runs |o--o{ proposals : "run_id"
  entities |o--o{ proposals : "entity_id"
  periods |o--o{ proposals : "period_id"
  close_tasks |o--o{ proposals : "close_task_id"
  skill_policies |o--o{ proposals : "policy_id"
  users |o--o{ proposals : "maker_user_id"
  users |o--o{ proposals : "requested_by"
  users |o--o{ proposals : "decided_by"
  journal_entries |o--o{ proposals : "posted_entry_id"
  users |o--o{ proposals : "post_hoc_reviewed_by"
  proposals ||--o{ approvals : "proposal_id"
  users ||--o{ approvals : "user_id"
```

| Table | Ontology class | Notes |
|---|---|---|
| `skills` | `bh:Skill` | Skill registry (global catalog of SKILL.md packages). |
| `skill_versions` |  | Immutable published version of a skill package. **Append-only.** |
| `skill_policies` | `bh:SkillPolicy` | Versioned, append-only tenant policy for a skill: autonomy level, thresholds, plain-English rules. **Append-only.** |
| `agent_runs` | `bh:AgentRun` | One execution of a skill: plan -> act -> observe -> verify -> propose, with budgets and cost accounting. |
| `agent_steps` | `bh:AgentStep` | Trace step of a run (append-only). **Append-only.** |
| `agent_tool_calls` | `bh:ToolCall` | Typed tool call made by an agent (append-only). **Append-only.** |
| `proposals` | `bh:Proposal` | Something an agent (or a person adopting a suggestion) wants to change, with why, confidence, evidence and checks. |
| `approvals` | `bh:ApprovalDecision` | Append-only decision history for proposals (approve, reject, adopt, post-hoc review). **Append-only.** |
| `ontology_versions` |  | Published versions of the close ontology referenced by runs. **Append-only.** |

