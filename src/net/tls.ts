import tls, { type SecureVersion } from 'node:tls';

/** The oldest TLS version any outbound connection may use. */
export const MIN_TLS_VERSION = 'TLSv1.3' satisfies SecureVersion;

/**
 * Makes TLS 1.3 the minimum for every TLS connection the process opens without its own `minVersion`,
 * including the global `fetch`, which has no per-request TLS options. Call it once at startup.
 */
export function requireModernTls(): void {
  tls.DEFAULT_MIN_VERSION = MIN_TLS_VERSION;
}
