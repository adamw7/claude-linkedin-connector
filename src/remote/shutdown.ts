import type { Server } from 'node:http';
import type { Logger } from './logger.js';

/**
 * Stops accepting connections and waits for in-flight requests (uploads and
 * posts can take a while) to finish, up to `timeoutMs`. After that, `abort`
 * cancels what is left and remaining connections are dropped. Resolves true
 * if everything finished in time.
 */
export async function drainServer(server: Server, abort: () => Promise<void>, timeoutMs: number, logger: Logger): Promise<boolean> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  // close() only drops connections idle at that moment; keep-alive connections whose request finishes later
  // (a proxy's, typically) would otherwise hold the server open until the timeout.
  server.closeIdleConnections();
  const sweep = setInterval(() => server.closeIdleConnections(), 100);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), timeoutMs);
  });
  const late = await Promise.race([closed.then(() => false), timedOut]);
  clearInterval(sweep);
  clearTimeout(timer);
  if (late) logger('warn', 'shutdown_timeout', { timeoutMs, message: 'Aborting requests still in flight.' });
  await abort();
  if (late) {
    server.closeAllConnections();
    await closed;
  }
  return !late;
}
