import { afterEach, describe, expect, it } from 'vitest';
import { LoopbackLogin, validateLoopbackRedirect, type LoopbackLoginHandle } from '../src/auth/loopback-login.js';
import { ConfigError } from '../src/errors.js';
import type { LinkedInTokens } from '../src/linkedin/oauth.js';
import { FakeLinkedIn, OAUTH_BASE } from './helpers/fake-linkedin.js';
import { freePort, startServer, type TestServer } from './helpers/http.js';

const pending: LoopbackLoginHandle[] = [];
const servers: TestServer[] = [];
afterEach(async () => {
  // Finish any flow a test left open so its listener is released.
  await Promise.all(pending.splice(0).map((flow) => fetch(callback(flow, { error: 'cleanup' })).catch(() => {})));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function callback(flow: LoopbackLoginHandle, params: Record<string, string>, path = '/callback'): string {
  const authorization = new URL(flow.authorizationUrl);
  const redirect = new URL(authorization.searchParams.get('redirect_uri')!);
  const url = new URL(path, redirect.href.replace('localhost', '127.0.0.1'));
  url.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, ...params }).toString();
  return url.href;
}

async function login(options: { onTokens?: (tokens: LinkedInTokens) => Promise<string | undefined>; timeoutMs?: number; host?: string } = {}) {
  const linkedin = new FakeLinkedIn();
  const port = await freePort();
  const received: LinkedInTokens[] = [];
  const loopback = new LoopbackLogin({
    app: { clientId: 'test-client', clientSecret: 'test-secret', scopes: ['openid', 'w_member_social'], oauthBaseUrl: OAUTH_BASE, fetch: linkedin.fetch },
    redirectUri: `http://${options.host ?? '127.0.0.1'}:${port}/callback`,
    onTokens:
      options.onTokens ??
      (async (tokens) => {
        received.push(tokens);
        return 'Ada <Lovelace>';
      }),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  return { loopback, linkedin, port, received };
}

describe('validateLoopbackRedirect', () => {
  it('accepts loopback http URIs with an explicit port', () => {
    for (const uri of ['http://localhost:8765/callback', 'http://127.0.0.1:1/cb', 'http://[::1]:9000/']) {
      expect(validateLoopbackRedirect(uri).href).toBe(new URL(uri).href);
    }
  });

  it('rejects everything else', () => {
    for (const uri of ['not a url', 'https://localhost:8765/cb', 'http://example.com:8765/cb', 'http://localhost/cb', 'http://localhost:0/cb']) {
      expect(() => validateLoopbackRedirect(uri), uri).toThrow(ConfigError);
    }
  });
});

describe('LoopbackLogin', () => {
  it('builds the LinkedIn authorization URL', async () => {
    const { loopback, port } = await login();
    const flow = await loopback.start();
    pending.push(flow);
    const url = new URL(flow.authorizationUrl);
    expect(url.origin + url.pathname).toBe(`${OAUTH_BASE}/oauth/v2/authorization`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'test-client',
      redirect_uri: `http://127.0.0.1:${port}/callback`,
      scope: 'openid w_member_social',
    });
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow.expiresAt).toBeGreaterThan(Date.now() + 9 * 60_000);
  });

  it('reuses the flow already waiting for the browser', async () => {
    const { loopback } = await login();
    const first = await loopback.start();
    pending.push(first);
    expect(await loopback.start()).toBe(first);
  });

  it('shares one listener between concurrent starts', async () => {
    const { loopback } = await login();
    const [first, second] = await Promise.all([loopback.start(), loopback.start()]);
    pending.push(first);
    expect(second).toBe(first);
  });

  it('exchanges the code, escapes the member name and closes the listener', async () => {
    const { loopback, received, linkedin } = await login();
    const flow = await loopback.start();

    const notFound = await fetch(callback(flow, { code: 'li-code' }, '/elsewhere'));
    expect(notFound.status).toBe(404);
    const missing = await fetch(callback(flow, {}));
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain('did not return an authorization code');

    const response = await fetch(callback(flow, { code: 'li-code' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('Connected to LinkedIn as <strong>Ada &#60;Lovelace&#62;</strong>');
    expect(await flow.completion).toBe('Ada <Lovelace>');
    expect(received).toEqual([expect.objectContaining({ accessToken: 'li-token', scopes: ['email', 'openid', 'profile', 'w_member_social'] })]);
    expect(new URLSearchParams(String(linkedin.find('POST', '/oauth/v2/accessToken')[0]!.body)).get('redirect_uri')).toBe(
      new URL(flow.authorizationUrl).searchParams.get('redirect_uri'),
    );

    await expect(fetch(callback(flow, { code: 'li-code' }))).rejects.toThrow();
    // A finished flow is not reused.
    const next = await loopback.start();
    pending.push(next);
    expect(next).not.toBe(flow);
  });

  it('rejects callbacks with the wrong state without ending the flow', async () => {
    const { loopback } = await login();
    const flow = await loopback.start();
    pending.push(flow);
    const response = await fetch(callback(flow, { code: 'li-code', state: 'forged' }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('This sign-in link has expired');
    expect(await loopback.start()).toBe(flow);
  });

  it('answers requests whose path is not a valid URL without ending the flow', async () => {
    const { loopback, port } = await login();
    const flow = await loopback.start();
    pending.push(flow);
    // Node accepts request targets such as `//[` that don't parse as URLs; one used to crash the whole server.
    const response = await fetch(`http://127.0.0.1:${port}//[`);
    expect(response.status).toBe(404);
    expect(await loopback.start()).toBe(flow);
  });

  it('reports a failed code exchange', async () => {
    const { loopback } = await login();
    const flow = await loopback.start();
    const response = await fetch(callback(flow, { code: 'bad-code' }));
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('LinkedIn sign-in failed');
    await expect(flow.completion).rejects.toThrow(/invalid_grant/);
  });

  it('reports failures to store the tokens', async () => {
    const { loopback } = await login({
      onTokens: async () => {
        throw new Error('disk <full>');
      },
    });
    const flow = await loopback.start();
    const response = await fetch(callback(flow, { code: 'li-code' }));
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('disk &#60;full&#62;');
    await expect(flow.completion).rejects.toThrow('disk <full>');
  });

  it('escapes LinkedIn error descriptions', async () => {
    const { loopback } = await login();
    const flow = await loopback.start();
    const response = await fetch(callback(flow, { error: 'access_denied', error_description: '<script>x</script>' }));
    expect(await response.text()).toContain('&#60;script&#62;x&#60;/script&#62;');
    await expect(flow.completion).rejects.toThrow('LinkedIn sign-in was not completed: <script>x</script>');
  });

  it('gives up after the timeout', async () => {
    const { loopback } = await login({ timeoutMs: 50 });
    const flow = await loopback.start();
    await expect(flow.completion).rejects.toThrow(/timed out/);
  });

  it('explains when the callback port is taken', async () => {
    const busy = await startServer((_req, res) => res.end());
    servers.push(busy);
    const port = new URL(busy.url).port;
    const loopback = new LoopbackLogin({
      app: { clientId: 'c', clientSecret: 's', scopes: [] },
      redirectUri: `http://127.0.0.1:${port}/callback`,
      onTokens: async () => undefined,
    });
    await expect(loopback.start()).rejects.toThrow(/Port \d+ is already in use/);
  });
});
