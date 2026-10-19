-- =============================================================================
-- Tieout migration 0010: no row-level-security bypass
--
-- Migration 0003 let a transaction see every tenant by setting `tieout.bypass = on`, for the few
-- lookups that run before the tenant is known (sign-in by email, session and API-token
-- resolution). Any database session can set a custom setting, so the application role could
-- switch tenant isolation off for itself. The bypass is gone: those lookups now read a small
-- directory that holds only lookup keys (a sign-in email, a session id or an API-token hash, all
-- unique across tenants) and the tenant they belong to; the rows themselves are then read under
-- that tenant, through row-level security like everything else. Triggers keep the directory in
-- step with users, sessions and API tokens.
-- =============================================================================

-- the tenant-isolation policies still honour the old bypass while this migration backfills
SELECT set_config('tieout.bypass', 'on', true);

-- id is '<kind>:<lookup key>', e.g. 'user_email:sam@bramblewood.example' or 'session:<sha-256>'
CREATE TABLE tenant_directory (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  CHECK (id ~ '^(user_email|session|api_token):.+$')
);

INSERT INTO tenant_directory (id, tenant_id) SELECT 'user_email:' || email, tenant_id FROM users;
INSERT INTO tenant_directory (id, tenant_id) SELECT 'session:' || id, tenant_id FROM sessions;
INSERT INTO tenant_directory (id, tenant_id) SELECT 'api_token:' || token_hash, tenant_id FROM api_tokens;

-- TG_ARGV: the directory kind, and the column that holds its lookup key
CREATE OR REPLACE FUNCTION tieout_directory_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_key TEXT;
  new_key TEXT;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    old_key := to_jsonb(OLD) ->> TG_ARGV[1];
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    new_key := to_jsonb(NEW) ->> TG_ARGV[1];
  END IF;
  IF TG_OP = 'UPDATE' AND old_key IS NOT DISTINCT FROM new_key THEN
    RETURN NULL;
  END IF;
  IF old_key IS NOT NULL THEN
    DELETE FROM tenant_directory WHERE id = TG_ARGV[0] || ':' || old_key;
  END IF;
  IF new_key IS NOT NULL THEN
    INSERT INTO tenant_directory (id, tenant_id) VALUES (TG_ARGV[0] || ':' || new_key, NEW.tenant_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER users_directory AFTER INSERT OR DELETE OR UPDATE OF email ON users
  FOR EACH ROW EXECUTE FUNCTION tieout_directory_sync('user_email', 'email');
CREATE TRIGGER sessions_directory AFTER INSERT OR DELETE OR UPDATE OF id ON sessions
  FOR EACH ROW EXECUTE FUNCTION tieout_directory_sync('session', 'id');
CREATE TRIGGER api_tokens_directory AFTER INSERT OR DELETE OR UPDATE OF token_hash ON api_tokens
  FOR EACH ROW EXECUTE FUNCTION tieout_directory_sync('api_token', 'token_hash');

-- tenant isolation without the bypass, on every tenant table
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_policies WHERE schemaname = current_schema() AND policyname = 'tenant_isolation' LOOP
    EXECUTE format('DROP POLICY tenant_isolation ON %I', t.tablename);
    IF t.tablename = 'tenants' THEN
      EXECUTE 'CREATE POLICY tenant_isolation ON tenants USING (id = current_setting(''tieout.tenant_id'', true)) WITH CHECK (id = current_setting(''tieout.tenant_id'', true))';
    ELSE
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''tieout.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''tieout.tenant_id'', true))', t.tablename);
    END IF;
  END LOOP;
END
$$;
