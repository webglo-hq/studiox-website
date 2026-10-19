-- =============================================================================
-- Tieout migration 0004: two-factor recovery codes
--
-- Ten one-time codes are issued when two-factor authentication is switched on, for when the
-- authenticator app is lost. Only SHA-256 hashes are stored, a code works once, and issuing a
-- new set (or an administrator's two-factor reset) removes the old ones.
-- =============================================================================

CREATE TABLE mfa_recovery_codes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ,
  UNIQUE (user_id, code_hash)
);
CREATE INDEX mfa_recovery_codes_user ON mfa_recovery_codes (user_id);

-- tenant isolation, as for every tenant table (migration 0003)
ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_recovery_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mfa_recovery_codes
  USING (tenant_id = current_setting('tieout.tenant_id', true) OR current_setting('tieout.bypass', true) = 'on')
  WITH CHECK (tenant_id = current_setting('tieout.tenant_id', true) OR current_setting('tieout.bypass', true) = 'on');
