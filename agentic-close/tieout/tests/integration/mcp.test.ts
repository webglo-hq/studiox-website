/** MCP server: an MCP client lists and calls Tieout tools through the HTTP API with an API token. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer, httpApi } from '../../src/mcp/server';
import { testApp, TEST_ORIGIN, type TestApp } from '../support/app';

let t: TestApp;
let client: Client;

const text = (r: unknown) => (r as { content: { type: string; text: string }[] }).content[0]!.text;

beforeAll(async () => {
  t = await testApp();
  const casey = t.client();
  await casey.login('casey');
  const { body } = await casey.post<{ token: string }>('/api/auth/tokens', { name: 'MCP test', days: 1 });
  const viaApp = ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(t.app.fetch(new Request(input, init)))) as typeof fetch;
  const server = createMcpServer(httpApi(TEST_ORIGIN, body.token, viaApp));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'tieout-test', version: '1.0.0' });
  await client.connect(clientSide);
}, 120_000);

afterAll(async () => {
  await client?.close();
});

describe('Tieout MCP server', () => {
  it('lists typed tools with read-only hints', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['tieout_whoami', 'tieout_close_status', 'tieout_list_proposals', 'tieout_get_proposal', 'tieout_trial_balance', 'tieout_financial_statements', 'tieout_flux', 'tieout_reconciliations', 'tieout_explain_term', 'tieout_run_skill', 'tieout_get_run']));
    expect(tools.find((x) => x.name === 'tieout_close_status')!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((x) => x.name === 'tieout_run_skill')!.annotations?.readOnlyHint).toBe(false);
    expect(JSON.stringify(tools.find((x) => x.name === 'tieout_list_proposals')!.inputSchema)).toContain('"review"');
  });

  it('answers who-am-I and the close status', async () => {
    expect(text(await client.callTool({ name: 'tieout_whoami', arguments: {} }))).toContain('Casey Morgan');
    const status = JSON.parse(text(await client.callTool({ name: 'tieout_close_status', arguments: { period: '2026-09' } }))) as { tasks: { key: string }[] };
    expect(status.tasks.length).toBe(14);
  });

  it('starts an agent run and reads its proposals, but cannot approve anything', async () => {
    const run = JSON.parse(text(await client.callTool({ name: 'tieout_run_skill', arguments: { skill: 'subledger-tieout', entity: 'BWL-US' } }))) as { status: string; ref: string; id: string };
    expect(run.status).toBe('succeeded');
    const list = JSON.parse(text(await client.callTool({ name: 'tieout_list_proposals', arguments: { status: 'open', entity: 'BWL-US' } }))) as { items: { id: string; skill: string }[] };
    const mine = list.items.find((p) => p.skill === 'subledger-tieout');
    expect(mine).toBeTruthy();
    const detail = text(await client.callTool({ name: 'tieout_get_proposal', arguments: { id: mine!.id } }));
    expect(detail).toContain('verification');
    const tools = (await client.listTools()).tools.map((x) => x.name);
    expect(tools.some((n) => /approve|post|lock|policy/.test(n))).toBe(false);
  });

  it('explains accounting terms from the ontology', async () => {
    const e = JSON.parse(text(await client.callTool({ name: 'tieout_explain_term', arguments: { term: 'deposit in transit' } }))) as { label: string; definition: string };
    expect(e.label.toLowerCase()).toContain('deposit in transit');
    expect(e.definition.length).toBeGreaterThan(20);
  });

  it('reports a clear error for an unknown entity', async () => {
    const r = await client.callTool({ name: 'tieout_trial_balance', arguments: { entity: 'NOPE' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Unknown entity/);
  });
});
