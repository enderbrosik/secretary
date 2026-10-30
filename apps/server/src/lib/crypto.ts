import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';

/**
 * Envelope encryption: each user has a random 256-bit data key (DEK) stored
 * wrapped with the server master key (KEK). Secrets (API keys, OAuth tokens)
 * are encrypted with the user's DEK using AES-256-GCM, bound to a purpose
 * string via AAD so ciphertexts cannot be swapped between fields or users.
 * Rotating the master key only requires re-wrapping DEKs.
 */

const VERSION = 'v1';

function seal(key: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return [VERSION, iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

function open(key: Buffer, token: string, aad: string): Buffer {
  const [v, iv, tag, ct] = token.split('.');
  if (v !== VERSION || !iv || !tag || ct === undefined) throw new Error('Malformed ciphertext');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
}

export class KeyRing {
  private cache = new Map<string, Buffer>();
  constructor(private readonly masterKey: Buffer) {}

  newWrappedDataKey(userId: string): string {
    return seal(this.masterKey, randomBytes(32), `dek:${userId}`);
  }

  private dek(userId: string, wrapped: string): Buffer {
    const hit = this.cache.get(userId);
    if (hit) return hit;
    const k = open(this.masterKey, wrapped, `dek:${userId}`);
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(userId, k);
    return k;
  }

  encrypt(user: { id: string; wrappedDataKey: string }, purpose: string, plaintext: string): string {
    return seal(this.dek(user.id, user.wrappedDataKey), Buffer.from(plaintext, 'utf8'), `${user.id}:${purpose}`);
  }

  decrypt(user: { id: string; wrappedDataKey: string }, purpose: string, token: string): string {
    return open(this.dek(user.id, user.wrappedDataKey), token, `${user.id}:${purpose}`).toString('utf8');
  }

  /** For server-level secrets (e.g. OAuth app client secrets), encrypted directly with the master key. */
  encryptSystem(purpose: string, plaintext: string): string {
    return seal(this.masterKey, Buffer.from(plaintext, 'utf8'), `system:${purpose}`);
  }

  decryptSystem(purpose: string, token: string): string {
    return open(this.masterKey, token, `system:${purpose}`).toString('utf8');
  }

  forget(userId: string) {
    this.cache.delete(userId);
  }
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Argon2id with OWASP-recommended parameters (19 MiB, t=2, p=1). */
export async function hashPassword(password: string): Promise<string> {
  return argon2id({ password, salt: randomBytes(16), parallelism: 1, iterations: 2, memorySize: 19456, hashLength: 32, outputType: 'encoded' });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash });
  } catch {
    return false;
  }
}

export function keyHint(key: string): string {
  return `…${key.slice(-4)}`;
}
