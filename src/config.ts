import { randomBytes } from 'node:crypto';
import { defaultTokenFile } from './auth/token-store.js';
import { ConfigError } from './errors.js';
import { LINKEDIN_API_BASE } from './linkedin/client.js';
import { LINKEDIN_OAUTH_BASE, parseScopes } from './linkedin/oauth.js';
import { isValidApiVersion } from './linkedin/versions.js';

/** Scopes granted by the self-serve "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn" products. */
export const DEFAULT_SCOPES = ['openid', 'profile', 'email', 'w_member_social'];
export const DEFAULT_LOCAL_REDIRECT_URI = 'http://localhost:8723/callback';
/** Where Claude (web, desktop and mobile) receives OAuth redirects for remote connectors. */
export const CLAUDE_REDIRECT_URIS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];

export interface CommonConfig {
  clientId: string | undefined;
  clientSecret: string | undefined;
  scopes: string[];
  apiVersion: string | undefined;
  apiBaseUrl: string;
  oauthBaseUrl: string;
}

export interface LocalConfig extends CommonConfig {
  redirectUri: string;
  tokenFile: string;
  /** A pre-issued token that bypasses the sign-in flow entirely. */
  accessToken: string | undefined;
}

export interface RemoteConfig extends CommonConfig {
  clientId: string;
  clientSecret: string;
  /** Public origin of the server; the MCP endpoint is `<publicUrl>/mcp`. */
  publicUrl: URL;
  host: string;
  port: number;
  /** Signs and encrypts OAuth artifacts. */
  secret: string;
  /** True when `secret` was generated at startup (connections won't survive a restart). */
  ephemeralSecret: boolean;
  /** Entries: exact URIs, `https://host/prefix*`, `loopback`, or `*`. */
  allowedRedirectUris: string[];
  /** LinkedIn member IDs or emails allowed to connect; empty allows anyone. */
  allowedMembers: string[];
  /** Host header values to accept; undefined disables the check. */
  allowedHosts: string[] | undefined;
}

type Env = NodeJS.ProcessEnv;

function value(env: Env, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw ? raw : undefined;
}

function list(env: Env, name: string): string[] | undefined {
  const raw = value(env, name);
  return raw === undefined ? undefined : raw.split(',').map((item) => item.trim()).filter(Boolean);
}

function common(env: Env): CommonConfig {
  const apiVersion = value(env, 'LINKEDIN_API_VERSION');
  if (apiVersion !== undefined && !isValidApiVersion(apiVersion)) {
    throw new ConfigError(`LINKEDIN_API_VERSION must look like YYYYMM (e.g. 202609), got "${apiVersion}".`);
  }
  const scopes = parseScopes(value(env, 'LINKEDIN_SCOPES'));
  return {
    clientId: value(env, 'LINKEDIN_CLIENT_ID'),
    clientSecret: value(env, 'LINKEDIN_CLIENT_SECRET'),
    scopes: scopes.length > 0 ? scopes : [...DEFAULT_SCOPES],
    apiVersion,
    apiBaseUrl: value(env, 'LINKEDIN_API_BASE_URL') ?? LINKEDIN_API_BASE,
    oauthBaseUrl: value(env, 'LINKEDIN_OAUTH_BASE_URL') ?? LINKEDIN_OAUTH_BASE,
  };
}

export function loadLocalConfig(env: Env = process.env): LocalConfig {
  return {
    ...common(env),
    redirectUri: value(env, 'LINKEDIN_REDIRECT_URI') ?? DEFAULT_LOCAL_REDIRECT_URI,
    tokenFile: value(env, 'LINKEDIN_TOKEN_FILE') ?? defaultTokenFile(env),
    accessToken: value(env, 'LINKEDIN_ACCESS_TOKEN'),
  };
}

export function loadRemoteConfig(env: Env = process.env, warn: (message: string) => void = () => {}): RemoteConfig {
  const base = common(env);
  const missing = ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'PUBLIC_URL'].filter((name) => !value(env, name));
  if (missing.length > 0) throw new ConfigError(`Missing required environment variables: ${missing.join(', ')}.`);

  let publicUrl: URL;
  try {
    publicUrl = new URL(value(env, 'PUBLIC_URL')!);
  } catch {
    throw new ConfigError(`PUBLIC_URL "${value(env, 'PUBLIC_URL')}" is not a valid URL.`);
  }
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
    throw new ConfigError('PUBLIC_URL must be an origin without a path, e.g. https://linkedin-mcp.example.com');
  }
  const loopback = publicUrl.hostname === 'localhost' || publicUrl.hostname === '127.0.0.1';
  if (publicUrl.protocol !== 'https:' && !(publicUrl.protocol === 'http:' && loopback)) {
    throw new ConfigError('PUBLIC_URL must use https (plain http is only allowed for localhost testing).');
  }

  const port = Number(value(env, 'PORT') ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`PORT "${env.PORT}" is not a valid port.`);

  let secret = value(env, 'SERVER_SECRET');
  const ephemeralSecret = secret === undefined;
  if (secret === undefined) {
    secret = randomBytes(32).toString('base64url');
    warn('SERVER_SECRET is not set; using a random one. Connections will stop working when the server restarts.');
  } else if (secret.length < 32) {
    throw new ConfigError('SERVER_SECRET must be at least 32 characters (try: openssl rand -base64 32).');
  }

  return {
    ...base,
    clientId: base.clientId!,
    clientSecret: base.clientSecret!,
    publicUrl,
    host: value(env, 'HOST') ?? '127.0.0.1',
    port,
    secret,
    ephemeralSecret,
    allowedRedirectUris: list(env, 'OAUTH_ALLOWED_REDIRECT_URIS') ?? [...CLAUDE_REDIRECT_URIS, 'loopback'],
    allowedMembers: (list(env, 'LINKEDIN_ALLOWED_MEMBERS') ?? []).map((member) => member.toLowerCase()),
    allowedHosts: list(env, 'ALLOWED_HOSTS'),
  };
}
