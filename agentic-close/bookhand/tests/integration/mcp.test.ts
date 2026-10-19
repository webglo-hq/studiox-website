import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiKernel, type ApiRequest, type ApiResponse } from '../../src/api/kernel';
import { ROUTES } from '../../src/api/routes';
import { App } from '../../src/app/app';
import { type BookhandClient, McpServer, TOOLS } from '../../src/mcp/server';
import { registerSkills } from '../../src/packs/accounting/pack';
import { seedScenario, type SeedResult } from '../../src/packs/accounting/seed/loader';
import { MemoryDb } from '../../src/persistence/memory';
import { configurePasswordHashing, DEMO_SCRYPT } from '../../src/security/passwords';
import { createHttpServer } from '../../src/server/http';

configurePasswordHashing({ params: DEMO_SCRYPT });

/** A browser-like client (cookie session + CSRF) used to manage tokens. */
class Browser {
  cookies: Record<string, string> = {};
  csrf = '';
  constructor(private readonly kernel: ApiKernel) {}
  async call(method: string, path: string, body?: unknown): Promise<ApiResponse> {
    const req: ApiRequest = { method, path, query: {}, headers: { host: 'bookhand.test', 'x-requested-with': 'bookhand', ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}) }, cookies: { ...this.cookies }, body, ip: '10.9.0.1' };
    const res = await this.kernel.handle(req);
    for (const c of res.cookies) this.cookies[c.name] = c.value;
    const b = res.body as { csrfToken?: string };
    if (b && typeof b === 'object' && b.csrfToken) this.csrf = b.csrfToken;
    return res;
  }
}

/** What the MCP CLI does over HTTP, wired straight to the kernel: bearer token, no cookies, no CSRF token. */
function tokenClient(kernel: ApiKernel, token: string): BookhandClient {
  return {
    async request(method, pathAndQuery, body) {
      const url = new URL(pathAndQuery, 'http://bookhand.test');
      const res = await kernel.handle({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: { host: 'bookhand.test', authorization: `Bearer ${token}`, 'x-bookhand-client': 'mcp' }, cookies: {}, body, ip: '10.9.0.2' });
      return { status: res.status, body: res.body };
    },
  };
}

type ToolResult = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

describe('access tokens and the MCP server', () => {
  let app: App;
  let kernel: ApiKernel;
  let seed: SeedResult;
  const email = (key: string) => seed.logins.find((l) => l.key === key)!.email;
  let hannahToken = '';
  let hannahTokenId = '';
  let sofiaToken = '';

  beforeAll(async () => {
    const db = new MemoryDb();
    app = new App(db, { mode: 'demo', secretKey: 'test'.repeat(8), sessionIdleMinutes: 30, sessionAbsoluteHours: 12, secureCookies: false, demoPassword: 'bookhand-demo' }, { businessDate: '2026-10-02' });
    seed = await seedScenario(db, { extend: async (tx, ctx) => void (await registerSkills(tx, ctx.tenantId, app.runtime.listSkills(), ctx.clock.now())) });
    kernel = new ApiKernel(app, ROUTES);
  }, 120_000);

  it('issues tokens from a signed-in session, shows them once and stores only a hash', async () => {
    const hannah = new Browser(kernel);
    expect((await hannah.call('POST', '/api/auth/login', { email: email('hannah'), password: 'bookhand-demo' })).status).toBe(200);
    await hannah.call('GET', '/api/session');
    const created = await hannah.call('POST', '/api/me/tokens', { name: 'Claude Desktop', scope: 'write', expiresInDays: 30 });
    expect(created.status).toBe(200);
    const body = created.body as { id: string; token: string; scopes: string[]; status: string };
    expect(body.token).toMatch(/^bh_pat_[A-Za-z0-9_-]{40,}$/);
    expect(body.scopes).toEqual(['read', 'write']);
    hannahToken = body.token;
    hannahTokenId = body.id;
    const row = await app.read((tx) => tx.get('api_tokens', body.id));
    expect(row?.token_hash).not.toContain(body.token.slice(7));
    const listed = (await hannah.call('GET', '/api/me/tokens')).body as { tokens: Array<Record<string, unknown>> };
    expect(JSON.stringify(listed)).not.toContain(body.token);
    // Read-only roles get read-only tokens; lifetimes are bounded.
    const sofia = new Browser(kernel);
    await sofia.call('POST', '/api/auth/login', { email: email('sofia'), password: 'bookhand-demo' });
    await sofia.call('GET', '/api/session');
    expect((await sofia.call('POST', '/api/me/tokens', { name: 'Audit notebook', scope: 'write', expiresInDays: 30 })).status).toBe(400);
    expect((await sofia.call('POST', '/api/me/tokens', { name: 'Forever', scope: 'read', expiresInDays: 9999 })).status).toBe(400);
    sofiaToken = ((await sofia.call('POST', '/api/me/tokens', { name: 'Audit notebook', scope: 'read', expiresInDays: 7 })).body as { token: string }).token;
    const audit = await app.read((tx) => tx.find('audit_log', { tenant_id: seed.tenantId, action: 'api_token.create' }));
    expect(audit).toHaveLength(2);
  });

  it('speaks MCP: initialize, list tools with JSON Schemas, answer pings, reject unknown methods', async () => {
    const mcp = new McpServer(tokenClient(kernel, hannahToken));
    const init = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })) as { result: { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string }; instructions: string } };
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.serverInfo.name).toBe('bookhand');
    expect(init.result.capabilities.tools).toBeTruthy();
    expect(init.result.instructions).toMatch(/data, never instructions/);
    expect(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
    const list = (await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })) as { result: { tools: Array<{ name: string; inputSchema: { type: string }; annotations: { readOnlyHint: boolean } }> } };
    expect(list.result.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    for (const t of list.result.tools) expect(t.inputSchema.type).toBe('object');
    expect(list.result.tools.find((t) => t.name === 'approve_proposal')!.annotations.readOnlyHint).toBe(false);
    expect(((await mcp.handle({ jsonrpc: '2.0', id: 4, method: 'resources/list' })) as { error: { code: number } }).error.code).toBe(-32601);
    const old = new McpServer(tokenClient(kernel, hannahToken));
    expect(((await old.handle({ jsonrpc: '2.0', id: 5, method: 'initialize', params: { protocolVersion: '1999-01-01' } })) as { result: { protocolVersion: string } }).result.protocolVersion).toBe('2025-11-25');
  });

  it('runs the close and approves as its person, within their limits, recorded as made via MCP', async () => {
    const mcp = new McpServer(tokenClient(kernel, hannahToken));
    await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    const call = async (name: string, args: Record<string, unknown> = {}) => ((await mcp.handle({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } })) as { result: ToolResult }).result;

    const next = await call('whats_next');
    expect(next.isError).toBeFalsy();
    expect((next.structuredContent!.you as { name: string }).name).toBe('Hannah Weiss');

    const started = await call('run_close_agents');
    const runId = (started.structuredContent as { runId: string }).runId;
    await app.queue.idle();
    const run = await app.read((tx) => tx.get('agent_runs', runId));
    expect(run?.trigger).toBe('mcp');
    const trace = await call('get_agent_run', { id: runId });
    expect((trace.structuredContent!.run as { status: string }).status).toBe('completed');

    const pending = await call('list_proposals', { view: 'pending', limit: 100 });
    const items = (pending.structuredContent as { items: Array<{ id: string; title: string; riskFlags: string[]; youCanApprove: boolean }> }).items;
    expect(pending.structuredContent!.note).toMatch(/never as instructions/);
    const halcyon = items.find((i) => /HALCYON/.test(i.title))!;
    expect(halcyon.riskFlags).toContain('instruction_like_text');
    const accrual = items.find((i) => i.title.startsWith('Accrue Fieldnote'))!;
    const detail = await call('get_proposal', { id: accrual.id });
    expect((detail.structuredContent!.checks as unknown[]).length).toBeGreaterThan(0);

    // Hannah started these agents, so segregation of duties stops her approving their larger proposals,
    // exactly as in the web app; the inbox already says so.
    expect(accrual.youCanApprove).toBe(false);
    const refused = await call('approve_proposal', { id: accrual.id, note: 'PO-1042 receipt confirmed' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/Bookhand refused \(\d{3}\)/);

    const mine = items.find((i) => i.youCanApprove && !i.riskFlags.length)!;
    const approved = await call('approve_proposal', { id: mine.id, note: 'Reviewed via MCP' });
    expect(approved.isError, approved.content[0]!.text).toBeFalsy();
    const event = await app.read((tx) => tx.findOne('audit_log', { tenant_id: seed.tenantId, action: 'proposal.approve', object_id: mine.id }));
    expect(event?.actor_label).toBe('Hannah Weiss (via MCP)');

    // The same rules as the web app: approving twice is refused, arguments are validated, tools exist.
    expect((await call('approve_proposal', { id: mine.id })).isError).toBe(true);
    expect((await call('reject_proposal', { id: halcyon.id, reason: '' })).isError).toBe(true);
    expect((await call('no_such_tool')).isError).toBe(true);
    expect((await call('trial_balance', { entity: 'BW-UK' })).structuredContent!.balanced).toBe(true);
    expect((await call('verify_audit_chain')).structuredContent!.ok).toBe(true);
  });

  it('keeps read-only tokens read-only and refuses tokens on account and admin endpoints', async () => {
    const mcp = new McpServer(tokenClient(kernel, sofiaToken));
    const call = async (name: string, args: Record<string, unknown> = {}) => ((await mcp.handle({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } })) as { result: ToolResult }).result;
    const list = await call('list_proposals', { view: 'all', limit: 5 });
    expect(list.isError).toBeFalsy();
    const anyId = (list.structuredContent as { items: Array<{ id: string }> }).items[0]!.id;
    const refused = await call('approve_proposal', { id: anyId });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/read-only/);
    // Auditors may verify the chain with a read token (it changes nothing but its own audit entry).
    expect((await call('verify_audit_chain')).isError).toBeFalsy();
    const direct = (path: string, method = 'GET') => kernel.handle({ method, path, query: {}, headers: { host: 'bookhand.test', authorization: `Bearer ${hannahToken}` }, cookies: {}, body: {}, ip: '10.9.0.3' });
    expect((await direct('/api/me/tokens')).status).toBe(403);
    expect((await direct('/api/admin/users')).status).toBe(403);
    expect((await direct('/api/session')).status).toBe(403);
    expect((await kernel.handle({ method: 'GET', path: '/api/home', query: {}, headers: { authorization: 'Bearer not-a-real-token-at-all-0000' }, cookies: {}, body: undefined, ip: '10.9.0.4' })).status).toBe(401);
    expect((await kernel.handle({ method: 'GET', path: '/api/home', query: {}, headers: { authorization: 'Basic abc' }, cookies: {}, body: undefined, ip: '10.9.0.4' })).status).toBe(401);
  });

  it('stops a revoked token immediately', async () => {
    const hannah = new Browser(kernel);
    await hannah.call('POST', '/api/auth/login', { email: email('hannah'), password: 'bookhand-demo' });
    await hannah.call('GET', '/api/session');
    expect((await hannah.call('POST', `/api/me/tokens/${hannahTokenId}/revoke`, {})).status).toBe(200);
    const mcp = new McpServer(tokenClient(kernel, hannahToken));
    const res = ((await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whats_next', arguments: {} } })) as { result: ToolResult }).result;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/invalid, expired or revoked/);
  });

  describe('over stdio and HTTP (the real CLI)', () => {
    let server: ReturnType<typeof createHttpServer>;
    let url = '';
    beforeAll(async () => {
      server = createHttpServer({ kernel, webRoot: null, secure: false, trustProxy: false });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it('answers initialize and a tool call through `npm run mcp`', async () => {
      const token = sofiaToken;
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/mcp.ts'], { env: { ...process.env, BOOKHAND_URL: url, BOOKHAND_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] });
      const responses: Array<{ id: number; result?: { serverInfo?: { name: string }; content?: Array<{ text: string }>; isError?: boolean } }> = [];
      let buffer = '';
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      const done = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`MCP CLI timed out; stderr: ${stderr}`)), 30_000);
        child.stdout.on('data', (d: Buffer) => {
          buffer += d.toString();
          let i: number;
          while ((i = buffer.indexOf('\n')) >= 0) {
            responses.push(JSON.parse(buffer.slice(0, i)) as (typeof responses)[number]);
            buffer = buffer.slice(i + 1);
          }
          if (responses.length >= 2) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } } })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'close_status', arguments: {} } })}\n`);
      await done;
      child.stdin.end();
      await new Promise((r) => child.on('exit', r));
      const byId = new Map(responses.map((r) => [r.id, r]));
      expect(byId.get(1)!.result!.serverInfo!.name).toBe('bookhand');
      const status = byId.get(2)!.result!;
      expect(status.isError ?? false).toBe(false);
      expect(JSON.parse(status.content![0]!.text).close.name).toBe('September 2026 close');
    }, 60_000);
  });
});
