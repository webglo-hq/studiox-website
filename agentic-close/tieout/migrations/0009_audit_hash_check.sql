-- =============================================================================
-- Tieout migration 0009: the database recomputes every audit hash (AX-AUD-01)
--
-- The insert trigger checked only the sequence and the link to the previous hash, so a forged
-- event that continued the chain with a made-up hash was stored, to be caught only by the next
-- verification. It now recomputes the hash exactly as src/core/audit/chain.ts does —
--   SHA-256( prev_hash || "\n" || canonical_json(event without its hash fields) )
-- with canonical JSON as in src/core/util/json.ts (keys sorted, no whitespace, numbers and
-- strings written as JavaScript writes them) — and refuses the row when they differ.
-- =============================================================================

-- A JSON number as JavaScript prints it: plain digits from 1e-6 up to 1e21, exponent form outside.
CREATE OR REPLACE FUNCTION tieout_js_number(n NUMERIC) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  a NUMERIC := abs(n);
  t TEXT;
  int_part TEXT;
  frac TEXT;
  digits TEXT;
  e INT;
BEGIN
  IF a = 0 THEN
    RETURN '0';
  END IF;
  IF a >= 0.000001 AND a < 1e21 THEN
    RETURN trim_scale(n)::text;
  END IF;
  t := trim_scale(a)::text;
  int_part := split_part(t, '.', 1);
  frac := split_part(t, '.', 2);
  IF a < 1 THEN
    e := -(length(frac) - length(ltrim(frac, '0')) + 1);
    digits := ltrim(frac, '0');
  ELSE
    e := length(int_part) - 1;
    digits := rtrim(int_part || frac, '0');
  END IF;
  RETURN CASE WHEN n < 0 THEN '-' ELSE '' END
    || left(digits, 1) || CASE WHEN length(digits) > 1 THEN '.' || substr(digits, 2) ELSE '' END
    || 'e' || CASE WHEN e > 0 THEN '+' ELSE '-' END || abs(e)::text;
END;
$$;

-- canonical JSON of a jsonb value: object keys sorted, no whitespace
CREATE OR REPLACE FUNCTION tieout_canonical_json(j JSONB) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  out TEXT;
  k TEXT;
  v JSONB;
  first BOOLEAN := true;
BEGIN
  CASE jsonb_typeof(j)
    WHEN 'object' THEN
      out := '{';
      FOR k, v IN SELECT key, value FROM jsonb_each(j) ORDER BY key COLLATE "C" LOOP
        out := out || CASE WHEN first THEN '' ELSE ',' END || to_json(k)::text || ':' || tieout_canonical_json(v);
        first := false;
      END LOOP;
      RETURN out || '}';
    WHEN 'array' THEN
      RETURN '[' || coalesce((SELECT string_agg(tieout_canonical_json(e), ',' ORDER BY i) FROM jsonb_array_elements(j) WITH ORDINALITY AS x(e, i)), '') || ']';
    WHEN 'number' THEN
      RETURN tieout_js_number((j #>> '{}')::numeric);
    ELSE
      RETURN j::text; -- string (escaped as JSON.stringify does), boolean or null
  END CASE;
END;
$$;

CREATE OR REPLACE FUNCTION tieout_audit_hash(r audit_log) RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(r.prev_hash || E'\n'
    || '{"action":' || to_json(r.action)::text
    || ',"actor_id":' || to_json(r.actor_id)::text
    || ',"actor_label":' || to_json(r.actor_label)::text
    || ',"actor_type":' || to_json(r.actor_type)::text
    || ',"at":' || to_json(to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text
    || ',"data":' || tieout_canonical_json(r.data)
    || ',"entity_id":' || coalesce(to_json(r.entity_id)::text, 'null')
    || ',"id":' || to_json(r.id)::text
    || ',"ip":' || coalesce(to_json(r.ip)::text, 'null')
    || ',"on_behalf_of":' || coalesce(to_json(r.on_behalf_of)::text, 'null')
    || ',"seq":' || r.seq::text
    || ',"subject_id":' || to_json(r.subject_id)::text
    || ',"subject_type":' || to_json(r.subject_type)::text
    || ',"summary":' || to_json(r.summary)::text
    || ',"tenant_id":' || to_json(r.tenant_id)::text
    || '}', 'UTF8')), 'hex')
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
  IF NEW.hash IS DISTINCT FROM tieout_audit_hash(NEW) THEN
    RAISE EXCEPTION 'AX-AUD-01: audit event % does not match its hash', NEW.seq
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
