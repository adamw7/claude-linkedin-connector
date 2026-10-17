import { LinkedInOAuthError } from '../errors.js';
import { USER_AGENT } from '../version.js';

export const LINKEDIN_OAUTH_BASE = 'https://www.linkedin.com';

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
  return (value ?? '')
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

export function buildAuthorizationUrl(app: LinkedInOAuthApp, redirectUri: string, state: string): string {
  const url = new URL(oauthUrl(app, '/oauth/v2/authorization'));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', app.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', app.scopes.join(' '));
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
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Handled below.
  }
  if (!response.ok || typeof json.access_token !== 'string') {
    throw new LinkedInOAuthError(
      typeof json.error === 'string' ? json.error : `http_${response.status}`,
      typeof json.error_description === 'string' ? json.error_description : text.slice(0, 300) || undefined,
    );
  }
  const now = Date.now();
  const tokens: LinkedInTokens = {
    accessToken: json.access_token,
    scopes: parseScopes(typeof json.scope === 'string' ? json.scope : undefined),
  };
  if (typeof json.expires_in === 'number') tokens.expiresAt = now + json.expires_in * 1000;
  if (typeof json.refresh_token === 'string') tokens.refreshToken = json.refresh_token;
  if (typeof json.refresh_token_expires_in === 'number') {
    tokens.refreshTokenExpiresAt = now + json.refresh_token_expires_in * 1000;
  }
  if (tokens.scopes.length === 0) tokens.scopes = [...app.scopes];
  return tokens;
}
