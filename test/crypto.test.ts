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
