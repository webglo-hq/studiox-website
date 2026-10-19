import { describe, expect, it } from 'vitest';
import { hashPassword, needsRehash, passwordProblems, verifyPassword } from '../../src/server/auth/password';
import { SecretBox } from '../../src/server/auth/secrets';
import { createSession, csrfMatches, csrfTokenFor, dueForRotation, loadSession, rotateSession } from '../../src/server/auth/sessions';
import { base32Decode, base32Encode, hotp, newTotpSecret, otpauthUri, totp, verifyTotp } from '../../src/server/auth/totp';
import { DEFAULT_RULES, RateLimiter, scaleRules } from '../../src/server/rate-limit';
import { loadConfig } from '../../src/server/config';
import { buildMiniTenant } from '../shared/invariant-suite';
import { createMemoryDb } from '../../src/packs/accounting/store';

describe('passwords (scrypt)', () => {
  it('hashes with a per-password salt and verifies only the right password', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).toMatch(/^scrypt\$32768\$8\$3\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('correct horse batterz', a)).toBe(false);
    expect(await verifyPassword('anything at all', null)).toBe(false);
    expect(await verifyPassword('anything at all', 'plaintext')).toBe(false);
  });
  it('EK-m3: uses OWASP scrypt parameters and flags weaker hashes for rehash', async () => {
    // OWASP Password Storage Cheat Sheet: these settings are equivalent; meet at least one of them.
    const OWASP = [[1 << 17, 1], [1 << 16, 2], [1 << 15, 3], [1 << 14, 5], [1 << 13, 10]] as const;
    const h = await hashPassword('a long and unremarkable passphrase');
    const [, n, r, p] = h.split('$').map(Number);
    expect(r).toBeGreaterThanOrEqual(8);
    expect(OWASP.some(([minN, minP]) => n! >= minN && p! >= minP)).toBe(true);
    expect(needsRehash(h)).toBe(false);
    expect(needsRehash('scrypt$32768$8$1$a$b')).toBe(true);
    expect(needsRehash('scrypt$131072$8$1$a$b')).toBe(false);
    expect(needsRehash('scrypt$131072$4$2$a$b')).toBe(true);
  });
  it('enforces length and flags weak parameters for rehash', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/12 characters/);
    expect(needsRehash('scrypt$1024$8$1$a$b')).toBe(true);
    expect(passwordProblems('sam-rivera-password', ['sam', 'Sam Rivera']).join(' ')).toMatch(/name or email/);
    expect(passwordProblems('a long passphrase that is fine')).toEqual([]);
  });
});

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  const secret = Buffer.from('12345678901234567890');
  it('matches the RFC 4226 HOTP vectors', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => hotp(secret, c))).toEqual(['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']);
  });
  it('matches the RFC 6238 SHA-1 vectors', () => {
    const cases: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [t, code] of cases) expect(totp(secret, t * 1000, 30, 8)).toBe(code);
  });
  it('verifies within one step either side and returns the step for replay protection', () => {
    const b32 = base32Encode(secret);
    expect(base32Decode(b32).equals(secret)).toBe(true);
    const at = 1_700_000_000_000;
    const code = totp(secret, at);
    expect(verifyTotp(b32, code, at)).toBe(Math.floor(at / 30_000));
    expect(verifyTotp(b32, code, at + 30_000)).toBe(Math.floor(at / 30_000));
    expect(verifyTotp(b32, code, at + 120_000)).toBeNull();
    expect(verifyTotp(b32, '12345', at)).toBeNull();
    expect(newTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUri('ABC', 'casey@kitewell.example')).toContain('otpauth://totp/Evenkeel:casey%40kitewell.example?secret=ABC');
  });
});

describe('secret box', () => {
  it('encrypts with AES-GCM and detects tampering or the wrong context', () => {
    const box = SecretBox.forTests();
    const sealed = box.seal('JBSWY3DPEHPK3PXP', 'user-1');
    expect(sealed).toMatch(/^v1\./);
    expect(box.open(sealed, 'user-1')).toBe('JBSWY3DPEHPK3PXP');
    expect(() => box.open(sealed, 'user-2')).toThrow();
    const parts = sealed.split('.');
    parts[2] = parts[2]!.slice(0, -2) + (parts[2]!.endsWith('A') ? 'BB' : 'AA');
    expect(() => box.open(parts.join('.'), 'user-1')).toThrow();
    expect(box.mac('csrf', 'x')).toBe(box.mac('csrf', 'x'));
    expect(box.mac('csrf', 'x')).not.toBe(SecretBox.forTests('other').mac('csrf', 'x'));
  });
});

describe('sessions and CSRF', () => {
  it('stores only token hashes, expires on idle and absolute limits, rotates and keeps CSRF stable', async () => {
    const db = createMemoryDb();
    const t = await buildMiniTenant(db);
    const box = SecretBox.forTests();
    const now = '2026-10-02T16:00:00.000Z';
    const { token, row } = await createSession(db, { tenantId: t.tenantId, userId: t.userA, ip: '127.0.0.1', userAgent: 'test', mfaVerified: true, now });
    expect(row.id).not.toBe(token);
    expect(row.id).toMatch(/^[0-9a-f]{64}$/);
    expect((await loadSession(db, token, now)).ok).toBe(true);
    expect((await loadSession(db, 'x'.repeat(43), now)).ok).toBe(false);
    const idle = await loadSession(db, token, '2026-10-02T16:31:00.000Z');
    expect(idle).toEqual({ ok: false, reason: 'idle' });

    const csrf = csrfTokenFor(row, box);
    expect(csrfMatches(row, csrf, box)).toBe(true);
    expect(csrfMatches(row, `${csrf}x`, box)).toBe(false);
    expect(csrfMatches(row, undefined, box)).toBe(false);

    expect(dueForRotation(row, '2026-10-02T16:16:00.000Z')).toBe(true);
    const rotated = await rotateSession(db, row, '2026-10-02T16:16:00.000Z');
    expect(csrfMatches(rotated.row, csrf, box)).toBe(true); // open tabs keep working
    expect((await loadSession(db, token, '2026-10-02T16:16:01.000Z')).ok).toBe(false); // old token revoked
    const fresh = await rotateSession(db, rotated.row, '2026-10-02T16:17:00.000Z', { newCsrf: true });
    expect(csrfMatches(fresh.row, csrf, box)).toBe(false); // privilege change → new CSRF
    expect((await loadSession(db, fresh.token, '2026-10-03T05:00:00.000Z')).ok).toBe(false); // absolute 12 h
  });
});

describe('rate limiting and configuration', () => {
  it('uses token buckets with refill and reports retry-after', () => {
    let t = 0;
    const rl = new RateLimiter({ login: { capacity: 2, refillPerSecond: 0.5 } }, () => t);
    expect(rl.take('login', 'ip')).toBe(0);
    expect(rl.take('login', 'ip')).toBe(0);
    expect(rl.take('login', 'ip')).toBe(2);
    expect(rl.take('login', 'other-ip')).toBe(0);
    t = 2_000;
    expect(rl.take('login', 'ip')).toBe(0);
    expect(scaleRules(DEFAULT_RULES, 10).login_ip!.capacity).toBe(100);
  });
  it('refuses unsafe production settings and treats empty values as unset', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DEMO_LOGIN_HELPER: '1' })).toThrow();
    expect(() => loadConfig({ NODE_ENV: 'production', DEMO_PASSWORD: 'x'.repeat(16) })).toThrow();
    expect(() => loadConfig({ NODE_ENV: 'production', RATE_LIMIT_SCALE: '5' })).toThrow();
    const c = loadConfig({ PUBLIC_ORIGIN: '', DATABASE_URL: '', PORT: '0' });
    expect(c.publicOrigin).toBeNull();
    expect(c.databaseUrl).toBeNull();
    expect(c.port).toBe(0);
  });
});
