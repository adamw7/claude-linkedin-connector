import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pkceChallenge, randomToken, safeEqual, Sealer } from '../src/remote/crypto.js';

describe('Sealer', () => {
  const sealer = new Sealer('a'.repeat(32));

  it('round-trips sealed payloads and hides their contents', () => {
    const token = sealer.seal('code', { at: 'secret-token', n: 1 });
    expect(token).not.toContain('secret-token');
    expect(Buffer.from(token, 'base64url').toString('utf8')).not.toContain('secret-token');
    expect(sealer.unseal('code', token)).toEqual({ at: 'secret-token', n: 1 });
  });

  it('derives the same keys as earlier versions, so upgrading keeps everyone connected', () => {
    // Issued by 0.1.0 with SERVER_SECRET=aaa…a (32 characters).
    expect(sealer.mac('client', 'value')).toBe('Tc7C_yUVlQSnveoJxMqBo4iLoZgCijF22iE69N2Jtng');
    expect(sealer.unseal('access', 'PgN7ZLX7Gp3CGU3XBInmucwfeuPfS6G5eR7MaccCs4-FhERsAEuLdlMTM1Xp')).toEqual({ at: 'li-token' });
    expect(new Sealer('b'.repeat(32), 'a'.repeat(32)).unseal('access', 'PgN7ZLX7Gp3CGU3XBInmucwfeuPfS6G5eR7MaccCs4-FhERsAEuLdlMTM1Xp')).toEqual({
      at: 'li-token',
    });
  });

  it('uses a fresh IV for every seal', () => {
    expect(sealer.seal('code', { a: 1 })).not.toBe(sealer.seal('code', { a: 1 }));
  });

  it('rejects sealed payloads used for another purpose, key or after tampering', () => {
    const token = sealer.seal('code', { a: 1 });
    expect(sealer.unseal('refresh', token)).toBeUndefined();
    expect(new Sealer('b'.repeat(32)).unseal('code', token)).toBeUndefined();
    const raw = Buffer.from(token, 'base64url');
    raw[raw.length - 1]! ^= 1;
    expect(sealer.unseal('code', raw.toString('base64url'))).toBeUndefined();
  });

  it('rejects malformed sealed payloads', () => {
    expect(sealer.unseal('code', '')).toBeUndefined();
    expect(sealer.unseal('code', 'short')).toBeUndefined();
    expect(sealer.unseal('code', Buffer.alloc(28).toString('base64url'))).toBeUndefined();
  });

  it('round-trips signed payloads, which stay readable', () => {
    const token = sealer.sign('client', { r: ['https://claude.ai/cb'] });
    expect(JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'))).toEqual({ r: ['https://claude.ai/cb'] });
    expect(sealer.verify('client', token)).toEqual({ r: ['https://claude.ai/cb'] });
  });

  it('rejects signed payloads used for another purpose, key or after tampering', () => {
    const token = sealer.sign('client', { r: ['https://claude.ai/cb'] });
    expect(sealer.verify('consent', token)).toBeUndefined();
    expect(new Sealer('b'.repeat(32)).verify('client', token)).toBeUndefined();
    const [, mac] = token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ r: ['https://evil.example/cb'] })).toString('base64url')}.${mac}`;
    expect(sealer.verify('client', forged)).toBeUndefined();
  });

  it('rejects malformed signed payloads', () => {
    expect(sealer.verify('client', '')).toBeUndefined();
    expect(sealer.verify('client', 'no-dot')).toBeUndefined();
    expect(sealer.verify('client', '.mac')).toBeUndefined();
    const body = Buffer.from('{not json').toString('base64url');
    expect(sealer.verify('client', `${body}.${sealer.mac('client', body)}`)).toBeUndefined();
  });

  it('binds the purpose into MACs', () => {
    expect(sealer.mac('a', 'value')).toBe(sealer.mac('a', 'value'));
    expect(sealer.mac('a', 'value')).not.toBe(sealer.mac('b', 'value'));
    // The separator keeps purpose/value boundaries unambiguous.
    expect(sealer.mac('ab', 'c')).not.toBe(sealer.mac('a', 'bc'));
    expect(sealer.macMatches('a', 'value', sealer.mac('a', 'value'))).toBe(true);
    expect(sealer.macMatches('b', 'value', sealer.mac('a', 'value'))).toBe(false);
    expect(sealer.macMatches('a', 'other', sealer.mac('a', 'value'))).toBe(false);
  });
});

describe('Sealer with a previous secret', () => {
  const previous = new Sealer('o'.repeat(32));
  const current = new Sealer('n'.repeat(32));
  const rotated = new Sealer('n'.repeat(32), 'o'.repeat(32));

  it('opens artifacts issued with the previous secret', () => {
    expect(rotated.unseal('code', previous.seal('code', { a: 1 }))).toEqual({ a: 1 });
    expect(rotated.verify('client', previous.sign('client', { r: 1 }))).toEqual({ r: 1 });
    expect(rotated.macMatches('client-secret', 'id', previous.mac('client-secret', 'id'))).toBe(true);
    expect(current.unseal('code', previous.seal('code', { a: 1 }))).toBeUndefined();
  });

  it('issues new artifacts with the current secret only', () => {
    expect(current.unseal('code', rotated.seal('code', { b: 2 }))).toEqual({ b: 2 });
    expect(previous.unseal('code', rotated.seal('code', { b: 2 }))).toBeUndefined();
    expect(current.verify('client', rotated.sign('client', { r: 1 }))).toEqual({ r: 1 });
    expect(previous.verify('client', rotated.sign('client', { r: 1 }))).toBeUndefined();
    expect(rotated.mac('client-secret', 'id')).toBe(current.mac('client-secret', 'id'));
  });

  it('still binds the purpose for previous secrets', () => {
    expect(rotated.unseal('access', previous.seal('code', { a: 1 }))).toBeUndefined();
    expect(rotated.verify('consent', previous.sign('client', { r: 1 }))).toBeUndefined();
    expect(rotated.macMatches('other', 'id', previous.mac('client-secret', 'id'))).toBe(false);
  });
});

describe('crypto helpers', () => {
  it('compares strings of any length safely', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('generates random URL-safe tokens', () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(token);
    expect(Buffer.from(randomToken(16), 'base64url')).toHaveLength(16);
  });

  it('computes RFC 7636 S256 challenges', () => {
    // Example from RFC 7636 Appendix B.
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(pkceChallenge('x')).toBe(createHash('sha256').update('x').digest('base64url'));
  });
});
