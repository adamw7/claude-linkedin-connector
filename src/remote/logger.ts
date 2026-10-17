import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';

export type LogLevel = 'info' | 'warn' | 'error';

/** Writes one event; `fields` must never contain tokens, codes or other secrets. */
export type Logger = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void;

export const silentLogger: Logger = () => {};

function serialize(value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;
}

/** Logs one JSON object per line (stderr by default), the format log collectors ingest without parsing rules. */
export function jsonLogger(write: (line: string) => void = (line) => process.stderr.write(line), now: () => Date = () => new Date()): Logger {
  return (level, event, fields = {}) => {
    const entry: Record<string, unknown> = { time: now().toISOString(), level, event };
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) entry[key] = serialize(value);
    write(`${JSON.stringify(entry)}\n`);
  };
}

/** The request path without the query string; unlike `req.path`, unaffected by mounted middleware. */
export function pathOf(req: Request): string {
  return req.originalUrl.split('?', 1)[0]!;
}

/** What a proxy's request ID may look like to be kept: UUIDs, hex and the like, nothing that could mislead a log reader. */
const REQUEST_ID = /^[\w.:+=@/-]{1,128}$/;

/**
 * Tags each request with an ID: the one a proxy in front sent as `X-Request-Id`, or a new UUID. It is
 * echoed in the response and logged with the request, its tool calls and errors, so they can be matched up.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get('x-request-id');
  const id = incoming !== undefined && REQUEST_ID.test(incoming) ? incoming : randomUUID();
  // Kept on the request headers so the MCP handler, which only sees a copy of the request, can read it too.
  req.headers['x-request-id'] = id;
  res.set('X-Request-Id', id);
  next();
};

/**
 * Logs each finished request. Only the path is logged: OAuth query strings
 * carry codes and state, and bodies carry tokens and post text.
 */
export function requestLogger(logger: Logger, now: () => number = performance.now.bind(performance)): RequestHandler {
  return (req, res, next) => {
    const start = now();
    res.once('finish', () => {
      const path = pathOf(req);
      if (path === '/healthz') return;
      logger(res.statusCode >= 500 ? 'error' : 'info', 'http_request', {
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(now() - start),
        ip: req.ip,
        requestId: req.get('x-request-id'),
      });
    });
    next();
  };
}
