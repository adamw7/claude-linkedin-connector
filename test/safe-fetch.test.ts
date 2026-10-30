import type { LookupAddress } from 'node:dns';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FetchError, isBlockedAddress, safeFetch } from '../src/net/safe-fetch.js';
import { fakeTransport } from './helpers/fake-transport.js';
import { startServer, type TestServer } from './helpers/http.js';

/** What DNS answers for these names; any other name is looked up for real. */
const dnsAnswers = vi.hoisted(() => new Map<string, LookupAddress[] | NodeJS.ErrnoException>());
vi.mock('node:dns', async (importOriginal) => {
  const dns = await importOriginal<typeof import('node:dns')>();
  const lookup = (hostname: string, options: object, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => {
    const answer = dnsAnswers.get(hostname);
    if (answer === undefined) return dns.lookup(hostname, { ...options, all: true }, callback);
    queueMicrotask(() => (answer instanceof Error ? callback(answer, []) : callback(null, answer)));
  };
  return { ...dns, lookup };
});

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::a00:1',
    '2002:c0a8:0101::1',
    '[::1]',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '13.107.42.14', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it('reads IPv6 addresses written out in full, without "::"', () => {
    expect(isBlockedAddress('2606:4700:4700:1:2:3:4:5')).toBe(false);
    expect(isBlockedAddress('fd00:1:2:3:4:5:6:7')).toBe(true);
    // 6to4 for 192.168.1.1, then for 8.8.8.8.
    expect(isBlockedAddress('2002:c0a8:101:1:2:3:4:5')).toBe(true);
    expect(isBlockedAddress('2002:808:808:1:2:3:4:5')).toBe(false);
  });

  it('ignores an IPv6 zone, which names a network interface rather than an address', () => {
    expect(isBlockedAddress('fe80::1%eth0')).toBe(true);
    expect(isBlockedAddress('2606:4700:4700::1111%eth0')).toBe(false);
  });

  it.each(['example.com', '', '1.2.3', '::ffff:1.2.3'])('blocks %j, which is not an IP address', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });
});

describe('safeFetch', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer((req, res) => {
      if (req.url === '/hello') res.end('hello world');
      else if (req.url === '/big') res.end(Buffer.alloc(10_000, 'a'));
      else if (req.url === '/chunked') {
        // No Content-Length, so the limit can only be enforced while reading.
        res.write(Buffer.alloc(800, 'a'));
        setTimeout(() => res.end(Buffer.alloc(800, 'b')), 10);
      } else if (req.url === '/drip') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        const timer = setInterval(() => res.write('x'), 50);
        res.on('close', () => clearInterval(timer));
      } else if (req.url === '/to-file') res.writeHead(302, { Location: 'file:///etc/passwd' }).end();
      else if (req.url === '/to-nowhere') res.writeHead(302, { Location: 'http://[' }).end();
      else if (req.url?.startsWith('/redirect/')) {
        const remaining = Number(req.url.split('/')[2]);
        res.writeHead(302, { Location: remaining > 0 ? `/redirect/${remaining - 1}` : '/hello' }).end();
      } else res.writeHead(404).end();
    });
  });
  afterAll(() => server.close());

  const open = { maxBytes: 1_000, allowPrivateNetwork: true };

  it('fetches a body and follows redirects', async () => {
    const result = await safeFetch(`${server.url}/redirect/2`, open);
    expect(result.data.toString()).toBe('hello world');
    expect(result.url).toBe(`${server.url}/hello`);
  });

  it('limits redirects', async () => {
    await expect(safeFetch(`${server.url}/redirect/9`, { ...open, maxRedirects: 3 })).rejects.toThrow(/Too many redirects/);
  });

  it('enforces the size limit, or truncates when asked', async () => {
    await expect(safeFetch(`${server.url}/big`, open)).rejects.toThrow(/larger than/);
    const truncated = await safeFetch(`${server.url}/big`, { ...open, truncate: true });
    expect(truncated.data.length).toBe(1_000);
  });

  it('enforces the size limit on bodies without a Content-Length', async () => {
    await expect(safeFetch(`${server.url}/chunked`, open)).rejects.toThrow(/larger than/);
    const truncated = await safeFetch(`${server.url}/chunked`, { ...open, truncate: true });
    expect(truncated.data.toString()).toBe('a'.repeat(800) + 'b'.repeat(200));
  });

  it('gives up on a slowly trickling body at the overall deadline', async () => {
    const start = Date.now();
    await expect(safeFetch(`${server.url}/drip`, { ...open, timeoutMs: 300 })).rejects.toThrow(/Timed out/);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it('re-checks redirect targets', async () => {
    await expect(safeFetch(`${server.url}/to-file`, open)).rejects.toThrow(/Only http/);
  });

  it('reports a redirect to an invalid URL as a fetch failure', async () => {
    const failure = safeFetch(`${server.url}/to-nowhere`, open);
    await expect(failure).rejects.toThrow(FetchError);
    await expect(failure).rejects.toThrow(`Fetching ${server.url}/to-nowhere failed: it redirected to an invalid URL.`);
  });

  it('reports HTTP errors', async () => {
    await expect(safeFetch(`${server.url}/missing`, open)).rejects.toThrow(/HTTP 404/);
  });

  it('refuses loopback and private targets by default, including via DNS', async () => {
    await expect(safeFetch(`${server.url}/hello`, { maxBytes: 1_000 })).rejects.toThrow(/private or reserved/);
    const viaName = server.url.replace('127.0.0.1', 'localhost');
    await expect(safeFetch(`${viaName}/hello`, { maxBytes: 1_000 })).rejects.toThrow(/private or reserved/);
    await expect(safeFetch('http://[::ffff:169.254.169.254]/latest/meta-data/', { maxBytes: 1_000 })).rejects.toThrow(FetchError);
  });

  it('only fetches http(s) URLs without credentials', async () => {
    await expect(safeFetch('file:///etc/passwd', open)).rejects.toThrow(/Only http/);
    await expect(safeFetch('https://user:pass@example.com/', open)).rejects.toThrow(/credentials/);
    await expect(safeFetch('not a url', open)).rejects.toThrow(/not a valid URL/);
  });
});

describe('safeFetch redirects from a public site', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['http://127.0.0.1:8080/admin', 'http://169.254.169.254/latest/meta-data/', 'http://[::ffff:10.0.0.1]/', 'http://[fd00::1]/'])(
    'refuses a redirect to %s without connecting to it',
    async (target) => {
      const requests = fakeTransport(() => ({ status: 302, headers: { Location: target } }));
      await expect(safeFetch('https://public.example/link', { maxBytes: 1_000 })).rejects.toThrow(/private or reserved address/);
      expect(requests.map((request) => request.url.hostname)).toEqual(['public.example']);
    },
  );

  it('refuses a redirect to a hostname that resolves to a private address', async () => {
    const requests = fakeTransport(() => ({ status: 302, headers: { Location: 'http://localhost:8080/admin' } }));
    await expect(safeFetch('https://public.example/link', { maxBytes: 1_000 })).rejects.toThrow(/localhost: it resolves to a private or reserved address/);
    expect(requests).toHaveLength(1);
  });

  it('follows a redirect to another public site', async () => {
    fakeTransport(({ url }) => (url.hostname === 'public.example' ? { status: 301, headers: { Location: 'https://cdn.example/a.png' } } : { status: 200, body: 'ok' }), [
      'public.example',
      'cdn.example',
    ]);
    const result = await safeFetch('https://public.example/link', { maxBytes: 1_000 });
    expect(result).toMatchObject({ url: 'https://cdn.example/a.png', data: Buffer.from('ok') });
  });
});

describe('safeFetch name resolution', () => {
  afterEach(() => {
    dnsAnswers.clear();
    vi.restoreAllMocks();
  });

  /** The lookup safeFetch gives the connection, which Node calls for every address (`all`) or for one. */
  async function guardedLookup(): Promise<LookupFunction> {
    let lookup: LookupFunction | undefined;
    vi.spyOn(https, 'request').mockImplementation(((_url: URL, options: { lookup: LookupFunction }) => {
      lookup = options.lookup;
      throw new Error('not connecting');
    }) as unknown as typeof https.request);
    await safeFetch('https://public.example/', { maxBytes: 1_000 }).catch(() => {});
    return lookup!;
  }

  function resolve(lookup: LookupFunction, hostname: string, all: boolean) {
    return new Promise<{ error: NodeJS.ErrnoException | null; address: string | LookupAddress[]; family?: number }>((done) =>
      lookup(hostname, { all }, (error, address, family) => done({ error, address, family })),
    );
  }

  it('connects to a public name by any of its addresses, or by the first', async () => {
    const addresses = [
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ];
    dnsAnswers.set('cdn.example', addresses);
    const lookup = await guardedLookup();
    expect(await resolve(lookup, 'cdn.example', true)).toEqual({ error: null, address: addresses, family: undefined });
    expect(await resolve(lookup, 'cdn.example', false)).toEqual({ error: null, address: '8.8.8.8', family: 4 });
  });

  it.each<[string, LookupAddress[]]>([
    ['one of its addresses is private', [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]],
    ['it maps to a private IPv4 address', [{ address: '::ffff:169.254.169.254', family: 6 }]],
    ['it has no address', []],
  ])('refuses a name when %s', async (_, addresses) => {
    dnsAnswers.set('rebind.example', addresses);
    const { error } = await resolve(await guardedLookup(), 'rebind.example', true);
    expect(error).toEqual(new FetchError('Refusing to fetch from rebind.example: it resolves to a private or reserved address.'));
  });

  it('reports a name that does not resolve', async () => {
    const notFound = Object.assign(new Error('getaddrinfo ENOTFOUND missing.example'), { code: 'ENOTFOUND' });
    dnsAnswers.set('missing.example', notFound);
    expect((await resolve(await guardedLookup(), 'missing.example', true)).error).toBe(notFound);
    vi.restoreAllMocks();
    fakeTransport(() => ({ status: 200, body: 'ok' }), []);
    await expect(safeFetch('https://missing.example/a.png', { maxBytes: 1_000 })).rejects.toThrow(
      new FetchError('Fetching https://missing.example/a.png failed: getaddrinfo ENOTFOUND missing.example'),
    );
  });
});

describe('safeFetch deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('counts the time spent on every redirect, and does not follow one past the deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const requests = fakeTransport(
      () => {
        vi.setSystemTime(Date.now() + 1_500);
        return { status: 302, headers: { Location: 'https://cdn.example/a.png' } };
      },
      ['public.example', 'cdn.example'],
    );
    await expect(safeFetch('https://public.example/link', { maxBytes: 1_000, timeoutMs: 1_000 })).rejects.toThrow(
      new FetchError('Timed out fetching https://cdn.example/a.png.'),
    );
    expect(requests.map((request) => request.url.hostname)).toEqual(['public.example']);
  });
});

describe('safeFetch from a site without TLS 1.3', () => {
  afterEach(() => vi.restoreAllMocks());

  // A server that knows TLS 1.3 but has it turned off sends a protocol_version alert (see tls.test.ts). One too old to
  // know it answers in TLS 1.2, which OpenSSL refuses as an "unsupported protocol".
  it('says so instead of quoting OpenSSL', async () => {
    const failure = new Error(
      'write EPROTO 40A8C3B6:error:0A000102:SSL routines:ssl_choose_client_version:unsupported protocol:../deps/openssl/openssl/ssl/statem/statem_lib.c:1956:\n',
    );
    vi.spyOn(https, 'request').mockImplementation((() => {
      const request = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
      request.end = () =>
        queueMicrotask(() => {
          request.emit('error', failure);
          request.emit('close');
        });
      request.destroy = () => {};
      return request;
    }) as unknown as typeof https.request);
    await expect(safeFetch('https://public.example/old.png', { maxBytes: 1_000 })).rejects.toThrow(
      "Fetching https://public.example/old.png failed: the site doesn't support TLS 1.3, which the connector requires.",
    );
  });
});
