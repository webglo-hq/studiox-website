-- =============================================================================
-- Tieout migration 0001: framework core
-- Tenancy, identity, sessions, RBAC, tamper-evident audit log, agent runtime,
-- skills registry and policies, evidence, integration provenance.
--
-- Conventions (parsed by scripts/gen-bundles.ts into src/generated/schema.ts):
--   * one column per line, every table has `id TEXT PRIMARY KEY`
--   * tenant-scoped tables carry `tenant_id TEXT NOT NULL`
--   * money is integer minor units (BIGINT, cents/pence); rates are NUMERIC
--   * `-- @json <TypeName>` after a JSONB column names its TypeScript type
-- Axiom references (AX-*) point to the ontology (src/packs/accounting/ontology/axioms.ts).
-- =============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_demo BOOLEAN NOT NULL DEFAULT false,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb, -- @json TenantSettings
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (slug ~ '^[a-z0-9-]{2,40}$')
);

-- Per-tenant monotonic counters for human-readable references (JE-2026-09-0042, P-0107, R-0031)
CREATE TABLE counters (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  value BIGINT NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, name),
  CHECK (value >= 0)
);

-- ---------------------------------------------------------------- identity ---
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  title TEXT,
  password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'invited')),
  kind TEXT NOT NULL DEFAULT 'human' CHECK (kind IN ('human', 'agent', 'service')),
  mfa_enabled BOOLEAN NOT NULL DEFAULT false,
  failed_logins INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb, -- @json UserPreferences
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (email = lower(email))
);

CREATE TABLE permissions (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  sensitive BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  approval_limit_minor BIGINT,
  is_system BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (tenant_id, key),
  CHECK (approval_limit_minor IS NULL OR approval_limit_minor >= 0)
);

CREATE TABLE role_permissions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id),
  UNIQUE (role_id, permission_id)
);

-- scope_entity_id NULL = all legal entities of the tenant (entity scoping, see app/context.ts)
CREATE TABLE user_roles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id),
  scope_entity_id TEXT,
  granted_by TEXT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role_id, scope_entity_id)
);

-- Session ids are SHA-256 digests of 256-bit random tokens; raw tokens only live in the cookie.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL,
  mfa_state TEXT NOT NULL DEFAULT 'not_required' CHECK (mfa_state IN ('not_required', 'pending', 'verified')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idle_expires_at TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  rotated_from TEXT,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  ip TEXT,
  user_agent TEXT,
  CHECK (id ~ '^[0-9a-f]{64}$'),
  CHECK (absolute_expires_at > created_at)
);

-- TOTP secrets are encrypted at rest (AES-256-GCM, key from APP_ENCRYPTION_KEY)
CREATE TABLE mfa_factors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'totp' CHECK (type IN ('totp')),
  secret_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  last_used_step BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ
);

-- Personal access tokens for the MCP server and automation (hashed, scoped, expiring)
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb, -- @json string[]
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

-- Segregation-of-duties rules (AX-SOD-*); evaluated by src/packs/accounting/controls/sod.ts
CREATE TABLE sod_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('maker_checker', 'requester_checker', 'role_conflict', 'permission_conflict')),
  config JSONB NOT NULL DEFAULT '{}'::jsonb, -- @json SodRuleConfig
  severity TEXT NOT NULL DEFAULT 'block' CHECK (severity IN ('block', 'warn')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

-- --------------------------------------------------------------- audit log ---
-- Append-only, hash-chained per tenant (AX-AUD-01).
-- hash = sha256(prev_hash || canonical_json(event)); verified by src/core/audit/audit.ts
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  seq BIGINT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system', 'policy')),
  actor_id TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  on_behalf_of TEXT,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  entity_id TEXT,
  summary TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb, -- @json Record<string, unknown>
  ip TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  UNIQUE (tenant_id, seq),
  CHECK (seq >= 1),
  CHECK (hash ~ '^[0-9a-f]{64}$'),
  CHECK (prev_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX audit_log_subject_idx ON audit_log (tenant_id, subject_type, subject_id);
CREATE INDEX audit_log_at_idx ON audit_log (tenant_id, at);

CREATE OR REPLACE FUNCTION tieout_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AX-AUD-01: % on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE OR REPLACE FUNCTION tieout_audit_chain_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_seq BIGINT;
  last_hash TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tieout.audit.' || NEW.tenant_id));
  SELECT seq, hash INTO last_seq, last_hash
    FROM audit_log WHERE tenant_id = NEW.tenant_id ORDER BY seq DESC LIMIT 1;
  IF last_seq IS NULL THEN
    IF NEW.seq <> 1 OR NEW.prev_hash <> repeat('0', 64) THEN
      RAISE EXCEPTION 'AX-AUD-01: audit chain genesis must be seq 1 with zero prev_hash'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.seq <> last_seq + 1 OR NEW.prev_hash <> last_hash THEN
    RAISE EXCEPTION 'AX-AUD-01: audit chain link broken at seq % (expected % / %)', NEW.seq, last_seq + 1, last_hash
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION tieout_audit_chain_check();
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION tieout_forbid_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION tieout_forbid_mutation();

-- ----------------------------------------------------------------- ontology ---
CREATE TABLE ontology_versions (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  class_count INT NOT NULL,
  axiom_count INT NOT NULL,
  term_count INT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------- skills ---
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  domain TEXT NOT NULL,
  current_version TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE TABLE skill_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  skill_id TEXT NOT NULL REFERENCES skills(id),
  version TEXT NOT NULL,
  manifest JSONB NOT NULL, -- @json SkillManifest
  skill_md TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (skill_id, version)
);

-- Versioned, append-only policy history; exactly one current row per (skill, scope).
CREATE TABLE skill_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  skill_id TEXT NOT NULL REFERENCES skills(id),
  scope_entity_id TEXT,
  version INT NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT true,
  autonomy_level TEXT NOT NULL CHECK (autonomy_level IN ('L0', 'L1', 'L2', 'L3')),
  thresholds JSONB NOT NULL DEFAULT '{}'::jsonb, -- @json PolicyThresholds
  mappings JSONB NOT NULL DEFAULT '[]'::jsonb, -- @json PolicyMapping[]
  rules JSONB NOT NULL DEFAULT '[]'::jsonb, -- @json PolicyRule[]
  enabled BOOLEAN NOT NULL DEFAULT true,
  change_note TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (skill_id, scope_entity_id, version),
  CHECK (version >= 1)
);
CREATE UNIQUE INDEX skill_policies_one_current ON skill_policies (skill_id, COALESCE(scope_entity_id, '*')) WHERE is_current;

CREATE TABLE skill_eval_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  skill_id TEXT NOT NULL REFERENCES skills(id),
  skill_version TEXT NOT NULL,
  engine TEXT NOT NULL CHECK (engine IN ('offline', 'live')),
  total INT NOT NULL,
  passed INT NOT NULL,
  results JSONB NOT NULL, -- @json EvalCaseResult[]
  ran_by TEXT NOT NULL,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (passed >= 0 AND passed <= total)
);

-- ------------------------------------------------------------ agent runtime ---
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  ref TEXT NOT NULL,
  skill_key TEXT NOT NULL,
  skill_version TEXT NOT NULL,
  orchestration_id TEXT,
  entity_id TEXT,
  period_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'budget_exceeded')),
  mode TEXT NOT NULL CHECK (mode IN ('offline', 'live')),
  model TEXT,
  autonomy_level TEXT NOT NULL CHECK (autonomy_level IN ('L0', 'L1', 'L2', 'L3')),
  policy_version INT NOT NULL,
  requested_by TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  input JSONB NOT NULL DEFAULT '{}'::jsonb, -- @json Record<string, unknown>
  summary JSONB NOT NULL DEFAULT '{}'::jsonb, -- @json RunSummary
  budget JSONB NOT NULL, -- @json RunBudget
  steps_used INT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  cost_micros BIGINT NOT NULL DEFAULT 0,
  attempts INT NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, ref)
);
CREATE INDEX agent_runs_status_idx ON agent_runs (tenant_id, status);
CREATE INDEX agent_runs_orch_idx ON agent_runs (tenant_id, orchestration_id);

CREATE TABLE agent_steps (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  seq INT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('plan', 'act', 'observe', 'verify', 'propose', 'route', 'post', 'audit', 'summarize')),
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'skipped')),
  title TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb, -- @json Record<string, unknown>
  idempotency_key TEXT NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cost_micros BIGINT NOT NULL DEFAULT 0,
  duration_ms INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE (run_id, seq),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE agent_tool_calls (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  step_id TEXT NOT NULL REFERENCES agent_steps(id),
  seq INT NOT NULL,
  tool TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('read', 'propose')),
  input JSONB NOT NULL, -- @json Record<string, unknown>
  output JSONB, -- @json unknown
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'denied')),
  error TEXT,
  untrusted_flags JSONB NOT NULL DEFAULT '[]'::jsonb, -- @json InjectionFlag[]
  duration_ms INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

-- Live-mode transcript, persisted append-only so a crashed run resumes mid-conversation.
CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  seq INT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content JSONB NOT NULL, -- @json unknown
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

-- Every agent output a human can act on (AX-AGT-01: why + confidence + evidence are mandatory)
CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  ref TEXT NOT NULL,
  run_id TEXT REFERENCES agent_runs(id),
  skill_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('journal_entry', 'coding', 'rec_match', 'reconciling_item', 'flux_explanation', 'finding', 'schedule_update')),
  ontology_type TEXT NOT NULL,
  entity_id TEXT,
  period_key TEXT,
  title TEXT NOT NULL,
  why TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL,
  amount_minor BIGINT NOT NULL DEFAULT 0,
  currency TEXT,
  materiality TEXT NOT NULL CHECK (materiality IN ('trivial', 'below_pm', 'material')),
  payload JSONB NOT NULL, -- @json ProposalPayload
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb, -- @json EvidenceRef[]
  verification JSONB NOT NULL DEFAULT '[]'::jsonb, -- @json VerificationResult[]
  flags JSONB NOT NULL DEFAULT '[]'::jsonb, -- @json string[]
  status TEXT NOT NULL CHECK (status IN ('suggested', 'pending_approval', 'approved', 'auto_approved', 'applied', 'rejected', 'superseded', 'failed')),
  autonomy_level TEXT NOT NULL CHECK (autonomy_level IN ('L0', 'L1', 'L2', 'L3')),
  route TEXT NOT NULL CHECK (route IN ('suggestion', 'human_approval', 'auto_post_sampled', 'auto_post')),
  review_status TEXT NOT NULL DEFAULT 'none' CHECK (review_status IN ('none', 'pending', 'reviewed')),
  assigned_role TEXT,
  assigned_to TEXT,
  prepared_by TEXT NOT NULL,
  requested_by TEXT,
  edited_by TEXT,
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  decision_reason TEXT,
  applied_ref_type TEXT,
  applied_ref_id TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, ref),
  CHECK (confidence >= 0 AND confidence <= 1),
  CHECK (length(why) >= 12),
  CHECK (amount_minor >= 0),
  CHECK (status <> 'rejected' OR decision_reason IS NOT NULL),
  CHECK (decided_by IS NULL OR decided_by <> prepared_by)
);
CREATE INDEX proposals_status_idx ON proposals (tenant_id, status);
CREATE INDEX proposals_run_idx ON proposals (run_id);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'reviewed')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'policy')),
  actor_id TEXT NOT NULL,
  policy_ref TEXT,
  reason TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (actor_type <> 'policy' OR policy_ref IS NOT NULL)
);
CREATE INDEX approvals_subject_idx ON approvals (tenant_id, subject_type, subject_id);

-- --------------------------------------------------- evidence & provenance ---
CREATE TABLE connectors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bank_feed', 'card_feed', 'erp_gl', 'ap', 'ar', 'payroll')),
  format TEXT NOT NULL CHECK (format IN ('bai2', 'camt053', 'ofx', 'csv', 'json')),
  name TEXT NOT NULL,
  entity_id TEXT,
  config JSONB NOT NULL DEFAULT '{}'::jsonb, -- @json Record<string, unknown>
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  last_import_at TIMESTAMPTZ,
  UNIQUE (tenant_id, key)
);

-- Raw source documents; content_hash makes re-imports idempotent.
CREATE TABLE source_documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  connector_id TEXT REFERENCES connectors(id),
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_by TEXT NOT NULL,
  UNIQUE (tenant_id, content_hash)
);

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  connector_id TEXT NOT NULL REFERENCES connectors(id),
  source_document_id TEXT NOT NULL REFERENCES source_documents(id),
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed', 'duplicate')),
  records_total INT NOT NULL DEFAULT 0,
  records_created INT NOT NULL DEFAULT 0,
  records_skipped INT NOT NULL DEFAULT 0,
  records_failed INT NOT NULL DEFAULT 0,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb, -- @json ImportError[]
  imported_by TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('source_document', 'file', 'note', 'computation', 'link')),
  title TEXT NOT NULL,
  mime TEXT,
  content TEXT,
  source_document_id TEXT REFERENCES source_documents(id),
  content_hash TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX evidence_subject_idx ON evidence (tenant_id, subject_type, subject_id);
