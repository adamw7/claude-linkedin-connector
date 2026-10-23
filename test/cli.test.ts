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
    scopes: ['openid', 'profile', 'email', 'w_member_social'],
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
    expect(stdout).toContain('To switch\n            accounts, sign out of linkedin.com in the browser first.');
  });

  it('rejects unknown commands with exit code 2', () => {
    const { status, stderr } = cli(['nope']);
    expect(status).toBe(2);
    expect(stderr).toContain('Unknown command "nope"');
  });

  it('shows help for --help after a command instead of running it', () => {
    storeToken();
    for (const args of [['logout', '--help'], ['login', '-h']]) {
      const { status, stdout } = cli(args, { LINKEDIN_CLIENT_ID: 'test-client', LINKEDIN_CLIENT_SECRET: 'test-secret' });
      expect(status, args.join(' ')).toBe(0);
      expect(stdout).toContain('Usage:');
    }
    expect(existsSync(tokenFile)).toBe(true);
  });

  it('rejects options and arguments a command does not take, without running it', () => {
    storeToken();
    const typo = cli(['logout', '--all']);
    expect(typo.status).toBe(2);
    expect(typo.stderr).toContain("logout: Unknown option '--all'.");
    expect(typo.stderr).toContain('Usage:');
    expect(existsSync(tokenFile)).toBe(true);
    expect(cli(['status', 'now'])).toMatchObject({ status: 2, stderr: expect.stringContaining("status: Unexpected argument 'now'.") });
  });

  it('reports the sign-in status', () => {
    const terminalSignIn = 'To sign in from this terminal, run the same command with "login" in place of "status".\n';
    const signedOut = cli(['status']);
    expect(signedOut.status).toBe(1);
    expect(signedOut.stdout).toBe(
      "You are not signed in to LinkedIn. Ask Claude to run the linkedin_login tool, which opens LinkedIn's sign-in page in your browser.\n" +
        terminalSignIn,
    );

    storeToken();
    const signedIn = cli(['status']);
    expect(signedIn.status).toBe(0);
    expect(signedIn.stdout).toContain('Signed in as Ada Lovelace');
    expect(signedIn.stdout).toContain('Scopes: openid profile email w_member_social');
    expect(signedIn.stdout).not.toContain(terminalSignIn);

    // Scopes added after signing in (e.g. for comments) need a new sign-in, which `npm run setup` keys off the exit code.
    const predates = cli(['status'], { LINKEDIN_SCOPES: 'openid profile email w_member_social w_member_social_feed' });
    expect(predates.status).toBe(1);
    expect(predates.stdout).toContain('That sign-in predates the w_member_social_feed permission now configured: sign in again to grant it.');
    expect(predates.stdout.endsWith(terminalSignIn)).toBe(true);

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
    // The link and what to check are printed first; the CLI is listening by the time it says it is waiting.
    while (!login.output.includes('Waiting for LinkedIn')) await once(child.stdout, 'data');
    login.authorization = new URL(/https?:\/\/\S+authorization\S*/.exec(login.output)![0]);
    return login;
  }

  it('signs in through the browser callback and stores the token', async () => {
    const login = await startLogin(['--no-browser']);
    try {
      expect(login.authorization.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${login.port}/callback`);
      // LinkedIn shows a redirect URL its app doesn't list on its own page, and the CLI would just wait.
      expect(login.output).toContain(
        `If LinkedIn shows an error instead of asking you to approve access, add http://127.0.0.1:${login.port}/callback to the authorized redirect URLs`,
      );
      const state = login.authorization.searchParams.get('state')!;

      const page = await fetch(`http://127.0.0.1:${login.port}/callback?code=li-code&state=${encodeURIComponent(state)}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('Connected to LinkedIn as <strong>Ada Lovelace</strong>');

      const [code] = await login.exited;
      expect(code).toBe(0);
      expect(login.output).toContain(`Signed in to LinkedIn as Ada Lovelace. Token saved to ${tokenFile}`);
      expect(JSON.parse(readFileSync(tokenFile, 'utf8'))).toMatchObject({ accessToken: 'li-token', member: { id: 'abc123', name: 'Ada Lovelace' } });
      expect(existsSync(browserLog)).toBe(false);
      expect(login.output).not.toContain('already signed in with');
    } finally {
      login.child.kill();
    }
  });

  it('says how to switch accounts when signing in again kept the same one', async () => {
    storeToken();
    const login = await startLogin(['--no-browser']);
    try {
      const state = login.authorization.searchParams.get('state')!;
      await fetch(`http://127.0.0.1:${login.port}/callback?code=li-code&state=${encodeURIComponent(state)}`);
      expect(await login.exited).toEqual([0, null]);
      expect(login.output).toContain(
        'That is the account you were already signed in with. If you meant to switch to another LinkedIn account, sign out of linkedin.com ' +
          'in your browser first, then sign in again: LinkedIn signs in whoever is signed in there.',
      );
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
      // No terminal command: this install's command and app credentials are Claude's, not the user's shell's.
      expect(status.structuredContent).toMatchObject({
        authenticated: false,
        source: 'none',
        message: "You are not signed in to LinkedIn. Ask Claude to run the linkedin_login tool, which opens LinkedIn's sign-in page in your browser.",
      });
    } finally {
      await client.close();
    }
  });

  it('remembers published posts next to the token, for the next conversation', async () => {
    const linkedin = await startServer((req, res) => {
      if (req.method === 'POST' && req.url === '/rest/posts') res.writeHead(201, { 'x-restli-id': 'urn:li:share:7001' }).end();
      else res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
    });
    storeToken();
    // Each conversation starts its own server process.
    const conversation = async () => {
      const env = environment({ LINKEDIN_API_BASE_URL: linkedin.url });
      const client = new Client({ name: 'cli-test', version: '1.0.0' });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY, 'stdio'], env, stderr: 'pipe' }));
      return client;
    };
    try {
      const first = await conversation();
      try {
        const created = await first.callTool({ name: 'linkedin_create_post', arguments: { text: 'Hello (from the CLI)' } });
        expect(created.structuredContent).toMatchObject({ postUrn: 'urn:li:share:7001', author: 'urn:li:person:abc123' });
      } finally {
        await first.close();
      }
      expect(JSON.parse(readFileSync(join(home, 'posts.json'), 'utf8'))).toMatchObject({
        version: 1,
        posts: [{ postUrn: 'urn:li:share:7001', text: 'Hello (from the CLI)' }],
      });

      const second = await conversation();
      try {
        const listed = await second.callTool({ name: 'linkedin_list_posts', arguments: {} });
        expect(listed.structuredContent).toEqual({
          matched: 1,
          posts: [
            {
              postUrn: 'urn:li:share:7001',
              url: 'https://www.linkedin.com/feed/update/urn:li:share:7001/',
              author: 'urn:li:person:abc123',
              text: 'Hello (from the CLI)',
              visibility: 'PUBLIC',
              attachment: 'none',
              publishedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
            },
          ],
        });
      } finally {
        await second.close();
      }
    } finally {
      await linkedin.close();
    }
  });

  // `script` (util-linux) runs the CLI with a terminal as stdin, as when someone starts it by hand.
  const hasScript = process.platform === 'linux' && spawnSync('script', ['--version']).status === 0;
  it.runIf(hasScript)('says what it is waiting for when started from a terminal', async () => {
    const child = spawn('script', ['-qec', `"${process.execPath}" "${ENTRY}"`, '/dev/null'], { env: environment() });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    try {
      await expect.poll(() => output, { timeout: 5_000 }).toContain('Waiting for MCP messages on stdin');
    } finally {
      child.kill();
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
        KEEP_ALIVE_TIMEOUT: '61',
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
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(await health.json()).toEqual({ status: 'ok' });
      expect(health.headers.get('keep-alive')).toBe('timeout=61');

      child.kill('SIGTERM');
      const [code] = await exited;
      expect(code).toBe(0);
      expect(events).toContainEqual(expect.objectContaining({ event: 'shutting_down', signal: 'SIGTERM' }));
    } finally {
      child.kill();
    }
  });
});
