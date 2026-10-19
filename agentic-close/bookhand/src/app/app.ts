import { AgentRuntime } from '../agents/framework/runtime';
import type { LlmClient } from '../agents/llm/types';
import type { Db, Tx } from '../persistence/db';
import { accountingPack, registerSkills } from '../packs/accounting/pack';
import { buildAccountingScope, type AccountingScope } from '../packs/accounting/scope';
import { LedgerLookups } from '../packs/accounting/domain/lookups';
import { ROLES } from '../security/permissions';
import type { Principal } from '../security/principal';
import { SecretBox } from '../security/secretbox';
import type { Actor, Clock, DomainContext } from '../shared/context';
import { DomainError } from '../shared/errors';
import type { OutboxTransport } from './outbox';
import { RunQueue } from './runner';

/**
 * Application layer: one object that wires persistence, the agent runtime and the accounting pack, and turns
 * an authenticated principal into a domain context. HTTP routes, the MCP server, the in-browser demo and the
 * tests all call the same use cases through it, so authorization and auditing are identical everywhere.
 */

export interface AppConfig {
  mode: 'server' | 'demo';
  /** Deployment secret for encrypting secrets at rest (TOTP seeds). */
  secretKey: string;
  publicOrigin?: string | null;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  /** Cookie Secure flag (true behind HTTPS). */
  secureCookies: boolean;
  demoPassword?: string | null;
  /** Message transport for real organizations (enrolment and reset links); demo organizations use their delivery log. */
  outbox?: OutboxTransport | null;
}

export interface RequestMeta {
  requestId?: string;
  ip?: string;
  userAgent?: string;
  /** How the request arrived: the web app (session cookie), an API client or the MCP server (access token). */
  channel?: 'web' | 'api' | 'mcp';
}

export class App {
  readonly runtime: AgentRuntime<AccountingScope>;
  readonly queue: RunQueue;
  readonly secrets: SecretBox;
  private businessDate: string;

  constructor(
    readonly db: Db,
    readonly config: AppConfig,
    opts: { clock?: Partial<Clock>; llm?: LlmClient | null; businessDate?: string; log?: (m: string) => void } = {},
  ) {
    this.businessDate = opts.businessDate ?? new Date().toISOString().slice(0, 10);
    const now = opts.clock?.now ?? (() => new Date().toISOString());
    this.clock = { now, businessDate: () => this.businessDate };
    this.runtime = new AgentRuntime<AccountingScope>({ db, pack: accountingPack(), clock: this.clock, llm: opts.llm ?? null, log: opts.log });
    this.queue = new RunQueue(this.runtime as unknown as AgentRuntime<unknown>, opts.log);
    this.secrets = new SecretBox(config.secretKey, 'mfa-totp');
  }

  readonly clock: Clock;

  setBusinessDate(date: string): void {
    this.businessDate = date;
  }

  /** Load the tenant's scenario business date (demo data lives on a fixed calendar). */
  async syncBusinessDate(): Promise<void> {
    const tenant = (await this.db.read((tx) => tx.find('tenants', {}, { limit: 1 })))[0];
    if (tenant?.business_date) this.businessDate = tenant.business_date;
  }

  actorOf(p: Principal, meta: RequestMeta = {}): Actor {
    const via = meta.channel === 'mcp' ? ' (via MCP)' : meta.channel === 'api' ? ' (via API token)' : '';
    return { type: 'user', userId: p.user.id, label: `${p.user.display_name}${via}`, roleKeys: p.roleKeys, requestId: meta.requestId, ip: meta.ip };
  }

  ctx(p: Principal, meta: RequestMeta = {}): DomainContext {
    return { db: this.db, tenantId: p.tenantId, actor: this.actorOf(p, meta), clock: this.clock };
  }

  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.tx(fn);
  }

  read<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.read(fn);
  }

  scope(tx: Tx, ctx: DomainContext): Promise<AccountingScope> {
    return buildAccountingScope(tx, ctx);
  }

  lookups(tx: Tx, tenantId: string): Promise<LedgerLookups> {
    return LedgerLookups.load(tx, tenantId);
  }

  get liveModel(): string | null {
    return this.runtime.llm?.model ?? null;
  }

  /** Bring the system roles in line with their definitions in code (idempotent; runs at start-up). */
  async ensureRoles(): Promise<void> {
    await this.db.tx(async (tx) => {
      for (const [i, r] of ROLES.entries()) {
        const want = { name: r.name, description: r.description, permissions: r.permissions as string[], approval_limit_minor: r.approvalLimitMinor, is_read_only: !!r.readOnly, sort_order: i };
        const row = await tx.findOne('roles', { key: r.key });
        if (!row) await tx.insert('roles', { key: r.key, ...want });
        else if (row.name !== want.name || row.description !== want.description || JSON.stringify(row.permissions) !== JSON.stringify(want.permissions) || row.approval_limit_minor !== want.approval_limit_minor || row.is_read_only !== want.is_read_only) {
          await tx.update('roles', row.id, want);
        }
      }
    });
  }

  /** Publish skills and install default policies for every tenant (idempotent; runs at start-up). */
  async ensureSkills(): Promise<void> {
    const tenants = await this.db.read((tx) => tx.find('tenants', {}));
    for (const t of tenants) await this.db.tx((tx) => registerSkills(tx, t.id, this.runtime.listSkills(), this.clock.now()));
  }

  notFound(what: string): never {
    throw new DomainError('NOT_FOUND', `${what} not found`);
  }
}
