import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromBase64Url, randomBytes, toBase64Url } from '../shared/ids';

/**
 * Authenticated encryption for secrets at rest (TOTP seeds). AES-256-GCM with a 96-bit random nonce; the key is
 * derived with HKDF-SHA256 from the deployment secret (BOOKHAND_SECRET_KEY) and a purpose label, so one master
 * secret never encrypts two kinds of data under the same key. Format: `v1.<nonce>.<ciphertext+tag>` (base64url).
 */
export class SecretBox {
  private readonly key: Uint8Array;

  constructor(masterSecret: string | Uint8Array, purpose: string) {
    const ikm = typeof masterSecret === 'string' ? new TextEncoder().encode(masterSecret) : masterSecret;
    if (ikm.length < 16) throw new Error('SecretBox: master secret must be at least 16 bytes');
    this.key = hkdf(sha256, ikm, new TextEncoder().encode('bookhand.secretbox.v1'), new TextEncoder().encode(purpose), 32);
  }

  seal(plaintext: string, aad = ''): string {
    const nonce = randomBytes(12);
    const sealed = gcm(this.key, nonce, new TextEncoder().encode(aad)).encrypt(new TextEncoder().encode(plaintext));
    return `v1.${toBase64Url(nonce)}.${toBase64Url(sealed)}`;
  }

  open(box: string, aad = ''): string {
    const [version, nonce, sealed] = box.split('.');
    if (version !== 'v1' || !nonce || !sealed) throw new Error('SecretBox: unsupported format');
    const plain = gcm(this.key, fromBase64Url(nonce), new TextEncoder().encode(aad)).decrypt(fromBase64Url(sealed));
    return new TextDecoder().decode(plain);
  }
}
