import { describe, expect, it } from 'vitest';
import { LinkedInOAuthError } from '../src/errors.js';
import { buildAuthorizationUrl, exchangeAuthorizationCode, parseScopes, refreshAccessToken } from '../src/linkedin/oauth.js';
import { FakeLinkedIn, OAUTH_BASE } from './helpers/fake-linkedin.js';

const linkedin = new FakeLinkedIn();
const app = {
  clientId: 'test-client',
  clientSecret: 'test-secret',
  scopes: ['openid', 'profile', 'w_member_social'],
  oauthBaseUrl: OAUTH_BASE,
  fetch: linkedin.fetch,
};

describe('LinkedIn OAuth helpers', () => {
  it('builds the authorization URL', () => {
    const url = new URL(buildAuthorizationUrl(app, 'http://localhost:8723/callback', 'xyz'));
    expect(url.origin + url.pathname).toBe(`${OAUTH_BASE}/oauth/v2/authorization`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'test-client',
      redirect_uri: 'http://localhost:8723/callback',
      state: 'xyz',
      scope: 'openid profile w_member_social',
    });
  });

  it('parses comma- or space-separated scopes', () => {
    expect(parseScopes('email,openid, profile w_member_social')).toEqual(['email', 'openid', 'profile', 'w_member_social']);
    expect(parseScopes(undefined)).toEqual([]);
  });

  it('exchanges an authorization code using the client secret', async () => {
    const before = Date.now();
    const tokens = await exchangeAuthorizationCode(app, 'li-code', 'http://localhost:8723/callback');
    expect(tokens.accessToken).toBe('li-token');
    expect(tokens.scopes).toEqual(['email', 'openid', 'profile', 'w_member_social']);
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 5_184_000_000);
    const form = new URLSearchParams(String(linkedin.requests.at(-1)!.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code',
      code: 'li-code',
      redirect_uri: 'http://localhost:8723/callback',
      client_id: 'test-client',
      client_secret: 'test-secret',
    });
  });

  it('refreshes tokens when LinkedIn issued a refresh token', async () => {
    const tokens = await refreshAccessToken(app, 'li-refresh');
    expect(tokens).toMatchObject({ accessToken: 'li-token-refreshed', refreshToken: 'li-refresh-2' });
  });

  it('reports LinkedIn OAuth errors', async () => {
    const error = await exchangeAuthorizationCode(app, 'bad-code', 'http://localhost:8723/callback').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinkedInOAuthError);
    expect(error).toMatchObject({ error: 'invalid_grant' });
  });
});
