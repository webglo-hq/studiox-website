-- Evenkeel 0004: fixes from the independent review (2026-10-19).

-- Maker-checker for manual entries (ontology AX-SOD-01). A person-prepared entry posts only with
-- an approver, who (ek_je_guard checks) is neither its preparer nor its requester. A reversal
-- that mirrors a posted entry (ek_je_guard, EK-JE-02) carries no new judgement and is exempt.
CREATE OR REPLACE FUNCTION ek_je_manual_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'posted' AND (TG_OP = 'INSERT' OR OLD.status <> 'posted')
     AND NEW.source = 'manual' AND NEW.approved_by IS NULL
     AND NOT (NEW.entry_type = 'reversing' AND NEW.reverses_entry_id IS NOT NULL) THEN
    RAISE EXCEPTION 'EK-SOD-01: manual entry % needs an approver other than its preparer before it posts', NEW.entry_number;
  END IF;
  RETURN NEW;
END $$;

-- Fires after journal_entry_guard (triggers run in name order), so balance and period errors win.
CREATE TRIGGER journal_entry_manual_approval
  BEFORE INSERT OR UPDATE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION ek_je_manual_approval();

-- The CFO approves material items of every kind, including entries and reconciliation items
-- (role definitions in src/packs/accounting/domain/rbac.ts; databases seeded earlier catch up here).
INSERT INTO role_permission (role_id, permission)
SELECT r.id, p.permission
  FROM role r CROSS JOIN (VALUES ('je.approve'), ('rec.review')) AS p(permission)
 WHERE r.code = 'cfo'
ON CONFLICT (role_id, permission) DO NOTHING;
