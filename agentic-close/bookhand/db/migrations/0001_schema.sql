-- 0001_schema.sql
-- GENERATED from src/persistence/schema by `npm run db:generate`. Do not edit by hand:
-- tests/unit/ddl.test.ts fails if this file drifts from the schema.

CREATE TABLE "tenants" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "reporting_currency" text NOT NULL,
  "fiscal_year_start_month" integer NOT NULL DEFAULT 1,
  "business_date" date,
  "is_demo" boolean NOT NULL DEFAULT false,
  "settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tenants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tenants_reporting_currency_check" CHECK ("reporting_currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "tenants_fiscal_year_start_month_check" CHECK ("fiscal_year_start_month" BETWEEN 1 AND 12),
  CONSTRAINT "tenants_slug_key" UNIQUE ("slug")
);

CREATE TABLE "entities" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "legal_name" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'operating',
  "functional_currency" text NOT NULL,
  "country" text NOT NULL,
  "parent_entity_id" uuid,
  "ownership_pct" numeric(7,4) NOT NULL DEFAULT 100,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "entities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "entities_kind_check" CHECK ("kind" IN ('operating', 'elimination')),
  CONSTRAINT "entities_functional_currency_check" CHECK ("functional_currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "entities_status_check" CHECK ("status" IN ('active', 'inactive')),
  CONSTRAINT "entities_tenant_id_code_key" UNIQUE ("tenant_id", "code")
);

CREATE TABLE "users" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "email" text NOT NULL,
  "display_name" text NOT NULL,
  "title" text,
  "password_hash" text,
  "identity_provider" text NOT NULL DEFAULT 'password',
  "external_subject" text,
  "status" text NOT NULL DEFAULT 'active',
  "mfa_enabled" boolean NOT NULL DEFAULT false,
  "mfa_secret_enc" text,
  "mfa_pending_secret_enc" text,
  "failed_login_count" integer NOT NULL DEFAULT 0,
  "locked_until" timestamptz,
  "last_login_at" timestamptz,
  "avatar_hue" integer NOT NULL DEFAULT 210,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "users_email_check" CHECK ("email" = lower(email)),
  CONSTRAINT "users_identity_provider_check" CHECK ("identity_provider" IN ('password', 'oidc', 'saml')),
  CONSTRAINT "users_status_check" CHECK ("status" IN ('active', 'disabled')),
  CONSTRAINT "users_tenant_id_email_key" UNIQUE ("tenant_id", "email"),
  CONSTRAINT "users_tenant_id_identity_provider_external_subject_key" UNIQUE ("tenant_id", "identity_provider", "external_subject")
);

CREATE TABLE "roles" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "key" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "permissions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "approval_limit_minor" bigint,
  "is_read_only" boolean NOT NULL DEFAULT false,
  "sort_order" integer NOT NULL DEFAULT 0,
  CONSTRAINT "roles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "roles_key_key" UNIQUE ("key")
);

CREATE TABLE "user_roles" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "role_id" uuid NOT NULL,
  "entity_id" uuid,
  "granted_by" uuid,
  "granted_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_roles_user_id_role_id_entity_id_key" UNIQUE NULLS NOT DISTINCT ("user_id", "role_id", "entity_id")
);

CREATE TABLE "sessions" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "csrf_token" text NOT NULL,
  "auth_method" text NOT NULL,
  "mfa_verified" boolean NOT NULL DEFAULT false,
  "state" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  "idle_expires_at" timestamptz NOT NULL,
  "absolute_expires_at" timestamptz NOT NULL,
  "rotated_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz,
  "revoked_reason" text,
  "rotated_from_id" uuid,
  "ip" text,
  "user_agent" text,
  CONSTRAINT "sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sessions_auth_method_check" CHECK ("auth_method" IN ('password', 'password+totp', 'oidc', 'saml', 'api_token')),
  CONSTRAINT "sessions_state_check" CHECK ("state" IN ('active', 'mfa_pending')),
  CONSTRAINT "sessions_token_hash_key" UNIQUE ("token_hash")
);

CREATE TABLE "api_tokens" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "name" text NOT NULL,
  "token_hash" text NOT NULL,
  "scopes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz,
  "last_used_at" timestamptz,
  "revoked_at" timestamptz,
  CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "api_tokens_token_hash_key" UNIQUE ("token_hash")
);

CREATE TABLE "sod_rules" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "kind" text NOT NULL,
  "params" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "severity" text NOT NULL DEFAULT 'block',
  "enabled" boolean NOT NULL DEFAULT true,
  "version" integer NOT NULL DEFAULT 1,
  "updated_by" uuid,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sod_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sod_rules_kind_check" CHECK ("kind" IN ('maker_checker', 'requester_limit', 'policy_author', 'vendor_master_payment', 'role_conflict')),
  CONSTRAINT "sod_rules_severity_check" CHECK ("severity" IN ('block', 'warn')),
  CONSTRAINT "sod_rules_tenant_id_code_key" UNIQUE ("tenant_id", "code")
);

CREATE TABLE "holidays" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "holiday_date" date NOT NULL,
  "name" text NOT NULL,
  CONSTRAINT "holidays_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "holidays_tenant_id_holiday_date_key" UNIQUE ("tenant_id", "holiday_date")
);

CREATE TABLE "idempotency_keys" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "scope" text NOT NULL,
  "key" text NOT NULL,
  "request_hash" text NOT NULL,
  "status_code" integer NOT NULL,
  "response" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "idempotency_keys_tenant_id_scope_key_key" UNIQUE ("tenant_id", "scope", "key"),
  CONSTRAINT "idem_status" CHECK (status_code BETWEEN 100 AND 599)
);

CREATE TABLE "audit_log" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "seq" bigint NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "actor_type" text NOT NULL,
  "actor_id" text,
  "actor_label" text NOT NULL,
  "action" text NOT NULL,
  "object_type" text NOT NULL,
  "object_id" text,
  "summary" text NOT NULL,
  "record" text NOT NULL,
  "prev_hash" text NOT NULL,
  "hash" text NOT NULL,
  "request_id" text,
  "ip" text,
  CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "audit_log_seq_check" CHECK ("seq" > 0),
  CONSTRAINT "audit_log_actor_type_check" CHECK ("actor_type" IN ('user', 'agent', 'system')),
  CONSTRAINT "audit_log_hash_key" UNIQUE ("hash"),
  CONSTRAINT "audit_log_tenant_id_seq_key" UNIQUE ("tenant_id", "seq"),
  CONSTRAINT "audit_hash_format" CHECK (hash ~ '^[0-9a-f]{64}$' AND prev_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "accounts" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "number" text NOT NULL,
  "name" text NOT NULL,
  "account_class" text NOT NULL,
  "subtype" text NOT NULL,
  "normal_balance" text NOT NULL,
  "parent_id" uuid,
  "is_postable" boolean NOT NULL DEFAULT true,
  "fs_line" text NOT NULL,
  "xbrl_element" text,
  "is_reconcilable" boolean NOT NULL DEFAULT false,
  "is_control_account" boolean NOT NULL DEFAULT false,
  "is_intercompany" boolean NOT NULL DEFAULT false,
  "is_monetary" boolean NOT NULL DEFAULT false,
  "requires_department" boolean NOT NULL DEFAULT false,
  "status" text NOT NULL DEFAULT 'active',
  "description" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "accounts_account_class_check" CHECK ("account_class" IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  CONSTRAINT "accounts_normal_balance_check" CHECK ("normal_balance" IN ('debit', 'credit')),
  CONSTRAINT "accounts_status_check" CHECK ("status" IN ('active', 'inactive')),
  CONSTRAINT "accounts_tenant_id_number_key" UNIQUE ("tenant_id", "number")
);

CREATE TABLE "departments" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "parent_id" uuid,
  "owner_user_id" uuid,
  "status" text NOT NULL DEFAULT 'active',
  CONSTRAINT "departments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "departments_status_check" CHECK ("status" IN ('active', 'inactive')),
  CONSTRAINT "departments_tenant_id_code_key" UNIQUE ("tenant_id", "code")
);

CREATE TABLE "locations" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "parent_id" uuid,
  "owner_user_id" uuid,
  "status" text NOT NULL DEFAULT 'active',
  CONSTRAINT "locations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "locations_status_check" CHECK ("status" IN ('active', 'inactive')),
  CONSTRAINT "locations_tenant_id_code_key" UNIQUE ("tenant_id", "code")
);

CREATE TABLE "classes" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "parent_id" uuid,
  "owner_user_id" uuid,
  "status" text NOT NULL DEFAULT 'active',
  CONSTRAINT "classes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "classes_status_check" CHECK ("status" IN ('active', 'inactive')),
  CONSTRAINT "classes_tenant_id_code_key" UNIQUE ("tenant_id", "code")
);

CREATE TABLE "projects" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "parent_id" uuid,
  "owner_user_id" uuid,
  "status" text NOT NULL DEFAULT 'active',
  CONSTRAINT "projects_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "projects_status_check" CHECK ("status" IN ('active', 'inactive')),
  CONSTRAINT "projects_tenant_id_code_key" UNIQUE ("tenant_id", "code")
);

CREATE TABLE "periods" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "fiscal_year" integer NOT NULL,
  "period_number" integer NOT NULL,
  "name" text NOT NULL,
  "start_date" date NOT NULL,
  "end_date" date NOT NULL,
  "status" text NOT NULL DEFAULT 'future',
  "soft_closed_at" timestamptz,
  "soft_closed_by" uuid,
  "locked_at" timestamptz,
  "locked_by" uuid,
  "reopened_count" integer NOT NULL DEFAULT 0,
  CONSTRAINT "periods_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "periods_period_number_check" CHECK ("period_number" BETWEEN 1 AND 13),
  CONSTRAINT "periods_status_check" CHECK ("status" IN ('future', 'open', 'soft_closed', 'locked')),
  CONSTRAINT "periods_entity_id_fiscal_year_period_number_key" UNIQUE ("entity_id", "fiscal_year", "period_number"),
  CONSTRAINT "period_dates" CHECK (end_date >= start_date),
  CONSTRAINT "period_lock_meta" CHECK (status <> 'locked' OR locked_at IS NOT NULL)
);

CREATE TABLE "fx_rates" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "base_currency" text NOT NULL,
  "quote_currency" text NOT NULL,
  "rate_date" date NOT NULL,
  "rate_type" text NOT NULL,
  "rate" numeric(18,8) NOT NULL,
  "source" text NOT NULL DEFAULT 'seed',
  CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fx_rates_base_currency_check" CHECK ("base_currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "fx_rates_quote_currency_check" CHECK ("quote_currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "fx_rates_rate_type_check" CHECK ("rate_type" IN ('spot', 'average', 'closing')),
  CONSTRAINT "fx_rates_rate_check" CHECK ("rate" > 0),
  CONSTRAINT "fx_rates_tenant_id_base_currency_quote_currency_rate_d_576b82a8" UNIQUE ("tenant_id", "base_currency", "quote_currency", "rate_date", "rate_type")
);

CREATE TABLE "journal_entries" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "period_id" uuid NOT NULL,
  "entry_number" text NOT NULL,
  "entry_date" date NOT NULL,
  "entry_type" text NOT NULL DEFAULT 'standard',
  "status" text NOT NULL DEFAULT 'draft',
  "description" text NOT NULL,
  "source" text NOT NULL DEFAULT 'manual',
  "source_module" text NOT NULL DEFAULT 'gl',
  "source_document_id" uuid,
  "import_batch_id" uuid,
  "source_locator" text,
  "external_ref" text,
  "external_prepared_by" text,
  "external_approved_by" text,
  "currency" text NOT NULL,
  "fx_rate" numeric(18,8) NOT NULL DEFAULT 1,
  "prepared_by" uuid,
  "prepared_by_run_id" uuid,
  "proposal_id" uuid,
  "approval_basis" text,
  "approved_by" uuid,
  "approved_at" timestamptz,
  "posted_at" timestamptz,
  "posted_by" uuid,
  "posted_by_run_id" uuid,
  "reverses_entry_id" uuid,
  "auto_reverse_date" date,
  "ic_reference" text,
  "counterparty_entity_id" uuid,
  "idempotency_key" text,
  "total_minor" bigint NOT NULL DEFAULT 0,
  "line_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "journal_entries_entry_type_check" CHECK ("entry_type" IN ('standard', 'adjusting', 'accrual', 'reversing', 'recurring', 'reclass', 'elimination', 'revaluation', 'depreciation', 'amortization', 'opening')),
  CONSTRAINT "journal_entries_status_check" CHECK ("status" IN ('draft', 'pending_approval', 'posted', 'rejected')),
  CONSTRAINT "journal_entries_source_check" CHECK ("source" IN ('manual', 'agent', 'subledger', 'import', 'system')),
  CONSTRAINT "journal_entries_source_module_check" CHECK ("source_module" IN ('gl', 'ap', 'ar', 'bank', 'card', 'fixed_assets', 'prepaid', 'payroll', 'intercompany', 'fx', 'revenue')),
  CONSTRAINT "journal_entries_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "journal_entries_approval_basis_check" CHECK ("approval_basis" IN ('human_approval', 'autonomy_policy', 'reversal_exemption', 'import', 'system')),
  CONSTRAINT "journal_entries_reverses_entry_id_key" UNIQUE ("reverses_entry_id"),
  CONSTRAINT "journal_entries_idempotency_key_key" UNIQUE ("idempotency_key"),
  CONSTRAINT "journal_entries_entity_id_entry_number_key" UNIQUE ("entity_id", "entry_number"),
  CONSTRAINT "je_maker_checker" CHECK (approval_basis IS DISTINCT FROM 'human_approval' OR (approved_by IS NOT NULL AND approved_by IS DISTINCT FROM prepared_by)),
  CONSTRAINT "je_posted_meta" CHECK (status <> 'posted' OR (posted_at IS NOT NULL AND approval_basis IS NOT NULL)),
  CONSTRAINT "je_auto_reverse_after" CHECK (auto_reverse_date IS NULL OR auto_reverse_date > entry_date),
  CONSTRAINT "je_not_self_reversal" CHECK (reverses_entry_id IS NULL OR reverses_entry_id <> id),
  CONSTRAINT "je_fx_rate" CHECK (fx_rate > 0)
);

CREATE TABLE "journal_lines" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "journal_entry_id" uuid NOT NULL,
  "line_number" integer NOT NULL,
  "entity_id" uuid NOT NULL,
  "period_id" uuid NOT NULL,
  "entry_date" date NOT NULL,
  "account_id" uuid NOT NULL,
  "debit_minor" bigint NOT NULL DEFAULT 0,
  "credit_minor" bigint NOT NULL DEFAULT 0,
  "txn_currency" text NOT NULL,
  "txn_amount_minor" bigint NOT NULL,
  "department_id" uuid,
  "location_id" uuid,
  "class_id" uuid,
  "project_id" uuid,
  "counterparty_entity_id" uuid,
  "vendor_id" uuid,
  "customer_id" uuid,
  "memo" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "journal_lines_debit_minor_check" CHECK ("debit_minor" >= 0),
  CONSTRAINT "journal_lines_credit_minor_check" CHECK ("credit_minor" >= 0),
  CONSTRAINT "journal_lines_txn_currency_check" CHECK ("txn_currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "journal_lines_journal_entry_id_line_number_key" UNIQUE ("journal_entry_id", "line_number"),
  CONSTRAINT "jl_one_sided" CHECK ((debit_minor > 0 AND credit_minor = 0) OR (credit_minor > 0 AND debit_minor = 0)),
  CONSTRAINT "jl_txn_sign" CHECK ((debit_minor > 0 AND txn_amount_minor >= 0) OR (credit_minor > 0 AND txn_amount_minor <= 0))
);

CREATE TABLE "recurring_templates" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "frequency" text NOT NULL DEFAULT 'monthly',
  "lines" jsonb NOT NULL,
  "auto_reverse" boolean NOT NULL DEFAULT false,
  "next_run_date" date NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "recurring_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recurring_templates_frequency_check" CHECK ("frequency" IN ('monthly', 'quarterly')),
  CONSTRAINT "recurring_templates_status_check" CHECK ("status" IN ('active', 'paused'))
);

CREATE TABLE "budgets" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "name" text NOT NULL,
  "fiscal_year" integer NOT NULL,
  "kind" text NOT NULL DEFAULT 'budget',
  "version" integer NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'draft',
  "created_by" uuid,
  "approved_by" uuid,
  "approved_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "budgets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "budgets_kind_check" CHECK ("kind" IN ('budget', 'forecast')),
  CONSTRAINT "budgets_status_check" CHECK ("status" IN ('draft', 'approved', 'superseded')),
  CONSTRAINT "budgets_entity_id_fiscal_year_kind_version_key" UNIQUE ("entity_id", "fiscal_year", "kind", "version")
);

CREATE TABLE "budget_lines" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "budget_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "department_id" uuid,
  "period_number" integer NOT NULL,
  "amount_minor" bigint NOT NULL,
  "driver" text,
  CONSTRAINT "budget_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "budget_lines_period_number_check" CHECK ("period_number" BETWEEN 1 AND 12),
  CONSTRAINT "budget_lines_budget_id_account_id_department_id_period_e25ef8c0" UNIQUE NULLS NOT DISTINCT ("budget_id", "account_id", "department_id", "period_number")
);

CREATE TABLE "materiality_settings" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "fiscal_year" integer NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "benchmark" text NOT NULL,
  "benchmark_minor" bigint NOT NULL,
  "overall_pct" numeric(8,6) NOT NULL,
  "overall_minor" bigint NOT NULL,
  "performance_pct" numeric(8,6) NOT NULL,
  "performance_minor" bigint NOT NULL,
  "trivial_pct" numeric(8,6) NOT NULL,
  "trivial_minor" bigint NOT NULL,
  "rationale" text NOT NULL,
  "set_by" uuid,
  "approved_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "materiality_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "materiality_settings_benchmark_check" CHECK ("benchmark" IN ('revenue', 'pretax_income', 'total_assets', 'total_expenses')),
  CONSTRAINT "materiality_settings_tenant_id_fiscal_year_version_key" UNIQUE ("tenant_id", "fiscal_year", "version"),
  CONSTRAINT "materiality_order" CHECK (trivial_minor <= performance_minor AND performance_minor <= overall_minor)
);

CREATE TABLE "vendors" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "legal_name" text,
  "category" text,
  "default_account_id" uuid,
  "default_department_id" uuid,
  "payment_terms_days" integer NOT NULL DEFAULT 30,
  "currency" text NOT NULL,
  "is_1099" boolean NOT NULL DEFAULT false,
  "status" text NOT NULL DEFAULT 'active',
  "tax_id_last4" text,
  "remit_bank_last4" text,
  "created_by" uuid,
  "updated_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "vendors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vendors_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "vendors_status_check" CHECK ("status" IN ('active', 'inactive', 'blocked')),
  CONSTRAINT "vendors_tenant_id_code_key" UNIQUE ("tenant_id", "code")
);

CREATE TABLE "purchase_orders" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "vendor_id" uuid NOT NULL,
  "po_number" text NOT NULL,
  "order_date" date NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "currency" text NOT NULL,
  "total_minor" bigint NOT NULL,
  "description" text NOT NULL,
  "requested_by" uuid,
  "approved_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "purchase_orders_status_check" CHECK ("status" IN ('open', 'partially_received', 'received', 'closed', 'cancelled')),
  CONSTRAINT "purchase_orders_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "purchase_orders_total_minor_check" CHECK ("total_minor" > 0),
  CONSTRAINT "purchase_orders_entity_id_po_number_key" UNIQUE ("entity_id", "po_number")
);

CREATE TABLE "purchase_order_lines" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "purchase_order_id" uuid NOT NULL,
  "line_number" integer NOT NULL,
  "description" text NOT NULL,
  "account_id" uuid NOT NULL,
  "department_id" uuid,
  "quantity" numeric(14,4) NOT NULL DEFAULT 1,
  "unit_price_minor" bigint NOT NULL,
  "amount_minor" bigint NOT NULL,
  "received_amount_minor" bigint NOT NULL DEFAULT 0,
  "billed_amount_minor" bigint NOT NULL DEFAULT 0,
  "service_start" date,
  "service_end" date,
  CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "purchase_order_lines_amount_minor_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "purchase_order_lines_purchase_order_id_line_number_key" UNIQUE ("purchase_order_id", "line_number")
);

CREATE TABLE "goods_receipts" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "purchase_order_id" uuid NOT NULL,
  "purchase_order_line_id" uuid NOT NULL,
  "receipt_date" date NOT NULL,
  "quantity" numeric(14,4) NOT NULL DEFAULT 1,
  "amount_minor" bigint NOT NULL,
  "received_by" uuid,
  "note" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "goods_receipts_amount_minor_check" CHECK ("amount_minor" > 0)
);

CREATE TABLE "bills" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "vendor_id" uuid NOT NULL,
  "bill_number" text NOT NULL,
  "bill_date" date NOT NULL,
  "received_date" date NOT NULL,
  "due_date" date NOT NULL,
  "currency" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "purchase_order_id" uuid,
  "service_start" date,
  "service_end" date,
  "description" text NOT NULL,
  "journal_entry_id" uuid,
  "source_document_id" uuid,
  "import_batch_id" uuid,
  "source_locator" text,
  "created_by" uuid,
  "approved_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "bills_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bills_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "bills_amount_minor_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "bills_status_check" CHECK ("status" IN ('draft', 'open', 'partially_paid', 'paid', 'void')),
  CONSTRAINT "bills_vendor_id_bill_number_key" UNIQUE ("vendor_id", "bill_number"),
  CONSTRAINT "bill_due_after" CHECK (due_date >= bill_date)
);

CREATE TABLE "bill_lines" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "bill_id" uuid NOT NULL,
  "line_number" integer NOT NULL,
  "account_id" uuid NOT NULL,
  "department_id" uuid,
  "location_id" uuid,
  "class_id" uuid,
  "project_id" uuid,
  "description" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "service_start" date,
  "service_end" date,
  CONSTRAINT "bill_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bill_lines_amount_minor_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "bill_lines_bill_id_line_number_key" UNIQUE ("bill_id", "line_number")
);

CREATE TABLE "vendor_payments" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "vendor_id" uuid NOT NULL,
  "bank_account_id" uuid NOT NULL,
  "payment_date" date NOT NULL,
  "method" text NOT NULL,
  "reference" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "status" text NOT NULL DEFAULT 'sent',
  "journal_entry_id" uuid,
  "created_by" uuid,
  "approved_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "vendor_payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vendor_payments_method_check" CHECK ("method" IN ('ach', 'wire', 'check', 'card')),
  CONSTRAINT "vendor_payments_amount_minor_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "vendor_payments_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "vendor_payments_status_check" CHECK ("status" IN ('scheduled', 'sent', 'cleared', 'void')),
  CONSTRAINT "payment_sod" CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM created_by)
);

CREATE TABLE "payment_applications" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "payment_id" uuid NOT NULL,
  "bill_id" uuid NOT NULL,
  "amount_minor" bigint NOT NULL,
  CONSTRAINT "payment_applications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_applications_amount_minor_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "payment_applications_payment_id_bill_id_key" UNIQUE ("payment_id", "bill_id")
);

CREATE TABLE "customers" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "segment" text,
  "currency" text NOT NULL,
  "payment_terms_days" integer NOT NULL DEFAULT 30,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "customers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customers_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "customers_status_check" CHECK ("status" IN ('active', 'inactive')),
  CONSTRAINT "customers_tenant_id_code_key" UNIQUE ("tenant_id", "code")
);

CREATE TABLE "invoices" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL,
  "invoice_number" text NOT NULL,
  "invoice_date" date NOT NULL,
  "due_date" date NOT NULL,
  "currency" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "service_start" date,
  "service_end" date,
  "description" text NOT NULL,
  "journal_entry_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "invoices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "invoices_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "invoices_amount_minor_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "invoices_status_check" CHECK ("status" IN ('open', 'partially_paid', 'paid', 'void', 'written_off')),
  CONSTRAINT "invoices_entity_id_invoice_number_key" UNIQUE ("entity_id", "invoice_number")
);

CREATE TABLE "invoice_lines" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "invoice_id" uuid NOT NULL,
  "line_number" integer NOT NULL,
  "description" text NOT NULL,
  "revenue_account_id" uuid NOT NULL,
  "class_id" uuid,
  "amount_minor" bigint NOT NULL,
  "service_start" date,
  "service_end" date,
  "deferred" boolean NOT NULL DEFAULT false,
  CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "invoice_lines_amount_minor_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "invoice_lines_invoice_id_line_number_key" UNIQUE ("invoice_id", "line_number")
);

CREATE TABLE "customer_receipts" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL,
  "bank_account_id" uuid NOT NULL,
  "receipt_date" date NOT NULL,
  "method" text NOT NULL,
  "reference" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "status" text NOT NULL DEFAULT 'applied',
  "journal_entry_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "customer_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_receipts_method_check" CHECK ("method" IN ('ach', 'wire', 'check', 'card')),
  CONSTRAINT "customer_receipts_amount_minor_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "customer_receipts_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "customer_receipts_status_check" CHECK ("status" IN ('received', 'applied', 'void'))
);

CREATE TABLE "receipt_applications" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "receipt_id" uuid NOT NULL,
  "invoice_id" uuid NOT NULL,
  "amount_minor" bigint NOT NULL,
  CONSTRAINT "receipt_applications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "receipt_applications_amount_minor_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "receipt_applications_receipt_id_invoice_id_key" UNIQUE ("receipt_id", "invoice_id")
);

CREATE TABLE "bank_accounts" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "name" text NOT NULL,
  "institution" text NOT NULL,
  "account_last4" text NOT NULL,
  "currency" text NOT NULL,
  "gl_account_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bank_accounts_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "bank_accounts_status_check" CHECK ("status" IN ('active', 'closed')),
  CONSTRAINT "bank_accounts_entity_id_name_key" UNIQUE ("entity_id", "name")
);

CREATE TABLE "bank_statements" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "bank_account_id" uuid NOT NULL,
  "statement_date" date NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "opening_balance_minor" bigint NOT NULL,
  "closing_balance_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "source_document_id" uuid,
  "import_batch_id" uuid,
  "source_locator" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "bank_statements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bank_statements_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "bank_statements_bank_account_id_period_start_period_end_key" UNIQUE ("bank_account_id", "period_start", "period_end")
);

CREATE TABLE "bank_transactions" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "bank_account_id" uuid NOT NULL,
  "statement_id" uuid,
  "booking_date" date NOT NULL,
  "value_date" date,
  "amount_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "description" text NOT NULL,
  "counterparty" text,
  "reference" text,
  "bank_reference" text NOT NULL,
  "type_code" text,
  "status" text NOT NULL DEFAULT 'unmatched',
  "dedupe_key" text NOT NULL,
  "source_document_id" uuid,
  "import_batch_id" uuid,
  "source_locator" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "bank_transactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bank_transactions_amount_minor_check" CHECK ("amount_minor" <> 0),
  CONSTRAINT "bank_transactions_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "bank_transactions_status_check" CHECK ("status" IN ('unmatched', 'matched', 'excluded')),
  CONSTRAINT "bank_transactions_bank_account_id_dedupe_key_key" UNIQUE ("bank_account_id", "dedupe_key")
);

CREATE TABLE "cards" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "cardholder_name" text NOT NULL,
  "cardholder_user_id" uuid,
  "last4" text NOT NULL,
  "department_id" uuid,
  "liability_account_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "cards_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cards_status_check" CHECK ("status" IN ('active', 'frozen', 'closed'))
);

CREATE TABLE "card_transactions" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "card_id" uuid NOT NULL,
  "transaction_date" date NOT NULL,
  "posted_date" date NOT NULL,
  "merchant_name" text NOT NULL,
  "mcc" text,
  "amount_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "memo" text,
  "receipt_document_id" uuid,
  "status" text NOT NULL DEFAULT 'pending',
  "coded_account_id" uuid,
  "coded_department_id" uuid,
  "coding_source" text,
  "coding_confidence" numeric(4,3),
  "journal_entry_id" uuid,
  "external_id" text NOT NULL,
  "import_batch_id" uuid,
  "source_locator" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "card_transactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "card_transactions_amount_minor_check" CHECK ("amount_minor" <> 0),
  CONSTRAINT "card_transactions_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "card_transactions_status_check" CHECK ("status" IN ('pending', 'coded', 'posted', 'excluded')),
  CONSTRAINT "card_transactions_coding_source_check" CHECK ("coding_source" IN ('rule', 'agent', 'human', 'history')),
  CONSTRAINT "card_transactions_card_id_external_id_key" UNIQUE ("card_id", "external_id")
);

CREATE TABLE "fixed_assets" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "asset_number" text NOT NULL,
  "description" text NOT NULL,
  "asset_class" text NOT NULL,
  "acquisition_date" date NOT NULL,
  "in_service_date" date NOT NULL,
  "cost_minor" bigint NOT NULL,
  "salvage_minor" bigint NOT NULL DEFAULT 0,
  "useful_life_months" integer NOT NULL,
  "method" text NOT NULL DEFAULT 'straight_line',
  "asset_account_id" uuid NOT NULL,
  "accumulated_depreciation_account_id" uuid NOT NULL,
  "depreciation_expense_account_id" uuid NOT NULL,
  "department_id" uuid,
  "location_id" uuid,
  "vendor_id" uuid,
  "bill_id" uuid,
  "status" text NOT NULL DEFAULT 'active',
  "disposal_date" date,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "fixed_assets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fixed_assets_asset_class_check" CHECK ("asset_class" IN ('computer_equipment', 'furniture_fixtures', 'leasehold_improvements', 'machinery', 'software', 'vehicles')),
  CONSTRAINT "fixed_assets_cost_minor_check" CHECK ("cost_minor" > 0),
  CONSTRAINT "fixed_assets_useful_life_months_check" CHECK ("useful_life_months" > 0),
  CONSTRAINT "fixed_assets_method_check" CHECK ("method" IN ('straight_line')),
  CONSTRAINT "fixed_assets_status_check" CHECK ("status" IN ('active', 'disposed', 'fully_depreciated')),
  CONSTRAINT "fixed_assets_entity_id_asset_number_key" UNIQUE ("entity_id", "asset_number"),
  CONSTRAINT "fa_salvage" CHECK (salvage_minor >= 0 AND salvage_minor < cost_minor),
  CONSTRAINT "fa_dates" CHECK (in_service_date >= acquisition_date)
);

CREATE TABLE "depreciation_lines" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "fixed_asset_id" uuid NOT NULL,
  "period_id" uuid NOT NULL,
  "fiscal_year" integer NOT NULL,
  "period_number" integer NOT NULL,
  "amount_minor" bigint NOT NULL,
  "accumulated_minor" bigint NOT NULL,
  "net_book_value_minor" bigint NOT NULL,
  "status" text NOT NULL DEFAULT 'scheduled',
  "journal_entry_id" uuid,
  CONSTRAINT "depreciation_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "depreciation_lines_amount_minor_check" CHECK ("amount_minor" >= 0),
  CONSTRAINT "depreciation_lines_status_check" CHECK ("status" IN ('scheduled', 'posted', 'skipped')),
  CONSTRAINT "depreciation_lines_fixed_asset_id_period_id_key" UNIQUE ("fixed_asset_id", "period_id")
);

CREATE TABLE "amortization_schedules" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "description" text NOT NULL,
  "vendor_id" uuid,
  "customer_id" uuid,
  "bill_id" uuid,
  "invoice_id" uuid,
  "balance_account_id" uuid NOT NULL,
  "pl_account_id" uuid NOT NULL,
  "department_id" uuid,
  "total_minor" bigint NOT NULL,
  "start_date" date NOT NULL,
  "end_date" date NOT NULL,
  "months" integer NOT NULL,
  "method" text NOT NULL DEFAULT 'straight_line_monthly',
  "status" text NOT NULL DEFAULT 'active',
  "created_by" uuid,
  "created_by_run_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "amortization_schedules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "amortization_schedules_kind_check" CHECK ("kind" IN ('prepaid_expense', 'deferred_revenue')),
  CONSTRAINT "amortization_schedules_total_minor_check" CHECK ("total_minor" > 0),
  CONSTRAINT "amortization_schedules_months_check" CHECK ("months" > 0),
  CONSTRAINT "amortization_schedules_method_check" CHECK ("method" IN ('straight_line_monthly')),
  CONSTRAINT "amortization_schedules_status_check" CHECK ("status" IN ('active', 'completed', 'cancelled')),
  CONSTRAINT "amort_dates" CHECK (end_date >= start_date)
);

CREATE TABLE "amortization_lines" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "schedule_id" uuid NOT NULL,
  "period_id" uuid NOT NULL,
  "period_end" date NOT NULL,
  "amount_minor" bigint NOT NULL,
  "status" text NOT NULL DEFAULT 'scheduled',
  "journal_entry_id" uuid,
  CONSTRAINT "amortization_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "amortization_lines_amount_minor_check" CHECK ("amount_minor" >= 0),
  CONSTRAINT "amortization_lines_status_check" CHECK ("status" IN ('scheduled', 'posted', 'skipped')),
  CONSTRAINT "amortization_lines_schedule_id_period_id_key" UNIQUE ("schedule_id", "period_id")
);

CREATE TABLE "payroll_runs" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "external_id" text NOT NULL,
  "pay_period_start" date NOT NULL,
  "pay_period_end" date NOT NULL,
  "pay_date" date NOT NULL,
  "currency" text NOT NULL,
  "gross_minor" bigint NOT NULL,
  "employer_tax_minor" bigint NOT NULL,
  "benefits_minor" bigint NOT NULL,
  "withholding_minor" bigint NOT NULL,
  "net_pay_minor" bigint NOT NULL,
  "headcount" integer NOT NULL,
  "journal_entry_id" uuid,
  "source_document_id" uuid,
  "import_batch_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payroll_runs_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "payroll_runs_entity_id_provider_external_id_key" UNIQUE ("entity_id", "provider", "external_id"),
  CONSTRAINT "payroll_net" CHECK (net_pay_minor = gross_minor - withholding_minor)
);

CREATE TABLE "payroll_lines" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "payroll_run_id" uuid NOT NULL,
  "department_id" uuid,
  "category" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  CONSTRAINT "payroll_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payroll_lines_category_check" CHECK ("category" IN ('wages', 'bonus', 'commission', 'employer_tax', 'benefits'))
);

CREATE TABLE "connectors" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "adapter" text NOT NULL,
  "name" text NOT NULL,
  "entity_id" uuid,
  "bank_account_id" uuid,
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'active',
  "last_sync_at" timestamptz,
  "last_sync_status" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "connectors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "connectors_kind_check" CHECK ("kind" IN ('bank_feed', 'erp_gl', 'card_feed', 'ap', 'ar', 'payroll')),
  CONSTRAINT "connectors_status_check" CHECK ("status" IN ('active', 'paused', 'error'))
);

CREATE TABLE "source_documents" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "filename" text NOT NULL,
  "media_type" text NOT NULL,
  "sha256" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "content" bytea,
  "text_content" text,
  "storage_key" text,
  "connector_id" uuid,
  "uploaded_by" uuid,
  "uploaded_at" timestamptz NOT NULL DEFAULT now(),
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT "source_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "source_documents_kind_check" CHECK ("kind" IN ('bank_statement', 'card_feed', 'erp_export', 'ap_export', 'ar_export', 'payroll_report', 'invoice', 'receipt', 'contract', 'evidence', 'close_package', 'other')),
  CONSTRAINT "source_documents_size_bytes_check" CHECK ("size_bytes" >= 0),
  CONSTRAINT "source_documents_tenant_id_sha256_key" UNIQUE ("tenant_id", "sha256"),
  CONSTRAINT "doc_sha" CHECK (sha256 ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "import_batches" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "connector_id" uuid,
  "source_document_id" uuid NOT NULL,
  "format" text NOT NULL,
  "target" text NOT NULL,
  "status" text NOT NULL DEFAULT 'running',
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  "records_total" integer NOT NULL DEFAULT 0,
  "records_created" integer NOT NULL DEFAULT 0,
  "records_duplicate" integer NOT NULL DEFAULT 0,
  "records_failed" integer NOT NULL DEFAULT 0,
  "errors" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "imported_by" uuid,
  "idempotency_key" text NOT NULL,
  CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "import_batches_format_check" CHECK ("format" IN ('csv', 'bai2', 'camt053', 'ofx', 'json')),
  CONSTRAINT "import_batches_status_check" CHECK ("status" IN ('running', 'completed', 'partial', 'failed')),
  CONSTRAINT "import_batches_idempotency_key_key" UNIQUE ("idempotency_key")
);

CREATE TABLE "attachments" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "object_type" text NOT NULL,
  "object_id" uuid NOT NULL,
  "source_document_id" uuid NOT NULL,
  "note" text,
  "attached_by" uuid,
  "attached_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "comments" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "object_type" text NOT NULL,
  "object_id" uuid NOT NULL,
  "author_id" uuid NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "comments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "comments_body_check" CHECK ("body" <> ''),
  CONSTRAINT "comment_len" CHECK (char_length(body) <= 4000)
);

CREATE TABLE "closes" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "fiscal_year" integer NOT NULL,
  "period_number" integer NOT NULL,
  "name" text NOT NULL,
  "period_end" date NOT NULL,
  "target_workday" integer NOT NULL DEFAULT 5,
  "status" text NOT NULL DEFAULT 'planned',
  "started_at" timestamptz,
  "closed_at" timestamptz,
  "closed_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "closes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "closes_status_check" CHECK ("status" IN ('planned', 'in_progress', 'in_review', 'closed')),
  CONSTRAINT "closes_tenant_id_fiscal_year_period_number_key" UNIQUE ("tenant_id", "fiscal_year", "period_number")
);

CREATE TABLE "checklist_templates" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "name" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "checklist_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "checklist_templates_status_check" CHECK ("status" IN ('active', 'retired')),
  CONSTRAINT "checklist_templates_tenant_id_name_version_key" UNIQUE ("tenant_id", "name", "version")
);

CREATE TABLE "checklist_template_tasks" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "template_id" uuid NOT NULL,
  "key" text NOT NULL,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "category" text NOT NULL,
  "workday" integer NOT NULL,
  "scope" text NOT NULL,
  "owner_role" text NOT NULL,
  "reviewer_role" text,
  "skill_key" text,
  "depends_on" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "evidence_required" boolean NOT NULL DEFAULT false,
  "sort_order" integer NOT NULL DEFAULT 0,
  CONSTRAINT "checklist_template_tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "checklist_template_tasks_category_check" CHECK ("category" IN ('cash', 'cards', 'ap', 'ar', 'accruals', 'prepaids', 'fixed_assets', 'payroll', 'intercompany', 'fx', 'review', 'reporting', 'lock')),
  CONSTRAINT "checklist_template_tasks_workday_check" CHECK ("workday" <> 0),
  CONSTRAINT "checklist_template_tasks_scope_check" CHECK ("scope" IN ('each_entity', 'parent', 'consolidated')),
  CONSTRAINT "checklist_template_tasks_template_id_key_key" UNIQUE ("template_id", "key")
);

CREATE TABLE "close_tasks" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "close_id" uuid NOT NULL,
  "key" text NOT NULL,
  "entity_id" uuid,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "category" text NOT NULL,
  "due_workday" integer NOT NULL,
  "due_date" date NOT NULL,
  "owner_id" uuid,
  "reviewer_id" uuid,
  "status" text NOT NULL DEFAULT 'not_started',
  "skill_key" text,
  "last_run_id" uuid,
  "blocked_reason" text,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "completed_by" uuid,
  "completed_by_run_id" uuid,
  "reviewed_at" timestamptz,
  "reviewed_by" uuid,
  "evidence_required" boolean NOT NULL DEFAULT false,
  "sort_order" integer NOT NULL DEFAULT 0,
  CONSTRAINT "close_tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "close_tasks_category_check" CHECK ("category" IN ('cash', 'cards', 'ap', 'ar', 'accruals', 'prepaids', 'fixed_assets', 'payroll', 'intercompany', 'fx', 'review', 'reporting', 'lock')),
  CONSTRAINT "close_tasks_status_check" CHECK ("status" IN ('not_started', 'in_progress', 'blocked', 'ready_for_review', 'done', 'skipped')),
  CONSTRAINT "close_tasks_close_id_key_entity_id_key" UNIQUE NULLS NOT DISTINCT ("close_id", "key", "entity_id"),
  CONSTRAINT "task_review_sod" CHECK (reviewed_by IS NULL OR reviewed_by IS DISTINCT FROM completed_by)
);

CREATE TABLE "close_task_dependencies" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "depends_on_task_id" uuid NOT NULL,
  CONSTRAINT "close_task_dependencies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "close_task_dependencies_task_id_depends_on_task_id_key" UNIQUE ("task_id", "depends_on_task_id"),
  CONSTRAINT "dep_not_self" CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE "signoffs" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "object_type" text NOT NULL,
  "object_id" uuid NOT NULL,
  "role" text NOT NULL,
  "action" text NOT NULL DEFAULT 'sign',
  "user_id" uuid NOT NULL,
  "signed_at" timestamptz NOT NULL DEFAULT now(),
  "comment" text,
  "evidence_hash" text,
  CONSTRAINT "signoffs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "signoffs_object_type_check" CHECK ("object_type" IN ('close_task', 'reconciliation', 'flux_analysis', 'flux_line', 'close_package', 'period')),
  CONSTRAINT "signoffs_role_check" CHECK ("role" IN ('preparer', 'reviewer', 'approver')),
  CONSTRAINT "signoffs_action_check" CHECK ("action" IN ('sign', 'revoke'))
);

CREATE TABLE "close_packages" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "close_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "generated_at" timestamptz NOT NULL DEFAULT now(),
  "generated_by" uuid,
  "generated_by_run_id" uuid,
  "content" jsonb NOT NULL,
  "content_hash" text NOT NULL,
  "source_document_id" uuid,
  "approved_by" uuid,
  "approved_at" timestamptz,
  CONSTRAINT "close_packages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "close_packages_status_check" CHECK ("status" IN ('draft', 'final')),
  CONSTRAINT "close_packages_close_id_version_key" UNIQUE ("close_id", "version"),
  CONSTRAINT "pkg_sod" CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM generated_by)
);

CREATE TABLE "reconciliations" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "period_id" uuid NOT NULL,
  "close_task_id" uuid,
  "rec_type" text NOT NULL,
  "account_id" uuid NOT NULL,
  "bank_account_id" uuid,
  "counterparty_entity_id" uuid,
  "currency" text NOT NULL,
  "gl_balance_minor" bigint NOT NULL DEFAULT 0,
  "external_balance_minor" bigint NOT NULL DEFAULT 0,
  "reconciling_total_minor" bigint NOT NULL DEFAULT 0,
  "difference_minor" bigint NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'not_started',
  "risk" text NOT NULL DEFAULT 'medium',
  "prepared_by" uuid,
  "prepared_at" timestamptz,
  "reviewed_by" uuid,
  "reviewed_at" timestamptz,
  "last_run_id" uuid,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "reconciliations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reconciliations_rec_type_check" CHECK ("rec_type" IN ('bank', 'credit_card', 'subledger_ap', 'subledger_ar', 'intercompany', 'prepaid', 'fixed_assets', 'accrued_liabilities', 'payroll_liabilities', 'deferred_revenue', 'balance_sheet')),
  CONSTRAINT "reconciliations_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "reconciliations_status_check" CHECK ("status" IN ('not_started', 'in_progress', 'prepared', 'reviewed', 'reopened')),
  CONSTRAINT "reconciliations_risk_check" CHECK ("risk" IN ('low', 'medium', 'high')),
  CONSTRAINT "reconciliations_period_id_account_id_rec_type_bank_acc_b0a4a96a" UNIQUE NULLS NOT DISTINCT ("period_id", "account_id", "rec_type", "bank_account_id", "counterparty_entity_id"),
  CONSTRAINT "rec_certify_sod" CHECK (reviewed_by IS NULL OR reviewed_by IS DISTINCT FROM prepared_by),
  CONSTRAINT "rec_reviewed_meta" CHECK (status <> 'reviewed' OR (reviewed_by IS NOT NULL AND prepared_by IS NOT NULL))
);

CREATE TABLE "rec_matches" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "reconciliation_id" uuid NOT NULL,
  "match_type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'proposed',
  "confidence" numeric(4,3) NOT NULL,
  "rule" text NOT NULL,
  "explanation" text NOT NULL,
  "proposal_id" uuid,
  "accepted_by" uuid,
  "accepted_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "rec_matches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "rec_matches_match_type_check" CHECK ("match_type" IN ('exact', 'fuzzy', 'one_to_many', 'many_to_one', 'many_to_many', 'manual')),
  CONSTRAINT "rec_matches_status_check" CHECK ("status" IN ('proposed', 'accepted', 'rejected')),
  CONSTRAINT "rec_matches_confidence_check" CHECK ("confidence" BETWEEN 0 AND 1)
);

CREATE TABLE "rec_match_items" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "match_id" uuid NOT NULL,
  "side" text NOT NULL,
  "bank_transaction_id" uuid,
  "journal_line_id" uuid,
  "amount_minor" bigint NOT NULL,
  CONSTRAINT "rec_match_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "rec_match_items_side_check" CHECK ("side" IN ('external', 'ledger')),
  CONSTRAINT "match_item_one_ref" CHECK (num_nonnulls(bank_transaction_id, journal_line_id) = 1)
);

CREATE TABLE "reconciling_items" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "reconciliation_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "description" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "item_date" date NOT NULL,
  "expected_clear_date" date,
  "cleared_date" date,
  "status" text NOT NULL DEFAULT 'open',
  "bank_transaction_id" uuid,
  "journal_line_id" uuid,
  "resolution_entry_id" uuid,
  "proposal_id" uuid,
  "created_by" uuid,
  "created_by_run_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "reconciling_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reconciling_items_kind_check" CHECK ("kind" IN ('deposit_in_transit', 'outstanding_check', 'bank_fee', 'interest', 'bank_error', 'book_error', 'timing_difference', 'unrecorded_transaction', 'fx_difference', 'unexplained')),
  CONSTRAINT "reconciling_items_status_check" CHECK ("status" IN ('open', 'resolved', 'written_off'))
);

CREATE TABLE "flux_analyses" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "close_id" uuid NOT NULL,
  "entity_id" uuid,
  "comparison" text NOT NULL,
  "threshold_pct" numeric(8,6) NOT NULL,
  "threshold_minor" bigint NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "generated_by_run_id" uuid,
  "prepared_by" uuid,
  "approved_by" uuid,
  "approved_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "flux_analyses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "flux_analyses_comparison_check" CHECK ("comparison" IN ('prior_month', 'prior_year', 'budget')),
  CONSTRAINT "flux_analyses_status_check" CHECK ("status" IN ('draft', 'in_review', 'approved')),
  CONSTRAINT "flux_sod" CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM prepared_by)
);

CREATE TABLE "flux_lines" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "analysis_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "fs_line" text NOT NULL,
  "current_minor" bigint NOT NULL,
  "comparison_minor" bigint NOT NULL,
  "variance_minor" bigint NOT NULL,
  "variance_pct" numeric(12,6),
  "is_material" boolean NOT NULL DEFAULT false,
  "drivers" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "explanation" text,
  "explanation_status" text NOT NULL DEFAULT 'not_required',
  "explained_by" uuid,
  "explained_by_run_id" uuid,
  "confidence" numeric(4,3),
  "proposal_id" uuid,
  "reviewed_by" uuid,
  "reviewed_at" timestamptz,
  CONSTRAINT "flux_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "flux_lines_explanation_status_check" CHECK ("explanation_status" IN ('not_required', 'missing', 'drafted', 'accepted', 'rejected')),
  CONSTRAINT "flux_lines_analysis_id_account_id_key" UNIQUE ("analysis_id", "account_id"),
  CONSTRAINT "flux_line_math" CHECK (variance_minor = current_minor - comparison_minor)
);

CREATE TABLE "skills" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "key" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "category" text NOT NULL,
  "domain" text NOT NULL DEFAULT 'accounting',
  "current_version" text NOT NULL,
  "status" text NOT NULL DEFAULT 'enabled',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "skills_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "skills_status_check" CHECK ("status" IN ('enabled', 'disabled')),
  CONSTRAINT "skills_key_key" UNIQUE ("key")
);

CREATE TABLE "skill_versions" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "skill_id" uuid NOT NULL,
  "version" text NOT NULL,
  "manifest" jsonb NOT NULL,
  "instructions" text NOT NULL,
  "resources" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "content_hash" text NOT NULL,
  "published_at" timestamptz NOT NULL DEFAULT now(),
  "published_by" text NOT NULL DEFAULT 'system',
  "eval_summary" jsonb,
  CONSTRAINT "skill_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "skill_versions_skill_id_version_key" UNIQUE ("skill_id", "version")
);

CREATE TABLE "skill_policies" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "skill_key" text NOT NULL,
  "entity_id" uuid,
  "version" integer NOT NULL,
  "autonomy_level" text NOT NULL,
  "thresholds" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "rules_text" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "rules" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "change_reason" text NOT NULL,
  "created_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "supersedes_id" uuid,
  CONSTRAINT "skill_policies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "skill_policies_autonomy_level_check" CHECK ("autonomy_level" IN ('L0', 'L1', 'L2', 'L3')),
  CONSTRAINT "skill_policies_tenant_id_skill_key_entity_id_version_key" UNIQUE NULLS NOT DISTINCT ("tenant_id", "skill_key", "entity_id", "version")
);

CREATE TABLE "agent_runs" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "skill_key" text NOT NULL,
  "skill_version" text NOT NULL,
  "policy_id" uuid,
  "ontology_version" text NOT NULL,
  "close_id" uuid,
  "close_task_id" uuid,
  "entity_id" uuid,
  "period_id" uuid,
  "parent_run_id" uuid,
  "status" text NOT NULL DEFAULT 'queued',
  "phase" text NOT NULL DEFAULT 'plan',
  "mode" text NOT NULL,
  "provider" text NOT NULL,
  "model" text,
  "requested_by" uuid,
  "requested_by_label" text NOT NULL,
  "trigger" text NOT NULL DEFAULT 'manual',
  "input" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "plan" jsonb,
  "summary" text,
  "error" text,
  "budget" jsonb NOT NULL,
  "steps_used" integer NOT NULL DEFAULT 0,
  "tool_calls_used" integer NOT NULL DEFAULT 0,
  "tokens_in" integer NOT NULL DEFAULT 0,
  "tokens_out" integer NOT NULL DEFAULT 0,
  "cache_read_tokens" integer NOT NULL DEFAULT 0,
  "cost_usd_micros" bigint NOT NULL DEFAULT 0,
  "proposals_count" integer NOT NULL DEFAULT 0,
  "idempotency_key" text NOT NULL,
  "heartbeat_at" timestamptz,
  "resume_count" integer NOT NULL DEFAULT 0,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_runs_status_check" CHECK ("status" IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'budget_exceeded')),
  CONSTRAINT "agent_runs_phase_check" CHECK ("phase" IN ('plan', 'act', 'verify', 'propose', 'done')),
  CONSTRAINT "agent_runs_mode_check" CHECK ("mode" IN ('offline', 'live', 'replay')),
  CONSTRAINT "agent_runs_trigger_check" CHECK ("trigger" IN ('manual', 'orchestrator', 'schedule', 'api', 'mcp')),
  CONSTRAINT "agent_runs_idempotency_key_key" UNIQUE ("idempotency_key")
);

CREATE TABLE "agent_steps" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "seq" integer NOT NULL,
  "phase" text NOT NULL,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "detail" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "tokens_in" integer NOT NULL DEFAULT 0,
  "tokens_out" integer NOT NULL DEFAULT 0,
  "cost_usd_micros" bigint NOT NULL DEFAULT 0,
  "duration_ms" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_steps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_steps_phase_check" CHECK ("phase" IN ('plan', 'act', 'observe', 'verify', 'propose', 'post', 'audit')),
  CONSTRAINT "agent_steps_kind_check" CHECK ("kind" IN ('plan', 'tool_call', 'observation', 'verification', 'proposal', 'message', 'error', 'decision')),
  CONSTRAINT "agent_steps_run_id_seq_key" UNIQUE ("run_id", "seq")
);

CREATE TABLE "agent_tool_calls" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "step_id" uuid,
  "tool_name" text NOT NULL,
  "input" jsonb NOT NULL,
  "output" jsonb,
  "status" text NOT NULL,
  "is_mutation" boolean NOT NULL DEFAULT false,
  "idempotency_key" text NOT NULL,
  "error" text,
  "duration_ms" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_tool_calls_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_tool_calls_status_check" CHECK ("status" IN ('ok', 'error', 'denied')),
  CONSTRAINT "agent_tool_calls_idempotency_key_key" UNIQUE ("idempotency_key")
);

CREATE TABLE "proposals" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "run_id" uuid,
  "skill_key" text,
  "kind" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "disposition" text NOT NULL,
  "title" text NOT NULL,
  "why" text NOT NULL,
  "confidence" numeric(4,3) NOT NULL,
  "amount_minor" bigint NOT NULL DEFAULT 0,
  "currency" text NOT NULL,
  "entity_id" uuid,
  "period_id" uuid,
  "close_task_id" uuid,
  "payload" jsonb NOT NULL,
  "evidence" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "verification" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "risk_flags" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "autonomy_level" text NOT NULL,
  "policy_id" uuid,
  "required_permission" text NOT NULL,
  "maker_type" text NOT NULL,
  "maker_user_id" uuid,
  "requested_by" uuid,
  "decided_by" uuid,
  "decided_at" timestamptz,
  "decision_reason" text,
  "effect" jsonb,
  "posted_entry_id" uuid,
  "sampled_for_review" boolean NOT NULL DEFAULT false,
  "post_hoc_status" text NOT NULL DEFAULT 'not_required',
  "post_hoc_reviewed_by" uuid,
  "post_hoc_reviewed_at" timestamptz,
  "idempotency_key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "proposals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "proposals_kind_check" CHECK ("kind" IN ('journal_entry', 'rec_match', 'reconciling_item', 'transaction_coding', 'flux_explanation', 'anomaly', 'schedule', 'task_update')),
  CONSTRAINT "proposals_status_check" CHECK ("status" IN ('pending', 'suggested', 'blocked', 'approved', 'auto_applied', 'rejected', 'failed', 'superseded')),
  CONSTRAINT "proposals_disposition_check" CHECK ("disposition" IN ('suggestion', 'needs_approval', 'auto_apply', 'blocked')),
  CONSTRAINT "proposals_confidence_check" CHECK ("confidence" BETWEEN 0 AND 1),
  CONSTRAINT "proposals_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "proposals_autonomy_level_check" CHECK ("autonomy_level" IN ('L0', 'L1', 'L2', 'L3')),
  CONSTRAINT "proposals_maker_type_check" CHECK ("maker_type" IN ('agent', 'user')),
  CONSTRAINT "proposals_post_hoc_status_check" CHECK ("post_hoc_status" IN ('not_required', 'pending', 'confirmed', 'reversed')),
  CONSTRAINT "proposals_idempotency_key_key" UNIQUE ("idempotency_key"),
  CONSTRAINT "proposal_maker_checker" CHECK (decided_by IS NULL OR decided_by IS DISTINCT FROM maker_user_id)
);

CREATE TABLE "approvals" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "proposal_id" uuid NOT NULL,
  "decision" text NOT NULL,
  "user_id" uuid NOT NULL,
  "role_key" text NOT NULL,
  "reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "approvals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "approvals_decision_check" CHECK ("decision" IN ('approve', 'reject', 'adopt', 'post_hoc_confirm', 'post_hoc_reverse'))
);

CREATE TABLE "ontology_versions" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "version" text NOT NULL,
  "content_hash" text NOT NULL,
  "class_count" integer NOT NULL,
  "axiom_count" integer NOT NULL,
  "published_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ontology_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ontology_versions_version_key" UNIQUE ("version")
);

-- Foreign keys (added after all tables exist; circular references are allowed)
ALTER TABLE "entities" ADD CONSTRAINT "entities_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "entities" ADD CONSTRAINT "entities_parent_entity_id_fkey" FOREIGN KEY ("parent_entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE;
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles" ("id") ON DELETE RESTRICT;
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_rotated_from_id_fkey" FOREIGN KEY ("rotated_from_id") REFERENCES "sessions" ("id") ON DELETE SET NULL;
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE;
ALTER TABLE "sod_rules" ADD CONSTRAINT "sod_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "sod_rules" ADD CONSTRAINT "sod_rules_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "accounts" ("id") ON DELETE RESTRICT;
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "departments" ADD CONSTRAINT "departments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "departments" ("id") ON DELETE RESTRICT;
ALTER TABLE "departments" ADD CONSTRAINT "departments_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "locations" ADD CONSTRAINT "locations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "locations" ADD CONSTRAINT "locations_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "locations" ("id") ON DELETE RESTRICT;
ALTER TABLE "locations" ADD CONSTRAINT "locations_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "classes" ADD CONSTRAINT "classes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "classes" ADD CONSTRAINT "classes_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "classes" ("id") ON DELETE RESTRICT;
ALTER TABLE "classes" ADD CONSTRAINT "classes_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "projects" ADD CONSTRAINT "projects_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "projects" ADD CONSTRAINT "projects_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "projects" ("id") ON DELETE RESTRICT;
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "periods" ADD CONSTRAINT "periods_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "periods" ADD CONSTRAINT "periods_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "periods" ADD CONSTRAINT "periods_soft_closed_by_fkey" FOREIGN KEY ("soft_closed_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "periods" ADD CONSTRAINT "periods_locked_by_fkey" FOREIGN KEY ("locked_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "periods" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_documents" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "import_batches" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_prepared_by_fkey" FOREIGN KEY ("prepared_by") REFERENCES "users" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_prepared_by_run_id_fkey" FOREIGN KEY ("prepared_by_run_id") REFERENCES "agent_runs" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposals" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_posted_by_fkey" FOREIGN KEY ("posted_by") REFERENCES "users" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_posted_by_run_id_fkey" FOREIGN KEY ("posted_by_run_id") REFERENCES "agent_runs" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reverses_entry_id_fkey" FOREIGN KEY ("reverses_entry_id") REFERENCES "journal_entries" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_counterparty_entity_id_fkey" FOREIGN KEY ("counterparty_entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries" ("id") ON DELETE CASCADE;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "periods" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_counterparty_entity_id_fkey" FOREIGN KEY ("counterparty_entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors" ("id") ON DELETE RESTRICT;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers" ("id") ON DELETE RESTRICT;
ALTER TABLE "recurring_templates" ADD CONSTRAINT "recurring_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "recurring_templates" ADD CONSTRAINT "recurring_templates_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "recurring_templates" ADD CONSTRAINT "recurring_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "budgets" ("id") ON DELETE CASCADE;
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE RESTRICT;
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT;
ALTER TABLE "materiality_settings" ADD CONSTRAINT "materiality_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "materiality_settings" ADD CONSTRAINT "materiality_settings_set_by_fkey" FOREIGN KEY ("set_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "materiality_settings" ADD CONSTRAINT "materiality_settings_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_default_account_id_fkey" FOREIGN KEY ("default_account_id") REFERENCES "accounts" ("id") ON DELETE RESTRICT;
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_default_department_id_fkey" FOREIGN KEY ("default_department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT;
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors" ("id") ON DELETE RESTRICT;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders" ("id") ON DELETE CASCADE;
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE RESTRICT;
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT;
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders" ("id") ON DELETE RESTRICT;
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_order_line_id_fkey" FOREIGN KEY ("purchase_order_line_id") REFERENCES "purchase_order_lines" ("id") ON DELETE RESTRICT;
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_received_by_fkey" FOREIGN KEY ("received_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "bills" ADD CONSTRAINT "bills_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "bills" ADD CONSTRAINT "bills_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "bills" ADD CONSTRAINT "bills_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors" ("id") ON DELETE RESTRICT;
ALTER TABLE "bills" ADD CONSTRAINT "bills_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders" ("id") ON DELETE RESTRICT;
ALTER TABLE "bills" ADD CONSTRAINT "bills_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries" ("id") ON DELETE RESTRICT;
ALTER TABLE "bills" ADD CONSTRAINT "bills_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_documents" ("id") ON DELETE RESTRICT;
ALTER TABLE "bills" ADD CONSTRAINT "bills_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "import_batches" ("id") ON DELETE RESTRICT;
ALTER TABLE "bills" ADD CONSTRAINT "bills_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "bills" ADD CONSTRAINT "bills_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills" ("id") ON DELETE CASCADE;
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE RESTRICT;
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT;
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations" ("id") ON DELETE RESTRICT;
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes" ("id") ON DELETE RESTRICT;
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects" ("id") ON DELETE RESTRICT;
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors" ("id") ON DELETE RESTRICT;
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts" ("id") ON DELETE RESTRICT;
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries" ("id") ON DELETE RESTRICT;
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "payment_applications" ADD CONSTRAINT "payment_applications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "payment_applications" ADD CONSTRAINT "payment_applications_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "vendor_payments" ("id") ON DELETE CASCADE;
ALTER TABLE "payment_applications" ADD CONSTRAINT "payment_applications_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills" ("id") ON DELETE RESTRICT;
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers" ("id") ON DELETE RESTRICT;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries" ("id") ON DELETE RESTRICT;
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices" ("id") ON DELETE CASCADE;
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_revenue_account_id_fkey" FOREIGN KEY ("revenue_account_id") REFERENCES "accounts" ("id") ON DELETE RESTRICT;
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes" ("id") ON DELETE RESTRICT;
ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers" ("id") ON DELETE RESTRICT;
ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts" ("id") ON DELETE RESTRICT;
ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries" ("id") ON DELETE RESTRICT;
ALTER TABLE "receipt_applications" ADD CONSTRAINT "receipt_applications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "receipt_applications" ADD CONSTRAINT "receipt_applications_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "customer_receipts" ("id") ON DELETE CASCADE;
ALTER TABLE "receipt_applications" ADD CONSTRAINT "receipt_applications_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices" ("id") ON DELETE RESTRICT;
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_gl_account_id_fkey" FOREIGN KEY ("gl_account_id") REFERENCES "accounts" ("id") ON DELETE RESTRICT;
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts" ("id") ON DELETE RESTRICT;
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_documents" ("id") ON DELETE RESTRICT;
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "import_batches" ("id") ON DELETE RESTRICT;
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts" ("id") ON DELETE RESTRICT;
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_statement_id_fkey" FOREIGN KEY ("statement_id") REFERENCES "bank_statements" ("id") ON DELETE RESTRICT;
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_documents" ("id") ON DELETE RESTRICT;
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "import_batches" ("id") ON DELETE RESTRICT;
ALTER TABLE "cards" ADD CONSTRAINT "cards_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "cards" ADD CONSTRAINT "cards_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "cards" ADD CONSTRAINT "cards_cardholder_user_id_fkey" FOREIGN KEY ("cardholder_user_id") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "cards" ADD CONSTRAINT "cards_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT;
ALTER TABLE "cards" ADD CONSTRAINT "cards_liability_account_id_fkey" FOREIGN KEY ("liability_account_id") REFERENCES "accounts" ("id") ON DELETE RESTRICT;
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards" ("id") ON DELETE RESTRICT;
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_receipt_document_id_fkey" FOREIGN KEY ("receipt_document_id") REFERENCES "source_documents" ("id") ON DELETE RESTRICT;
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_coded_account_id_fkey" FOREIGN KEY ("coded_account_id") REFERENCES "accounts" ("id") ON DELETE RESTRICT;
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_coded_department_id_fkey" FOREIGN KEY ("coded_department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT;
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries" ("id") ON DELETE RESTRICT;
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "import_batches" ("id") ON DELETE RESTRICT;
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_asset_account_id_fkey" FOREIGN KEY ("asset_account_id") REFERENCES "accounts" ("id") ON DELETE RESTRICT;
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_accumulated_depreciation_account_id_fkey" FOREIGN KEY ("accumulated_depreciation_account_id") REFERENCES "accounts" ("id") ON DELETE RESTRICT;
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_depreciation_expense_account_id_fkey" FOREIGN KEY ("depreciation_expense_account_id") REFERENCES "accounts" ("id") ON DELETE RESTRICT;
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT;
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations" ("id") ON DELETE RESTRICT;
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors" ("id") ON DELETE RESTRICT;
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills" ("id") ON DELETE RESTRICT;
ALTER TABLE "depreciation_lines" ADD CONSTRAINT "depreciation_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "depreciation_lines" ADD CONSTRAINT "depreciation_lines_fixed_asset_id_fkey" FOREIGN KEY ("fixed_asset_id") REFERENCES "fixed_assets" ("id") ON DELETE CASCADE;
ALTER TABLE "depreciation_lines" ADD CONSTRAINT "depreciation_lines_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "periods" ("id") ON DELETE RESTRICT;
ALTER TABLE "depreciation_lines" ADD CONSTRAINT "depreciation_lines_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries" ("id") ON DELETE RESTRICT;
ALTER TABLE "amortization_schedules" ADD CONSTRAINT "amortization_schedules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "amortization_schedules" ADD CONSTRAINT "amortization_schedules_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "amortization_schedules" ADD CONSTRAINT "amortization_schedules_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors" ("id") ON DELETE RESTRICT;
ALTER TABLE "amortization_schedules" ADD CONSTRAINT "amortization_schedules_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers" ("id") ON DELETE RESTRICT;
ALTER TABLE "amortization_schedules" ADD CONSTRAINT "amortization_schedules_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills" ("id") ON DELETE RESTRICT;
ALTER TABLE "amortization_schedules" ADD CONSTRAINT "amortization_schedules_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices" ("id") ON DELETE RESTRICT;
ALTER TABLE "amortization_schedules" ADD CONSTRAINT "amortization_schedules_balance_account_id_fkey" FOREIGN KEY ("balance_account_id") REFERENCES "accounts" ("id") ON DELETE RESTRICT;
ALTER TABLE "amortization_schedules" ADD CONSTRAINT "amortization_schedules_pl_account_id_fkey" FOREIGN KEY ("pl_account_id") REFERENCES "accounts" ("id") ON DELETE RESTRICT;
ALTER TABLE "amortization_schedules" ADD CONSTRAINT "amortization_schedules_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT;
ALTER TABLE "amortization_schedules" ADD CONSTRAINT "amortization_schedules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "amortization_schedules" ADD CONSTRAINT "amortization_schedules_created_by_run_id_fkey" FOREIGN KEY ("created_by_run_id") REFERENCES "agent_runs" ("id") ON DELETE RESTRICT;
ALTER TABLE "amortization_lines" ADD CONSTRAINT "amortization_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "amortization_lines" ADD CONSTRAINT "amortization_lines_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "amortization_schedules" ("id") ON DELETE CASCADE;
ALTER TABLE "amortization_lines" ADD CONSTRAINT "amortization_lines_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "periods" ("id") ON DELETE RESTRICT;
ALTER TABLE "amortization_lines" ADD CONSTRAINT "amortization_lines_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries" ("id") ON DELETE RESTRICT;
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries" ("id") ON DELETE RESTRICT;
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_documents" ("id") ON DELETE RESTRICT;
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "import_batches" ("id") ON DELETE RESTRICT;
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_payroll_run_id_fkey" FOREIGN KEY ("payroll_run_id") REFERENCES "payroll_runs" ("id") ON DELETE CASCADE;
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT;
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts" ("id") ON DELETE RESTRICT;
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors" ("id") ON DELETE RESTRICT;
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors" ("id") ON DELETE RESTRICT;
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_documents" ("id") ON DELETE RESTRICT;
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_imported_by_fkey" FOREIGN KEY ("imported_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_documents" ("id") ON DELETE RESTRICT;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_attached_by_fkey" FOREIGN KEY ("attached_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "comments" ADD CONSTRAINT "comments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users" ("id") ON DELETE RESTRICT;
ALTER TABLE "closes" ADD CONSTRAINT "closes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "closes" ADD CONSTRAINT "closes_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "checklist_template_tasks" ADD CONSTRAINT "checklist_template_tasks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "checklist_template_tasks" ADD CONSTRAINT "checklist_template_tasks_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "checklist_templates" ("id") ON DELETE CASCADE;
ALTER TABLE "close_tasks" ADD CONSTRAINT "close_tasks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "close_tasks" ADD CONSTRAINT "close_tasks_close_id_fkey" FOREIGN KEY ("close_id") REFERENCES "closes" ("id") ON DELETE CASCADE;
ALTER TABLE "close_tasks" ADD CONSTRAINT "close_tasks_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "close_tasks" ADD CONSTRAINT "close_tasks_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "close_tasks" ADD CONSTRAINT "close_tasks_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "close_tasks" ADD CONSTRAINT "close_tasks_last_run_id_fkey" FOREIGN KEY ("last_run_id") REFERENCES "agent_runs" ("id") ON DELETE RESTRICT;
ALTER TABLE "close_tasks" ADD CONSTRAINT "close_tasks_completed_by_fkey" FOREIGN KEY ("completed_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "close_tasks" ADD CONSTRAINT "close_tasks_completed_by_run_id_fkey" FOREIGN KEY ("completed_by_run_id") REFERENCES "agent_runs" ("id") ON DELETE RESTRICT;
ALTER TABLE "close_tasks" ADD CONSTRAINT "close_tasks_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "close_task_dependencies" ADD CONSTRAINT "close_task_dependencies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "close_task_dependencies" ADD CONSTRAINT "close_task_dependencies_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "close_tasks" ("id") ON DELETE CASCADE;
ALTER TABLE "close_task_dependencies" ADD CONSTRAINT "close_task_dependencies_depends_on_task_id_fkey" FOREIGN KEY ("depends_on_task_id") REFERENCES "close_tasks" ("id") ON DELETE CASCADE;
ALTER TABLE "signoffs" ADD CONSTRAINT "signoffs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "signoffs" ADD CONSTRAINT "signoffs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT;
ALTER TABLE "close_packages" ADD CONSTRAINT "close_packages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "close_packages" ADD CONSTRAINT "close_packages_close_id_fkey" FOREIGN KEY ("close_id") REFERENCES "closes" ("id") ON DELETE RESTRICT;
ALTER TABLE "close_packages" ADD CONSTRAINT "close_packages_generated_by_fkey" FOREIGN KEY ("generated_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "close_packages" ADD CONSTRAINT "close_packages_generated_by_run_id_fkey" FOREIGN KEY ("generated_by_run_id") REFERENCES "agent_runs" ("id") ON DELETE RESTRICT;
ALTER TABLE "close_packages" ADD CONSTRAINT "close_packages_source_document_id_fkey" FOREIGN KEY ("source_document_id") REFERENCES "source_documents" ("id") ON DELETE RESTRICT;
ALTER TABLE "close_packages" ADD CONSTRAINT "close_packages_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "periods" ("id") ON DELETE RESTRICT;
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_close_task_id_fkey" FOREIGN KEY ("close_task_id") REFERENCES "close_tasks" ("id") ON DELETE SET NULL;
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE RESTRICT;
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "bank_accounts" ("id") ON DELETE RESTRICT;
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_counterparty_entity_id_fkey" FOREIGN KEY ("counterparty_entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_prepared_by_fkey" FOREIGN KEY ("prepared_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_last_run_id_fkey" FOREIGN KEY ("last_run_id") REFERENCES "agent_runs" ("id") ON DELETE RESTRICT;
ALTER TABLE "rec_matches" ADD CONSTRAINT "rec_matches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "rec_matches" ADD CONSTRAINT "rec_matches_reconciliation_id_fkey" FOREIGN KEY ("reconciliation_id") REFERENCES "reconciliations" ("id") ON DELETE CASCADE;
ALTER TABLE "rec_matches" ADD CONSTRAINT "rec_matches_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposals" ("id") ON DELETE RESTRICT;
ALTER TABLE "rec_matches" ADD CONSTRAINT "rec_matches_accepted_by_fkey" FOREIGN KEY ("accepted_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "rec_match_items" ADD CONSTRAINT "rec_match_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "rec_match_items" ADD CONSTRAINT "rec_match_items_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "rec_matches" ("id") ON DELETE CASCADE;
ALTER TABLE "rec_match_items" ADD CONSTRAINT "rec_match_items_bank_transaction_id_fkey" FOREIGN KEY ("bank_transaction_id") REFERENCES "bank_transactions" ("id") ON DELETE RESTRICT;
ALTER TABLE "rec_match_items" ADD CONSTRAINT "rec_match_items_journal_line_id_fkey" FOREIGN KEY ("journal_line_id") REFERENCES "journal_lines" ("id") ON DELETE RESTRICT;
ALTER TABLE "reconciling_items" ADD CONSTRAINT "reconciling_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "reconciling_items" ADD CONSTRAINT "reconciling_items_reconciliation_id_fkey" FOREIGN KEY ("reconciliation_id") REFERENCES "reconciliations" ("id") ON DELETE CASCADE;
ALTER TABLE "reconciling_items" ADD CONSTRAINT "reconciling_items_bank_transaction_id_fkey" FOREIGN KEY ("bank_transaction_id") REFERENCES "bank_transactions" ("id") ON DELETE RESTRICT;
ALTER TABLE "reconciling_items" ADD CONSTRAINT "reconciling_items_journal_line_id_fkey" FOREIGN KEY ("journal_line_id") REFERENCES "journal_lines" ("id") ON DELETE RESTRICT;
ALTER TABLE "reconciling_items" ADD CONSTRAINT "reconciling_items_resolution_entry_id_fkey" FOREIGN KEY ("resolution_entry_id") REFERENCES "journal_entries" ("id") ON DELETE RESTRICT;
ALTER TABLE "reconciling_items" ADD CONSTRAINT "reconciling_items_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposals" ("id") ON DELETE RESTRICT;
ALTER TABLE "reconciling_items" ADD CONSTRAINT "reconciling_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "reconciling_items" ADD CONSTRAINT "reconciling_items_created_by_run_id_fkey" FOREIGN KEY ("created_by_run_id") REFERENCES "agent_runs" ("id") ON DELETE RESTRICT;
ALTER TABLE "flux_analyses" ADD CONSTRAINT "flux_analyses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "flux_analyses" ADD CONSTRAINT "flux_analyses_close_id_fkey" FOREIGN KEY ("close_id") REFERENCES "closes" ("id") ON DELETE RESTRICT;
ALTER TABLE "flux_analyses" ADD CONSTRAINT "flux_analyses_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "flux_analyses" ADD CONSTRAINT "flux_analyses_generated_by_run_id_fkey" FOREIGN KEY ("generated_by_run_id") REFERENCES "agent_runs" ("id") ON DELETE RESTRICT;
ALTER TABLE "flux_analyses" ADD CONSTRAINT "flux_analyses_prepared_by_fkey" FOREIGN KEY ("prepared_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "flux_analyses" ADD CONSTRAINT "flux_analyses_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "flux_lines" ADD CONSTRAINT "flux_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "flux_lines" ADD CONSTRAINT "flux_lines_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "flux_analyses" ("id") ON DELETE CASCADE;
ALTER TABLE "flux_lines" ADD CONSTRAINT "flux_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE RESTRICT;
ALTER TABLE "flux_lines" ADD CONSTRAINT "flux_lines_explained_by_fkey" FOREIGN KEY ("explained_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "flux_lines" ADD CONSTRAINT "flux_lines_explained_by_run_id_fkey" FOREIGN KEY ("explained_by_run_id") REFERENCES "agent_runs" ("id") ON DELETE RESTRICT;
ALTER TABLE "flux_lines" ADD CONSTRAINT "flux_lines_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposals" ("id") ON DELETE RESTRICT;
ALTER TABLE "flux_lines" ADD CONSTRAINT "flux_lines_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills" ("id") ON DELETE CASCADE;
ALTER TABLE "skill_policies" ADD CONSTRAINT "skill_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "skill_policies" ADD CONSTRAINT "skill_policies_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "skill_policies" ADD CONSTRAINT "skill_policies_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "skill_policies" ADD CONSTRAINT "skill_policies_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "skill_policies" ("id") ON DELETE RESTRICT;
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "skill_policies" ("id") ON DELETE RESTRICT;
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_close_id_fkey" FOREIGN KEY ("close_id") REFERENCES "closes" ("id") ON DELETE RESTRICT;
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_close_task_id_fkey" FOREIGN KEY ("close_task_id") REFERENCES "close_tasks" ("id") ON DELETE SET NULL;
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "periods" ("id") ON DELETE RESTRICT;
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_parent_run_id_fkey" FOREIGN KEY ("parent_run_id") REFERENCES "agent_runs" ("id") ON DELETE RESTRICT;
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs" ("id") ON DELETE CASCADE;
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs" ("id") ON DELETE CASCADE;
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "agent_steps" ("id") ON DELETE RESTRICT;
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs" ("id") ON DELETE RESTRICT;
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE RESTRICT;
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "periods" ("id") ON DELETE RESTRICT;
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_close_task_id_fkey" FOREIGN KEY ("close_task_id") REFERENCES "close_tasks" ("id") ON DELETE SET NULL;
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "skill_policies" ("id") ON DELETE RESTRICT;
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_maker_user_id_fkey" FOREIGN KEY ("maker_user_id") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_posted_entry_id_fkey" FOREIGN KEY ("posted_entry_id") REFERENCES "journal_entries" ("id") ON DELETE RESTRICT;
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_post_hoc_reviewed_by_fkey" FOREIGN KEY ("post_hoc_reviewed_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposals" ("id") ON DELETE CASCADE;
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT;

-- Indexes
CREATE INDEX "entities_parent_entity_id_idx" ON "entities" ("parent_entity_id");
CREATE INDEX "user_roles_tenant_id_idx" ON "user_roles" ("tenant_id");
CREATE INDEX "user_roles_role_id_idx" ON "user_roles" ("role_id");
CREATE INDEX "user_roles_entity_id_idx" ON "user_roles" ("entity_id");
CREATE INDEX "user_roles_granted_by_idx" ON "user_roles" ("granted_by");
CREATE INDEX "sessions_user_id_idx" ON "sessions" ("user_id");
CREATE INDEX "sessions_tenant_id_idx" ON "sessions" ("tenant_id");
CREATE INDEX "sessions_rotated_from_id_idx" ON "sessions" ("rotated_from_id");
CREATE INDEX "api_tokens_tenant_id_idx" ON "api_tokens" ("tenant_id");
CREATE INDEX "api_tokens_user_id_idx" ON "api_tokens" ("user_id");
CREATE INDEX "sod_rules_updated_by_idx" ON "sod_rules" ("updated_by");
CREATE INDEX "audit_log_tenant_id_object_type_object_id_idx" ON "audit_log" ("tenant_id", "object_type", "object_id");
CREATE INDEX "audit_log_tenant_id_occurred_at_idx" ON "audit_log" ("tenant_id", "occurred_at");
CREATE INDEX "accounts_parent_id_idx" ON "accounts" ("parent_id");
CREATE INDEX "departments_parent_id_idx" ON "departments" ("parent_id");
CREATE INDEX "departments_owner_user_id_idx" ON "departments" ("owner_user_id");
CREATE INDEX "locations_parent_id_idx" ON "locations" ("parent_id");
CREATE INDEX "locations_owner_user_id_idx" ON "locations" ("owner_user_id");
CREATE INDEX "classes_parent_id_idx" ON "classes" ("parent_id");
CREATE INDEX "classes_owner_user_id_idx" ON "classes" ("owner_user_id");
CREATE INDEX "projects_parent_id_idx" ON "projects" ("parent_id");
CREATE INDEX "projects_owner_user_id_idx" ON "projects" ("owner_user_id");
CREATE INDEX "periods_tenant_id_idx" ON "periods" ("tenant_id");
CREATE INDEX "periods_soft_closed_by_idx" ON "periods" ("soft_closed_by");
CREATE INDEX "periods_locked_by_idx" ON "periods" ("locked_by");
CREATE INDEX "journal_entries_entity_id_period_id_status_idx" ON "journal_entries" ("entity_id", "period_id", "status");
CREATE INDEX "journal_entries_tenant_id_status_idx" ON "journal_entries" ("tenant_id", "status");
CREATE INDEX "journal_entries_prepared_by_run_id_idx" ON "journal_entries" ("prepared_by_run_id");
CREATE INDEX "journal_entries_period_id_idx" ON "journal_entries" ("period_id");
CREATE INDEX "journal_entries_source_document_id_idx" ON "journal_entries" ("source_document_id");
CREATE INDEX "journal_entries_import_batch_id_idx" ON "journal_entries" ("import_batch_id");
CREATE INDEX "journal_entries_prepared_by_idx" ON "journal_entries" ("prepared_by");
CREATE INDEX "journal_entries_proposal_id_idx" ON "journal_entries" ("proposal_id");
CREATE INDEX "journal_entries_approved_by_idx" ON "journal_entries" ("approved_by");
CREATE INDEX "journal_entries_posted_by_idx" ON "journal_entries" ("posted_by");
CREATE INDEX "journal_entries_posted_by_run_id_idx" ON "journal_entries" ("posted_by_run_id");
CREATE INDEX "journal_entries_counterparty_entity_id_idx" ON "journal_entries" ("counterparty_entity_id");
CREATE INDEX "journal_lines_entity_id_period_id_account_id_idx" ON "journal_lines" ("entity_id", "period_id", "account_id");
CREATE INDEX "journal_lines_account_id_idx" ON "journal_lines" ("account_id");
CREATE INDEX "journal_lines_vendor_id_idx" ON "journal_lines" ("vendor_id");
CREATE INDEX "journal_lines_tenant_id_idx" ON "journal_lines" ("tenant_id");
CREATE INDEX "journal_lines_period_id_idx" ON "journal_lines" ("period_id");
CREATE INDEX "journal_lines_department_id_idx" ON "journal_lines" ("department_id");
CREATE INDEX "journal_lines_location_id_idx" ON "journal_lines" ("location_id");
CREATE INDEX "journal_lines_class_id_idx" ON "journal_lines" ("class_id");
CREATE INDEX "journal_lines_project_id_idx" ON "journal_lines" ("project_id");
CREATE INDEX "journal_lines_counterparty_entity_id_idx" ON "journal_lines" ("counterparty_entity_id");
CREATE INDEX "journal_lines_customer_id_idx" ON "journal_lines" ("customer_id");
CREATE INDEX "recurring_templates_tenant_id_idx" ON "recurring_templates" ("tenant_id");
CREATE INDEX "recurring_templates_entity_id_idx" ON "recurring_templates" ("entity_id");
CREATE INDEX "recurring_templates_created_by_idx" ON "recurring_templates" ("created_by");
CREATE INDEX "budgets_tenant_id_idx" ON "budgets" ("tenant_id");
CREATE INDEX "budgets_created_by_idx" ON "budgets" ("created_by");
CREATE INDEX "budgets_approved_by_idx" ON "budgets" ("approved_by");
CREATE INDEX "budget_lines_tenant_id_idx" ON "budget_lines" ("tenant_id");
CREATE INDEX "budget_lines_account_id_idx" ON "budget_lines" ("account_id");
CREATE INDEX "budget_lines_department_id_idx" ON "budget_lines" ("department_id");
CREATE INDEX "materiality_settings_set_by_idx" ON "materiality_settings" ("set_by");
CREATE INDEX "materiality_settings_approved_by_idx" ON "materiality_settings" ("approved_by");
CREATE INDEX "vendors_default_account_id_idx" ON "vendors" ("default_account_id");
CREATE INDEX "vendors_default_department_id_idx" ON "vendors" ("default_department_id");
CREATE INDEX "vendors_created_by_idx" ON "vendors" ("created_by");
CREATE INDEX "vendors_updated_by_idx" ON "vendors" ("updated_by");
CREATE INDEX "purchase_orders_tenant_id_idx" ON "purchase_orders" ("tenant_id");
CREATE INDEX "purchase_orders_vendor_id_idx" ON "purchase_orders" ("vendor_id");
CREATE INDEX "purchase_orders_requested_by_idx" ON "purchase_orders" ("requested_by");
CREATE INDEX "purchase_orders_approved_by_idx" ON "purchase_orders" ("approved_by");
CREATE INDEX "purchase_order_lines_tenant_id_idx" ON "purchase_order_lines" ("tenant_id");
CREATE INDEX "purchase_order_lines_account_id_idx" ON "purchase_order_lines" ("account_id");
CREATE INDEX "purchase_order_lines_department_id_idx" ON "purchase_order_lines" ("department_id");
CREATE INDEX "goods_receipts_tenant_id_idx" ON "goods_receipts" ("tenant_id");
CREATE INDEX "goods_receipts_entity_id_idx" ON "goods_receipts" ("entity_id");
CREATE INDEX "goods_receipts_purchase_order_id_idx" ON "goods_receipts" ("purchase_order_id");
CREATE INDEX "goods_receipts_purchase_order_line_id_idx" ON "goods_receipts" ("purchase_order_line_id");
CREATE INDEX "goods_receipts_received_by_idx" ON "goods_receipts" ("received_by");
CREATE INDEX "bills_entity_id_bill_date_idx" ON "bills" ("entity_id", "bill_date");
CREATE INDEX "bills_tenant_id_idx" ON "bills" ("tenant_id");
CREATE INDEX "bills_purchase_order_id_idx" ON "bills" ("purchase_order_id");
CREATE INDEX "bills_journal_entry_id_idx" ON "bills" ("journal_entry_id");
CREATE INDEX "bills_source_document_id_idx" ON "bills" ("source_document_id");
CREATE INDEX "bills_import_batch_id_idx" ON "bills" ("import_batch_id");
CREATE INDEX "bills_created_by_idx" ON "bills" ("created_by");
CREATE INDEX "bills_approved_by_idx" ON "bills" ("approved_by");
CREATE INDEX "bill_lines_tenant_id_idx" ON "bill_lines" ("tenant_id");
CREATE INDEX "bill_lines_account_id_idx" ON "bill_lines" ("account_id");
CREATE INDEX "bill_lines_department_id_idx" ON "bill_lines" ("department_id");
CREATE INDEX "bill_lines_location_id_idx" ON "bill_lines" ("location_id");
CREATE INDEX "bill_lines_class_id_idx" ON "bill_lines" ("class_id");
CREATE INDEX "bill_lines_project_id_idx" ON "bill_lines" ("project_id");
CREATE INDEX "vendor_payments_vendor_id_payment_date_idx" ON "vendor_payments" ("vendor_id", "payment_date");
CREATE INDEX "vendor_payments_tenant_id_idx" ON "vendor_payments" ("tenant_id");
CREATE INDEX "vendor_payments_entity_id_idx" ON "vendor_payments" ("entity_id");
CREATE INDEX "vendor_payments_bank_account_id_idx" ON "vendor_payments" ("bank_account_id");
CREATE INDEX "vendor_payments_journal_entry_id_idx" ON "vendor_payments" ("journal_entry_id");
CREATE INDEX "vendor_payments_created_by_idx" ON "vendor_payments" ("created_by");
CREATE INDEX "vendor_payments_approved_by_idx" ON "vendor_payments" ("approved_by");
CREATE INDEX "payment_applications_tenant_id_idx" ON "payment_applications" ("tenant_id");
CREATE INDEX "payment_applications_bill_id_idx" ON "payment_applications" ("bill_id");
CREATE INDEX "invoices_entity_id_invoice_date_idx" ON "invoices" ("entity_id", "invoice_date");
CREATE INDEX "invoices_tenant_id_idx" ON "invoices" ("tenant_id");
CREATE INDEX "invoices_customer_id_idx" ON "invoices" ("customer_id");
CREATE INDEX "invoices_journal_entry_id_idx" ON "invoices" ("journal_entry_id");
CREATE INDEX "invoice_lines_tenant_id_idx" ON "invoice_lines" ("tenant_id");
CREATE INDEX "invoice_lines_revenue_account_id_idx" ON "invoice_lines" ("revenue_account_id");
CREATE INDEX "invoice_lines_class_id_idx" ON "invoice_lines" ("class_id");
CREATE INDEX "customer_receipts_customer_id_receipt_date_idx" ON "customer_receipts" ("customer_id", "receipt_date");
CREATE INDEX "customer_receipts_tenant_id_idx" ON "customer_receipts" ("tenant_id");
CREATE INDEX "customer_receipts_entity_id_idx" ON "customer_receipts" ("entity_id");
CREATE INDEX "customer_receipts_bank_account_id_idx" ON "customer_receipts" ("bank_account_id");
CREATE INDEX "customer_receipts_journal_entry_id_idx" ON "customer_receipts" ("journal_entry_id");
CREATE INDEX "receipt_applications_tenant_id_idx" ON "receipt_applications" ("tenant_id");
CREATE INDEX "receipt_applications_invoice_id_idx" ON "receipt_applications" ("invoice_id");
CREATE INDEX "bank_accounts_tenant_id_idx" ON "bank_accounts" ("tenant_id");
CREATE INDEX "bank_accounts_gl_account_id_idx" ON "bank_accounts" ("gl_account_id");
CREATE INDEX "bank_statements_tenant_id_idx" ON "bank_statements" ("tenant_id");
CREATE INDEX "bank_statements_source_document_id_idx" ON "bank_statements" ("source_document_id");
CREATE INDEX "bank_statements_import_batch_id_idx" ON "bank_statements" ("import_batch_id");
CREATE INDEX "bank_transactions_bank_account_id_booking_date_idx" ON "bank_transactions" ("bank_account_id", "booking_date");
CREATE INDEX "bank_transactions_tenant_id_idx" ON "bank_transactions" ("tenant_id");
CREATE INDEX "bank_transactions_entity_id_idx" ON "bank_transactions" ("entity_id");
CREATE INDEX "bank_transactions_statement_id_idx" ON "bank_transactions" ("statement_id");
CREATE INDEX "bank_transactions_source_document_id_idx" ON "bank_transactions" ("source_document_id");
CREATE INDEX "bank_transactions_import_batch_id_idx" ON "bank_transactions" ("import_batch_id");
CREATE INDEX "cards_tenant_id_idx" ON "cards" ("tenant_id");
CREATE INDEX "cards_entity_id_idx" ON "cards" ("entity_id");
CREATE INDEX "cards_cardholder_user_id_idx" ON "cards" ("cardholder_user_id");
CREATE INDEX "cards_department_id_idx" ON "cards" ("department_id");
CREATE INDEX "cards_liability_account_id_idx" ON "cards" ("liability_account_id");
CREATE INDEX "card_transactions_entity_id_transaction_date_idx" ON "card_transactions" ("entity_id", "transaction_date");
CREATE INDEX "card_transactions_status_idx" ON "card_transactions" ("status");
CREATE INDEX "card_transactions_tenant_id_idx" ON "card_transactions" ("tenant_id");
CREATE INDEX "card_transactions_receipt_document_id_idx" ON "card_transactions" ("receipt_document_id");
CREATE INDEX "card_transactions_coded_account_id_idx" ON "card_transactions" ("coded_account_id");
CREATE INDEX "card_transactions_coded_department_id_idx" ON "card_transactions" ("coded_department_id");
CREATE INDEX "card_transactions_journal_entry_id_idx" ON "card_transactions" ("journal_entry_id");
CREATE INDEX "card_transactions_import_batch_id_idx" ON "card_transactions" ("import_batch_id");
CREATE INDEX "fixed_assets_tenant_id_idx" ON "fixed_assets" ("tenant_id");
CREATE INDEX "fixed_assets_asset_account_id_idx" ON "fixed_assets" ("asset_account_id");
CREATE INDEX "fixed_assets_accumulated_depreciation_account_id_idx" ON "fixed_assets" ("accumulated_depreciation_account_id");
CREATE INDEX "fixed_assets_depreciation_expense_account_id_idx" ON "fixed_assets" ("depreciation_expense_account_id");
CREATE INDEX "fixed_assets_department_id_idx" ON "fixed_assets" ("department_id");
CREATE INDEX "fixed_assets_location_id_idx" ON "fixed_assets" ("location_id");
CREATE INDEX "fixed_assets_vendor_id_idx" ON "fixed_assets" ("vendor_id");
CREATE INDEX "fixed_assets_bill_id_idx" ON "fixed_assets" ("bill_id");
CREATE INDEX "depreciation_lines_tenant_id_idx" ON "depreciation_lines" ("tenant_id");
CREATE INDEX "depreciation_lines_period_id_idx" ON "depreciation_lines" ("period_id");
CREATE INDEX "depreciation_lines_journal_entry_id_idx" ON "depreciation_lines" ("journal_entry_id");
CREATE INDEX "amortization_schedules_tenant_id_idx" ON "amortization_schedules" ("tenant_id");
CREATE INDEX "amortization_schedules_entity_id_idx" ON "amortization_schedules" ("entity_id");
CREATE INDEX "amortization_schedules_vendor_id_idx" ON "amortization_schedules" ("vendor_id");
CREATE INDEX "amortization_schedules_customer_id_idx" ON "amortization_schedules" ("customer_id");
CREATE INDEX "amortization_schedules_bill_id_idx" ON "amortization_schedules" ("bill_id");
CREATE INDEX "amortization_schedules_invoice_id_idx" ON "amortization_schedules" ("invoice_id");
CREATE INDEX "amortization_schedules_balance_account_id_idx" ON "amortization_schedules" ("balance_account_id");
CREATE INDEX "amortization_schedules_pl_account_id_idx" ON "amortization_schedules" ("pl_account_id");
CREATE INDEX "amortization_schedules_department_id_idx" ON "amortization_schedules" ("department_id");
CREATE INDEX "amortization_schedules_created_by_idx" ON "amortization_schedules" ("created_by");
CREATE INDEX "amortization_schedules_created_by_run_id_idx" ON "amortization_schedules" ("created_by_run_id");
CREATE INDEX "amortization_lines_tenant_id_idx" ON "amortization_lines" ("tenant_id");
CREATE INDEX "amortization_lines_period_id_idx" ON "amortization_lines" ("period_id");
CREATE INDEX "amortization_lines_journal_entry_id_idx" ON "amortization_lines" ("journal_entry_id");
CREATE INDEX "payroll_runs_tenant_id_idx" ON "payroll_runs" ("tenant_id");
CREATE INDEX "payroll_runs_journal_entry_id_idx" ON "payroll_runs" ("journal_entry_id");
CREATE INDEX "payroll_runs_source_document_id_idx" ON "payroll_runs" ("source_document_id");
CREATE INDEX "payroll_runs_import_batch_id_idx" ON "payroll_runs" ("import_batch_id");
CREATE INDEX "payroll_lines_tenant_id_idx" ON "payroll_lines" ("tenant_id");
CREATE INDEX "payroll_lines_payroll_run_id_idx" ON "payroll_lines" ("payroll_run_id");
CREATE INDEX "payroll_lines_department_id_idx" ON "payroll_lines" ("department_id");
CREATE INDEX "connectors_tenant_id_idx" ON "connectors" ("tenant_id");
CREATE INDEX "connectors_entity_id_idx" ON "connectors" ("entity_id");
CREATE INDEX "connectors_bank_account_id_idx" ON "connectors" ("bank_account_id");
CREATE INDEX "source_documents_connector_id_idx" ON "source_documents" ("connector_id");
CREATE INDEX "source_documents_uploaded_by_idx" ON "source_documents" ("uploaded_by");
CREATE INDEX "import_batches_tenant_id_idx" ON "import_batches" ("tenant_id");
CREATE INDEX "import_batches_connector_id_idx" ON "import_batches" ("connector_id");
CREATE INDEX "import_batches_source_document_id_idx" ON "import_batches" ("source_document_id");
CREATE INDEX "import_batches_imported_by_idx" ON "import_batches" ("imported_by");
CREATE INDEX "attachments_object_type_object_id_idx" ON "attachments" ("object_type", "object_id");
CREATE INDEX "attachments_tenant_id_idx" ON "attachments" ("tenant_id");
CREATE INDEX "attachments_source_document_id_idx" ON "attachments" ("source_document_id");
CREATE INDEX "attachments_attached_by_idx" ON "attachments" ("attached_by");
CREATE INDEX "comments_object_type_object_id_idx" ON "comments" ("object_type", "object_id");
CREATE INDEX "comments_tenant_id_idx" ON "comments" ("tenant_id");
CREATE INDEX "comments_author_id_idx" ON "comments" ("author_id");
CREATE INDEX "closes_closed_by_idx" ON "closes" ("closed_by");
CREATE INDEX "checklist_template_tasks_tenant_id_idx" ON "checklist_template_tasks" ("tenant_id");
CREATE INDEX "close_tasks_close_id_status_idx" ON "close_tasks" ("close_id", "status");
CREATE INDEX "close_tasks_owner_id_idx" ON "close_tasks" ("owner_id");
CREATE INDEX "close_tasks_tenant_id_idx" ON "close_tasks" ("tenant_id");
CREATE INDEX "close_tasks_entity_id_idx" ON "close_tasks" ("entity_id");
CREATE INDEX "close_tasks_reviewer_id_idx" ON "close_tasks" ("reviewer_id");
CREATE INDEX "close_tasks_last_run_id_idx" ON "close_tasks" ("last_run_id");
CREATE INDEX "close_tasks_completed_by_idx" ON "close_tasks" ("completed_by");
CREATE INDEX "close_tasks_completed_by_run_id_idx" ON "close_tasks" ("completed_by_run_id");
CREATE INDEX "close_tasks_reviewed_by_idx" ON "close_tasks" ("reviewed_by");
CREATE INDEX "close_task_dependencies_tenant_id_idx" ON "close_task_dependencies" ("tenant_id");
CREATE INDEX "close_task_dependencies_depends_on_task_id_idx" ON "close_task_dependencies" ("depends_on_task_id");
CREATE INDEX "signoffs_object_type_object_id_idx" ON "signoffs" ("object_type", "object_id");
CREATE INDEX "signoffs_tenant_id_idx" ON "signoffs" ("tenant_id");
CREATE INDEX "signoffs_user_id_idx" ON "signoffs" ("user_id");
CREATE INDEX "close_packages_tenant_id_idx" ON "close_packages" ("tenant_id");
CREATE INDEX "close_packages_generated_by_idx" ON "close_packages" ("generated_by");
CREATE INDEX "close_packages_generated_by_run_id_idx" ON "close_packages" ("generated_by_run_id");
CREATE INDEX "close_packages_source_document_id_idx" ON "close_packages" ("source_document_id");
CREATE INDEX "close_packages_approved_by_idx" ON "close_packages" ("approved_by");
CREATE INDEX "reconciliations_entity_id_period_id_idx" ON "reconciliations" ("entity_id", "period_id");
CREATE INDEX "reconciliations_tenant_id_idx" ON "reconciliations" ("tenant_id");
CREATE INDEX "reconciliations_close_task_id_idx" ON "reconciliations" ("close_task_id");
CREATE INDEX "reconciliations_account_id_idx" ON "reconciliations" ("account_id");
CREATE INDEX "reconciliations_bank_account_id_idx" ON "reconciliations" ("bank_account_id");
CREATE INDEX "reconciliations_counterparty_entity_id_idx" ON "reconciliations" ("counterparty_entity_id");
CREATE INDEX "reconciliations_prepared_by_idx" ON "reconciliations" ("prepared_by");
CREATE INDEX "reconciliations_reviewed_by_idx" ON "reconciliations" ("reviewed_by");
CREATE INDEX "reconciliations_last_run_id_idx" ON "reconciliations" ("last_run_id");
CREATE INDEX "rec_matches_reconciliation_id_idx" ON "rec_matches" ("reconciliation_id");
CREATE INDEX "rec_matches_tenant_id_idx" ON "rec_matches" ("tenant_id");
CREATE INDEX "rec_matches_proposal_id_idx" ON "rec_matches" ("proposal_id");
CREATE INDEX "rec_matches_accepted_by_idx" ON "rec_matches" ("accepted_by");
CREATE INDEX "rec_match_items_bank_transaction_id_idx" ON "rec_match_items" ("bank_transaction_id");
CREATE INDEX "rec_match_items_journal_line_id_idx" ON "rec_match_items" ("journal_line_id");
CREATE INDEX "rec_match_items_tenant_id_idx" ON "rec_match_items" ("tenant_id");
CREATE INDEX "rec_match_items_match_id_idx" ON "rec_match_items" ("match_id");
CREATE INDEX "reconciling_items_reconciliation_id_idx" ON "reconciling_items" ("reconciliation_id");
CREATE INDEX "reconciling_items_tenant_id_idx" ON "reconciling_items" ("tenant_id");
CREATE INDEX "reconciling_items_bank_transaction_id_idx" ON "reconciling_items" ("bank_transaction_id");
CREATE INDEX "reconciling_items_journal_line_id_idx" ON "reconciling_items" ("journal_line_id");
CREATE INDEX "reconciling_items_resolution_entry_id_idx" ON "reconciling_items" ("resolution_entry_id");
CREATE INDEX "reconciling_items_proposal_id_idx" ON "reconciling_items" ("proposal_id");
CREATE INDEX "reconciling_items_created_by_idx" ON "reconciling_items" ("created_by");
CREATE INDEX "reconciling_items_created_by_run_id_idx" ON "reconciling_items" ("created_by_run_id");
CREATE INDEX "flux_analyses_tenant_id_idx" ON "flux_analyses" ("tenant_id");
CREATE INDEX "flux_analyses_close_id_idx" ON "flux_analyses" ("close_id");
CREATE INDEX "flux_analyses_entity_id_idx" ON "flux_analyses" ("entity_id");
CREATE INDEX "flux_analyses_generated_by_run_id_idx" ON "flux_analyses" ("generated_by_run_id");
CREATE INDEX "flux_analyses_prepared_by_idx" ON "flux_analyses" ("prepared_by");
CREATE INDEX "flux_analyses_approved_by_idx" ON "flux_analyses" ("approved_by");
CREATE INDEX "flux_lines_tenant_id_idx" ON "flux_lines" ("tenant_id");
CREATE INDEX "flux_lines_account_id_idx" ON "flux_lines" ("account_id");
CREATE INDEX "flux_lines_explained_by_idx" ON "flux_lines" ("explained_by");
CREATE INDEX "flux_lines_explained_by_run_id_idx" ON "flux_lines" ("explained_by_run_id");
CREATE INDEX "flux_lines_proposal_id_idx" ON "flux_lines" ("proposal_id");
CREATE INDEX "flux_lines_reviewed_by_idx" ON "flux_lines" ("reviewed_by");
CREATE INDEX "skill_policies_entity_id_idx" ON "skill_policies" ("entity_id");
CREATE INDEX "skill_policies_created_by_idx" ON "skill_policies" ("created_by");
CREATE INDEX "skill_policies_supersedes_id_idx" ON "skill_policies" ("supersedes_id");
CREATE INDEX "agent_runs_tenant_id_created_at_idx" ON "agent_runs" ("tenant_id", "created_at");
CREATE INDEX "agent_runs_close_task_id_idx" ON "agent_runs" ("close_task_id");
CREATE INDEX "agent_runs_status_idx" ON "agent_runs" ("status");
CREATE INDEX "agent_runs_policy_id_idx" ON "agent_runs" ("policy_id");
CREATE INDEX "agent_runs_close_id_idx" ON "agent_runs" ("close_id");
CREATE INDEX "agent_runs_entity_id_idx" ON "agent_runs" ("entity_id");
CREATE INDEX "agent_runs_period_id_idx" ON "agent_runs" ("period_id");
CREATE INDEX "agent_runs_parent_run_id_idx" ON "agent_runs" ("parent_run_id");
CREATE INDEX "agent_runs_requested_by_idx" ON "agent_runs" ("requested_by");
CREATE INDEX "agent_steps_tenant_id_idx" ON "agent_steps" ("tenant_id");
CREATE INDEX "agent_tool_calls_run_id_idx" ON "agent_tool_calls" ("run_id");
CREATE INDEX "agent_tool_calls_tenant_id_idx" ON "agent_tool_calls" ("tenant_id");
CREATE INDEX "agent_tool_calls_step_id_idx" ON "agent_tool_calls" ("step_id");
CREATE INDEX "proposals_tenant_id_status_idx" ON "proposals" ("tenant_id", "status");
CREATE INDEX "proposals_run_id_idx" ON "proposals" ("run_id");
CREATE INDEX "proposals_close_task_id_idx" ON "proposals" ("close_task_id");
CREATE INDEX "proposals_entity_id_idx" ON "proposals" ("entity_id");
CREATE INDEX "proposals_period_id_idx" ON "proposals" ("period_id");
CREATE INDEX "proposals_policy_id_idx" ON "proposals" ("policy_id");
CREATE INDEX "proposals_maker_user_id_idx" ON "proposals" ("maker_user_id");
CREATE INDEX "proposals_requested_by_idx" ON "proposals" ("requested_by");
CREATE INDEX "proposals_decided_by_idx" ON "proposals" ("decided_by");
CREATE INDEX "proposals_posted_entry_id_idx" ON "proposals" ("posted_entry_id");
CREATE INDEX "proposals_post_hoc_reviewed_by_idx" ON "proposals" ("post_hoc_reviewed_by");
CREATE INDEX "approvals_proposal_id_idx" ON "approvals" ("proposal_id");
CREATE INDEX "approvals_tenant_id_idx" ON "approvals" ("tenant_id");
CREATE INDEX "approvals_user_id_idx" ON "approvals" ("user_id");

-- Documentation
COMMENT ON TABLE "tenants" IS 'A customer organization. Every business row is scoped to one tenant.';
COMMENT ON TABLE "entities" IS 'A legal or reporting entity with its own functional currency and set of books.';
COMMENT ON TABLE "users" IS 'A person who signs in. Passwords are scrypt hashes (PHC string); TOTP seeds are encrypted at rest.';
COMMENT ON TABLE "roles" IS 'A named bundle of permissions with an approval limit (RBAC).';
COMMENT ON TABLE "user_roles" IS 'Role assignment, optionally scoped to one entity.';
COMMENT ON TABLE "sessions" IS 'Server-side session (cookie holds an opaque random token).';
COMMENT ON TABLE "api_tokens" IS 'Personal access token for API/MCP clients; acts with the owner''s roles.';
COMMENT ON TABLE "sod_rules" IS 'Segregation-of-duties rule enforced by the runtime and checked by the JE review skill.';
COMMENT ON TABLE "holidays" IS 'Company holidays added to the bank-holiday calendar for workday math.';
COMMENT ON TABLE "idempotency_keys" IS 'Stored responses for retried mutating requests (Idempotency-Key header).';
COMMENT ON TABLE "audit_log" IS 'Tamper-evident, append-only event log. hash = sha256(prev_hash || "\n" || record); the database rejects UPDATE/DELETE and any insert that breaks the chain.';
COMMENT ON TABLE "accounts" IS 'Chart of accounts (tenant-wide, shared by entities). Leaf accounts are postable; headers roll up.';
COMMENT ON TABLE "departments" IS 'Cost-center dimension (who spent it).';
COMMENT ON TABLE "locations" IS 'Geographic dimension (where).';
COMMENT ON TABLE "classes" IS 'Classification dimension, e.g. product line.';
COMMENT ON TABLE "projects" IS 'Project dimension for capitalizable or tracked work.';
COMMENT ON TABLE "periods" IS 'Accounting period per entity with its state machine: future -> open -> soft_closed -> locked.';
COMMENT ON TABLE "fx_rates" IS 'Exchange rates: spot (daily), average (month) and closing (month end).';
COMMENT ON TABLE "journal_entries" IS 'Journal entry header. Posting is a state transition the database validates (>= 2 lines, debits = credits, period open, dates in period). Posted entries are immutable; corrections are reversing entries.';
COMMENT ON TABLE "journal_lines" IS 'Journal line: exactly one side positive (debit XOR credit), functional-currency amounts plus the transaction-currency amount.';
COMMENT ON TABLE "recurring_templates" IS 'Template for recurring journal entries (e.g. rent, management fee).';
COMMENT ON TABLE "budgets" IS 'Budget or forecast version for an entity and fiscal year.';
COMMENT ON TABLE "budget_lines" IS 'Budget amount per account, department and month.';
COMMENT ON TABLE "materiality_settings" IS 'Materiality: overall, performance and clearly-trivial thresholds (AS 2105 / ISA 320).';
COMMENT ON TABLE "vendors" IS 'Vendor master (supplier).';
COMMENT ON TABLE "purchase_orders" IS 'Purchase order (commitment, REA).';
COMMENT ON TABLE "purchase_order_lines" IS 'Purchase order line.';
COMMENT ON TABLE "goods_receipts" IS 'Goods or services received against a PO line (evidence for GRNI accruals).';
COMMENT ON TABLE "bills" IS 'Vendor bill (invoice received). Posting credits AP and debits the coded accounts.';
COMMENT ON TABLE "bill_lines" IS 'Bill line with GL coding and dimensions.';
COMMENT ON TABLE "vendor_payments" IS 'Outgoing payment to a vendor (economic event: cash disbursement).';
COMMENT ON TABLE "payment_applications" IS 'Allocation of a payment to the bills it settles.';
COMMENT ON TABLE "customers" IS 'Customer master.';
COMMENT ON TABLE "invoices" IS 'Customer invoice. Subscription invoices create deferred revenue recognized over the service period (ASC 606).';
COMMENT ON TABLE "invoice_lines" IS 'Invoice line (performance obligation).';
COMMENT ON TABLE "customer_receipts" IS 'Cash received from a customer.';
COMMENT ON TABLE "receipt_applications" IS 'Allocation of a receipt to invoices.';
COMMENT ON TABLE "bank_accounts" IS 'Bank account mapped to a GL cash account.';
COMMENT ON TABLE "bank_statements" IS 'Bank statement (period with opening and closing balances).';
COMMENT ON TABLE "bank_transactions" IS 'Bank statement line. Imports are idempotent on (bank account, dedupe key).';
COMMENT ON TABLE "cards" IS 'Corporate card.';
COMMENT ON TABLE "card_transactions" IS 'Card transaction from the card feed; coded to an account and department before posting.';
COMMENT ON TABLE "fixed_assets" IS 'Fixed asset register (ASC 360).';
COMMENT ON TABLE "depreciation_lines" IS 'Depreciation schedule line per asset per period.';
COMMENT ON TABLE "amortization_schedules" IS 'Amortization schedule for a prepaid expense (ASC 340) or deferred revenue (ASC 606).';
COMMENT ON TABLE "amortization_lines" IS 'Monthly amortization amount.';
COMMENT ON TABLE "payroll_runs" IS 'Payroll run summary from the payroll provider.';
COMMENT ON TABLE "payroll_lines" IS 'Payroll cost by department and category.';
COMMENT ON TABLE "connectors" IS 'A configured source system (bank feed, ERP export, card feed, payroll...).';
COMMENT ON TABLE "source_documents" IS 'Immutable source document (file) identified by its SHA-256; every imported record links back to one.';
COMMENT ON TABLE "import_batches" IS 'One import of one source document (idempotent; tracks created/duplicate/failed counts).';
COMMENT ON TABLE "attachments" IS 'Evidence attached to any object (rec, task, JE, proposal).';
COMMENT ON TABLE "comments" IS 'Discussion on an object.';
COMMENT ON TABLE "closes" IS 'A month-end close across all entities for one fiscal period.';
COMMENT ON TABLE "checklist_templates" IS 'Versioned close checklist template.';
COMMENT ON TABLE "checklist_template_tasks" IS 'Task definition in a checklist template.';
COMMENT ON TABLE "close_tasks" IS 'A task in a specific close, assigned to an owner and reviewer, due on a workday.';
COMMENT ON TABLE "close_task_dependencies" IS 'Directed dependency between close tasks (must be acyclic).';
COMMENT ON TABLE "signoffs" IS 'Append-only sign-off ledger (preparer/reviewer/approver) for any closeable object.';
COMMENT ON TABLE "close_packages" IS 'Generated close package (TB, statements, commentary, rec and exception status).';
COMMENT ON TABLE "reconciliations" IS 'Account reconciliation for one period: GL vs. external balance, reconciling items, certification.';
COMMENT ON TABLE "rec_matches" IS 'A match group between external items and ledger items.';
COMMENT ON TABLE "rec_match_items" IS 'Member of a match group (exactly one referenced item).';
COMMENT ON TABLE "reconciling_items" IS 'Explained difference between GL and external balance (timing or error), with aging.';
COMMENT ON TABLE "flux_analyses" IS 'Flux (variance) analysis for a close: current vs. comparison with materiality thresholds.';
COMMENT ON TABLE "flux_lines" IS 'Variance on one account with drivers and an explanation.';
COMMENT ON TABLE "skills" IS 'Skill registry (global catalog of SKILL.md packages).';
COMMENT ON TABLE "skill_versions" IS 'Immutable published version of a skill package.';
COMMENT ON TABLE "skill_policies" IS 'Versioned, append-only tenant policy for a skill: autonomy level, thresholds, plain-English rules.';
COMMENT ON TABLE "agent_runs" IS 'One execution of a skill: plan -> act -> observe -> verify -> propose, with budgets and cost accounting.';
COMMENT ON TABLE "agent_steps" IS 'Trace step of a run (append-only).';
COMMENT ON TABLE "agent_tool_calls" IS 'Typed tool call made by an agent (append-only).';
COMMENT ON TABLE "proposals" IS 'Something an agent (or a person adopting a suggestion) wants to change, with why, confidence, evidence and checks.';
COMMENT ON TABLE "approvals" IS 'Append-only decision history for proposals (approve, reject, adopt, post-hoc review).';
COMMENT ON TABLE "ontology_versions" IS 'Published versions of the close ontology referenced by runs.';
