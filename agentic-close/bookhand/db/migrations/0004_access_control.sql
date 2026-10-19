-- 0004_access_control.sql
-- GENERATED from src/persistence/schema by `npm run db:generate`. Do not edit by hand:
-- tests/unit/ddl.test.ts fails if this file drifts from the schema.

CREATE TABLE "access_requests" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "target_user_id" uuid,
  "sod_rule_id" uuid,
  "payload" jsonb NOT NULL,
  "summary" text NOT NULL,
  "reason" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "requested_by" uuid NOT NULL,
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "decided_by" uuid,
  "decided_at" timestamptz,
  "decision_reason" text,
  CONSTRAINT "access_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "access_requests_kind_check" CHECK ("kind" IN ('role_grant', 'sod_rule_change')),
  CONSTRAINT "access_requests_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected', 'superseded')),
  CONSTRAINT "access_request_maker_checker" CHECK (decided_by IS NULL OR decided_by IS DISTINCT FROM requested_by),
  CONSTRAINT "access_request_not_own_grant" CHECK (decided_by IS NULL OR decided_by IS DISTINCT FROM target_user_id),
  CONSTRAINT "access_request_subject" CHECK ((kind = 'role_grant' AND target_user_id IS NOT NULL) OR (kind = 'sod_rule_change' AND sod_rule_id IS NOT NULL))
);

CREATE TABLE "credential_tokens" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "purpose" text NOT NULL,
  "token_hash" text NOT NULL,
  "created_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "revoked_at" timestamptz,
  CONSTRAINT "credential_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credential_tokens_purpose_check" CHECK ("purpose" IN ('enrolment', 'password_reset')),
  CONSTRAINT "credential_tokens_token_hash_key" UNIQUE ("token_hash")
);

CREATE TABLE "outbox_messages" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "to_user_id" uuid,
  "to_email" text NOT NULL,
  "kind" text NOT NULL,
  "subject" text NOT NULL,
  "body" text NOT NULL,
  "link" text,
  "transport" text NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "delivered_at" timestamptz,
  "opened_count" integer NOT NULL DEFAULT 0,
  "last_opened_at" timestamptz,
  CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outbox_messages_kind_check" CHECK ("kind" IN ('enrolment', 'password_reset', 'account_locked')),
  CONSTRAINT "outbox_messages_status_check" CHECK ("status" IN ('queued', 'delivered', 'failed'))
);

-- Foreign keys (added after all tables exist; circular references are allowed)
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users" ("id") ON DELETE CASCADE;
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_sod_rule_id_fkey" FOREIGN KEY ("sod_rule_id") REFERENCES "sod_rules" ("id") ON DELETE CASCADE;
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users" ("id") ON DELETE RESTRICT;
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users" ("id") ON DELETE RESTRICT;
ALTER TABLE "credential_tokens" ADD CONSTRAINT "credential_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "credential_tokens" ADD CONSTRAINT "credential_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE;
ALTER TABLE "credential_tokens" ADD CONSTRAINT "credential_tokens_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users" ("id") ON DELETE CASCADE;

-- Indexes
CREATE INDEX "access_requests_tenant_id_status_idx" ON "access_requests" ("tenant_id", "status");
CREATE INDEX "access_requests_target_user_id_idx" ON "access_requests" ("target_user_id");
CREATE INDEX "access_requests_sod_rule_id_idx" ON "access_requests" ("sod_rule_id");
CREATE INDEX "access_requests_requested_by_idx" ON "access_requests" ("requested_by");
CREATE INDEX "access_requests_decided_by_idx" ON "access_requests" ("decided_by");
CREATE INDEX "credential_tokens_user_id_idx" ON "credential_tokens" ("user_id");
CREATE INDEX "credential_tokens_tenant_id_idx" ON "credential_tokens" ("tenant_id");
CREATE INDEX "credential_tokens_created_by_idx" ON "credential_tokens" ("created_by");
CREATE INDEX "outbox_messages_tenant_id_to_email_idx" ON "outbox_messages" ("tenant_id", "to_email");
CREATE INDEX "outbox_messages_to_user_id_idx" ON "outbox_messages" ("to_user_id");

-- Documentation
COMMENT ON TABLE "access_requests" IS 'A change to access or controls held for a second person: a role grant that carries approval authority, or a segregation-of-duties rule change. Applied only when someone other than the requester and the grantee approves it.';
COMMENT ON TABLE "credential_tokens" IS 'Single-use, expiring enrolment or password-reset link for one person; only its hash is stored and nobody but the addressee receives it.';
COMMENT ON TABLE "outbox_messages" IS 'Messages Bookhand sends people (enrolment and reset links, lockout notices), queued for the configured transport; a demo organization reads them in its delivery log.';
