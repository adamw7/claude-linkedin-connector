import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCOPES, loadLocalConfig, loadRemoteConfig } from '../src/config.js';
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
    });
    expect(config.allowedRedirectUris).toContain('https://claude.ai/api/mcp/auth_callback');
    expect(() => loadRemoteConfig({ ...remoteEnv, LINKEDIN_CLIENT_ID: '' })).toThrow(/LINKEDIN_CLIENT_ID/);
    expect(() => loadRemoteConfig({ ...remoteEnv, PUBLIC_URL: 'http://example.com' })).toThrow(/https/);
    expect(() => loadRemoteConfig({ ...remoteEnv, PUBLIC_URL: 'https://example.com/linkedin' })).toThrow(/without a path/);
    expect(() => loadRemoteConfig({ ...remoteEnv, SERVER_SECRET: 'short' })).toThrow(/32 characters/);
    expect(loadRemoteConfig({ ...remoteEnv, PUBLIC_URL: 'http://localhost:3000' }).publicUrl.href).toBe('http://localhost:3000/');
  });

  it('requires an explicit member allowlist unless the server is only on localhost', () => {
    expect(() => loadRemoteConfig({ ...remoteEnv, LINKEDIN_ALLOWED_MEMBERS: undefined })).toThrow(/LINKEDIN_ALLOWED_MEMBERS is required/);
    expect(() => loadRemoteConfig({ ...remoteEnv, LINKEDIN_ALLOWED_MEMBERS: ' , ' })).toThrow(/LINKEDIN_ALLOWED_MEMBERS/);
    const local = loadRemoteConfig({ ...remoteEnv, LINKEDIN_ALLOWED_MEMBERS: undefined, PUBLIC_URL: 'http://localhost:3000' });
    expect(local.allowedMembers).toEqual(['*']);
  });

  it('reads proxy, rate limit and shutdown settings', () => {
    const config = loadRemoteConfig({ ...remoteEnv, TRUST_PROXY: '1', RATE_LIMIT_OAUTH: '0', RATE_LIMIT_MCP: '30', SHUTDOWN_TIMEOUT: '20' });
    expect(config).toMatchObject({ trustProxy: 1, oauthRateLimit: 0, mcpRateLimit: 30, shutdownTimeoutMs: 20_000 });
    expect(loadRemoteConfig({ ...remoteEnv, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadRemoteConfig({ ...remoteEnv, TRUST_PROXY: 'loopback, 10.0.0.0/8' }).trustProxy).toBe('loopback, 10.0.0.0/8');
    expect(() => loadRemoteConfig({ ...remoteEnv, RATE_LIMIT_MCP: '-1' })).toThrow(/RATE_LIMIT_MCP/);
    expect(() => loadRemoteConfig({ ...remoteEnv, SHUTDOWN_TIMEOUT: '1.5' })).toThrow(/SHUTDOWN_TIMEOUT/);
  });

  it('generates an ephemeral secret with a warning', () => {
    const warnings: string[] = [];
    const config = loadRemoteConfig({ ...remoteEnv, SERVER_SECRET: undefined, LINKEDIN_ALLOWED_MEMBERS: 'Ada@Example.com, abc123' }, (m) => warnings.push(m));
    expect(config.ephemeralSecret).toBe(true);
    expect(config.secret.length).toBeGreaterThanOrEqual(32);
    expect(warnings[0]).toMatch(/SERVER_SECRET/);
    expect(config.allowedMembers).toEqual(['ada@example.com', 'abc123']);
  });

  it('keeps version numbers in sync', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    const manifest = JSON.parse(readFileSync('mcpb/manifest.json', 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(manifest.version).toBe(pkg.version);
  });
});
