import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../scripts/setup-claude-code.mjs', import.meta.url));
const ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const nodeMajor = Number(process.versions.node.split('.')[0]);

// A stand-in for the `claude` CLI that logs its arguments; `mcp get` succeeds when FAKE_EXISTS is set.
const FAKE_CLAUDE = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG"
if [ "$1 $2" = "mcp get" ]; then [ -n "$FAKE_EXISTS" ]; exit $?; fi
exit 0
`;

describe.skipIf(process.platform === 'win32' || nodeMajor < 24)('setup-claude-code script', () => {
  let dir: string;
  let log: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'setup-test-'));
    log = join(dir, 'claude.log');
    writeFileSync(join(dir, 'claude'), FAKE_CLAUDE);
    chmodSync(join(dir, 'claude'), 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function setup(args: string[], env: Record<string, string> = {}, { login = false } = {}) {
    const result = spawnSync(process.execPath, [SCRIPT, '--skip-build', ...(login ? [] : ['--no-login']), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: `${dir}${delimiter}${process.env.PATH}`,
        HOME: dir,
        FAKE_LOG: log,
        LINKEDIN_CLIENT_ID: 'id-123',
        LINKEDIN_CLIENT_SECRET: 'secret-456',
        ...env,
      },
    });
    const calls = (() => {
      try {
        return readFileSync(log, 'utf8').trim().split('\n');
      } catch {
        return [];
      }
    })();
    return { ...result, calls };
  }

  it('registers the built server with the LinkedIn credentials in user scope', () => {
    const { status, calls } = setup([]);
    expect(status).toBe(0);
    const add = calls.find((call) => call.startsWith('mcp add-json'));
    expect(add).toBeDefined();
    expect(add!.startsWith('mcp add-json linkedin {')).toBe(true);
    expect(add!.endsWith('} --scope user')).toBe(true);
    const server = JSON.parse(add!.slice(add!.indexOf('{'), add!.lastIndexOf('}') + 1));
    expect(server).toEqual({
      type: 'stdio',
      command: process.execPath,
      args: [ENTRY],
      env: {
        LINKEDIN_CLIENT_ID: 'id-123',
        LINKEDIN_CLIENT_SECRET: 'secret-456',
        LINKEDIN_SCOPES: 'openid profile email w_member_social',
      },
    });
  });

  it('takes credentials, scopes, name and config scope from flags', () => {
    const { status, calls } = setup(
      ['--client-id', 'flag-id', '--client-secret', 'flag-secret', '--scopes', 'openid', '--name', 'li', '--scope', 'local'],
      { LINKEDIN_CLIENT_ID: '', LINKEDIN_CLIENT_SECRET: '' },
    );
    expect(status).toBe(0);
    const add = calls.find((call) => call.startsWith('mcp add-json li '))!;
    expect(add.endsWith('--scope local')).toBe(true);
    expect(JSON.parse(add.slice(add.indexOf('{'), add.lastIndexOf('}') + 1)).env).toEqual({
      LINKEDIN_CLIENT_ID: 'flag-id',
      LINKEDIN_CLIENT_SECRET: 'flag-secret',
      LINKEDIN_SCOPES: 'openid',
    });
  });

  it('registers the redirect URL and folders the sign-in uses, so the server uses them too', () => {
    const registered = (args: string[], env: Record<string, string> = {}) => {
      rmSync(log, { force: true });
      const add = setup(args, env).calls.find((call) => call.startsWith('mcp add-json'))!;
      return JSON.parse(add.slice(add.indexOf('{'), add.lastIndexOf('}') + 1)).env;
    };
    expect(registered(['--redirect-uri', 'http://localhost:9000/cb', '--file-dirs', '~/Documents,~/Downloads'])).toEqual({
      LINKEDIN_CLIENT_ID: 'id-123',
      LINKEDIN_CLIENT_SECRET: 'secret-456',
      LINKEDIN_SCOPES: 'openid profile email w_member_social',
      LINKEDIN_REDIRECT_URI: 'http://localhost:9000/cb',
      LINKEDIN_FILE_DIRS: '~/Documents,~/Downloads',
    });
    expect(registered([], { LINKEDIN_REDIRECT_URI: ' http://127.0.0.1:9001/callback ', LINKEDIN_FILE_DIRS: '/srv/media' })).toMatchObject({
      LINKEDIN_REDIRECT_URI: 'http://127.0.0.1:9001/callback',
      LINKEDIN_FILE_DIRS: '/srv/media',
    });
    expect(registered(['--redirect-uri', 'http://[::1]:9002/cb'], { LINKEDIN_REDIRECT_URI: 'http://localhost:9001/callback' })).toMatchObject({
      LINKEDIN_REDIRECT_URI: 'http://[::1]:9002/cb',
    });
  });

  it('refuses a redirect URL the connector cannot listen on before registering anything', () => {
    for (const uri of ['not a url', 'https://localhost:9000/cb', 'http://example.com:9000/cb', 'http://localhost/cb', 'http://localhost:0/cb']) {
      rmSync(log, { force: true });
      const { status, stderr, calls } = setup(['--redirect-uri', uri]);
      expect(status).toBe(1);
      expect(stderr).toContain(`--redirect-uri must look like http://localhost:<port>/<path> (got "${uri}").`);
      expect(calls.some((call) => call.startsWith('mcp add-json'))).toBe(false);
    }
    expect(setup([], { LINKEDIN_REDIRECT_URI: 'localhost:8723/callback' }).stderr).toContain(
      'LINKEDIN_REDIRECT_URI must look like http://localhost:<port>/<path> (got "localhost:8723/callback").',
    );
  });

  it('adds the scopes for --comments and --pages', () => {
    const scopes = (args: string[]) => {
      rmSync(log, { force: true });
      const add = setup(args).calls.find((call) => call.startsWith('mcp add-json'))!;
      return JSON.parse(add.slice(add.indexOf('{'), add.lastIndexOf('}') + 1)).env.LINKEDIN_SCOPES;
    };
    expect(scopes(['--comments', '--pages'])).toBe('openid profile email w_member_social w_member_social_feed w_organization_social');
    expect(scopes(['--scopes', 'openid,w_member_social_feed', '--comments'])).toBe('openid,w_member_social_feed');
  });

  it('refuses to overwrite an existing server unless --yes is given', () => {
    const refused = setup([], { FAKE_EXISTS: '1' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('already exists. Run "node scripts/setup-claude-code.mjs --yes" to replace it');
    expect(refused.calls.some((call) => call.startsWith('mcp add-json'))).toBe(false);

    rmSync(log);
    const replaced = setup(['--yes'], { FAKE_EXISTS: '1' });
    expect(replaced.status).toBe(0);
    const removeAt = replaced.calls.indexOf('mcp remove linkedin --scope local');
    expect(replaced.calls).toContain('mcp remove linkedin --scope user');
    expect(removeAt).toBeGreaterThan(-1);
    expect(replaced.calls.findIndex((call) => call.startsWith('mcp add-json'))).toBeGreaterThan(removeAt);
  });

  it('fails without credentials when it cannot ask for them', () => {
    const { status, stderr, calls } = setup([], { LINKEDIN_CLIENT_ID: '' });
    expect(status).toBe(1);
    expect(stderr).toContain('Pass --client-id or set LINKEDIN_CLIENT_ID');
    expect(calls.some((call) => call.startsWith('mcp add-json'))).toBe(false);
  });

  it('rejects project scope, which would put the secret in the shared .mcp.json', () => {
    const { status, stderr } = setup(['--scope', 'project']);
    expect(status).toBe(1);
    expect(stderr).toContain('--scope must be "user" or "local"');
  });

  it('explains bad options instead of printing a stack trace', () => {
    const typo = setup(['--client_id', 'id-123']);
    expect(typo.status).toBe(1);
    expect(typo.stderr).toContain(`Unknown option '--client_id'. Run "node scripts/setup-claude-code.mjs --help" to see the options.`);
    expect(typo.stderr).not.toContain('    at ');
    expect(setup(['--scope', 'openid profile w_member_social_feed']).stderr).toContain('LinkedIn permissions go in --scopes.');
  });

  it('notices options npm kept for itself because -- was left out', () => {
    // What `npm run setup --scope local --no-login` runs the script with: no arguments, the options as npm config.
    const kept = setup([], { npm_lifecycle_event: 'setup', npm_config_scope: 'local', npm_config_login: '' });
    expect(kept.status).toBe(1);
    expect(kept.stderr).toContain('npm kept --scope, --no-login for itself');
    expect(kept.stderr).toContain('npm run setup -- <options>');
    expect(kept.calls.some((call) => call.startsWith('mcp add-json'))).toBe(false);
    // An npm scope, e.g. from .npmrc, is npm's own.
    expect(setup([], { npm_lifecycle_event: 'setup', npm_config_scope: '@acme' }).status).toBe(0);
  });

  it('says what to do when signing in fails after registering', () => {
    const { status, stderr, calls } = setup([], { LINKEDIN_API_VERSION: 'soon' }, { login: true });
    expect(status).toBe(1);
    expect(calls.some((call) => call.startsWith('mcp add-json'))).toBe(true);
    expect(stderr).toContain('LINKEDIN_API_VERSION must look like YYYYMM (e.g. 202609), got "soon".');
    expect(stderr).toContain('Signing in to LinkedIn failed (see above). "linkedin" is registered with Claude Code');
  });
});
