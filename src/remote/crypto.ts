import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseJson } from '../json.js';

const IV_BYTES = 12;
const TAG_BYTES = 16;

interface Keys {
  encryption: Buffer;
  signing: Buffer;
}

function deriveKeys(secret: string): Keys {
  return {
    encryption: Buffer.from(hkdfSync('sha256', secret, 'claude-linkedin-connector', 'encryption', 32)),
    signing: Buffer.from(hkdfSync('sha256', secret, 'claude-linkedin-connector', 'signing', 32)),
  };
}

function hmac(key: Buffer, purpose: string, value: string): string {
  return createHmac('sha256', key).update(purpose).update('\0').update(value).digest('base64url');
}

function decrypt(key: Buffer, purpose: string, raw: Buffer): string | undefined {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * Signs or encrypts the server's OAuth artifacts (client IDs, codes, tokens)
 * so the server can stay stateless. `purpose` is bound into every MAC and
 * ciphertext, so an artifact minted for one use is rejected for another.
 *
 * New artifacts always use the current secret; previous secrets only open
 * artifacts issued before a rotation, so it disconnects no one.
 */
export class Sealer {
  private readonly keys: [Keys, ...Keys[]];

  constructor(secret: string, previousSecret?: string) {
    this.keys = previousSecret === undefined ? [deriveKeys(secret)] : [deriveKeys(secret), deriveKeys(previousSecret)];
  }

  /** Encrypts and authenticates a JSON payload (AES-256-GCM). */
  seal(purpose: string, payload: unknown): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.keys[0].encryption, iv);
    cipher.setAAD(Buffer.from(purpose));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64url');
  }

  unseal<T>(purpose: string, token: string): T | undefined {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length <= IV_BYTES + TAG_BYTES) return undefined;
    for (const { encryption } of this.keys) {
      const plaintext = decrypt(encryption, purpose, raw);
      if (plaintext !== undefined) return parseJson(plaintext) as T | undefined;
    }
    return undefined;
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
    if (!this.macMatches(purpose, body, token.slice(dot + 1))) return undefined;
    return parseJson(Buffer.from(body, 'base64url').toString('utf8')) as T | undefined;
  }

  /** The MAC of `value` under the current secret. */
  mac(purpose: string, value: string): string {
    return hmac(this.keys[0].signing, purpose, value);
  }

  /** Whether `mac` is the MAC of `value` under the current or a previous secret. */
  macMatches(purpose: string, value: string, mac: string): boolean {
    return this.keys.some(({ signing }) => safeEqual(mac, hmac(signing, purpose, value)));
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
