-- Evenkeel 0003: two-step sign-in replay protection and a sign-in history.

-- Last accepted TOTP time step per user; a code from the same (or an earlier) step is a replay.
ALTER TABLE app_user ADD COLUMN mfa_last_step bigint;

-- Every sign-in attempt, successful or not (for lockout review and the security page).
CREATE TABLE login_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenant(id),
  email text NOT NULL,
  user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  ok boolean NOT NULL,
  reason text NOT NULL CONSTRAINT login_attempt_reason_check CHECK (reason IN ('ok','bad_credentials','locked','disabled','rate_limited','mfa_required','mfa_failed','mfa_ok')),
  ip text,
  user_agent text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempt_email_idx ON login_attempt(email, occurred_at);
