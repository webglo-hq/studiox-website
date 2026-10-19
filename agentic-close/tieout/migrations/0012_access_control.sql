-- =============================================================================
-- Tieout migration 0012: nobody can mint an approver alone
--
-- 1. Credentials never pass through an administrator. Inviting someone or resetting their
--    password creates a single-use, expiring link (only its SHA-256 is stored) and sends it to the
--    person through the outbox; the administrator sees that it was sent, never the link.
-- 2. The outbox holds every message to a person, its body sealed with the application key
--    (AES-256-GCM): an email relay sends it, or, in the demo, the person reads it in the demo
--    mailbox, where opening it is recorded.
-- 3. Two people for authority: a grant that confers approval authority, or any change to a
--    segregation-of-duties rule, is a request until a second person with sufficient authority
--    approves it. The database refuses a request decided by its requester, or by the person it
--    grants access to.
-- =============================================================================

CREATE TABLE credential_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('enrolment', 'password_reset')),
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CHECK (expires_at > created_at)
);
CREATE INDEX credential_links_user ON credential_links (user_id);

CREATE TABLE outbox_messages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  to_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  to_address TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('enrolment', 'password_reset', 'access_request')),
  subject TEXT NOT NULL,
  body_sealed TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('demo_mailbox', 'email')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'failed')),
  created_at TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ
);
CREATE INDEX outbox_messages_to ON outbox_messages (tenant_id, to_address);

CREATE TABLE access_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('role_grant', 'sod_rule')),
  subject_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  change JSONB NOT NULL, -- @json AccessChange
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES users(id),
  requested_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'superseded')),
  decided_by TEXT REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  UNIQUE (tenant_id, ref),
  -- two different people: the requester never decides, and nobody approves access for themselves
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK (decided_by IS NULL OR subject_user_id IS NULL OR decided_by <> subject_user_id),
  CHECK (status <> 'approved' OR decided_by IS NOT NULL)
);
CREATE INDEX access_requests_status ON access_requests (tenant_id, status);

-- tenant isolation, as for every tenant table (migrations 0003 and 0010)
ALTER TABLE credential_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON credential_links USING (tenant_id = current_setting('tieout.tenant_id', true)) WITH CHECK (tenant_id = current_setting('tieout.tenant_id', true));
ALTER TABLE outbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON outbox_messages USING (tenant_id = current_setting('tieout.tenant_id', true)) WITH CHECK (tenant_id = current_setting('tieout.tenant_id', true));
ALTER TABLE access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON access_requests USING (tenant_id = current_setting('tieout.tenant_id', true)) WITH CHECK (tenant_id = current_setting('tieout.tenant_id', true));

-- a link is opened before anyone is signed in: the directory names its tenant (by token hash)
ALTER TABLE tenant_directory DROP CONSTRAINT tenant_directory_id_check;
ALTER TABLE tenant_directory ADD CONSTRAINT tenant_directory_id_check CHECK (id ~ '^(user_email|session|api_token|credential_link):.+$');
CREATE TRIGGER credential_links_directory AFTER INSERT OR DELETE OR UPDATE OF token_hash ON credential_links
  FOR EACH ROW EXECUTE FUNCTION tieout_directory_sync('credential_link', 'token_hash');
