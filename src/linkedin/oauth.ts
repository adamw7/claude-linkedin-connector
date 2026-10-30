import { LinkedInOAuthError, sentence } from '../errors.js';
import { parseJson } from '../json.js';
import { USER_AGENT } from '../version.js';

export const LINKEDIN_OAUTH_BASE = 'https://www.linkedin.com';

/** Treat LinkedIn tokens this close to expiry as expired. */
export const TOKEN_EXPIRY_MARGIN_MS = 60_000;

export interface LinkedInOAuthApp {
  clientId: string;
  clientSecret: string;
  scopes: string[];
  oauthBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export interface LinkedInTokens {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  refreshToken?: string;
  /** Epoch milliseconds. */
  refreshTokenExpiresAt?: number;
  scopes: string[];
}

function oauthUrl(app: Pick<LinkedInOAuthApp, 'oauthBaseUrl'>, path: string): string {
  return `${(app.oauthBaseUrl ?? LINKEDIN_OAUTH_BASE).replace(/\/+$/, '')}${path}`;
}

/** LinkedIn reports granted scopes comma-separated; requests use spaces. Accept both. */
export function parseScopes(value: string | undefined | null): string[] {
  return (value ?? '').split(/[\s,]+/).filter(Boolean);
}

export function buildAuthorizationUrl(app: LinkedInOAuthApp, redirectUri: string, state: string): string {
  const url = new URL(oauthUrl(app, '/oauth/v2/authorization'));
  const params = { response_type: 'code', client_id: app.clientId, redirect_uri: redirectUri, state, scope: app.scopes.join(' ') };
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

export function exchangeAuthorizationCode(app: LinkedInOAuthApp, code: string, redirectUri: string): Promise<LinkedInTokens> {
  return requestToken(app, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
}

/** Only LinkedIn-approved apps receive refresh tokens; others re-authorize every 60 days. */
export function refreshAccessToken(app: LinkedInOAuthApp, refreshToken: string): Promise<LinkedInTokens> {
  return requestToken(app, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

async function requestToken(app: LinkedInOAuthApp, params: Record<string, string>): Promise<LinkedInTokens> {
  const fetchImpl = app.fetch ?? globalThis.fetch;
  const response = await fetchImpl(oauthUrl(app, '/oauth/v2/accessToken'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: new URLSearchParams({ ...params, client_id: app.clientId, client_secret: app.clientSecret }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  const json = (parseJson(text) ?? {}) as Record<string, unknown>;
  if (!response.ok || typeof json.access_token !== 'string') {
    const code = typeof json.error === 'string' ? json.error : undefined;
    const error = code ?? `http_${response.status}`;
    // Without a code or description (a proxy's error page, say) the body is all there is to go on.
    const description = typeof json.error_description === 'string' ? json.error_description : code ? undefined : text.slice(0, 300) || undefined;
    throw new LinkedInOAuthError(
      error,
      // Usually a mistyped or regenerated Client Secret; LinkedIn's own description doesn't say which setting is wrong.
      error === 'invalid_client'
        ? `${sentence(description ?? 'Client authentication failed')} Check that the Client ID and Client Secret you configured are the ones on the Auth tab of your LinkedIn app.`
        : description,
    );
  }
  const expiry = (seconds: unknown) => (typeof seconds === 'number' ? Date.now() + seconds * 1000 : undefined);
  const scopes = parseScopes(typeof json.scope === 'string' ? json.scope : undefined);
  return {
    accessToken: json.access_token,
    scopes: scopes.length > 0 ? scopes : [...app.scopes],
    expiresAt: expiry(json.expires_in),
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    refreshTokenExpiresAt: expiry(json.refresh_token_expires_in),
  };
}
