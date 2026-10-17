import { afterEach, describe, expect, it, vi } from 'vitest';
import { drainServer } from '../src/remote/shutdown.js';
import { startServer, type TestServer } from './helpers/http.js';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** A server whose responses take `delayMs`, so a request is in flight during shutdown. */
async function slowServer(delayMs: number) {
  const server = await startServer((_req, res) => {
    setTimeout(() => res.end('done'), delayMs);
  });
  servers.push(server);
  return server;
}

describe('drainServer', () => {
  it('lets in-flight requests finish before aborting the rest', async () => {
    const { url, server } = await slowServer(100);
    const response = fetch(url).then((r) => r.text());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const abort = vi.fn(async () => {});
    const logger = vi.fn();
    expect(await drainServer(server, abort, 2000, logger)).toBe(true);
    expect(await response).toBe('done');
    expect(abort).toHaveBeenCalledOnce();
    expect(logger).not.toHaveBeenCalled();
    expect(server.listening).toBe(false);
  });

  it('gives up after the timeout, aborts and drops remaining connections', async () => {
    const { url, server } = await slowServer(5000);
    const response = fetch(url).then(
      () => 'finished',
      () => 'dropped',
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const abort = vi.fn(async () => {});
    const logger = vi.fn();
    expect(await drainServer(server, abort, 50, logger)).toBe(false);
    expect(abort).toHaveBeenCalledOnce();
    expect(logger).toHaveBeenCalledWith('warn', 'shutdown_timeout', expect.objectContaining({ timeoutMs: 50 }));
    expect(await response).toBe('dropped');
  });
});
