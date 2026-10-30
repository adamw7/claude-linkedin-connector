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
  it('signs in at the real LinkedIn unless told otherwise, without doubling slashes', async () => {
    expect(buildAuthorizationUrl({ ...app, oauthBaseUrl: undefined }, 'http://localhost:8723/callback', 'xyz')).toMatch(
      /^https:\/\/www\.linkedin\.com\/oauth\/v2\/authorization\?/,
    );
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      urls.push(String(input));
      return Response.json({ access_token: 'li-token' });
    };
    await exchangeAuthorizationCode({ ...app, oauthBaseUrl: undefined, fetch }, 'li-code', 'http://localhost:8723/callback');
    await exchangeAuthorizationCode({ ...app, oauthBaseUrl: `${OAUTH_BASE}//`, fetch }, 'li-code', 'http://localhost:8723/callback');
    expect(urls).toEqual(['https://www.linkedin.com/oauth/v2/accessToken', `${OAUTH_BASE}/oauth/v2/accessToken`]);
  });

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
    const { headers } = linkedin.requests.at(-1)!;
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('user-agent')).toMatch(/^claude-linkedin-connector\//);
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

  it('falls back to the scopes it asked for when LinkedIn does not list the granted ones', async () => {
    // Fields of other types than LinkedIn documents count as missing.
    const fetch = async () => Response.json({ access_token: 'li-token', scope: ['email'], refresh_token: 7, expires_in: '60' });
    const tokens = await exchangeAuthorizationCode({ ...app, fetch }, 'li-code', 'http://localhost:8723/callback');
    expect(tokens).toEqual({ accessToken: 'li-token', scopes: ['openid', 'profile', 'w_member_social'], expiresAt: undefined, refreshToken: undefined, refreshTokenExpiresAt: undefined });
  });

  it.each<[string, () => Response, string, string | undefined]>([
    ['a page from a proxy', () => new Response('<h1>502 Bad Gateway</h1>', { status: 502 }), 'http_502', '<h1>502 Bad Gateway</h1>'],
    ['an empty answer', () => new Response('', { status: 503 }), 'http_503', undefined],
    ['a success without a token', () => Response.json({ expires_in: 60 }), 'http_200', '{"expires_in":60}'],
  ])('reports %s from the token endpoint', async (_, answer, code, description) => {
    const error = await exchangeAuthorizationCode({ ...app, fetch: async () => answer() }, 'li-code', 'http://localhost:8723/callback').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinkedInOAuthError);
    expect(error).toMatchObject({ error: code, description, message: description ? `${code}: ${description}` : code });
  });

  it('cuts a long error page down to 300 characters', async () => {
    const page = `<html>${'x'.repeat(1000)}</html>`;
    const error = await exchangeAuthorizationCode({ ...app, fetch: async () => new Response(page, { status: 500 }) }, 'li-code', 'http://localhost:8723/callback').catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ error: 'http_500', description: page.slice(0, 300) });
  });

  it('says which settings to check when LinkedIn rejects the app credentials', async () => {
    const error = await exchangeAuthorizationCode({ ...app, clientSecret: 'mistyped' }, 'li-code', 'http://localhost:8723/callback').catch((e: unknown) => e);
    expect(error).toMatchObject({
      error: 'invalid_client',
      message: "invalid_client: Client authentication failed. Check that the Client ID and Client Secret you configured are the ones on the Auth tab of your LinkedIn app.",
    });
  });
});
