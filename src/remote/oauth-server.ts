import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthMetadata, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import type { RemoteConfig } from '../config.js';
import { decodeHtmlEntities } from '../html.js';
import { LinkedInClient } from '../linkedin/client.js';
import { buildAuthorizationUrl, exchangeAuthorizationCode, type LinkedInOAuthApp } from '../linkedin/oauth.js';
import { refusedScope } from '../linkedin/scopes.js';
import type { ApiVersion } from '../linkedin/versions.js';
import { HOMEPAGE } from '../version.js';
import { redirectUriMatches, type ClientRegistry, type OAuthClient } from './clients.js';
import { pkceChallenge, randomToken, safeEqual, type Sealer } from './crypto.js';
import { silentLogger, type Logger } from './logger.js';
import { sendConsentPage, sendErrorPage } from './pages.js';

/** The LinkedIn credentials an access token carries (encrypted inside it). */
export interface LinkedInGrant {
  /** LinkedIn access token. */
  at: string;
  /** LinkedIn token expiry, epoch milliseconds. */
  exp?: number;
  sc: string[];
  sub?: string;
  name?: string;
  email?: string;
}

interface AuthorizationRequest {
  cid: string;
  ru: string;
  cc: string;
  res: string;
  st?: string;
}

/** What each step of the flow carries forward: the client's request, valid until `exp`. */
type Step<T> = T & { req: AuthorizationRequest; exp: number };
type ConsentPayload = Step<{ csrf: string }>;
type PendingPayload = Step<{ ls: string }>;
type CodePayload = Step<{ li: LinkedInGrant; jti: string }>;

interface AccessTokenPayload {
  cid: string;
  res: string;
  li: LinkedInGrant;
  iat: number;
  exp: number;
}

const CONSENT_TTL_S = 10 * 60;
const CODE_TTL_S = 5 * 60;
/** LinkedIn tokens last 60 days; never outlive them (or that). */
const MAX_TOKEN_TTL_S = 60 * 24 * 60 * 60;

export interface OAuthServerOptions {
  config: RemoteConfig;
  sealer: Sealer;
  clients: ClientRegistry;
  /** The MCP endpoint URL, i.e. the RFC 8707 resource tokens are issued for. */
  resource: URL;
  version: ApiVersion;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  logger?: Logger;
}

export interface OAuthServer {
  router: Router;
  metadata: OAuthMetadata;
  verifier: OAuthTokenVerifier;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Compares resource indicators, ignoring case of scheme/host, a trailing slash and any fragment. */
function sameResource(a: string, b: string): boolean {
  const normalize = (value: string) => {
    const url = URL.parse(value);
    if (url) url.hash = '';
    return url?.href.replace(/\/$/, '');
  };
  const left = normalize(a);
  return left !== undefined && left === normalize(b);
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function redirectWith(res: Response, uri: string, params: Record<string, string | undefined>): void {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  res.set('Cache-Control', 'no-store').redirect(302, url.href);
}

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

function oauthError(res: Response, status: number, error: string, description: string): void {
  res.status(status).set(NO_STORE).json({ error, error_description: description });
}

function parseBasicAuth(header: string | undefined): { id: string; secret: string } | undefined {
  const match = /^Basic\s+(.+)$/i.exec(header ?? '');
  if (!match) return undefined;
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return undefined;
  try {
    return { id: decodeURIComponent(decoded.slice(0, colon)), secret: decodeURIComponent(decoded.slice(colon + 1)) };
  } catch {
    return undefined;
  }
}

/** Lets browser-based MCP clients call the token and registration endpoints. */
function cors(req: Request, res: Response, next: NextFunction): void {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
    'Access-Control-Max-Age': '86400',
  });
  if (req.method === 'OPTIONS') res.status(204).end();
  else next();
}

/**
 * A small OAuth 2.1 authorization server for MCP clients (PKCE, dynamic
 * client registration and client ID metadata documents) that delegates the
 * user's sign-in to LinkedIn. Each issued token carries the user's LinkedIn
 * token encrypted inside it, so the server needs no database.
 */
export function createOAuthServer(options: OAuthServerOptions): OAuthServer {
  const { config, sealer, clients, resource } = options;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? silentLogger;
  const nowSeconds = () => Math.floor(now() / 1000);
  const issuer = config.publicUrl.origin;
  const callbackUrl = new URL('/oauth/callback', config.publicUrl).href;
  const secureCookies = config.publicUrl.protocol === 'https:';
  const cookieName = (name: string) => (secureCookies ? `__Host-${name}` : name);
  const { clientId, clientSecret, scopes, oauthBaseUrl } = config;
  const linkedInApp: LinkedInOAuthApp = { clientId, clientSecret, scopes, oauthBaseUrl, fetch: options.fetch };

  const usedCodes = new Map<string, number>();
  const markCodeUsed = (jti: string, exp: number): boolean => {
    const current = nowSeconds();
    for (const [id, expiry] of usedCodes) if (expiry < current) usedCodes.delete(id);
    if (usedCodes.has(jti)) return false;
    usedCodes.set(jti, exp);
    return true;
  };

  const setCookie = (res: Response, name: string, value: string, sameSite: 'strict' | 'lax') =>
    res.cookie(cookieName(name), value, { httpOnly: true, secure: secureCookies, sameSite, path: '/', maxAge: CONSENT_TTL_S * 1000 });
  const clearCookie = (res: Response, name: string) =>
    res.clearCookie(cookieName(name), { httpOnly: true, secure: secureCookies, path: '/' });

  const capabilities = (() => {
    const scopes = new Set(config.scopes);
    const list = ['See your name, email address and profile photo', 'Publish posts on your behalf, and edit or delete them'];
    if (scopes.has('w_member_social_feed')) list.push('Comment on and react to posts on your behalf');
    if (scopes.has('w_organization_social')) list.push('Post, comment and react as LinkedIn Pages you administer');
    return list;
  })();

  /** Whether LINKEDIN_ALLOWED_MEMBERS admits this member (by member ID or verified email). */
  const memberAllowed = (grant: LinkedInGrant): boolean => {
    if (config.allowedMembers.includes('*')) return true;
    const identities = [grant.sub, grant.email].filter((id): id is string => !!id).map((id) => id.toLowerCase());
    return identities.some((id) => config.allowedMembers.includes(id));
  };

  const clientAccepts = (client: OAuthClient | undefined, redirectUri: string): client is OAuthClient =>
    client !== undefined && client.redirectUris.some((registered) => redirectUriMatches(registered, redirectUri));

  const router = express.Router();
  // Browsers and OAuth clients don't compress these forms; see the JSON parser in app.ts.
  const formBody = express.urlencoded({ extended: false, limit: '64kb', inflate: false });

  router.get('/authorize', async (req, res) => {
    const query = req.query as Record<string, unknown>;
    const clientId = str(query.client_id);
    const redirectUri = str(query.redirect_uri);
    if (!clientId || !redirectUri) {
      return sendErrorPage(res, 400, 'Invalid request', 'The authorization request is missing client_id or redirect_uri.');
    }
    const client = await clients.resolve(clientId);
    if (!clientAccepts(client, redirectUri)) {
      // Never redirect to an unverified URI: show the error here instead.
      return sendErrorPage(
        res,
        400,
        'Unknown application',
        'This application or its redirect address is not registered with this connector. Remove the connector in Claude and add it again.',
      );
    }
    const state = str(query.state);
    const fail = (error: string, description: string) =>
      redirectWith(res, redirectUri, { error, error_description: description, state, iss: issuer });
    if (query.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported.');
    const challenge = str(query.code_challenge);
    if (query.code_challenge_method !== 'S256' || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
    }
    const requestedResource = str(query.resource);
    if (requestedResource !== undefined && !sameResource(requestedResource, resource.href)) {
      return fail('invalid_target', `This server only issues tokens for ${resource.href}.`);
    }
    const request: AuthorizationRequest = { cid: client.clientId, ru: redirectUri, cc: challenge, res: resource.href, st: state };
    const csrf = randomToken();
    setCookie(res, 'csrf', csrf, 'strict');
    sendConsentPage(res, {
      client,
      redirectUri,
      consent: sealer.sign('consent', { req: request, csrf, exp: nowSeconds() + CONSENT_TTL_S } satisfies ConsentPayload),
      csrf,
      capabilities,
    });
  });

  router.post('/authorize', formBody, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const csrf = str(body.csrf);
    const cookieCsrf = readCookie(req, cookieName('csrf'));
    const consent = str(body.consent);
    const payload = consent ? sealer.verify<ConsentPayload>('consent', consent) : undefined;
    // Defense in depth; the SameSite=Strict CSRF cookie is what stops cross-site posts. Browsers send
    // `null` from opaque origins, which can't carry that cookie anyway.
    const origin = req.headers.origin;
    const foreignOrigin = origin !== undefined && origin !== 'null' && origin !== config.publicUrl.origin;
    clearCookie(res, 'csrf');
    const expired = !payload || payload.exp < nowSeconds();
    if (expired || !csrf || !cookieCsrf || !safeEqual(csrf, cookieCsrf) || !safeEqual(csrf, payload.csrf) || foreignOrigin) {
      return sendErrorPage(res, 400, 'This page has expired', 'Go back to Claude and start connecting LinkedIn again.');
    }
    const request = payload.req;
    if (!clientAccepts(await clients.resolve(request.cid), request.ru)) {
      return sendErrorPage(res, 400, 'Unknown application', 'This application is no longer allowed to connect.');
    }
    if (body.decision !== 'approve') {
      return redirectWith(res, request.ru, { error: 'access_denied', error_description: 'You declined access.', state: request.st, iss: issuer });
    }
    const linkedInState = randomToken();
    setCookie(res, 'auth', sealer.seal('pending', { req: request, ls: linkedInState, exp: nowSeconds() + CONSENT_TTL_S } satisfies PendingPayload), 'lax');
    res.set('Cache-Control', 'no-store').redirect(302, buildAuthorizationUrl(linkedInApp, callbackUrl, linkedInState));
  });

  router.get('/oauth/callback', async (req, res) => {
    const query = req.query as Record<string, unknown>;
    const cookie = readCookie(req, cookieName('auth'));
    const pending = cookie ? sealer.unseal<PendingPayload>('pending', cookie) : undefined;
    const state = str(query.state);
    clearCookie(res, 'auth');
    if (!pending || pending.exp < nowSeconds() || !state || !safeEqual(state, pending.ls)) {
      return sendErrorPage(res, 400, 'Sign-in session expired', 'Go back to Claude and start connecting LinkedIn again.');
    }
    const request = pending.req;
    const back = (params: Record<string, string | undefined>) => redirectWith(res, request.ru, { ...params, state: request.st, iss: issuer });

    const error = str(query.error);
    if (error) {
      // LinkedIn HTML-escapes quotes in descriptions: Scope &quot;w_member_social_feed&quot; is not authorized.
      const description = decodeHtmlEntities(str(query.error_description) ?? 'LinkedIn sign-in was cancelled.');
      // The app lacks a product for a scope this server asks for: only its operator can fix that.
      const refused = refusedScope(error, description, config.scopes);
      if (!refused) return back({ error: 'access_denied', error_description: description });
      logger('warn', 'linkedin_scope_not_authorized', { scope: refused.scope, clientId: request.cid });
      const product = refused.product ? `the ${refused.product} product` : `the product that grants ${refused.scope}`;
      const off = refused.feature ? ` or turn off ${refused.feature.variable}` : '';
      return back({
        error: 'access_denied',
        error_description: `This connector's LinkedIn app doesn't have ${product}. Ask whoever runs the connector to add it${off}.`,
      });
    }
    const code = str(query.code);
    if (!code) return back({ error: 'server_error', error_description: 'LinkedIn did not return an authorization code.' });
    let grant: LinkedInGrant;
    try {
      const tokens = await exchangeAuthorizationCode(linkedInApp, code, callbackUrl);
      grant = { at: tokens.accessToken, sc: tokens.scopes, exp: tokens.expiresAt };
    } catch (error) {
      logger('warn', 'linkedin_token_exchange_failed', { clientId: request.cid, error });
      return back({ error: 'server_error', error_description: `LinkedIn sign-in failed: ${(error as Error).message}` });
    }
    try {
      const { version, fetch } = options;
      const info = await new LinkedInClient({ accessToken: grant.at, version, apiBaseUrl: config.apiBaseUrl, fetch }).getUserInfo();
      // An unconfirmed email could be anyone's address, so only a verified one may match the allowlist.
      grant = { ...grant, sub: info.sub, name: info.name, email: info.email_verified === true ? info.email : undefined };
    } catch {
      // Without OpenID scopes there is no userinfo; tools report what is missing.
    }
    if (!memberAllowed(grant)) {
      logger('warn', 'member_not_allowed', { member: grant.sub, clientId: request.cid });
      // The member ID is what the operator can always add: linkedin.com shows it nowhere, and an email only matches
      // the account's primary one, once LinkedIn has verified it.
      const add = grant.sub ? ` Ask whoever runs it to add your LinkedIn member ID, ${grant.sub}, to LINKEDIN_ALLOWED_MEMBERS.` : '';
      return back({ error: 'access_denied', error_description: `This LinkedIn account is not allowed to use this connector.${add}` });
    }
    logger('info', 'member_authorized', { member: grant.sub, clientId: request.cid, scopes: grant.sc });
    const codePayload: CodePayload = { req: request, li: grant, jti: randomToken(16), exp: nowSeconds() + CODE_TTL_S };
    back({ code: sealer.seal('code', codePayload) });
  });

  router.post('/token', cors, formBody, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fail = (error: string, description: string, status = 400) => oauthError(res, status, error, description);
    if (body.grant_type !== 'authorization_code') return fail('unsupported_grant_type', 'Only the authorization_code grant is supported.');
    const basic = parseBasicAuth(req.headers.authorization);
    const bodyClientId = str(body.client_id);
    if (basic && bodyClientId && bodyClientId !== basic.id) {
      return fail('invalid_request', 'client_id does not match the Authorization header.');
    }
    const clientId = basic?.id ?? bodyClientId;
    const client = clientId ? await clients.resolve(clientId) : undefined;
    if (!client || !clients.authenticate(client, basic?.secret ?? str(body.client_secret))) {
      return fail('invalid_client', 'Client authentication failed.', 401);
    }
    const code = str(body.code);
    const payload = code ? sealer.unseal<CodePayload>('code', code) : undefined;
    if (!payload || payload.exp < nowSeconds() || payload.req.cid !== client.clientId) {
      return fail('invalid_grant', 'The authorization code is invalid, expired, or was issued to another client.');
    }
    // OAuth 2.1 clients may omit redirect_uri here (PKCE binds the code); if sent it must match.
    const redirectUri = str(body.redirect_uri);
    if (redirectUri !== undefined && redirectUri !== payload.req.ru) {
      return fail('invalid_grant', 'redirect_uri does not match the authorization request.');
    }
    const verifier = str(body.code_verifier);
    if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(pkceChallenge(verifier), payload.req.cc)) {
      return fail('invalid_grant', 'PKCE verification failed.');
    }
    const requestedResource = str(body.resource);
    if (requestedResource !== undefined && !sameResource(requestedResource, payload.req.res)) {
      return fail('invalid_target', `This server only issues tokens for ${payload.req.res}.`);
    }
    if (!markCodeUsed(payload.jti, payload.exp)) return fail('invalid_grant', 'The authorization code was already used.');
    const issuedAt = nowSeconds();
    const linkedInExpiry = payload.li.exp !== undefined ? Math.floor(payload.li.exp / 1000) : issuedAt + MAX_TOKEN_TTL_S;
    const expiresAt = Math.min(linkedInExpiry, issuedAt + MAX_TOKEN_TTL_S);
    if (expiresAt <= issuedAt) return fail('invalid_grant', 'The LinkedIn authorization has already expired.');
    const token: AccessTokenPayload = { cid: client.clientId, res: payload.req.res, li: payload.li, iat: issuedAt, exp: expiresAt };
    res.set(NO_STORE).json({ access_token: sealer.seal('access', token), token_type: 'Bearer', expires_in: expiresAt - issuedAt });
  });

  router.options('/register', cors);
  router.post('/register', cors, (req, res) => {
    const result = clients.register(req.body);
    res.status(result.status).set('Cache-Control', 'no-store').json(result.body);
  });

  const metadata: OAuthMetadata = {
    issuer,
    authorization_endpoint: new URL('/authorize', config.publicUrl).href,
    token_endpoint: new URL('/token', config.publicUrl).href,
    registration_endpoint: new URL('/register', config.publicUrl).href,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: HOMEPAGE,
  };

  const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const payload = sealer.unseal<AccessTokenPayload>('access', token);
      if (!payload) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid access token');
      // Re-checked on every request, so removing someone from LINKEDIN_ALLOWED_MEMBERS cuts off their tokens too.
      if (!memberAllowed(payload.li)) throw new OAuthError(OAuthErrorCode.InvalidToken, 'This LinkedIn account is no longer allowed');
      const { cid: clientId, exp: expiresAt, li: linkedin } = payload;
      return { token, clientId, scopes: [], expiresAt, resource: new URL(payload.res), extra: { linkedin } };
    },
  };

  return { router, metadata, verifier };
}
