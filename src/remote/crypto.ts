import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Signs or encrypts the server's OAuth artifacts (client IDs, codes, tokens)
 * so the server can stay stateless. `purpose` is bound into every MAC and
 * ciphertext, so an artifact minted for one use is rejected for another.
 */
export class Sealer {
  private readonly encryptionKey: Buffer;
  private readonly signingKey: Buffer;

  constructor(secret: string) {
    this.encryptionKey = Buffer.from(hkdfSync('sha256', secret, 'claude-linkedin-connector', 'encryption', 32));
    this.signingKey = Buffer.from(hkdfSync('sha256', secret, 'claude-linkedin-connector', 'signing', 32));
  }

  /** Encrypts and authenticates a JSON payload (AES-256-GCM). */
  seal(purpose: string, payload: unknown): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(purpose));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64url');
  }

  unseal<T>(purpose: string, token: string): T | undefined {
    try {
      const raw = Buffer.from(token, 'base64url');
      if (raw.length <= IV_BYTES + TAG_BYTES) return undefined;
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, raw.subarray(0, IV_BYTES));
      decipher.setAAD(Buffer.from(purpose));
      decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
      const plaintext = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8')) as T;
    } catch {
      return undefined;
    }
  }

  /** Signs (but does not hide) a JSON payload (HMAC-SHA256). */
  sign(purpose: string, payload: unknown): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.mac(purpose, body)}`;
  }

  verify<T>(purpose: string, token: string): T | undefined {
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return undefined;
    const body = token.slice(0, dot);
    if (!safeEqual(token.slice(dot + 1), this.mac(purpose, body))) return undefined;
    try {
      return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    } catch {
      return undefined;
    }
  }

  mac(purpose: string, value: string): string {
    return createHmac('sha256', this.signingKey).update(purpose).update('\0').update(value).digest('base64url');
  }
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** RFC 7636 S256 code challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
