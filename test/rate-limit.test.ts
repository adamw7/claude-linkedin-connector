import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { rateLimit } from '../src/remote/rate-limit.js';

function harness(limit: number, windowMs = 1000) {
  const clock = { t: 0 };
  const rejected: string[] = [];
  const headers: Record<string, string> = {};
  const limiter = rateLimit({ limit, windowMs, key: (req) => req.ip, reject: (req) => rejected.push(req.ip!), now: () => clock.t });
  const res = { set: (name: string, value: string) => (headers[name] = value) } as unknown as Response;
  const hit = (ip: string | undefined) => {
    let passed = false;
    limiter({ ip } as Request, res, () => (passed = true));
    return passed;
  };
  return { clock, rejected, headers, hit };
}

describe('rateLimit', () => {
  it('allows up to the limit per key and window, then rejects with Retry-After', () => {
    const { clock, rejected, headers, hit } = harness(2);
    expect([hit('a'), hit('a'), hit('a')]).toEqual([true, true, false]);
    expect(rejected).toEqual(['a']);
    expect(headers['Retry-After']).toBe('1');
    expect(hit('b')).toBe(true);
    clock.t = 1000;
    expect(hit('a')).toBe(true);
  });

  it('reports the time left in the window', () => {
    const { clock, headers, hit } = harness(1, 60_000);
    hit('a');
    clock.t = 15_500;
    hit('a');
    expect(headers['Retry-After']).toBe('45');
  });

  it('skips requests without a key, and everything when the limit is 0', () => {
    expect(harness(1).hit(undefined)).toBe(true);
    const disabled = harness(0);
    expect([disabled.hit('a'), disabled.hit('a')]).toEqual([true, true]);
  });

  it('keeps counting windows that are still open when it sweeps expired ones', () => {
    const { clock, hit } = harness(1, 120_000);
    hit('a');
    // Past the minute between sweeps, but not the end of the window.
    clock.t = 61_000;
    expect(hit('a')).toBe(false);
  });

  it('forgets expired windows', () => {
    const { clock, hit } = harness(1, 1000);
    hit('a');
    clock.t = 120_000;
    expect(hit('a')).toBe(true);
    expect(hit('a')).toBe(false);
  });
});
