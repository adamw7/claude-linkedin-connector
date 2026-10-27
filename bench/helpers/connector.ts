import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { LocalAuth } from '../../src/auth/local-auth.js';
import { PostHistory } from '../../src/auth/post-history.js';
import { TokenStore } from '../../src/auth/token-store.js';
import { loadLocalConfig, loadRemoteConfig } from '../../src/config.js';
import { ApiVersion } from '../../src/linkedin/versions.js';
import { createConnectorServer } from '../../src/mcp/server.js';
import { createRemoteApp } from '../../src/remote/app.js';
import { pkceChallenge } from '../../src/remote/crypto.js';
import { jsonLogger, type Logger } from '../../src/remote/logger.js';
import { API_BASE, FakeLinkedIn, MEMBER, OAUTH_BASE } from '../../test/helpers/fake-linkedin.js';

/** The LinkedIn app settings both modes are configured with, pointed at the fake LinkedIn. */
const APP = {
  LINKEDIN_CLIENT_ID: 'test-client',
  LINKEDIN_CLIENT_SECRET: 'test-secret',
  LINKEDIN_API_BASE_URL: API_BASE,
  LINKEDIN_OAUTH_BASE_URL: OAUTH_BASE,
};

const VERSION = '202609';

/** Calls a tool and returns its structured result, throwing if it failed: a benchmark must not time an error path by mistake. */
export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  return result.structuredContent as Record<string, any>;
}

export interface Local {
  client: Client;
  linkedin: FakeLinkedIn;
  /** The folder local files may come from (LINKEDIN_FILE_DIRS). */
  files: string;
  close: () => Promise<void>;
}

/**
 * The connector as `claude-linkedin-connector stdio` composes it, with its token and post history on disk, signed in
 * (as after `login` and a first tool call that looked up the member) and connected to an MCP client in memory.
 */
export async function startLocal(): Promise<Local> {
  const home = await mkdtemp(join(tmpdir(), 'linkedin-bench-'));
  const files = join(home, 'files');
  await mkdir(files);
  const config = loadLocalConfig({ ...APP, LINKEDIN_TOKEN_FILE: join(home, 'token.json'), LINKEDIN_FILE_DIRS: files });
  await new TokenStore(config.tokenFile).write({
    version: 1,
    accessToken: 'li-token',
    expiresAt: Date.now() + 30 * 86_400_000,
    scopes: config.scopes,
    member: { id: MEMBER.sub, name: MEMBER.name, email: MEMBER.email },
  });
  const linkedin = new FakeLinkedIn();
  const version = new ApiVersion(VERSION);
  const server = createConnectorServer({
    mode: 'local',
    auth: new LocalAuth({ config, version, fetch: linkedin.fetch }),
    version,
    scopes: config.scopes,
    apiBaseUrl: config.apiBaseUrl,
    fetch: linkedin.fetch,
    // Link previews come from a page served on loopback.
    allowPrivateNetwork: true,
    localFileDirs: config.fileDirs,
    history: new PostHistory(config.postHistoryFile),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'bench', version: '1.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    linkedin,
    files,
    close: async () => {
      await client.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

export interface Remote {
  base: string;
  mcpUrl: URL;
  linkedin: FakeLinkedIn;
  /** The events logged at warn or error level: a benchmark that caused any measured something going wrong. */
  problems: string[];
  close: () => Promise<void>;
}

/** The connector as `claude-linkedin-connector http` composes it, listening on loopback, logging as in production but to nowhere. */
export async function startRemote(): Promise<Remote> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const config = loadRemoteConfig({
    ...APP,
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    PORT: String(port),
    SERVER_SECRET: 'bench-secret-that-is-at-least-32-characters-long',
    // The benchmarks send many times more requests a minute than the limits allow anyone.
    RATE_LIMIT_OAUTH: '0',
    RATE_LIMIT_MCP: '0',
  });
  const linkedin = new FakeLinkedIn();
  const problems: string[] = [];
  const production = jsonLogger(() => {});
  const logger: Logger = (level, event, fields) => {
    if (level !== 'info') problems.push(event);
    production(level, event, fields);
  };
  const remote = createRemoteApp({ config, version: new ApiVersion(VERSION), fetch: linkedin.fetch, allowPrivateNetwork: true, logger });
  server.on('request', remote.app);
  return {
    base: config.publicUrl.origin,
    mcpUrl: remote.mcpUrl,
    linkedin,
    problems,
    close: async () => {
      await remote.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Where the benchmark's OAuth client (a desktop app, say) receives the authorization code. */
const REDIRECT_URI = 'http://localhost:7777/callback';

function expectStatus(response: Response, status: number, step: string): void {
  if (response.status !== status) throw new Error(`${step}: expected HTTP ${status}, got ${response.status}`);
}

function setCookie(response: Response, name: string): string {
  const cookie = response.headers.getSetCookie().find((header) => header.startsWith(`${name}=`));
  if (!cookie) throw new Error(`No ${name} cookie was set`);
  return cookie.slice(0, cookie.indexOf(';'));
}

function hiddenField(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (!match) throw new Error(`No ${name} field on the consent page`);
  return match[1]!;
}

/**
 * Connects an OAuth client to the remote connector as Claude and the member's browser do: registers the client,
 * approves the consent screen, signs in to LinkedIn and redeems the code. Returns the access token for /mcp.
 */
export async function signIn(remote: Remote): Promise<string> {
  const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const registration = await fetch(`${remote.base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Benchmark', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' }),
  });
  expectStatus(registration, 201, 'Registration');
  const { client_id: clientId } = (await registration.json()) as { client_id: string };

  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL('/authorize', remote.base);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
    state: 'bench',
    resource: remote.mcpUrl.href,
  }).toString();
  const consentPage = await fetch(authorize);
  expectStatus(consentPage, 200, 'Consent page');
  const html = await consentPage.text();
  const approved = await fetch(`${remote.base}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...form, Cookie: setCookie(consentPage, 'csrf'), Origin: remote.base },
    body: new URLSearchParams({ consent: hiddenField(html, 'consent'), csrf: hiddenField(html, 'csrf'), decision: 'approve' }),
  });
  expectStatus(approved, 302, 'Consent');

  // LinkedIn signs the member in and sends the browser back with its code.
  const linkedIn = new URL(approved.headers.get('location')!);
  const callback = new URL(linkedIn.searchParams.get('redirect_uri')!);
  callback.searchParams.set('code', 'li-code');
  callback.searchParams.set('state', linkedIn.searchParams.get('state')!);
  const back = await fetch(callback, { redirect: 'manual', headers: { Cookie: setCookie(approved, 'auth') } });
  expectStatus(back, 302, 'LinkedIn callback');
  const code = new URL(back.headers.get('location')!).searchParams.get('code');
  if (!code) throw new Error(`The sign-in ended without a code: ${back.headers.get('location')}`);

  const token = await fetch(`${remote.base}/token`, {
    method: 'POST',
    headers: form,
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, code_verifier: verifier, redirect_uri: REDIRECT_URI }),
  });
  expectStatus(token, 200, 'Token');
  return ((await token.json()) as { access_token: string }).access_token;
}

/** An MCP client connected to the remote connector with this access token, as Claude connects to a custom connector. */
export async function connectRemote(remote: Remote, accessToken: string): Promise<Client> {
  const client = new Client({ name: 'bench', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(remote.mcpUrl, { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return client;
}
