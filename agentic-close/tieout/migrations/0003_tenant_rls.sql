-- =============================================================================
-- Tieout migration 0003: tenant isolation in the database (defence in depth)
--
-- The store already scopes every query to one tenant. Row-level security makes PostgreSQL
-- enforce the same boundary, so a missing filter in application code cannot leak another
-- tenant's rows. Each transaction declares its tenant with
--   SELECT set_config('tieout.tenant_id', <tenant>, true)
-- and the few cross-tenant system lookups (sign-in by email, session and API-token lookup)
-- declare `tieout.bypass = on` for their transaction only.
--
-- FORCE applies the policies to the table owner too. PostgreSQL superusers always bypass RLS,
-- so run the application as an ordinary role (see docs/decisions.md, ADR-012).
-- =============================================================================

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
    WHERE c.table_schema = current_schema() AND c.column_name = 'tenant_id'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''tieout.tenant_id'', true) OR current_setting(''tieout.bypass'', true) = ''on'') WITH CHECK (tenant_id = current_setting(''tieout.tenant_id'', true) OR current_setting(''tieout.bypass'', true) = ''on'')',
      t.table_name
    );
  END LOOP;
END
$$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = current_setting('tieout.tenant_id', true) OR current_setting('tieout.bypass', true) = 'on')
  WITH CHECK (id = current_setting('tieout.tenant_id', true) OR current_setting('tieout.bypass', true) = 'on');
