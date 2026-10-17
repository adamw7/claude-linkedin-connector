import type { Request, RequestHandler, Response } from 'express';

export interface RateLimitOptions {
  /** Requests allowed per key and window; 0 disables the limit. */
  limit: number;
  windowMs?: number;
  /** The bucket a request counts against; undefined skips the limit for it. */
  key: (req: Request) => string | undefined;
  /** Sends the 429 response; `Retry-After` is already set. */
  reject: (req: Request, res: Response) => void;
  now?: () => number;
}

/** Sweep expired windows at most this often, so idle keys don't pile up. */
const SWEEP_MS = 60_000;

/**
 * A fixed-window request limiter kept in memory. Each instance counts on its
 * own, so with N replicas a key effectively gets N times the limit.
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const { limit, key, reject } = options;
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now;
  const windows = new Map<string, { count: number; resetAt: number }>();
  let nextSweep = now() + SWEEP_MS;

  return (req, res, next) => {
    const id = limit > 0 ? key(req) : undefined;
    if (id === undefined) {
      next();
      return;
    }
    const current = now();
    if (current >= nextSweep) {
      for (const [k, w] of windows) if (w.resetAt <= current) windows.delete(k);
      nextSweep = current + SWEEP_MS;
    }
    let window = windows.get(id);
    if (!window || window.resetAt <= current) {
      window = { count: 0, resetAt: current + windowMs };
      windows.set(id, window);
    }
    window.count += 1;
    if (window.count > limit) {
      res.set('Retry-After', String(Math.ceil((window.resetAt - current) / 1000)));
      reject(req, res);
      return;
    }
    next();
  };
}
