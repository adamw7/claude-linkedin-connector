import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { LocalAuth } from '../src/auth/local-auth.js';
import { defaultTokenFile, TokenStore, type StoredToken } from '../src/auth/token-store.js';
import { loadLocalConfig, type LocalConfig } from '../src/config.js';
import { ConfigError, NotAuthenticatedError } from '../src/errors.js';
import { ApiVersion } from '../src/linkedin/versions.js';
import { API_BASE, FakeLinkedIn, OAUTH_BASE } from './helpers/fake-linkedin.js';
import { freePort } from './helpers/http.js';

const DAY = 24 * 60 * 60 * 1000;

function token(overrides: Partial<StoredToken> = {}): StoredToken {
  return { version: 1, accessToken: 'li-token', scopes: ['openid', 'w_member_social'], expiresAt: Date.now() + 30 * DAY, ...overrides };
}

describe('TokenStore', () => {
  it('round-trips tokens in a user-only file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linkedin-store-'));
    const store = new TokenStore(join(dir, 'nested', 'token.json'));
    expect(await store.read()).toBeUndefined();
    await store.write(token());
    expect(await store.read()).toMatchObject({ accessToken: 'li-token' });
    if (process.platform !== 'win32') expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect(await store.clear()).toBe(true);
    expect(await store.clear()).toBe(false);
  });

  it('ignores corrupt files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linkedin-store-'));
    const store = new TokenStore(join(dir, 'token.json'));
    await writeFile(store.path, '{not json');
    expect(await store.read()).toBeUndefined();
  });

  it('reports a token file it cannot remove, rather than saying there was none', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linkedin-store-'));
    await mkdir(join(dir, 'token.json'));
    await expect(new TokenStore(join(dir, 'token.json')).clear()).rejects.toThrow(expect.objectContaining({ code: 'ERR_FS_EISDIR' }));
  });

  it('defaults to the per-user config directory', () => {
    expect(defaultTokenFile({ XDG_CONFIG_HOME: '/cfg' }, 'linux')).toBe('/cfg/claude-linkedin-connector/token.json');
    expect(defaultTokenFile({ APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' }, 'win32')).toContain('claude-linkedin-connector');
  });
});

describe('LocalAuth', () => {
  let linkedin: FakeLinkedIn;
  let config: LocalConfig;

  beforeEach(async () => {
    linkedin = new FakeLinkedIn();
    const dir = await mkdtemp(join(tmpdir(), 'linkedin-auth-'));
    config = {
      ...loadLocalConfig({}),
      clientId: 'test-client',
      clientSecret: 'test-secret',
      apiBaseUrl: API_BASE,
      oauthBaseUrl: OAUTH_BASE,
      tokenFile: join(dir, 'token.json'),
    };
  });

  const auth = (overrides: Partial<LocalConfig> = {}) =>
    new LocalAuth({ config: { ...config, ...overrides }, version: new ApiVersion('202609'), fetch: linkedin.fetch });

  it('explains how to sign in when there is no token', async () => {
    await expect(auth().getSession()).rejects.toThrow(NotAuthenticatedError);
    await expect(auth().getSession()).rejects.toThrow(/linkedin_login/);
    expect(await auth().status()).toMatchObject({ authenticated: false, source: 'none' });
  });

  it('uses LINKEDIN_ACCESS_TOKEN when set', async () => {
    const local = auth({ accessToken: 'env-token' });
    expect(await local.getSession()).toMatchObject({ accessToken: 'env-token' });
    await local.rememberMember({ id: 'abc123', name: 'Ada' });
    expect(await local.getSession()).toMatchObject({ memberId: 'abc123', name: 'Ada' });
    expect(await local.status()).toMatchObject({ authenticated: true, source: 'environment', memberUrn: 'urn:li:person:abc123' });
  });

  it('uses the stored token and remembers the member in it', async () => {
    const local = auth();
    await local.store.write(token());
    expect(await local.getSession()).toMatchObject({ accessToken: 'li-token' });
    await local.rememberMember({ id: 'abc123', name: 'Ada Lovelace' });
    const status = await local.status();
    expect(status).toMatchObject({ authenticated: true, source: 'token-file', name: 'Ada Lovelace' });
    expect(status.message).toContain('Signed in as Ada Lovelace');
  });

  it('reports configured scopes the stored token predates', async () => {
    const local = auth({ scopes: ['openid', 'w_member_social', 'w_member_social_feed', 'w_organization_social'] });
    await local.store.write(token());
    expect(await local.status()).toMatchObject({ authenticated: true, missingScopes: ['w_member_social_feed', 'w_organization_social'] });
    expect((await local.status()).message).toContain('predates the w_member_social_feed, w_organization_social permissions now configured: sign in again to grant them.');
    expect(await auth({ scopes: ['openid'] }).status()).not.toHaveProperty('missingScopes');
  });

  it('rejects expired tokens without a refresh token', async () => {
    const local = auth();
    await local.store.write(token({ expiresAt: Date.now() - DAY }));
    await expect(local.getSession()).rejects.toThrow(/expired/);
  });

  it('refreshes expired tokens when LinkedIn issued a refresh token', async () => {
    const local = auth();
    await local.store.write(token({ expiresAt: Date.now() - DAY, refreshToken: 'li-refresh', refreshTokenExpiresAt: Date.now() + 300 * DAY, member: { id: 'abc123' } }));
    expect(await local.getSession()).toMatchObject({ accessToken: 'li-token-refreshed', memberId: 'abc123' });
    const saved = JSON.parse(await readFile(config.tokenFile, 'utf8')) as StoredToken;
    expect(saved).toMatchObject({ accessToken: 'li-token-refreshed', refreshToken: 'li-refresh-2' });
  });

  it('treats an expired sign-in as over when its refresh fails or cannot be tried', async () => {
    const expired = token({ expiresAt: Date.now() - DAY, refreshToken: 'li-refresh', refreshTokenExpiresAt: Date.now() + 300 * DAY });
    const revoked = auth();
    await revoked.store.write({ ...expired, refreshToken: 'revoked-refresh' });
    await expect(revoked.getSession()).rejects.toThrow(/^Your LinkedIn sign-in has expired\. /);
    const uncredentialed = auth({ clientSecret: undefined });
    await uncredentialed.store.write(expired);
    await expect(uncredentialed.getSession()).rejects.toThrow(/^Your LinkedIn sign-in has expired\. /);
    expect(linkedin.find('POST', '/oauth/v2/accessToken')).toHaveLength(1);
    const lapsed = auth();
    await lapsed.store.write({ ...expired, refreshTokenExpiresAt: Date.now() - DAY });
    await expect(lapsed.getSession()).rejects.toThrow(/expired/);
    expect(linkedin.find('POST', '/oauth/v2/accessToken')).toHaveLength(1);
  });

  it('keeps the refresh token and its expiry when LinkedIn does not issue a new one', async () => {
    linkedin.override(({ url }) =>
      url.pathname === '/oauth/v2/accessToken' ? Response.json({ access_token: 'li-token-refreshed', expires_in: 3600, scope: 'openid,w_member_social' }) : undefined,
    );
    const local = auth();
    const refreshTokenExpiresAt = Date.now() + 300 * DAY;
    await local.store.write(token({ expiresAt: Date.now() - DAY, refreshToken: 'li-refresh', refreshTokenExpiresAt }));
    expect(await local.getSession()).toMatchObject({ accessToken: 'li-token-refreshed' });
    expect(await local.store.read()).toMatchObject({ accessToken: 'li-token-refreshed', refreshToken: 'li-refresh', refreshTokenExpiresAt });
  });

  it('does not give a new refresh token the expiry of the one it replaces', async () => {
    linkedin.override(({ url }) =>
      url.pathname === '/oauth/v2/accessToken' ? Response.json({ access_token: 'li-token-refreshed', expires_in: 3600, refresh_token: 'li-refresh-2' }) : undefined,
    );
    const local = auth();
    await local.store.write(token({ expiresAt: Date.now() - DAY, refreshToken: 'li-refresh', refreshTokenExpiresAt: Date.now() + DAY }));
    await local.getSession();
    const saved = await local.store.read();
    expect(saved).toMatchObject({ refreshToken: 'li-refresh-2' });
    expect(saved).not.toHaveProperty('refreshTokenExpiresAt');
  });

  it('describes a sign-in without an expiry, and a single permission it predates', async () => {
    const local = auth({ scopes: ['openid', 'w_member_social', 'w_member_social_feed'] });
    await local.store.write(token({ expiresAt: undefined }));
    const status = await local.status();
    expect(status).toMatchObject({ authenticated: true, expiresAt: undefined, missingScopes: ['w_member_social_feed'] });
    expect(status.message).toBe(
      `Signed in (token stored in ${config.tokenFile}). That sign-in predates the w_member_social_feed permission now configured: sign in again to grant it.`,
    );
  });

  it('reports a token file it cannot read, rather than saying the user is signed out', async () => {
    const local = auth();
    await mkdir(config.tokenFile);
    await expect(local.status()).rejects.toThrow(expect.objectContaining({ code: 'EISDIR' }));
  });

  it('signs out, forgetting the stored token and who LINKEDIN_ACCESS_TOKEN belongs to', async () => {
    const local = auth();
    await local.store.write(token());
    expect(await local.logout()).toBe(true);
    expect(await local.store.read()).toBeUndefined();
    await expect(local.getSession()).rejects.toThrow(NotAuthenticatedError);
    expect(await local.logout()).toBe(false);

    const environment = auth({ accessToken: 'env-token' });
    await environment.rememberMember({ id: 'abc123', name: 'Ada' });
    expect(await environment.logout()).toBe(false);
    expect(await environment.getSession()).toEqual({ accessToken: 'env-token', scopes: config.scopes });
  });

  it('requires app credentials to sign in', async () => {
    await expect(auth({ clientId: undefined }).login()).rejects.toThrow(ConfigError);
  });

  it('only accepts loopback redirect URIs with a fixed port', async () => {
    for (const redirectUri of ['https://example.com/callback', 'http://localhost/callback', 'http://127.0.0.1:0/callback']) {
      await expect(auth({ redirectUri }).login()).rejects.toThrow(ConfigError);
    }
  });

  it('signs in through the browser redirect and stores the token', async () => {
    const port = await freePort();
    const signIn = auth({ redirectUri: `http://127.0.0.1:${port}/callback` });

    let authorizationUrl = '';
    const done = signIn.loginAndWait((url) => {
      authorizationUrl = url;
    });
    await expect.poll(() => authorizationUrl).not.toBe('');
    const state = new URL(authorizationUrl).searchParams.get('state')!;

    const stale = await fetch(`http://127.0.0.1:${port}/callback?code=li-code&state=wrong`);
    expect(stale.status).toBe(400);
    const ok = await fetch(`http://127.0.0.1:${port}/callback?code=li-code&state=${state}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('Connected to LinkedIn as <strong>Ada Lovelace</strong>');
    expect(await done).toBe('Ada Lovelace');
    expect(await signIn.store.read()).toMatchObject({ accessToken: 'li-token', member: { id: 'abc123', email: 'ada@example.com' } });
  });

  it('opens the sign-in page in the browser and settles when the sign-in finishes', async () => {
    const port = await freePort();
    const opened: string[] = [];
    const signIn = new LocalAuth({
      config: { ...config, redirectUri: `http://127.0.0.1:${port}/callback` },
      version: new ApiVersion('202609'),
      fetch: linkedin.fetch,
      openBrowser: async (url) => {
        opened.push(url);
        return true;
      },
    });
    const start = await signIn.login();
    expect(start).toMatchObject({ browserOpened: true });
    expect(opened).toEqual([start.authorizationUrl]);
    // Tool calls made while it waits, at once or one after another, join it without opening it again.
    const joined = await Promise.all([signIn.login(), signIn.login()]);
    expect(joined.map((joining) => joining.authorizationUrl)).toEqual([start.authorizationUrl, start.authorizationUrl]);
    expect(joined.map((joining) => joining.browserOpened)).toEqual([true, true]);
    expect(opened).toEqual([start.authorizationUrl]);
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    await fetch(`http://127.0.0.1:${port}/callback?code=li-code&state=${state}`);
    expect(await start.completion).toBe('Ada Lovelace');
    // The next sign-in opens its own page.
    const next = await signIn.login();
    expect(opened).toEqual([start.authorizationUrl, next.authorizationUrl]);
    expect(next.authorizationUrl).not.toBe(start.authorizationUrl);
  });

  it('says when the sign-in page could not be opened, also to the calls that join it', async () => {
    const port = await freePort();
    const opened: string[] = [];
    const signIn = new LocalAuth({
      config: { ...config, redirectUri: `http://127.0.0.1:${port}/callback` },
      version: new ApiVersion('202609'),
      fetch: linkedin.fetch,
      // As when there is no xdg-open.
      openBrowser: async (url) => {
        opened.push(url);
        return false;
      },
    });
    const start = await signIn.login();
    expect(start.browserOpened).toBe(false);
    expect((await signIn.login()).browserOpened).toBe(false);
    expect(opened).toEqual([start.authorizationUrl]);
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    await fetch(`http://127.0.0.1:${port}/callback?error=cleanup&state=${state}`);
  });

  it('forgets a stored token LinkedIn rejected, but not a newer one or LINKEDIN_ACCESS_TOKEN', async () => {
    const local = auth();
    await local.store.write(token());
    const session = await local.getSession();
    await local.store.write(token({ accessToken: 'newer-token' }));
    expect(await local.rejected(session)).toBe(false);
    expect(await local.store.read()).toMatchObject({ accessToken: 'newer-token' });
    expect(await local.rejected(await local.getSession())).toBe(true);
    expect(await local.store.read()).toBeUndefined();
    expect(await local.status()).toMatchObject({ authenticated: false });

    const environment = auth({ accessToken: 'env-token' });
    await environment.store.write(token({ accessToken: 'env-token' }));
    expect(await environment.rejected(await environment.getSession())).toBe(false);
    expect(await environment.store.read()).toMatchObject({ accessToken: 'env-token' });
  });

  it('tells Claude why the last browser sign-in failed, until the next one starts', async () => {
    const port = await freePort();
    const signIn = auth({ clientSecret: 'mistyped-secret', redirectUri: `http://127.0.0.1:${port}/callback` });
    const start = await signIn.login();
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    const page = await fetch(`http://127.0.0.1:${port}/callback?code=li-code&state=${state}`);
    expect(page.status).toBe(500);
    expect(await page.text()).toContain('Check that the Client ID and Client Secret you configured are the ones on the Auth tab');

    const failure = /not signed in to LinkedIn\. The last sign-in attempt failed: invalid_client: Client authentication failed\. Check that the Client ID/;
    await expect(signIn.getSession()).rejects.toThrow(failure);
    expect((await signIn.status()).message).toMatch(failure);
    const retry = await signIn.login();
    await expect(signIn.getSession()).rejects.toThrow(/^You are not signed in to LinkedIn\. Ask Claude/);
    const retryState = new URL(retry.authorizationUrl).searchParams.get('state')!;
    await fetch(`http://127.0.0.1:${port}/callback?error=cleanup&state=${retryState}`);
  });

  it('reports a cancelled sign-in', async () => {
    const port = await freePort();
    const signIn = auth({ redirectUri: `http://localhost:${port}/callback` });
    const start = await signIn.login();
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    expect(start.expiresInSeconds).toBeGreaterThan(500);
    expect(start.redirectUri).toBe(`http://localhost:${port}/callback`);
    expect(start.browserOpened).toBe(false);
    const cancelled = expect(signIn.loginAndWait(() => {})).rejects.toThrow(/not completed: The user cancelled/);
    const response = await fetch(`http://127.0.0.1:${port}/callback?error=user_cancelled_authorize&error_description=The+user+cancelled&state=${state}`);
    expect(response.status).toBe(400);
    await cancelled;
  });
});
