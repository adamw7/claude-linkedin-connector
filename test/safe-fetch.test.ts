import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FetchError, isBlockedAddress, safeFetch } from '../src/net/safe-fetch.js';
import { startServer, type TestServer } from './helpers/http.js';

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
    '2002:c0a8:0101::1',
    '[::1]',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '13.107.42.14', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe('safeFetch', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer((req, res) => {
      if (req.url === '/hello') res.end('hello world');
      else if (req.url === '/big') res.end(Buffer.alloc(10_000, 'a'));
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
