-- =============================================================================
-- Tieout migration 0007: what a variance explanation covers
--
-- An explanation is written for one variance: this month's figure against the comparison month's.
-- Both are stored with it. When the ledger moves either one, the explanation is stale: it no longer
-- counts toward the lock (AX-FLX-01) and the close package will not carry it, until someone
-- explains the variance as it now stands.
-- =============================================================================

ALTER TABLE flux_explanations ADD COLUMN covered_current_minor BIGINT;
ALTER TABLE flux_explanations ADD COLUMN covered_comparative_minor BIGINT;

-- explanations written before this migration cover the figures their flux line recorded
UPDATE flux_explanations x
   SET covered_current_minor = l.current_minor, covered_comparative_minor = l.comparative_minor
  FROM flux_lines l
 WHERE l.id = x.flux_line_id AND x.covered_current_minor IS NULL;
