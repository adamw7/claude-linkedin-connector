import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';
import { freePort, startServer, type TestServer } from './helpers/http.js';

// The CLI is bundled from src/ for the test, so it never runs a stale dist/.
let bundleDir: string;
let ENTRY: string;
beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), 'cli-bundle-'));
  ENTRY = join(bundleDir, 'cli.cjs');
  await build({ entryPoints: ['src/index.ts'], outfile: ENTRY, bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent' });
}, 30_000);
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

let home: string;
let tokenFile: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cli-home-'));
  tokenFile = join(home, 'token.json');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** A clean environment: nothing from the developer's own LinkedIn setup leaks in. */
function environment(env: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: home, APPDATA: home, LINKEDIN_TOKEN_FILE: tokenFile, ...env };
}

function cli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [ENTRY, ...args], { encoding: 'utf8', env: environment(env), timeout: 10_000 });
}

function storeToken(): void {
  const token = {
    version: 1,
    accessToken: 'li-token',
    scopes: ['openid', 'profile', 'w_member_social'],
    obtainedAt: Date.now(),
    expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
    member: { id: 'abc123', name: 'Ada Lovelace' },
  };
  writeFileSync(tokenFile, JSON.stringify(token));
}

describe('command line', () => {
  it.each(['version', '--version', '-v'])('prints the version for %s', (flag) => {
    expect(cli([flag])).toMatchObject({ status: 0, stdout: `${VERSION}\n` });
  });

  it('prints help', () => {
    const { status, stdout } = cli(['help']);
    expect(status).toBe(0);
    for (const command of ['stdio', 'http', 'login', 'logout', 'status']) expect(stdout).toContain(`  ${command} `);
  });

  it('rejects unknown commands with exit code 2', () => {
    const { status, stderr } = cli(['nope']);
    expect(status).toBe(2);
    expect(stderr).toContain('Unknown command "nope"');
  });

  it('reports the sign-in status', () => {
    const signedOut = cli(['status']);
    expect(signedOut.status).toBe(1);
    expect(signedOut.stdout).toContain('You are not signed in to LinkedIn');

    storeToken();
    const signedIn = cli(['status']);
    expect(signedIn.status).toBe(0);
    expect(signedIn.stdout).toContain('Signed in as Ada Lovelace');
    expect(signedIn.stdout).toContain('Scopes: openid profile w_member_social');

    expect(cli(['status'], { LINKEDIN_ACCESS_TOKEN: 'env-token' })).toMatchObject({ status: 0, stdout: expect.stringContaining('LINKEDIN_ACCESS_TOKEN') });
  });

  it('logs out by deleting the stored token', () => {
    storeToken();
    expect(cli(['logout'])).toMatchObject({ status: 0, stdout: `Deleted ${tokenFile}.\n` });
    expect(existsSync(tokenFile)).toBe(false);
    expect(cli(['logout']).stdout).toContain('No stored LinkedIn token found.');
  });

  it('explains missing configuration instead of crashing', () => {
    const login = cli(['login', '--no-browser']);
    expect(login.status).toBe(1);
    expect(login.stderr).toContain('set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET');

    const http = cli(['http']);
    expect(http.status).toBe(1);
    expect(http.stderr).toContain('Missing required environment variables: LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, PUBLIC_URL.');
    expect(http.stderr).not.toContain('    at '); // no stack trace
  });
});

describe('login command', () => {
  let linkedin: TestServer;
  beforeAll(async () => {
    // Plays LinkedIn's token endpoint and userinfo for the whole sign-in.
    linkedin = await startServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/oauth/v2/accessToken') {
        res.end(JSON.stringify({ access_token: 'li-token', expires_in: 5_184_000, scope: 'openid,profile,w_member_social' }));
      } else if (req.url === '/v2/userinfo' && req.headers.authorization === 'Bearer li-token') {
        res.end(JSON.stringify({ sub: 'abc123', name: 'Ada Lovelace' }));
      } else res.writeHead(404).end('{}');
    });
  });
  afterAll(() => linkedin.close());

  let browserLog: string;
  beforeEach(() => {
    // Stand-ins for the commands the CLI opens links with, logging what they were asked to open.
    browserLog = join(home, 'browser.log');
    for (const opener of ['xdg-open', 'open']) {
      writeFileSync(join(home, opener), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${browserLog}"\n`);
      chmodSync(join(home, opener), 0o755);
    }
  });

  /** Starts `login` and waits until it is listening for the callback. */
  async function startLogin(args: string[]) {
    const port = await freePort();
    const child = spawn(process.execPath, [ENTRY, 'login', ...args], {
      env: environment({
        PATH: `${home}${delimiter}${process.env.PATH ?? ''}`,
        LINKEDIN_CLIENT_ID: 'test-client',
        LINKEDIN_CLIENT_SECRET: 'test-secret',
        LINKEDIN_REDIRECT_URI: `http://127.0.0.1:${port}/callback`,
        LINKEDIN_OAUTH_BASE_URL: linkedin.url,
        LINKEDIN_API_BASE_URL: linkedin.url,
      }),
    });
    const login = { child, port, output: '', exited: once(child, 'exit'), authorization: undefined as unknown as URL };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (login.output += chunk));
    // The link is printed first; the CLI is listening by the time it says it is waiting.
    while (!login.output.includes('Waiting for LinkedIn')) await once(child.stdout, 'data');
    login.authorization = new URL(/https?:\/\/\S+authorization\S*/.exec(login.output)![0]);
    return login;
  }

  it('signs in through the browser callback and stores the token', async () => {
    const login = await startLogin(['--no-browser']);
    try {
      expect(login.authorization.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${login.port}/callback`);
      const state = login.authorization.searchParams.get('state')!;

      const page = await fetch(`http://127.0.0.1:${login.port}/callback?code=li-code&state=${encodeURIComponent(state)}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('Connected to LinkedIn as <strong>Ada Lovelace</strong>');

      const [code] = await login.exited;
      expect(code).toBe(0);
      expect(login.output).toContain(`Signed in to LinkedIn as Ada Lovelace. Token saved to ${tokenFile}`);
      expect(JSON.parse(readFileSync(tokenFile, 'utf8'))).toMatchObject({ accessToken: 'li-token', member: { id: 'abc123', name: 'Ada Lovelace' } });
      expect(existsSync(browserLog)).toBe(false);
    } finally {
      login.child.kill();
    }
  });

  it.skipIf(process.platform === 'win32')('opens the link in the browser unless --no-browser is given', async () => {
    const login = await startLogin([]);
    try {
      await expect.poll(() => existsSync(browserLog) && readFileSync(browserLog, 'utf8'), { timeout: 5_000 }).toBe(`${login.authorization.href}\n`);
    } finally {
      login.child.kill();
    }
  });
});

describe('stdio command', () => {
  it('serves the LinkedIn tools over stdio', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY, 'stdio'], env: environment(), stderr: 'pipe' });
    const client = new Client({ name: 'cli-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['linkedin_create_post', 'linkedin_login', 'linkedin_logout']));
      const status = await client.callTool({ name: 'linkedin_auth_status', arguments: {} });
      expect(status.structuredContent).toMatchObject({ authenticated: false, source: 'none' });
    } finally {
      await client.close();
    }
  });
});

describe.skipIf(process.platform === 'win32')('http command', () => {
  it('serves until SIGTERM, then shuts down cleanly', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [ENTRY, 'http'], {
      env: environment({
        LINKEDIN_CLIENT_ID: 'test-client',
        LINKEDIN_CLIENT_SECRET: 'test-secret',
        PUBLIC_URL: `http://127.0.0.1:${port}`,
        PORT: String(port),
        SERVER_SECRET: 'test-secret-that-is-at-least-32-characters-long',
      }),
    });
    const events: Array<Record<string, unknown>> = [];
    const lines = createInterface({ input: child.stderr });
    const listening = new Promise<void>((resolve) =>
      lines.on('line', (line) => {
        const event = JSON.parse(line) as Record<string, unknown>;
        events.push(event);
        if (event.event === 'listening') resolve();
      }),
    );
    const exited = once(child, 'exit');
    try {
      await listening;
      expect(events.find((event) => event.event === 'listening')).toMatchObject({ version: VERSION, mcpUrl: `http://127.0.0.1:${port}/mcp`, allowedMembers: 'anyone' });
      expect(await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).toEqual({ status: 'ok' });

      child.kill('SIGTERM');
      const [code] = await exited;
      expect(code).toBe(0);
      expect(events).toContainEqual(expect.objectContaining({ event: 'shutting_down', signal: 'SIGTERM' }));
    } finally {
      child.kill();
    }
  });
});
