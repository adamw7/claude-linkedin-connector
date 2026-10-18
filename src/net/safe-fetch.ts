import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { USER_AGENT } from '../version.js';

/** The URL is malformed, unreachable, too large, or points somewhere it may not. */
export class FetchError extends Error {
  override readonly name = 'FetchError';
}

const BLOCKED_RANGES = {
  ipv4: '0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4',
  ipv6: '::/128 ::1/128 64:ff9b:1::/48 100::/64 2001::/32 2001:db8::/32 fc00::/7 fe80::/10 fec0::/10 ff00::/8',
} as const;

const BLOCKED = new BlockList();
for (const [family, ranges] of Object.entries(BLOCKED_RANGES) as Array<['ipv4' | 'ipv6', string]>) {
  for (const range of ranges.split(' ')) {
    const [network, prefix] = range.split('/');
    BLOCKED.addSubnet(network!, Number(prefix), family);
  }
}

function ipv6Hextets(address: string): number[] | undefined {
  // WHATWG URL parsing canonicalizes IPv6, including dotted IPv4 suffixes.
  const host = URL.parse(`http://[${address.split('%')[0]}]`)?.hostname.slice(1, -1);
  if (host === undefined) return undefined;
  const [head = '', tail] = host.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const zeros = tail === undefined ? 0 : 8 - headParts.length - tailParts.length;
  const parts = [...headParts, ...Array<string>(zeros).fill('0'), ...tailParts];
  return parts.length === 8 ? parts.map((part) => Number.parseInt(part, 16)) : undefined;
}

/** IPv4 address tunnelled inside an IPv6 one (mapped, compatible, NAT64 or 6to4). */
function embeddedIPv4(address: string): string | undefined {
  const h = ipv6Hextets(address);
  if (!h) return undefined;
  const toIPv4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zeroPrefix = h.slice(0, 5).every((x) => x === 0);
  if (zeroPrefix && (h[5] === 0xffff || h[5] === 0)) return toIPv4(h[6]!, h[7]!);
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return toIPv4(h[6]!, h[7]!);
  if (h[0] === 0x2002) return toIPv4(h[1]!, h[2]!);
  return undefined;
}

/** True for loopback, private, link-local, multicast and other non-public addresses. */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '');
  const family = isIP(bare.split('%')[0]!);
  if (family === 4) return BLOCKED.check(bare, 'ipv4');
  if (family === 6) {
    const ipv4 = embeddedIPv4(bare);
    if (ipv4 !== undefined) return BLOCKED.check(ipv4, 'ipv4');
    return BLOCKED.check(bare.split('%')[0]!, 'ipv6');
  }
  return true;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** DNS lookup that refuses hostnames resolving to non-public addresses (checked at connect time, so DNS rebinding can't bypass it). */
function guardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '');
      return;
    }
    const list = addresses as LookupAddress[];
    const blocked = list.find((entry) => isBlockedAddress(entry.address));
    if (blocked || list.length === 0) {
      callback(new FetchError(`Refusing to fetch from ${hostname}: it resolves to a private or reserved address.`), '');
      return;
    }
    if (options.all) callback(null, list);
    else callback(null, list[0]!.address, list[0]!.family);
  });
}

export interface SafeFetchOptions {
  maxBytes: number;
  /** Return the first `maxBytes` instead of failing when the body is larger. */
  truncate?: boolean;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Permit loopback/private targets. Only for tests and trusted local setups. */
  allowPrivateNetwork?: boolean;
  accept?: string;
}

export interface SafeFetchResult {
  data: Buffer;
  contentType: string | undefined;
  /** Final URL after redirects. */
  url: string;
}

export function parseHttpUrl(input: string): URL {
  const url = URL.parse(input);
  if (!url) throw new FetchError(`"${input}" is not a valid URL.`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchError(`Only http(s) URLs can be fetched, got "${url.protocol}".`);
  }
  if (url.username || url.password) throw new FetchError('URLs with embedded credentials are not allowed.');
  return url;
}

/** GETs a public http(s) URL with size, time, redirect and network-range limits. */
export async function safeFetch(input: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  let url = parseHttpUrl(input);
  for (let redirects = 0; ; redirects++) {
    const result = await requestOnce(url, options, deadline);
    if (result.redirect === undefined) {
      return { data: result.data, contentType: result.contentType, url: url.toString() };
    }
    if (redirects >= (options.maxRedirects ?? 5)) throw new FetchError(`Too many redirects fetching ${input}.`);
    url = parseHttpUrl(new URL(result.redirect, url).toString());
  }
}

interface SingleResponse {
  redirect?: string;
  data: Buffer;
  contentType?: string;
}

function requestOnce(url: URL, options: SafeFetchOptions, deadline: number): Promise<SingleResponse> {
  const allowPrivate = options.allowPrivateNetwork ?? false;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && isIP(hostname) && isBlockedAddress(hostname)) {
    return Promise.reject(new FetchError(`Refusing to fetch from ${url.host}: it is a private or reserved address.`));
  }
  const timedOut = () => new FetchError(`Timed out fetching ${url.toString()}.`);
  const failed = (error: Error) => new FetchError(`Fetching ${url.toString()} failed: ${error.message}`);
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(timedOut());

  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(
      url,
      {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: options.accept ?? '*/*', 'Accept-Encoding': 'identity' },
        agent: false,
        timeout: remaining,
        ...(allowPrivate ? {} : { lookup: guardedLookup }),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          resolve({ redirect: response.headers.location, data: Buffer.alloc(0) });
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new FetchError(`Fetching ${url.toString()} failed with HTTP ${status}.`));
          return;
        }
        const tooLarge = () => new FetchError(`${url.toString()} is larger than the ${options.maxBytes} byte limit.`);
        const declared = Number(response.headers['content-length']);
        if (!options.truncate && Number.isFinite(declared) && declared > options.maxBytes) {
          response.destroy();
          reject(tooLarge());
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve({ data: Buffer.concat(chunks), contentType: response.headers['content-type'] });
        };
        response.on('data', (chunk: Buffer) => {
          if (settled) return;
          if (size + chunk.length > options.maxBytes) {
            if (options.truncate) {
              chunks.push(chunk.subarray(0, options.maxBytes - size));
              finish();
            } else {
              settled = true;
              reject(tooLarge());
            }
            response.destroy();
            return;
          }
          size += chunk.length;
          chunks.push(chunk);
        });
        response.on('end', finish);
        response.on('error', (error) => {
          if (!settled) reject(failed(error));
          settled = true;
        });
      },
    );
    const timer = setTimeout(() => request.destroy(timedOut()), remaining);
    request.on('close', () => clearTimeout(timer));
    request.on('timeout', () => request.destroy(timedOut()));
    request.on('error', (error) => reject(error instanceof FetchError ? error : failed(error)));
    request.end();
  });
}
