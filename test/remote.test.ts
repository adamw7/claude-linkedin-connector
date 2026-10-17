import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_REDIRECT_URIS, DEFAULT_SCOPES, type RemoteConfig } from '../src/config.js';
import { ApiVersion } from '../src/linkedin/versions.js';
import { createRemoteApp } from '../src/remote/app.js';
import { API_BASE, FakeLinkedIn, MEMBER, OAUTH_BASE } from './helpers/fake-linkedin.js';

interface Remote {
  base: string;
  mcpUrl: URL;
  linkedin: FakeLinkedIn;
  logs: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

const running: Remote[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((remote) => remote.close()));
});

async function startRemote(
  overrides: Partial<RemoteConfig> = {},
  fetchClientMetadata?: (url: string) => Promise<string>,
): Promise<Remote> {
  const linkedin = new FakeLinkedIn();
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const publicUrl = new URL(`http://127.0.0.1:${port}`);
  const config: RemoteConfig = {
    clientId: 'test-client',
    clientSecret: 'test-secret',
    scopes: DEFAULT_SCOPES,
    apiVersion: undefined,
    apiBaseUrl: API_BASE,
    oauthBaseUrl: OAUTH_BASE,
    publicUrl,
    host: '127.0.0.1',
    port,
    secret: 'test-secret-that-is-at-least-32-characters-long',
    ephemeralSecret: false,
    allowedRedirectUris: [...CLAUDE_REDIRECT_URIS, 'loopback'],
    allowedMembers: ['*'],
    allowedHosts: undefined,
    trustProxy: false,
    oauthRateLimit: 0,
    mcpRateLimit: 0,
    shutdownTimeoutMs: 1000,
    ...overrides,
  };
  const logs: Array<Record<string, unknown>> = [];
  const remote = createRemoteApp({
    config,
    version: new ApiVersion('202609'),
    fetch: linkedin.fetch,
    allowPrivateNetwork: true,
    logger: (level, event, fields) => logs.push({ level, event, ...fields }),
    ...(fetchClientMetadata ? { fetchClientMetadata } : {}),
  });
  server.on('request', remote.app);
  const instance: Remote = {
    base: publicUrl.origin,
    mcpUrl: remote.mcpUrl,
    linkedin,
    logs,
    close: async () => {
      await remote.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  running.push(instance);
  return instance;
}

/** Plays the user's browser: keeps cookies and never follows redirects automatically. */
class Browser {
  readonly cookies = new Map<string, string>();

  async get(url: string): Promise<Response> {
    return this.send(url, { method: 'GET' });
  }

  async post(url: string, form: Record<string, string>, origin?: string): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (origin) headers.Origin = origin;
    return this.send(url, { method: 'POST', headers, body: new URLSearchParams(form).toString() });
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) headers.set('Cookie', [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    const response = await fetch(url, { ...init, headers, redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = cookie.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (!value || attributes.some((attribute) => /expires=Thu, 01 Jan 1970/i.test(attribute))) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }
}

/**
 * The Origin a browser sends when a form on `page` is submitted to `action`: the Fetch spec
 * replaces it with "null" for POST navigations when the page's referrer policy forbids it.
 */
function formOrigin(page: Response, action: string): string {
  const pageOrigin = new URL(page.url).origin;
  switch (page.headers.get('referrer-policy')) {
    case 'no-referrer':
      return 'null';
    case 'same-origin':
      return new URL(action).origin === pageOrigin ? pageOrigin : 'null';
    default:
      return pageOrigin;
  }
}

function hiddenField(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (!match) throw new Error(`No ${name} field in consent page`);
  return match[1]!;
}

/** Approves the consent screen and plays LinkedIn's redirect back. Returns where the client is finally sent. */
async function approve(browser: Browser, authorizationUrl: string, options: { decision?: string; linkedInQuery?: Record<string, string> } = {}): Promise<URL> {
  const consentPage = await browser.get(authorizationUrl);
  expect(consentPage.status).toBe(200);
  const html = await consentPage.text();
  const action = new URL('/authorize', authorizationUrl).href;
  const decided = await browser.post(
    action,
    { consent: hiddenField(html, 'consent'), csrf: hiddenField(html, 'csrf'), decision: options.decision ?? 'approve' },
    formOrigin(consentPage, action),
  );
  expect(decided.status).toBe(302);
  const next = new URL(decided.headers.get('location')!);
  if (next.origin !== OAUTH_BASE) return next;
  expect(next.pathname).toBe('/oauth/v2/authorization');
  expect(next.searchParams.get('client_id')).toBe('test-client');
  expect(next.searchParams.get('scope')).toBe('openid profile email w_member_social');
  const callback = new URL(next.searchParams.get('redirect_uri')!);
  expect(callback.href).toBe(new URL('/oauth/callback', authorizationUrl).href);
  for (const [key, value] of Object.entries(options.linkedInQuery ?? { code: 'li-code' })) callback.searchParams.set(key, value);
  callback.searchParams.set('state', next.searchParams.get('state')!);
  const back = await browser.get(callback.href);
  expect(back.status).toBe(302);
  return new URL(back.headers.get('location')!);
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function register(remote: Remote, metadata: Record<string, unknown>): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${remote.base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

function authorizeUrl(remote: Remote, params: Record<string, string | undefined>): string {
  const url = new URL('/authorize', remote.base);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url.href;
}

async function token(remote: Remote, form: Record<string, string>, headers: Record<string, string> = {}) {
  const response = await fetch(`${remote.base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form).toString(),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const REDIRECT = 'http://localhost:7777/callback';

/** Registers a public client and runs the browser part of the flow; returns the code and PKCE verifier. */
async function obtainCode(remote: Remote, extra: Record<string, string> = {}) {
  const { body: client } = await register(remote, { client_name: 'Test', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
  const { verifier, challenge } = pkce();
  const landing = await approve(
    new Browser(),
    authorizeUrl(remote, {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'client-state',
      resource: remote.mcpUrl.href,
      ...extra,
    }),
  );
  return { clientId: client.client_id as string, verifier, code: landing.searchParams.get('code')!, landing };
}

/** Runs the whole flow and returns an access token for /mcp. */
async function accessToken(remote: Remote): Promise<string> {
  const { clientId, verifier, code } = await obtainCode(remote);
  const { body } = await token(remote, { grant_type: 'authorization_code', code, client_id: clientId, code_verifier: verifier });
  return body.access_token as string;
}

function ping(remote: Remote, bearer: string): Promise<Response> {
  return fetch(remote.mcpUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
}

class TestOAuthProvider implements OAuthClientProvider {
  clientInfo: StoredOAuthClientInformation | undefined;
  saved: StoredOAuthTokens | undefined;
  verifier = '';
  authorizationUrl: URL | undefined;
  readonly redirectUrl = REDIRECT;

  get clientMetadata() {
    return {
      client_name: 'Claude (test)',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() {
    return this.clientInfo;
  }
  saveClientInformation(info: StoredOAuthClientInformation) {
    this.clientInfo = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: StoredOAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

describe('remote connector end to end', () => {
  it('lets an MCP client discover, register, authorize and post', async () => {
    const remote = await startRemote();
    const provider = new TestOAuthProvider();

    const first = new Client({ name: 'e2e', version: '1.0.0' });
    await expect(first.connect(new StreamableHTTPClientTransport(remote.mcpUrl, { authProvider: provider }))).rejects.toThrow(UnauthorizedError);
    expect(provider.clientInfo?.client_id).toBeDefined();
    const authorizationUrl = provider.authorizationUrl!;
    expect(authorizationUrl.searchParams.get('resource')).toBe(remote.mcpUrl.href);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');

    const landing = await approve(new Browser(), authorizationUrl.href);
    expect(landing.origin + landing.pathname).toBe(REDIRECT);
    expect(landing.searchParams.get('iss')).toBe(remote.base);
    const transport = new StreamableHTTPClientTransport(remote.mcpUrl, { authProvider: provider });
    await transport.finishAuth(landing.searchParams);
    expect(provider.saved?.token_type).toBe('Bearer');
    expect(provider.saved?.access_token).not.toContain('li-token');

    const client = new Client({ name: 'e2e', version: '1.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'linkedin_get_profile',
      'linkedin_read_connections',
      'linkedin_create_post',
      'linkedin_edit_post',
      'linkedin_delete_post',
      'linkedin_auth_status',
    ]);

    const status = await client.callTool({ name: 'linkedin_auth_status', arguments: {} });
    expect(status.structuredContent).toMatchObject({ authenticated: true, source: 'connector', name: 'Ada Lovelace' });

    const post = await client.callTool({ name: 'linkedin_create_post', arguments: { text: 'Hello from Claude' } });
    expect(post.isError).not.toBe(true);
    expect(post.structuredContent).toMatchObject({ author: 'urn:li:person:abc123' });
    const sent = remote.linkedin.find('POST', '/rest/posts')[0]!;
    expect(sent.headers.get('authorization')).toBe('Bearer li-token');
    // The member was resolved during sign-in, so no userinfo call was needed when posting.
    expect(remote.linkedin.find('GET', '/v2/userinfo')).toHaveLength(1);
    await client.close();

    expect(remote.logs).toContainEqual(expect.objectContaining({ event: 'member_authorized', member: 'abc123' }));
    expect(remote.logs).toContainEqual(
      expect.objectContaining({ level: 'info', event: 'tool_call', tool: 'linkedin_create_post', ok: true, member: 'abc123' }),
    );
    expect(remote.logs).toContainEqual(expect.objectContaining({ event: 'http_request', method: 'GET', path: '/oauth/callback', status: 302 }));
    // Neither tokens, codes nor post text reach the logs.
    const logged = JSON.stringify(remote.logs);
    for (const secret of ['li-token', 'li-code', provider.saved!.access_token, 'Hello from Claude']) expect(logged).not.toContain(secret);
  });

  it('works with a Client ID Metadata Document instead of registration', async () => {
    const clientId = 'https://client.example/oauth/metadata.json';
    const remote = await startRemote({}, async (url) => {
      expect(url).toBe(clientId);
      return JSON.stringify({ client_id: clientId, client_name: 'Metadata Client', redirect_uris: [REDIRECT] });
    });
    const { verifier, challenge } = pkce();
    const browser = new Browser();
    const url = authorizeUrl(remote, {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const consent = await (await browser.get(url)).text();
    expect(consent).toContain('Connect LinkedIn to Metadata Client');
    expect(consent).toContain('client.example');
    expect(consent).toContain('localhost');
    const landing = await approve(new Browser(), url);
    const result = await token(remote, {
      grant_type: 'authorization_code',
      code: landing.searchParams.get('code')!,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ token_type: 'Bearer', expires_in: expect.any(Number) });
  });
});

describe('remote connector discovery', () => {
  it('challenges unauthenticated MCP requests with the resource metadata URL', async () => {
    const remote = await startRemote();
    const response = await fetch(remote.mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(`resource_metadata="${remote.base}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('answers CORS preflights for browser-based clients', async () => {
    const remote = await startRemote();
    const response = await fetch(remote.mcpUrl, {
      method: 'OPTIONS',
      headers: { Origin: 'https://inspector.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type, mcp-protocol-version' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(response.headers.get('access-control-expose-headers')).toContain('WWW-Authenticate');
  });

  it('rejects forged tokens', async () => {
    const remote = await startRemote();
    const response = await fetch(remote.mcpUrl, {
      method: 'POST',
      headers: { Authorization: 'Bearer forged', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(401);
  });

  it('rejects tokens issued by another deployment, even one sharing SERVER_SECRET', async () => {
    const [first, second] = await Promise.all([startRemote(), startRemote()]);
    const bearer = await accessToken(first);
    expect((await ping(first, bearer)).status).toBe(200);
    expect((await ping(second, bearer)).status).toBe(401);
  });

  it('serves protected resource and authorization server metadata', async () => {
    const remote = await startRemote();
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const metadata = (await (await fetch(`${remote.base}${path}`)).json()) as Record<string, unknown>;
      expect(metadata).toMatchObject({ resource: remote.mcpUrl.href, authorization_servers: [remote.base], resource_name: 'LinkedIn' });
    }
    const as = (await (await fetch(`${remote.base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as).toMatchObject({
      issuer: remote.base,
      authorization_endpoint: `${remote.base}/authorize`,
      token_endpoint: `${remote.base}/token`,
      registration_endpoint: `${remote.base}/register`,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
    });
  });

  it('serves a landing page and health check', async () => {
    const remote = await startRemote();
    expect(await (await fetch(remote.base)).text()).toContain(remote.mcpUrl.href);
    expect(await (await fetch(`${remote.base}/healthz`)).json()).toEqual({ status: 'ok' });
  });

  it('reports oversized and malformed bodies as JSON, not an HTML stack trace', async () => {
    const remote = await startRemote();
    const post = (path: string, body: string) =>
      fetch(`${remote.base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

    const huge = JSON.stringify({ data: 'x'.repeat(31 * 1024 * 1024) });
    // Bodies are only read once the caller has authenticated.
    expect((await post('/mcp', huge)).status).toBe(401);

    const tooLarge = await fetch(remote.mcpUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken(remote)}`, 'Content-Type': 'application/json' },
      body: huge,
    });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32600, message: expect.stringContaining('instead of a data: URI') },
      id: null,
    });

    const tooLargeRegistration = await post('/register', JSON.stringify({ redirect_uris: [REDIRECT], padding: 'x'.repeat(100 * 1024) }));
    expect(tooLargeRegistration.status).toBe(413);
    expect(await tooLargeRegistration.json()).toEqual({ error: 'invalid_request', error_description: 'The request body is too large.' });

    const malformed = await post('/register', '{bad');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'invalid_request', error_description: 'The request body is not valid JSON.' });
  });
});

describe('dynamic client registration', () => {
  it('registers Claude and loopback clients', async () => {
    const remote = await startRemote();
    const claude = await register(remote, { client_name: 'Claude', redirect_uris: [CLAUDE_REDIRECT_URIS[0]] });
    expect(claude.status).toBe(201);
    expect(claude.body).toMatchObject({ token_endpoint_auth_method: 'client_secret_basic', grant_types: ['authorization_code'], client_secret: expect.any(String) });
    const local = await register(remote, { redirect_uris: ['http://127.0.0.1:5555/cb'], token_endpoint_auth_method: 'none' });
    expect(local.status).toBe(201);
    expect(local.body.client_secret).toBeUndefined();
  });

  it.each([
    [{ redirect_uris: ['https://evil.example/callback'] }, 'invalid_redirect_uri'],
    [{ redirect_uris: ['http://evil.example/callback'] }, 'invalid_redirect_uri'],
    [{ redirect_uris: [] }, 'invalid_redirect_uri'],
    [{ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'private_key_jwt' }, 'invalid_client_metadata'],
    [{ redirect_uris: [REDIRECT], grant_types: ['client_credentials'] }, 'invalid_client_metadata'],
  ])('rejects %j', async (metadata, error) => {
    const remote = await startRemote();
    const result = await register(remote, metadata);
    expect(result.status).toBe(400);
    expect(result.body.error).toBe(error);
  });

  it('honours a custom redirect allowlist', async () => {
    const remote = await startRemote({ allowedRedirectUris: ['https://app.example/oauth/*'] });
    expect((await register(remote, { redirect_uris: ['https://app.example/oauth/callback'] })).status).toBe(201);
    expect((await register(remote, { redirect_uris: [REDIRECT] })).status).toBe(400);
    expect((await register(remote, { redirect_uris: ['https://app.example/oauth/../evil'] })).status).toBe(400);
  });
});

describe('authorization endpoint', () => {
  async function client(remote: Remote) {
    return (await register(remote, { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' })).body.client_id as string;
  }

  it('shows an error page instead of redirecting for unknown clients or redirect URIs', async () => {
    const remote = await startRemote();
    const clientId = await client(remote);
    for (const params of [
      { client_id: 'made-up', redirect_uri: REDIRECT },
      { client_id: clientId, redirect_uri: 'https://evil.example/cb' },
      { client_id: `${clientId}x`, redirect_uri: REDIRECT },
    ]) {
      const response = await fetch(authorizeUrl(remote, { response_type: 'code', ...params }), { redirect: 'manual' });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('Unknown application');
    }
  });

  it('accepts any port for loopback redirect URIs', async () => {
    const remote = await startRemote();
    const clientId = await client(remote);
    const { challenge } = pkce();
    const response = await fetch(
      authorizeUrl(remote, { response_type: 'code', client_id: clientId, redirect_uri: 'http://localhost:9999/callback', code_challenge: challenge, code_challenge_method: 'S256' }),
    );
    expect(response.status).toBe(200);
  });

  it.each([
    [{ code_challenge_method: 'plain' }, 'invalid_request'],
    [{ code_challenge: undefined }, 'invalid_request'],
    [{ response_type: 'token' }, 'unsupported_response_type'],
    [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
  ])('redirects protocol errors back to the client: %j', async (override, error) => {
    const remote = await startRemote();
    const clientId = await client(remote);
    const response = await fetch(
      authorizeUrl(remote, {
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
        state: 's1',
        ...override,
      }),
      { redirect: 'manual' },
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe(error);
    expect(location.searchParams.get('state')).toBe('s1');
  });

  it('protects the consent form against cross-site submission', async () => {
    const remote = await startRemote();
    const clientId = await client(remote);
    const browser = new Browser();
    const html = await (
      await browser.get(authorizeUrl(remote, { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256' }))
    ).text();
    const form = { consent: hiddenField(html, 'consent'), csrf: hiddenField(html, 'csrf'), decision: 'approve' };
    // An attacker's page can replay the form fields, but not the victim's SameSite cookie.
    const attacker = await new Browser().post(`${remote.base}/authorize`, form, remote.base);
    expect(attacker.status).toBe(400);
    const crossOrigin = await browser.post(`${remote.base}/authorize`, form, 'https://evil.example');
    expect(crossOrigin.status).toBe(400);
  });

  it('re-checks the client when the consent is approved', async () => {
    const allowedRedirectUris = [...CLAUDE_REDIRECT_URIS, 'loopback'];
    const remote = await startRemote({ allowedRedirectUris });
    const clientId = await client(remote);
    const browser = new Browser();
    const html = await (
      await browser.get(authorizeUrl(remote, { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256' }))
    ).text();
    // The operator stops allowing loopback redirects while the consent page is open.
    allowedRedirectUris.splice(allowedRedirectUris.indexOf('loopback'), 1);
    const response = await browser.post(`${remote.base}/authorize`, { consent: hiddenField(html, 'consent'), csrf: hiddenField(html, 'csrf'), decision: 'approve' }, remote.base);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('no longer allowed to connect');
  });

  it('accepts an approval sent with an opaque Origin, since the CSRF cookie is what protects it', async () => {
    const remote = await startRemote();
    const clientId = await client(remote);
    const browser = new Browser();
    const html = await (
      await browser.get(authorizeUrl(remote, { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256' }))
    ).text();
    const response = await browser.post(`${remote.base}/authorize`, { consent: hiddenField(html, 'consent'), csrf: hiddenField(html, 'csrf'), decision: 'approve' }, 'null');
    expect(response.status).toBe(302);
  });

  it('reports a declined consent or LinkedIn sign-in to the client', async () => {
    const remote = await startRemote();
    const clientId = await client(remote);
    const params = { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256', state: 'abc' };
    const declined = await approve(new Browser(), authorizeUrl(remote, params), { decision: 'deny' });
    expect(Object.fromEntries(declined.searchParams)).toMatchObject({ error: 'access_denied', state: 'abc' });
    const cancelled = await approve(new Browser(), authorizeUrl(remote, params), { linkedInQuery: { error: 'user_cancelled_authorize' } });
    expect(Object.fromEntries(cancelled.searchParams)).toMatchObject({ error: 'access_denied', state: 'abc' });
    const badCode = await approve(new Browser(), authorizeUrl(remote, params), { linkedInQuery: { code: 'wrong' } });
    expect(badCode.searchParams.get('error')).toBe('server_error');
  });

  it('rejects LinkedIn callbacks that do not belong to this browser session', async () => {
    const remote = await startRemote();
    const response = await fetch(`${remote.base}/oauth/callback?code=li-code&state=guess`, { redirect: 'manual' });
    expect(response.status).toBe(400);
  });

  it('can restrict which LinkedIn members may connect', async () => {
    const remote = await startRemote({ allowedMembers: ['someone@example.com'] });
    const { landing } = await obtainCode(remote);
    expect(landing.searchParams.get('error')).toBe('access_denied');
    expect(remote.logs).toContainEqual(expect.objectContaining({ level: 'warn', event: 'member_not_allowed', member: 'abc123' }));
    const allowed = await startRemote({ allowedMembers: ['ADA@example.com'.toLowerCase()] });
    expect((await obtainCode(allowed)).landing.searchParams.get('code')).toBeTruthy();
  });

  it('matches the allowlist only against a verified email', async () => {
    const remote = await startRemote({ allowedMembers: ['ada@example.com'] });
    remote.linkedin.override(({ url }) =>
      url.pathname === '/v2/userinfo' ? Response.json({ ...MEMBER, email_verified: false }) : undefined,
    );
    expect((await obtainCode(remote)).landing.searchParams.get('error')).toBe('access_denied');
  });

  it('cuts off issued tokens when a member is removed from the allowlist', async () => {
    const allowedMembers = ['abc123'];
    const remote = await startRemote({ allowedMembers });
    const bearer = await accessToken(remote);
    expect((await ping(remote, bearer)).status).toBe(200);
    allowedMembers.splice(0, 1, 'someone-else');
    expect((await ping(remote, bearer)).status).toBe(401);
  });
});

describe('rate limiting', () => {
  it('limits OAuth endpoints per client IP', async () => {
    const remote = await startRemote({ oauthRateLimit: 2 });
    const metadata = { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' };
    expect((await register(remote, metadata)).status).toBe(201);
    expect((await register(remote, metadata)).status).toBe(201);
    const response = await fetch(`${remote.base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await response.json()).toMatchObject({ error: 'too_many_requests' });
    expect(remote.logs).toContainEqual(expect.objectContaining({ event: 'http_request', path: '/register', status: 429 }));
    // Discovery and health checks are not limited.
    expect((await fetch(`${remote.base}/healthz`)).status).toBe(200);
  });

  it('limits MCP requests per connected account', async () => {
    const remote = await startRemote({ mcpRateLimit: 1 });
    const bearer = await accessToken(remote);
    expect((await ping(remote, bearer)).status).not.toBe(429);
    const limited = await ping(remote, bearer);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32600 } });
    // Unauthenticated requests are challenged, not counted against anyone.
    expect((await fetch(remote.mcpUrl, { method: 'POST' })).status).toBe(401);
  });
});

describe('token endpoint', () => {
  it('issues a token once per code, after PKCE verification', async () => {
    const remote = await startRemote();
    const { clientId, verifier, code } = await obtainCode(remote);
    const base = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId };
    expect((await token(remote, { ...base, code_verifier: pkce().verifier })).body.error).toBe('invalid_grant');
    expect((await token(remote, { ...base, code_verifier: verifier, redirect_uri: 'http://localhost:7777/other' })).body.error).toBe('invalid_grant');
    expect((await token(remote, { ...base, code_verifier: verifier, resource: 'https://other.example/mcp' })).body.error).toBe('invalid_target');
    const ok = await token(remote, { ...base, code_verifier: verifier, resource: remote.mcpUrl.href });
    expect(ok.status).toBe(200);
    expect(ok.body.expires_in).toBeGreaterThan(59 * 24 * 3600);
    const replay = await token(remote, { ...base, code_verifier: verifier });
    expect(replay.body).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('already used') });
  });

  it('accepts token requests that omit redirect_uri', async () => {
    const remote = await startRemote();
    const { clientId, verifier, code } = await obtainCode(remote);
    const result = await token(remote, { grant_type: 'authorization_code', code, client_id: clientId, code_verifier: verifier });
    expect(result.status).toBe(200);
  });

  it('binds codes to the client they were issued to', async () => {
    const remote = await startRemote();
    const { verifier, code } = await obtainCode(remote);
    const other = (await register(remote, { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' })).body.client_id as string;
    const result = await token(remote, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: other, code_verifier: verifier });
    expect(result.body.error).toBe('invalid_grant');
  });

  it('authenticates confidential clients', async () => {
    const remote = await startRemote();
    const { body: client } = await register(remote, { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' });
    const { verifier, challenge } = pkce();
    const landing = await approve(
      new Browser(),
      authorizeUrl(remote, { response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' }),
    );
    const form = { grant_type: 'authorization_code', code: landing.searchParams.get('code')!, redirect_uri: REDIRECT, code_verifier: verifier };
    const unauthenticated = await token(remote, { ...form, client_id: client.client_id });
    expect(unauthenticated.status).toBe(401);
    const wrongSecret = await token(remote, { ...form, client_id: client.client_id, client_secret: 'nope' });
    expect(wrongSecret.status).toBe(401);
    const basic = Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString('base64');
    const ok = await token(remote, form, { Authorization: `Basic ${basic}` });
    expect(ok.status).toBe(200);
  });

  it('rejects a client_id that contradicts the Authorization header', async () => {
    const remote = await startRemote();
    const { clientId, verifier, code } = await obtainCode(remote);
    const basic = Buffer.from(`someone-else:secret`).toString('base64');
    const result = await token(remote, { grant_type: 'authorization_code', code, client_id: clientId, code_verifier: verifier }, { Authorization: `Basic ${basic}` });
    expect(result).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
  });

  it('issues no token for a LinkedIn grant that has already expired', async () => {
    const remote = await startRemote();
    remote.linkedin.override(({ url }) =>
      url.pathname === '/oauth/v2/accessToken' ? Response.json({ access_token: 'li-token', expires_in: 0, scope: remote.linkedin.grantedScope }) : undefined,
    );
    const { clientId, verifier, code } = await obtainCode(remote);
    const result = await token(remote, { grant_type: 'authorization_code', code, client_id: clientId, code_verifier: verifier });
    expect(result.body).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('already expired') });
  });

  it('only supports the authorization_code grant', async () => {
    const remote = await startRemote();
    expect((await token(remote, { grant_type: 'refresh_token', refresh_token: 'x' })).body.error).toBe('unsupported_grant_type');
  });
});
