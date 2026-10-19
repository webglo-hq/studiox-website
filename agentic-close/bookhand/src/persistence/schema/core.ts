import { c, check, nnd, table } from '../dsl';

const AREA = 'Tenancy & security';

export const tenants = table(
  'tenants',
  {
    id: c.id(),
    name: c.text(),
    slug: c.text().unique(),
    reporting_currency: c.currency(),
    fiscal_year_start_month: c.int().default(1).check('BETWEEN 1 AND 12', (v) => v >= 1 && v <= 12),
    /** Scenario business date for the close calendar (null = use the real date). */
    business_date: c.date().nullable(),
    is_demo: c.bool().default(false),
    settings: c.json<Record<string, unknown>>().default({}),
    created_at: c.timestamp().defaultNow(),
  },
  { area: AREA, description: 'A customer organization. Every business row is scoped to one tenant.', ontologyClass: 'bh:Organization' },
);

export const entities = table(
  'entities',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    code: c.text(),
    name: c.text(),
    legal_name: c.text(),
    kind: c.enum(['operating', 'elimination'] as const).default('operating'),
    functional_currency: c.currency(),
    country: c.text(),
    parent_entity_id: c.uuid().nullable().references('entities'),
    ownership_pct: c.numeric(7, 4).default(100),
    status: c.enum(['active', 'inactive'] as const).default('active'),
    created_at: c.timestamp().defaultNow(),
  },
  {
    area: AREA,
    description: 'A legal or reporting entity with its own functional currency and set of books.',
    ontologyClass: 'bh:ReportingEntity',
    uniques: [['tenant_id', 'code']],
  },
);

export const users = table(
  'users',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    email: c.text().check('= lower(email)', (v) => v === v.toLowerCase()),
    display_name: c.text(),
    title: c.text().nullable(),
    password_hash: c.text().nullable(),
    identity_provider: c.enum(['password', 'oidc', 'saml'] as const).default('password'),
    external_subject: c.text().nullable(),
    status: c.enum(['active', 'disabled'] as const).default('active'),
    mfa_enabled: c.bool().default(false),
    mfa_secret_enc: c.text().nullable(),
    mfa_pending_secret_enc: c.text().nullable(),
    failed_login_count: c.int().default(0),
    locked_until: c.timestamp().nullable(),
    last_login_at: c.timestamp().nullable(),
    avatar_hue: c.int().default(210),
    created_at: c.timestamp().defaultNow(),
    updated_at: c.timestamp().defaultNow(),
  },
  {
    area: AREA,
    description: 'A person who signs in. Passwords are scrypt hashes (PHC string); TOTP seeds are encrypted at rest.',
    ontologyClass: 'bh:Person',
    uniques: [['tenant_id', 'email'], ['tenant_id', 'identity_provider', 'external_subject']],
  },
);

export const roles = table(
  'roles',
  {
    id: c.id(),
    key: c.text().unique(),
    name: c.text(),
    description: c.text(),
    /** Permission codes granted (see security/permissions.ts). */
    permissions: c.json<string[]>().default([]),
    /** Max absolute amount (minor units, reporting currency) this role may approve; null = unlimited. */
    approval_limit_minor: c.money().nullable(),
    is_read_only: c.bool().default(false),
    sort_order: c.int().default(0),
  },
  { area: AREA, description: 'A named bundle of permissions with an approval limit (RBAC).', ontologyClass: 'bh:Role' },
);

export const userRoles = table(
  'user_roles',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    user_id: c.uuid().references('users', 'cascade'),
    role_id: c.uuid().references('roles'),
    /** Optional entity scope; null = all entities of the tenant. */
    entity_id: c.uuid().nullable().references('entities'),
    granted_by: c.uuid().nullable().references('users', 'set null'),
    granted_at: c.timestamp().defaultNow(),
  },
  {
    area: AREA,
    description: 'Role assignment, optionally scoped to one entity.',
    uniques: [nnd('user_id', 'role_id', 'entity_id')],
  },
);

export const sessions = table(
  'sessions',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    user_id: c.uuid().references('users', 'cascade'),
    /** SHA-256 of the opaque session token; the token itself is never stored. */
    token_hash: c.text().unique(),
    csrf_token: c.text(),
    auth_method: c.enum(['password', 'password+totp', 'oidc', 'saml', 'api_token'] as const),
    mfa_verified: c.bool().default(false),
    /** 'mfa_pending' sessions can only call the MFA verification endpoint. */
    state: c.enum(['active', 'mfa_pending'] as const).default('active'),
    created_at: c.timestamp().defaultNow(),
    last_seen_at: c.timestamp().defaultNow(),
    idle_expires_at: c.timestamp(),
    absolute_expires_at: c.timestamp(),
    rotated_at: c.timestamp().defaultNow(),
    revoked_at: c.timestamp().nullable(),
    revoked_reason: c.text().nullable(),
    rotated_from_id: c.uuid().nullable().references('sessions', 'set null'),
    ip: c.text().nullable(),
    user_agent: c.text().nullable(),
  },
  { area: AREA, description: 'Server-side session (cookie holds an opaque random token).', indexes: [['user_id']] },
);

export const apiTokens = table(
  'api_tokens',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    user_id: c.uuid().references('users', 'cascade'),
    name: c.text(),
    token_hash: c.text().unique(),
    scopes: c.json<string[]>().default([]),
    created_at: c.timestamp().defaultNow(),
    expires_at: c.timestamp().nullable(),
    last_used_at: c.timestamp().nullable(),
    revoked_at: c.timestamp().nullable(),
  },
  { area: AREA, description: 'Personal access token for API/MCP clients; acts with the owner\'s roles.' },
);

export const sodRules = table(
  'sod_rules',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    code: c.text(),
    name: c.text(),
    description: c.text(),
    kind: c.enum(['maker_checker', 'requester_limit', 'policy_author', 'vendor_master_payment', 'role_conflict'] as const),
    params: c.json<Record<string, unknown>>().default({}),
    severity: c.enum(['block', 'warn'] as const).default('block'),
    enabled: c.bool().default(true),
    version: c.int().default(1),
    updated_by: c.uuid().nullable().references('users', 'set null'),
    updated_at: c.timestamp().defaultNow(),
  },
  {
    area: AREA,
    description: 'Segregation-of-duties rule enforced by the runtime and checked by the JE review skill.',
    ontologyClass: 'bh:SegregationOfDutiesRule',
    uniques: [['tenant_id', 'code']],
  },
);

export const holidays = table(
  'holidays',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    holiday_date: c.date(),
    name: c.text(),
  },
  { area: AREA, description: 'Company holidays added to the bank-holiday calendar for workday math.', uniques: [['tenant_id', 'holiday_date']] },
);

export const idempotencyKeys = table(
  'idempotency_keys',
  {
    id: c.id(),
    tenant_id: c.uuid().references('tenants'),
    scope: c.text(),
    key: c.text(),
    request_hash: c.text(),
    status_code: c.int(),
    response: c.json<unknown>(),
    created_at: c.timestamp().defaultNow(),
  },
  {
    area: AREA,
    description: 'Stored responses for retried mutating requests (Idempotency-Key header).',
    uniques: [['tenant_id', 'scope', 'key']],
    checks: [check('idem_status', 'status_code BETWEEN 100 AND 599', (r) => Number(r.status_code) >= 100 && Number(r.status_code) <= 599, 'status code must be valid')],
  },
);
