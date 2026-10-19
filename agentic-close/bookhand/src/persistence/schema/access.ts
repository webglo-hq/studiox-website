import { c, check, table } from '../dsl';

/**
 * Access control added after the independent review (generated into db/migrations/0004_access_control.sql):
 * dual control over grants that carry approval authority and over SoD rules, single-use enrolment and reset
 * links instead of passwords handed to administrators, and the outbox that delivers those links to people.
 */

const AREA = 'Tenancy & security';
const MIGRATION = '0004';

export const accessRequests = table(
  'access_requests',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    kind: c.enum(['role_grant', 'sod_rule_change'] as const),
    /** The person whose roles change (role_grant). */
    target_user_id: c.uuid().nullable().references('users', 'cascade'),
    /** The rule that changes (sod_rule_change). */
    sod_rule_id: c.uuid().nullable().references('sod_rules', 'cascade'),
    /** role_grant: { grants: [{ role, entityId }] } to add; sod_rule_change: { before, after }. */
    payload: c.json<Record<string, unknown>>(),
    summary: c.text(),
    reason: c.text(),
    status: c.enum(['pending', 'approved', 'rejected', 'superseded'] as const).default('pending'),
    requested_by: c.uuid().references('users'),
    requested_at: c.timestamp().defaultNow(),
    decided_by: c.uuid().nullable().references('users'),
    decided_at: c.timestamp().nullable(),
    decision_reason: c.text().nullable(),
  },
  {
    area: AREA,
    migration: MIGRATION,
    description: 'A change to access or controls held for a second person: a role grant that carries approval authority, or a segregation-of-duties rule change. Applied only when someone other than the requester and the grantee approves it.',
    ontologyClass: 'bh:AccessRequest',
    indexes: [['tenant_id', 'status']],
    checks: [
      check('access_request_maker_checker', 'decided_by IS NULL OR decided_by IS DISTINCT FROM requested_by', (r) => r.decided_by == null || r.decided_by !== r.requested_by, 'maker-checker: whoever requested an access change cannot decide it'),
      check('access_request_not_own_grant', 'decided_by IS NULL OR decided_by IS DISTINCT FROM target_user_id', (r) => r.decided_by == null || r.decided_by !== r.target_user_id, 'nobody decides a grant of roles to themselves'),
      check(
        'access_request_subject',
        "(kind = 'role_grant' AND target_user_id IS NOT NULL) OR (kind = 'sod_rule_change' AND sod_rule_id IS NOT NULL)",
        (r) => (r.kind === 'role_grant' && r.target_user_id != null) || (r.kind === 'sod_rule_change' && r.sod_rule_id != null),
        'a role grant names its grantee and a rule change names its rule',
      ),
    ],
  },
);

export const credentialTokens = table(
  'credential_tokens',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    user_id: c.uuid().references('users', 'cascade'),
    purpose: c.enum(['enrolment', 'password_reset'] as const),
    /** SHA-256 of the single-use secret; the secret itself only travels in the message to the person. */
    token_hash: c.text().unique(),
    created_by: c.uuid().nullable().references('users', 'set null'),
    created_at: c.timestamp().defaultNow(),
    expires_at: c.timestamp(),
    used_at: c.timestamp().nullable(),
    revoked_at: c.timestamp().nullable(),
  },
  {
    area: AREA,
    migration: MIGRATION,
    description: 'Single-use, expiring enrolment or password-reset link for one person; only its hash is stored and nobody but the addressee receives it.',
    ontologyClass: 'bh:CredentialLink',
    indexes: [['user_id']],
  },
);

export const outboxMessages = table(
  'outbox_messages',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    to_user_id: c.uuid().nullable().references('users', 'cascade'),
    to_email: c.text(),
    kind: c.enum(['enrolment', 'password_reset', 'account_locked'] as const),
    subject: c.text(),
    body: c.text(),
    /** The addressee's single-use link, readable only in a demo organization's delivery log; cleared once a real transport sends it. */
    link: c.text().nullable(),
    transport: c.text(),
    status: c.enum(['queued', 'delivered', 'failed'] as const).default('queued'),
    created_at: c.timestamp().defaultNow(),
    delivered_at: c.timestamp().nullable(),
    opened_count: c.int().default(0),
    last_opened_at: c.timestamp().nullable(),
  },
  {
    area: AREA,
    migration: MIGRATION,
    description: 'Messages Bookhand sends people (enrolment and reset links, lockout notices), queued for the configured transport; a demo organization reads them in its delivery log.',
    ontologyClass: 'bh:OutboxMessage',
    indexes: [['tenant_id', 'to_email']],
  },
);
