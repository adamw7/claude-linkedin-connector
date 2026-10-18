import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls, { type SecureVersion } from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { safeFetch } from '../src/net/safe-fetch.js';
import { MIN_TLS_VERSION, requireModernTls } from '../src/net/tls.js';

// Real HTTPS servers on loopback with a throwaway self-signed certificate. A client that gets past version
// negotiation then rejects the certificate, so the two errors tell apart "refused TLS 1.2" from "spoke TLS 1.3".
const dir = mkdtempSync(join(tmpdir(), 'tls-test-'));
const servers = new Map<SecureVersion, { server: Server; url: string }>();
const urlFor = (maxVersion: SecureVersion) => servers.get(maxVersion)!.url;
const originalMin = tls.DEFAULT_MIN_VERSION;

beforeAll(async () => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  const options = { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
  for (const maxVersion of ['TLSv1.2', 'TLSv1.3'] as const) {
    const server = createServer({ ...options, minVersion: 'TLSv1.2', maxVersion }, (_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.set(maxVersion, { server, url: `https://127.0.0.1:${(server.address() as AddressInfo).port}/` });
  }
});

afterEach(() => {
  tls.DEFAULT_MIN_VERSION = originalMin;
});

afterAll(() => {
  for (const { server } of servers.values()) server.close();
  rmSync(dir, { recursive: true, force: true });
});

const fetchErrorCode = (url: string) =>
  fetch(url).then(
    () => 'connected',
    (error: Error) => (error.cause as NodeJS.ErrnoException).code,
  );

describe('TLS', () => {
  it('requires TLS 1.3', () => {
    expect(MIN_TLS_VERSION).toBe('TLSv1.3');
  });

  it('is required at startup, before any command runs', () => {
    expect(readFileSync('src/index.ts', 'utf8')).toMatch(/^requireModernTls\(\);\nmain\(/m);
  });

  it('makes the global fetch refuse servers older than TLS 1.3', async () => {
    expect(await fetchErrorCode(urlFor('TLSv1.2'))).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
    requireModernTls();
    expect(tls.DEFAULT_MIN_VERSION).toBe('TLSv1.3');
    expect(await fetchErrorCode(urlFor('TLSv1.2'))).toBe('ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION');
    expect(await fetchErrorCode(urlFor('TLSv1.3'))).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
  });

  it('makes safeFetch refuse servers older than TLS 1.3 without the process-wide setting', async () => {
    const open = { maxBytes: 1_000, allowPrivateNetwork: true };
    const tls12 = urlFor('TLSv1.2');
    await expect(safeFetch(tls12, open)).rejects.toThrow(new RegExp(`^Fetching ${tls12} failed: .*alert protocol version`));
    await expect(safeFetch(urlFor('TLSv1.3'), open)).rejects.toThrow(`Fetching ${urlFor('TLSv1.3')} failed: self-signed certificate`);
  });
});
