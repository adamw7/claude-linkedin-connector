import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SCOPES, defaultFileDirs, loadLocalConfig, loadRemoteConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';
import { VERSION } from '../src/version.js';

const remoteEnv = {
  LINKEDIN_CLIENT_ID: 'id',
  LINKEDIN_CLIENT_SECRET: 'secret',
  PUBLIC_URL: 'https://linkedin-mcp.example.com',
  SERVER_SECRET: 'a'.repeat(32),
  LINKEDIN_ALLOWED_MEMBERS: '*',
};

describe('configuration', () => {
  it('has local defaults', () => {
    const config = loadLocalConfig({ XDG_CONFIG_HOME: '/cfg' });
    expect(config).toMatchObject({
      scopes: DEFAULT_SCOPES,
      redirectUri: 'http://localhost:8723/callback',
      tokenFile: '/cfg/claude-linkedin-connector/token.json',
      accessToken: undefined,
    });
  });

  it('reads overrides and treats blank values as unset', () => {
    const config = loadLocalConfig({ LINKEDIN_SCOPES: 'openid,w_member_social', LINKEDIN_ACCESS_TOKEN: '  ', LINKEDIN_API_VERSION: '202608' });
    expect(config).toMatchObject({ scopes: ['openid', 'w_member_social'], accessToken: undefined, apiVersion: '202608' });
    expect(() => loadLocalConfig({ LINKEDIN_API_VERSION: '2026-08' })).toThrow(ConfigError);
  });

  it('limits local files to the usual folders, plus a working directory that is not above home', () => {
    const usual = ['/home/ada/Downloads', '/home/ada/Desktop', '/home/ada/Pictures'];
    expect(defaultFileDirs('/home/ada/project', '/home/ada')).toEqual([...usual, '/home/ada/project']);
    expect(defaultFileDirs('/srv/work', '/home/ada')).toEqual([...usual, '/srv/work']);
    expect(defaultFileDirs('/home/ada', '/home/ada')).toEqual(usual);
    expect(defaultFileDirs('/', '/home/ada')).toEqual(usual);
    expect(defaultFileDirs('/home', '/home/ada')).toEqual(usual);
  });

  it('adds the Desktop and Pictures folders OneDrive moves on Windows', () => {
    const home = 'C:\\Users\\ada';
    const env = { OneDrive: 'C:\\Users\\ada\\OneDrive', OneDriveConsumer: 'C:\\Users\\ada\\OneDrive', OneDriveCommercial: 'C:\\Users\\ada\\OneDrive - Acme' };
    expect(defaultFileDirs(home, home, env, 'win32')).toEqual([
      ...['Downloads', 'Desktop', 'Pictures'].map((name) => join(home, name)),
      join(env.OneDrive, 'Desktop'),
      join(env.OneDrive, 'Pictures'),
      join(env.OneDriveCommercial, 'Desktop'),
      join(env.OneDriveCommercial, 'Pictures'),
    ]);
    expect(defaultFileDirs('/home/ada', '/home/ada', env, 'linux')).toEqual(['/home/ada/Downloads', '/home/ada/Desktop', '/home/ada/Pictures']);
  });

  it('reads LINKEDIN_FILE_DIRS, expanding ~ and resolving relative folders', () => {
    const config = loadLocalConfig({ LINKEDIN_FILE_DIRS: '~/Posts, assets ,/data/media' }, '/work');
    expect(config.fileDirs).toEqual([join(homedir(), 'Posts'), '/work/assets', '/data/media']);
    expect(loadLocalConfig({}, '/').fileDirs).toEqual(defaultFileDirs('/', homedir(), {}));
  });

  it('validates remote settings', () => {
    const config = loadRemoteConfig(remoteEnv);
    expect(config).toMatchObject({
      port: 3000,
      host: '127.0.0.1',
      ephemeralSecret: false,
      allowedMembers: ['*'],
      allowedHosts: undefined,
      trustProxy: false,
      oauthRateLimit: 60,
      mcpRateLimit: 120,
      shutdownTimeoutMs: 8000,
      keepAliveTimeoutMs: 65_000,
      previousSecret: undefined,
    });
    expect(config.allowedRedirectUris).toContain('https://claude.ai/api/mcp/auth_callback');
    expect(() => loadRemoteConfig({ ...remoteEnv, LINKEDIN_CLIENT_ID: '' })).toThrow(/LINKEDIN_CLIENT_ID/);
    expect(() => loadRemoteConfig({ ...remoteEnv, PUBLIC_URL: 'http://example.com' })).toThrow(/https/);
    expect(() => loadRemoteConfig({ ...remoteEnv, PUBLIC_URL: 'https://example.com/linkedin' })).toThrow(/without a path/);
    expect(() => loadRemoteConfig({ ...remoteEnv, SERVER_SECRET: 'short' })).toThrow(
      'SERVER_SECRET must be at least 32 characters (try: openssl rand -base64 32).',
    );
    expect(loadRemoteConfig({ ...remoteEnv, PUBLIC_URL: 'http://localhost:3000' }).publicUrl.href).toBe('http://localhost:3000/');
  });

  it('requires an explicit member allowlist unless the server is only on localhost', () => {
    expect(() => loadRemoteConfig({ ...remoteEnv, LINKEDIN_ALLOWED_MEMBERS: undefined })).toThrow(/LINKEDIN_ALLOWED_MEMBERS is required/);
    expect(() => loadRemoteConfig({ ...remoteEnv, LINKEDIN_ALLOWED_MEMBERS: ' , ' })).toThrow(/LINKEDIN_ALLOWED_MEMBERS/);
    const local = loadRemoteConfig({ ...remoteEnv, LINKEDIN_ALLOWED_MEMBERS: undefined, PUBLIC_URL: 'http://localhost:3000' });
    expect(local.allowedMembers).toEqual(['*']);
  });

  it('reads proxy, rate limit and shutdown settings', () => {
    const config = loadRemoteConfig({
      ...remoteEnv,
      TRUST_PROXY: '1',
      RATE_LIMIT_OAUTH: '0',
      RATE_LIMIT_MCP: '30',
      SHUTDOWN_TIMEOUT: '20',
      KEEP_ALIVE_TIMEOUT: '620',
    });
    expect(config).toMatchObject({ trustProxy: 1, oauthRateLimit: 0, mcpRateLimit: 30, shutdownTimeoutMs: 20_000, keepAliveTimeoutMs: 620_000 });
    expect(loadRemoteConfig({ ...remoteEnv, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadRemoteConfig({ ...remoteEnv, TRUST_PROXY: 'loopback, 10.0.0.0/8' }).trustProxy).toBe('loopback, 10.0.0.0/8');
    expect(() => loadRemoteConfig({ ...remoteEnv, RATE_LIMIT_MCP: '-1' })).toThrow(/RATE_LIMIT_MCP/);
    expect(() => loadRemoteConfig({ ...remoteEnv, SHUTDOWN_TIMEOUT: '1.5' })).toThrow('SHUTDOWN_TIMEOUT must be a whole number, got "1.5".');
    // 0 would keep idle connections open forever.
    expect(() => loadRemoteConfig({ ...remoteEnv, KEEP_ALIVE_TIMEOUT: '0' })).toThrow('KEEP_ALIVE_TIMEOUT must be a whole number of at least 1, got "0".');
    expect(loadRemoteConfig({ ...remoteEnv, KEEP_ALIVE_TIMEOUT: '1' }).keepAliveTimeoutMs).toBe(1000);
  });

  it('requires SERVER_SECRET unless the server is only on localhost, where it generates one with a warning', () => {
    expect(() => loadRemoteConfig({ ...remoteEnv, SERVER_SECRET: undefined })).toThrow(
      'SERVER_SECRET is required: set it to at least 32 characters (try: openssl rand -base64 32) and keep it across restarts.',
    );
    const warnings: string[] = [];
    const env = { ...remoteEnv, PUBLIC_URL: 'http://localhost:3000', SERVER_SECRET: undefined, LINKEDIN_ALLOWED_MEMBERS: 'Ada@Example.com, abc123' };
    const config = loadRemoteConfig(env, (m) => warnings.push(m));
    expect(config.ephemeralSecret).toBe(true);
    expect(config.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(warnings).toEqual(['SERVER_SECRET is not set; using a random one. Connections will stop working when the server restarts.']);
    expect(config.allowedMembers).toEqual(['ada@example.com', 'abc123']);
  });

  it('accepts the previous SERVER_SECRET during a rotation', () => {
    expect(loadRemoteConfig({ ...remoteEnv, SERVER_SECRET_PREVIOUS: 'b'.repeat(32) }).previousSecret).toBe('b'.repeat(32));
    expect(() => loadRemoteConfig({ ...remoteEnv, SERVER_SECRET_PREVIOUS: 'short' })).toThrow(
      'SERVER_SECRET_PREVIOUS must be at least 32 characters (try: openssl rand -base64 32).',
    );
  });

  it('keeps version numbers in sync', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    const manifest = JSON.parse(readFileSync('mcpb/manifest.json', 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(manifest.version).toBe(pkg.version);
  });
});

describe('secrets from files', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'config-secrets-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  function secretFile(name: string, contents: string): string {
    const path = join(dir, name);
    writeFileSync(path, contents);
    return path;
  }

  it('reads LINKEDIN_CLIENT_SECRET, SERVER_SECRET and SERVER_SECRET_PREVIOUS from *_FILE, trimming the trailing newline', () => {
    const config = loadRemoteConfig({
      ...remoteEnv,
      LINKEDIN_CLIENT_SECRET: undefined,
      LINKEDIN_CLIENT_SECRET_FILE: secretFile('client', 'file-secret\n'),
      SERVER_SECRET: undefined,
      SERVER_SECRET_FILE: secretFile('server', `${'c'.repeat(32)}\n`),
      SERVER_SECRET_PREVIOUS_FILE: secretFile('previous', 'd'.repeat(32)),
    });
    expect(config).toMatchObject({ clientSecret: 'file-secret', secret: 'c'.repeat(32), previousSecret: 'd'.repeat(32), ephemeralSecret: false });
    expect(loadLocalConfig({ LINKEDIN_CLIENT_SECRET_FILE: secretFile('local', 'local-secret') }).clientSecret).toBe('local-secret');
  });

  it('explains unusable secret files', () => {
    const missing = join(dir, 'missing');
    expect(() => loadRemoteConfig({ ...remoteEnv, SERVER_SECRET: undefined, SERVER_SECRET_FILE: missing })).toThrow(
      `SERVER_SECRET_FILE: cannot read ${missing} (ENOENT).`,
    );
    const empty = secretFile('empty', ' \n');
    expect(() => loadRemoteConfig({ ...remoteEnv, SERVER_SECRET: undefined, SERVER_SECRET_FILE: empty })).toThrow(`SERVER_SECRET_FILE: ${empty} is empty.`);
    expect(() => loadRemoteConfig({ ...remoteEnv, LINKEDIN_CLIENT_SECRET_FILE: secretFile('client', 'x') })).toThrow(
      'Set either LINKEDIN_CLIENT_SECRET or LINKEDIN_CLIENT_SECRET_FILE, not both.',
    );
    expect(() => loadRemoteConfig({ ...remoteEnv, LINKEDIN_CLIENT_SECRET: undefined })).toThrow(
      'Missing required environment variables: LINKEDIN_CLIENT_SECRET.',
    );
  });
});
