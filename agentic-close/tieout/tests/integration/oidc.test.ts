/**
 * Single sign-on (OpenID Connect, authorization code + PKCE) against an in-process identity
 * provider that signs real RS256 ID tokens: the happy path and the attacks the relying party must
 * refuse (forged signature, wrong nonce/state/audience, expired token, unknown or unverified email).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToBase64Url } from '../../src/core/util/base64';
import { PEOPLE } from '../../src/packs/accounting/seed/company';
import { SESSION_COOKIE } from '../../src/server/app';
import { testApp, TEST_ORIGIN, type TestApp } from '../support/app';

const ISSUER = 'https://idp.example.test';
const CLIENT = 'tieout-web';
const enc = new TextEncoder();
const b64url = (o: unknown) => bytesToBase64Url(enc.encode(JSON.stringify(o)));

interface IdpState {
  codes: Map<string, { challenge: string; nonce: string; email: string }>;
  claims: (c: { nonce: string; email: string }) => Record<string, unknown>;
  signWith: CryptoKey;
}

let key: CryptoKeyPair;
let rogue: CryptoKeyPair;
let jwk: JsonWebKey;
let t: TestApp;
let idp: IdpState;

async function sign(claims: Record<string, unknown>, k: CryptoKey) {
  const head = b64url({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
  const body = b64url(claims);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, k, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${bytesToBase64Url(sig)}`;
}

/** The identity provider, reached through the relying party's injected fetch. */
const idpFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/.well-known/openid-configuration') return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` });
  if (url.pathname === '/jwks') return json({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] });
  if (url.pathname === '/token') {
    const form = new URLSearchParams(String(init?.body ?? ''));
    const entry = idp.codes.get(form.get('code') ?? '');
    if (!entry || form.get('client_id') !== CLIENT || form.get('grant_type') !== 'authorization_code') return json({ error: 'invalid_grant' }, 400);
    if (bytesToBase64Url(sha256(enc.encode(form.get('code_verifier') ?? ''))) !== entry.challenge) return json({ error: 'invalid_grant', error_description: 'PKCE' }, 400);
    idp.codes.delete(form.get('code')!);
    return json({ access_token: 'at', token_type: 'Bearer', id_token: await sign(idp.claims(entry), idp.signWith) });
  }
  return json({ error: 'not_found' }, 404);
}) as typeof fetch;

const defaultClaims = (c: { nonce: string; email: string }) => {
  const now = Math.floor(Date.now() / 1000);
  return { iss: ISSUER, sub: `user-${c.email}`, aud: CLIENT, exp: now + 300, iat: now, nonce: c.nonce, email: c.email, email_verified: true, amr: ['pwd', 'mfa'] };
};

/** Drive the browser part: start, "log in" at the provider, come back with the code. */
async function signIn(email: string, tamper: { state?: string } = {}) {
  const start = await t.app.fetch(new Request(`${TEST_ORIGIN}/api/auth/oidc/start`));
  expect(start.status).toBe(302);
  const loc = new URL(start.headers.get('location')!);
  expect(loc.origin + loc.pathname).toBe(`${ISSUER}/authorize`);
  expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
  const oidcCookie = start.headers.getSetCookie().find((c) => c.startsWith('tieout_oidc='))!;
  expect(oidcCookie).toMatch(/HttpOnly/i);
  expect(oidcCookie).toMatch(/SameSite=Lax/i);
  const code = `code-${Math.random().toString(36).slice(2)}`;
  idp.codes.set(code, { challenge: loc.searchParams.get('code_challenge')!, nonce: loc.searchParams.get('nonce')!, email });
  const cb = new URL(`${TEST_ORIGIN}/api/auth/oidc/callback`);
  cb.searchParams.set('code', code);
  cb.searchParams.set('state', tamper.state ?? loc.searchParams.get('state')!);
  const res = await t.app.fetch(new Request(cb, { headers: { cookie: oidcCookie.split(';')[0]! } }));
  const session = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !/Max-Age=0/i.test(c));
  return { res, html: await res.text(), session: session?.split(';')[0] ?? null };
}

beforeAll(async () => {
  key = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  rogue = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  jwk = await crypto.subtle.exportKey('jwk', key.publicKey);
  t = await testApp({ oidc: { issuer: ISSUER, clientId: CLIENT, redirectUri: `${TEST_ORIGIN}/api/auth/oidc/callback` } }, undefined, idpFetch);
  idp = { codes: new Map(), claims: defaultClaims, signWith: key.privateKey };
}, 120_000);

describe('single sign-on with OpenID Connect', () => {
  const casey = PEOPLE.find((p) => p.key === 'casey')!.email;

  it('advertises SSO on the sign-in page', async () => {
    const r = await t.app.fetch(new Request(`${TEST_ORIGIN}/api/auth/options`));
    expect(((await r.json()) as { oidc: { enabled: boolean; issuer: string } }).oidc).toMatchObject({ enabled: true, issuer: ISSUER });
  });

  it('signs an invited user in and opens a normal session', async () => {
    idp.claims = defaultClaims;
    const { res, html, session } = await signIn(casey);
    expect(res.status).toBe(200);
    expect(session).toBeTruthy();
    // the page forwards to the app root through a relative URL (works under a path prefix too)
    const target = /url=([^"]+)"/.exec(html)![1]!;
    expect(new URL(target, `${TEST_ORIGIN}/api/auth/oidc/callback?code=x&state=y`).href).toBe(`${TEST_ORIGIN}/`);
    const me = await t.app.fetch(new Request(`${TEST_ORIGIN}/api/auth/me`, { headers: { cookie: session! } }));
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { name: string } }).user.name).toBe('Casey Morgan');
  });

  it.each([
    ['a token signed by another key', { signWith: 'rogue' }, /signature is invalid/],
    ['a token for another client', { claims: { aud: 'someone-else' } }, /audience mismatch/],
    ['an expired token', { claims: { exp: Math.floor(Date.now() / 1000) - 3600 } }, /expired/],
    ['a replayed nonce', { claims: { nonce: 'not-the-one-we-sent' } }, /nonce mismatch/],
    ['another issuer', { claims: { iss: 'https://evil.example' } }, /issuer mismatch/],
    ['an unverified email', { claims: { email_verified: false } }, /verified email/],
  ])('refuses %s', async (_label, attack, message) => {
    const a = attack as { signWith?: string; claims?: Record<string, unknown> };
    idp.claims = (c) => ({ ...defaultClaims(c), ...(a.claims ?? {}) });
    idp.signWith = a.signWith === 'rogue' ? rogue.privateKey : key.privateKey;
    const { res, html, session } = await signIn(casey);
    expect(res.status).toBe(401);
    expect(html).toMatch(message);
    expect(session).toBeNull();
    idp.claims = defaultClaims;
    idp.signWith = key.privateKey;
  });

  it('refuses a forged state (login CSRF) and people who were never invited', async () => {
    expect((await signIn(casey, { state: 'forged' })).html).toMatch(/state mismatch/);
    const stranger = await signIn('stranger@bramblewood.example');
    expect(stranger.res.status).toBe(401);
    expect(stranger.html).toMatch(/no active Tieout account/);
  });

  it('records SSO sign-ins in the audit log with the provider and method', async () => {
    const { session } = await signIn(casey);
    const csrf = ((await (await t.app.fetch(new Request(`${TEST_ORIGIN}/api/auth/me`, { headers: { cookie: session! } }))).json()) as { csrfToken: string }).csrfToken;
    const log = await t.app.fetch(new Request(`${TEST_ORIGIN}/api/audit?action=auth.login`, { headers: { cookie: session!, 'x-csrf-token': csrf } }));
    const items = ((await log.json()) as { items: { summary: string }[] }).items;
    expect(items.some((i) => /single sign-on/.test(i.summary))).toBe(true);
  });

  it('lets an invited person in through SSO and retires the temporary password', async () => {
    const avery = t.client();
    await avery.login('avery');
    const invited = await avery.post<{ tempPassword: string }>('/api/admin/users', { email: 'quinn.reyes@bramblewood.example', name: 'Quinn Reyes', role: 'fpa_analyst' });
    expect(invited.status).toBe(200);
    const { res, session } = await signIn('quinn.reyes@bramblewood.example');
    expect(res.status).toBe(200);
    // no "choose a new password" step for someone who signs in with the identity provider
    expect((await t.app.fetch(new Request(`${TEST_ORIGIN}/api/home`, { headers: { cookie: session! } }))).status).toBe(200);
    const withTemp = await t.client().post('/api/auth/login', { email: 'quinn.reyes@bramblewood.example', password: invited.body.tempPassword });
    expect(withTemp.status).toBe(401);
  });
});
