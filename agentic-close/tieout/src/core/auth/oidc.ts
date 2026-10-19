/**
 * OpenID Connect relying party (authorization-code flow with PKCE, RFC 7636), dependency-free:
 * discovery, authorization URL, code exchange and ID-token validation (signature against the
 * provider's JWKS with RS256/PS256/ES256, issuer, audience/azp, expiry, nonce). Runs on WebCrypto,
 * so the same code works in Node and in the browser; `fetch` is injectable for tests.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { base64ToBytes, bytesToBase64Url } from '../util/base64';
import { secureRandomBytes } from '../util/random';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  /** confidential clients only (client_secret_post); public clients rely on PKCE alone */
  clientSecret?: string | null;
  scopes?: string[];
}

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface OidcPending {
  state: string;
  nonce: string;
  verifier: string;
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  azp?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  amr?: string[];
}

export class OidcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OidcError';
  }
}

interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

const ALGS: Record<string, { import: RsaHashedImportParams | EcKeyImportParams; verify: AlgorithmIdentifier | RsaPssParams | EcdsaParams }> = {
  RS256: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: { name: 'RSASSA-PKCS1-v1_5' } },
  PS256: { import: { name: 'RSA-PSS', hash: 'SHA-256' }, verify: { name: 'RSA-PSS', saltLength: 32 } },
  ES256: { import: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' } },
};

const text = new TextDecoder();
const SKEW_S = 120;

function decodeSegment<T>(seg: string): T {
  try {
    return JSON.parse(text.decode(base64ToBytes(seg))) as T;
  } catch {
    throw new OidcError('malformed ID token');
  }
}

export class OidcClient {
  private disco: { at: number; doc: OidcDiscovery } | null = null;
  private jwks: { at: number; keys: Jwk[] } | null = null;

  constructor(
    readonly config: OidcConfig,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!/^https:\/\//.test(config.issuer) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(config.issuer)) throw new OidcError('OIDC issuer must use https');
  }

  private async getJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(url, { ...init, headers: { accept: 'application/json', ...(init?.headers ?? {}) } });
    if (!res.ok) throw new OidcError(`${new URL(url).host} answered ${res.status}`);
    return (await res.json()) as T;
  }

  async discovery(): Promise<OidcDiscovery> {
    if (this.disco && this.now() - this.disco.at < 10 * 60_000) return this.disco.doc;
    const doc = await this.getJson<OidcDiscovery>(`${this.config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
    if (doc.issuer !== this.config.issuer) throw new OidcError('discovery issuer does not match the configured issuer');
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) if (typeof doc[k] !== 'string') throw new OidcError(`discovery is missing ${k}`);
    this.disco = { at: this.now(), doc };
    return doc;
  }

  /** Begin a sign-in: the URL to send the browser to, plus the values to keep until the callback. */
  async authorizationUrl(): Promise<{ url: string; pending: OidcPending }> {
    const d = await this.discovery();
    const pending: OidcPending = { state: bytesToBase64Url(secureRandomBytes(24)), nonce: bytesToBase64Url(secureRandomBytes(24)), verifier: bytesToBase64Url(secureRandomBytes(48)) };
    const challenge = bytesToBase64Url(sha256(new TextEncoder().encode(pending.verifier)));
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({ response_type: 'code', client_id: this.config.clientId, redirect_uri: this.config.redirectUri, scope: (this.config.scopes ?? ['openid', 'email', 'profile']).join(' '), state: pending.state, nonce: pending.nonce, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    return { url: url.toString(), pending };
  }

  /** Exchange the authorization code and return the validated ID-token claims. */
  async complete(params: { code: string | null; state: string | null; error?: string | null }, pending: OidcPending): Promise<IdTokenClaims> {
    if (params.error) throw new OidcError(`the identity provider returned ${params.error}`);
    if (!params.code || !params.state) throw new OidcError('missing code or state');
    if (params.state !== pending.state) throw new OidcError('state mismatch');
    const d = await this.discovery();
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: params.code, redirect_uri: this.config.redirectUri, client_id: this.config.clientId, code_verifier: pending.verifier });
    if (this.config.clientSecret) body.set('client_secret', this.config.clientSecret);
    const tokens = await this.getJson<{ id_token?: string }>(d.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    if (!tokens.id_token) throw new OidcError('no ID token in the token response');
    return this.verifyIdToken(tokens.id_token, pending.nonce);
  }

  async verifyIdToken(jwt: string, nonce: string): Promise<IdTokenClaims> {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new OidcError('malformed ID token');
    const [h, p, s] = parts as [string, string, string];
    const header = decodeSegment<{ alg: string; kid?: string; typ?: string }>(h);
    const alg = ALGS[header.alg];
    if (!alg) throw new OidcError(`unsupported token algorithm ${header.alg}`);
    const jwk = await this.key(header.kid, header.alg);
    const key = await globalThis.crypto.subtle.importKey('jwk', jwk as JsonWebKey, alg.import, false, ['verify']);
    const ok = await globalThis.crypto.subtle.verify(alg.verify, key, base64ToBytes(s) as BufferSource, new TextEncoder().encode(`${h}.${p}`));
    if (!ok) throw new OidcError('ID token signature is invalid');
    const c = decodeSegment<IdTokenClaims>(p);
    const now = Math.floor(this.now() / 1000);
    if (c.iss !== this.config.issuer) throw new OidcError('ID token issuer mismatch');
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!aud.includes(this.config.clientId)) throw new OidcError('ID token audience mismatch');
    if (aud.length > 1 && c.azp !== this.config.clientId) throw new OidcError('ID token authorized party mismatch');
    if (typeof c.exp !== 'number' || c.exp < now - SKEW_S) throw new OidcError('ID token expired');
    if (typeof c.iat === 'number' && c.iat > now + SKEW_S) throw new OidcError('ID token issued in the future');
    if (c.nonce !== nonce) throw new OidcError('ID token nonce mismatch');
    if (!c.sub) throw new OidcError('ID token has no subject');
    return c;
  }

  private async key(kid: string | undefined, alg: string): Promise<Jwk> {
    const pick = (keys: Jwk[]) => keys.find((k) => (kid ? k.kid === kid : true) && (!k.alg || k.alg === alg) && (!k.use || k.use === 'sig') && (alg.startsWith('ES') ? k.kty === 'EC' : k.kty === 'RSA'));
    const fresh = async () => {
      const d = await this.discovery();
      const set = await this.getJson<{ keys: Jwk[] }>(d.jwks_uri);
      this.jwks = { at: this.now(), keys: Array.isArray(set.keys) ? set.keys : [] };
      return this.jwks.keys;
    };
    let found = this.jwks && this.now() - this.jwks.at < 60 * 60_000 ? pick(this.jwks.keys) : undefined;
    if (!found) found = pick(await fresh()); // unknown kid: the provider may have rotated keys
    if (!found) throw new OidcError('no matching signing key in the provider JWKS');
    const { kty, n, e, crv, x, y } = found;
    return { kty, n, e, crv, x, y };
  }
}
