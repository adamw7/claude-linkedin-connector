import { EventEmitter } from 'node:events';
import http, { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type RequestOptions } from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { PassThrough } from 'node:stream';
import { vi } from 'vitest';

export interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

export interface FakeRequest {
  url: URL;
  headers: OutgoingHttpHeaders;
}

/**
 * Replaces `http.request` and `https.request` with in-memory servers, for code (safeFetch) that can't be
 * pointed at a loopback test server because it refuses private addresses. Hosts in `publicHosts` answer
 * as if they were on the internet. IP literals are connected to directly, and any other host first goes
 * through the request's `lookup` option, as with a real connection, so safeFetch's guards run for real.
 * Restore with `vi.restoreAllMocks()`.
 */
export function fakeTransport(respond: (request: FakeRequest) => FakeResponse, publicHosts: string[] = ['public.example']): FakeRequest[] {
  const requests: FakeRequest[] = [];
  const request = ((url: URL, options: RequestOptions, onResponse: (response: IncomingMessage) => void) => {
    const fake = new EventEmitter() as EventEmitter & { end(): void; destroy(error?: Error): void };
    let done = false;
    fake.destroy = (error) => {
      if (done) return;
      done = true;
      if (error) fake.emit('error', error);
      fake.emit('close');
    };
    fake.end = () => {
      const answer = () => {
        const recorded = { url, headers: options.headers as OutgoingHttpHeaders };
        requests.push(recorded);
        const { status, headers = {}, body } = respond(recorded);
        const response = Object.assign(new PassThrough(), {
          statusCode: status,
          headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])) as IncomingHttpHeaders,
        });
        onResponse(response as unknown as IncomingMessage);
        response.end(body);
        response.on('end', () => fake.destroy());
      };
      if (publicHosts.includes(url.hostname) || isIP(url.hostname.replace(/^\[|\]$/g, ''))) {
        answer();
        return;
      }
      const lookup = options.lookup as LookupFunction | undefined;
      if (!lookup) answer();
      else lookup(url.hostname, {}, (error) => (error ? fake.destroy(error) : answer()));
    };
    return fake;
  }) as unknown as typeof http.request;
  vi.spyOn(http, 'request').mockImplementation(request);
  vi.spyOn(https, 'request').mockImplementation(request as unknown as typeof https.request);
  return requests;
}
