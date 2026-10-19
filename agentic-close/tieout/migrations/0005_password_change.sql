-- =============================================================================
-- Tieout migration 0005: temporary passwords are replaced at the next sign-in
--
-- Set when an administrator invites a person or issues a temporary password. Until the person
-- chooses a new password, their session can only do that (or sign out).
-- =============================================================================

ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false;
