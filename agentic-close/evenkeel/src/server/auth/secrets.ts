import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Server-side secret box (AES-256-GCM) for data that must be recoverable, such as TOTP
 * secrets. The key comes from EVENKEEL_SECRET_KEY (base64, 32 bytes) or, in development, a
 * key file generated on first start under .data/ (gitignored, mode 0600).
 */
export class SecretBox {
  private readonly macKey: Buffer;

  private constructor(private readonly key: Buffer) {
    // A separate subkey for MACs, so the encryption key never serves two purposes.
    this.macKey = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'evenkeel/mac/v1', 32));
  }

  static fromEnvOrFile(envValue: string | undefined, file: string): SecretBox {
    if (envValue) {
      const key = Buffer.from(envValue, 'base64');
      if (key.length !== 32) throw new Error('EVENKEEL_SECRET_KEY must be 32 bytes, base64-encoded.');
      return new SecretBox(key);
    }
    if (existsSync(file)) return new SecretBox(Buffer.from(readFileSync(file, 'utf8').trim(), 'base64'));
    mkdirSync(dirname(file), { recursive: true });
    const key = randomBytes(32);
    writeFileSync(file, key.toString('base64'), { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort on filesystems without POSIX modes */
    }
    return new SecretBox(key);
  }

  static forTests(seed = 'evenkeel-tests'): SecretBox {
    return new SecretBox(createHash('sha256').update(seed).digest());
  }

  /** HMAC-SHA256 (base64url) of `data` under a purpose label; used for CSRF tokens. */
  mac(purpose: string, data: string): string {
    return createHmac('sha256', this.macKey).update(purpose).update('\0').update(data).digest('base64url');
  }

  seal(plaintext: string, aad = ''): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    if (aad) c.setAAD(Buffer.from(aad));
    const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return `v1.${iv.toString('base64url')}.${body.toString('base64url')}.${c.getAuthTag().toString('base64url')}`;
  }

  open(sealed: string, aad = ''): string {
    const [v, iv, body, tag] = sealed.split('.');
    if (v !== 'v1' || !iv || !body || !tag) throw new Error('Unrecognised sealed value');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    if (aad) d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  }
}
