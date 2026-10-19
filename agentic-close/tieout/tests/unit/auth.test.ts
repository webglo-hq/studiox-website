import { describe, expect, it } from 'vitest';
import { csrfFor } from '../../src/app/auth';
import { RateLimiter } from '../../src/app/rate-limit';
import { DEMO_SCRYPT, nobleScrypt, PasswordHasher, PRODUCTION_SCRYPT } from '../../src/core/auth/password';
import { hashRecoveryCode, newRecoveryCodes, normalizeRecoveryCode, RECOVERY_CODE_COUNT } from '../../src/core/auth/recovery';
import { decryptSecret, encryptSecret, newTotpSecret, otpauthUri, totpAt, verifyTotp } from '../../src/core/auth/totp';
import { bytesToBase32, bytesToBase64 } from '../../src/core/util/base64';
import { sha256Hex } from '../../src/core/util/hash';

describe('TOTP (RFC 6238, SHA-1, 30 s, 6 digits)', () => {
  // RFC 6238 Appendix B test vectors (8-digit values; a 6-digit code is the last six digits)
  const secret = bytesToBase32(new TextEncoder().encode('12345678901234567890'));
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('T=%i gives %s', (t, code) => {
    expect(totpAt(secret, Math.floor(t / 30))).toBe(code);
  });

  it('accepts the current code once and refuses replays', () => {
    const s = newTotpSecret();
    const now = Date.UTC(2026, 9, 2, 9, 0, 0);
    const step = Math.floor(now / 1000 / 30);
    const code = totpAt(s, step);
    const used = verifyTotp(s, code, now, null);
    expect(used).toBe(step);
    expect(verifyTotp(s, code, now, used)).toBeNull();
    expect(verifyTotp(s, '000000' === code ? '111111' : '000000', now, null)).toBeNull();
  });

  it('tolerates one step of clock drift but not two', () => {
    const s = newTotpSecret();
    const now = Date.UTC(2026, 9, 2, 9, 0, 0);
    const step = Math.floor(now / 1000 / 30);
    expect(verifyTotp(s, totpAt(s, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(s, totpAt(s, step - 3), now, null)).toBeNull();
  });

  it('builds an otpauth URI for authenticator apps', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'casey@bramblewood.example');
    expect(uri).toMatch(/^otpauth:\/\/totp\/Tieout:casey%40bramblewood\.example\?/);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('issuer=Tieout');
  });

  it('encrypts the shared secret at rest (AES-256-GCM) and detects the wrong key', async () => {
    const key = bytesToBase64(new Uint8Array(32).fill(1));
    const other = bytesToBase64(new Uint8Array(32).fill(2));
    const ct = await encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(ct).not.toContain('JBSWY3DPEHPK3PXP');
    expect(await decryptSecret(ct, key)).toBe('JBSWY3DPEHPK3PXP');
    await expect(decryptSecret(ct, other)).rejects.toThrow();
    expect(await encryptSecret('JBSWY3DPEHPK3PXP', key)).not.toBe(ct); // random IV
  });
});

describe('two-factor recovery codes', () => {
  it('are ten distinct codes from an unambiguous alphabet', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toMatch(/^[a-km-np-z2-9]{5}-[a-km-np-z2-9]{5}$/);
  });
  it('accept how people type them (case, spaces, dashes) and nothing else', () => {
    expect(normalizeRecoveryCode(' ABCDE-fgh23 ')).toBe('abcdefgh23');
    expect(normalizeRecoveryCode('abcde fgh23')).toBe('abcdefgh23');
    expect(normalizeRecoveryCode('123456')).toBeNull(); // a TOTP code is not a recovery code
    expect(normalizeRecoveryCode('abcde-fgh2l')).toBeNull(); // l is not in the alphabet
    expect(normalizeRecoveryCode('abcde-fgh234')).toBeNull();
  });
  it('are stored as a domain-separated hash', () => {
    expect(hashRecoveryCode('abcdefgh23')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode('abcdefgh23')).toBe(hashRecoveryCode(normalizeRecoveryCode('ABCDE-FGH23')!));
    expect(hashRecoveryCode('abcdefgh23')).not.toBe(sha256Hex('abcdefgh23'));
  });
});

describe('password hashing (scrypt, PHC string)', () => {
  const hasher = new PasswordHasher(nobleScrypt, DEMO_SCRYPT);
  it('verifies the right password only', async () => {
    const h = await hasher.hash('correct horse battery staple');
    expect(h).toMatch(/^\$scrypt\$ln=10,r=8,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await hasher.verify('correct horse battery staple', h)).toBe(true);
    expect(await hasher.verify('correct horse battery stapler', h)).toBe(false);
    expect(await hasher.verify('anything', null)).toBe(false);
  });
  it('salts every hash', async () => {
    expect(await hasher.hash('same password twice')).not.toBe(await hasher.hash('same password twice'));
  });
  it('enforces a minimum length', async () => {
    await expect(hasher.hash('short')).rejects.toThrow(/12 characters/);
  });
  it('flags weaker stored hashes for upgrade on next sign-in', async () => {
    const weak = await hasher.hash('a long enough passphrase');
    expect(new PasswordHasher(nobleScrypt, PRODUCTION_SCRYPT).needsRehash(weak)).toBe(true);
    expect(hasher.needsRehash(weak)).toBe(false);
  });
});

describe('CSRF token and rate limiting', () => {
  it('derives a per-session CSRF token that cannot be guessed from another session', () => {
    const a = csrfFor('session-token-a'.padEnd(64, 'x'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(csrfFor('session-token-a'.padEnd(64, 'x'))).toBe(a);
    expect(csrfFor('session-token-b'.padEnd(64, 'x'))).not.toBe(a);
  });
  it('limits a key within its window', () => {
    const rl = new RateLimiter();
    const results = Array.from({ length: 5 }, () => rl.check('login:ip:1.2.3.4', 3, 60_000).ok);
    expect(results).toEqual([true, true, true, false, false]);
    expect(rl.check('login:ip:5.6.7.8', 3, 60_000).ok).toBe(true);
  });
});
