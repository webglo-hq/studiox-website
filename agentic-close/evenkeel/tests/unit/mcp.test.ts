import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer, httpBackend, type JsonRpcResponse } from '../../src/mcp/server';
import { MCP_TOOLS } from '../../src/mcp/tools';
import { makeContext } from '../../src/packs/accounting/domain/context';
import { loadActor } from '../../src/packs/accounting/domain/rbac';
import { createToken, revokeToken } from '../../src/packs/accounting/services/api-tokens';
import type { UserKey } from '../../src/packs/accounting/seed/scenario';
import { SecretBox } from '../../src/server/auth/secrets';
import { loadConfig } from '../../src/server/config';
import { createHandler } from '../../src/server/http';
import { DEFAULT_RULES, RateLimiter } from '../../src/server/rate-limit';
import { loadTestScenario, type Scenario } from '../shared/scenario';

/**
 * The MCP server end to end: JSON-RPC over the real HTTP API with personal API tokens, so
 * roles, read-only tokens, maker-checker and the audit trail are those of the web app.
 */
let s: Scenario;
let server: Server;
let base = '';
let seq = 0;

const as = async (k: UserKey) => makeContext(s.db, s.info.tenantId, await loadActor(s.db, s.info.tenantId, s.user(k)), s.clock);
const mcp = (token: string) => createMcpServer(httpBackend(base, token));
const rpc = async (server: ReturnType<typeof mcp>, method: string, params: Record<string, unknown> = {}) => (await server.handle({ jsonrpc: '2.0', id: ++seq, method, params }))!;
const text = (r: JsonRpcResponse) => ((r.result as { content: { text: string }[] }).content[0]!.text);
const isError = (r: JsonRpcResponse) => (r.result as { isError: boolean }).isError;

beforeAll(async () => {
  s = await loadTestScenario();
  await s.engine.orchestrate(null, s.user('casey'));
  const handler = createHandler({ env: s.env, config: loadConfig({}), limiter: new RateLimiter(DEFAULT_RULES), secrets: SecretBox.forTests(), staticDir: null });
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

describe('MCP server', () => {
  it('initialises, negotiates the protocol version and lists typed tools', async () => {
    const { token } = await createToken(await as('casey'), { name: 'Claude Desktop', write: true, days: 30 });
    const m = mcp(token);
    const init = await rpc(m, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'evenkeel' }, capabilities: { tools: {} } });
    expect((await rpc(m, 'initialize', { protocolVersion: '1999-01-01' })).result).toMatchObject({ protocolVersion: '2025-06-18' });
    expect(await m.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const list = (await rpc(m, 'tools/list')).result as { tools: { name: string; inputSchema: { type: string; properties?: Record<string, unknown> }; annotations: { readOnlyHint: boolean } }[] };
    expect(list.tools).toHaveLength(MCP_TOOLS.length);
    const decide = list.tools.find((t) => t.name === 'decide_proposals')!;
    expect(decide.annotations.readOnlyHint).toBe(false);
    expect(decide.inputSchema).toMatchObject({ type: 'object', properties: { ids: { type: 'array' }, decision: { enum: ['approve', 'reject'] } } });
    expect(list.tools.find((t) => t.name === 'list_proposals')!.annotations.readOnlyHint).toBe(true);
    expect((await rpc(m, 'nope/nope')).error).toMatchObject({ code: -32601 });
    expect((await rpc(m, 'tools/call', { name: 'drop_tables' })).error).toMatchObject({ code: -32602 });
  });

  it('answers as the token owner and records the channel in the audit trail', async () => {
    const { token } = await createToken(await as('casey'), { name: 'Close copilot', write: true, days: 30 });
    const m = mcp(token);
    const next = await rpc(m, 'tools/call', { name: 'whats_next', arguments: {} });
    expect(isError(next)).toBe(false);
    expect(JSON.parse(text(next))).toHaveProperty('next');
    const mine = JSON.parse(text(await rpc(m, 'tools/call', { name: 'list_proposals', arguments: { tab: 'mine', limit: 40 } }))) as { items: { id: string; title: string; canApprove: { ok: boolean } }[] };
    const approvable = mine.items.find((p) => p.canApprove.ok)!;
    expect(approvable).toBeTruthy();
    const decided = await rpc(m, 'tools/call', { name: 'decide_proposals', arguments: { ids: [approvable.id], decision: 'approve' } });
    expect(isError(decided)).toBe(false);
    expect(JSON.parse(text(decided)).results[0]).toMatchObject({ ok: true });
    const events = await s.db.find('audit_log', { tenant_id: s.info.tenantId, action: 'agent.proposal.approved', subject_id: approvable.id });
    expect(events.map((e) => e.actor_label)).toEqual(['Casey Morgan via API token "Close copilot"']);
  });

  it('enforces read-only tokens, maker-checker and the methods tokens may never call', async () => {
    const { token: readOnly } = await createToken(await as('casey'), { name: 'Read only', write: false, days: 30 });
    const ro = mcp(readOnly);
    const waiting = JSON.parse(text(await rpc(ro, 'tools/call', { name: 'list_proposals', arguments: { tab: 'mine', limit: 5 } }))) as { items: { id: string }[] };
    const refused = await rpc(ro, 'tools/call', { name: 'decide_proposals', arguments: { ids: [waiting.items[0]!.id], decision: 'approve' } });
    expect(isError(refused)).toBe(true);
    expect(text(refused)).toMatch(/read-only/);

    // Sam prepared the bank work; his token cannot approve it (SOD-01), whatever the channel.
    const { token: samToken } = await createToken(await as('sam'), { name: 'Sam laptop', write: true, days: 30 });
    const sam = mcp(samToken);
    const samsOwn = (await s.db.find('proposal', { tenant_id: s.info.tenantId, status: 'pending', requested_by: s.user('sam') }))[0]!;
    const sod = await rpc(sam, 'tools/call', { name: 'decide_proposals', arguments: { ids: [samsOwn.id], decision: 'approve' } });
    expect(JSON.parse(text(sod)).results[0]).toMatchObject({ ok: false });

    const forbidden = await fetch(`${base}/api/rpc/admin.updateSettings`, { method: 'POST', headers: { authorization: `Bearer ${samToken}`, 'content-type': 'application/json' }, body: '{}' });
    expect(forbidden.status).toBe(403);
    const minting = await fetch(`${base}/api/rpc/account.createToken`, { method: 'POST', headers: { authorization: `Bearer ${samToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'more', write: true, days: 1 }) });
    expect(minting.status).toBe(403);
  });

  it('rejects unknown, malformed and revoked tokens', async () => {
    const bad = await rpc(mcp('ekt_this-is-not-a-real-token-but-it-has-the-right-length'), 'tools/call', { name: 'whats_next', arguments: {} });
    expect(isError(bad)).toBe(true);
    expect(text(bad)).toMatch(/UNAUTHENTICATED/);
    const ctx = await as('priya');
    const { token, view } = await createToken(ctx, { name: 'Temporary', write: false, days: 1 });
    expect(isError(await rpc(mcp(token), 'tools/call', { name: 'whats_next', arguments: {} }))).toBe(false);
    await revokeToken(ctx, view.id);
    expect(text(await rpc(mcp(token), 'tools/call', { name: 'whats_next', arguments: {} }))).toMatch(/UNAUTHENTICATED/);
    const stored = (await s.db.get('api_token', view.id))!;
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.token_hash).not.toContain(token.slice(4, 20));
  });
});
