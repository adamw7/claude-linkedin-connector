import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { jsonLogger, requestLogger } from '../src/remote/logger.js';
import { startServer, type TestServer } from './helpers/http.js';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('jsonLogger', () => {
  it('writes one JSON object per line, with errors serialized and undefined fields dropped', () => {
    const lines: string[] = [];
    const log = jsonLogger((line) => lines.push(line), () => new Date('2026-10-17T12:00:00Z'));
    log('error', 'boom', { path: '/x', missing: undefined, error: new TypeError('bad') });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith('\n')).toBe(true);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ time: '2026-10-17T12:00:00.000Z', level: 'error', event: 'boom', path: '/x', error: { name: 'TypeError', message: 'bad' } });
    expect(entry.error.stack).toContain('TypeError');
    expect('missing' in entry).toBe(false);
  });
});

describe('requestLogger', () => {
  it('logs method, path and status without the query string, and skips health checks', async () => {
    const entries: Array<Record<string, unknown>> = [];
    const app = express();
    app.use(requestLogger((level, event, fields) => entries.push({ level, event, ...fields })));
    app.get('/ok', (_req, res) => void res.send('ok'));
    app.get('/fail', (_req, res) => void res.status(503).end());
    app.get('/healthz', (_req, res) => void res.send('ok'));
    const server = await startServer(app);
    servers.push(server);
    await (await fetch(`${server.url}/ok?code=secret`)).text();
    await (await fetch(`${server.url}/fail`)).text();
    await (await fetch(`${server.url}/healthz`)).text();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(entries).toEqual([
      expect.objectContaining({ level: 'info', event: 'http_request', method: 'GET', path: '/ok', status: 200, durationMs: expect.any(Number) }),
      expect.objectContaining({ level: 'error', path: '/fail', status: 503 }),
    ]);
    expect(JSON.stringify(entries)).not.toContain('secret');
  });
});
