import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultTokenFile } from './auth/token-store.js';
import { ConfigError } from './errors.js';
import { LINKEDIN_API_BASE } from './linkedin/client.js';
import { expandHome, isInside } from './linkedin/media.js';
import { LINKEDIN_OAUTH_BASE, parseScopes } from './linkedin/oauth.js';
import { isValidApiVersion } from './linkedin/versions.js';
import { isLoopbackHostname } from './net/loopback.js';

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
  /** Folders tools may read local images, documents and connection exports from. */
  fileDirs: string[];
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
  /** The secret used before `secret`; still opens tokens and client IDs issued with it, during a rotation. */
  previousSecret: string | undefined;
  /** Entries: exact URIs, `https://host/prefix*`, `loopback`, or `*`. */
  allowedRedirectUris: string[];
  /** LinkedIn member IDs or emails allowed to connect (lowercase); `*` allows anyone. */
  allowedMembers: string[];
  /** Host header values to accept; undefined disables the check. */
  allowedHosts: string[] | undefined;
  /** Express `trust proxy` setting, so client IPs are read from X-Forwarded-For behind a proxy. */
  trustProxy: boolean | number | string;
  /** Requests per minute per client IP to the OAuth endpoints; 0 disables. */
  oauthRateLimit: number;
  /** Requests per minute per connected account to /mcp; 0 disables. */
  mcpRateLimit: number;
  /** How long to wait for in-flight requests on shutdown, in milliseconds. */
  shutdownTimeoutMs: number;
  /** How long idle keep-alive connections stay open, in milliseconds; above a load balancer's idle timeout. */
  keepAliveTimeoutMs: number;
}

type Env = NodeJS.ProcessEnv;

function value(env: Env, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw ? raw : undefined;
}

/** A secret from NAME, or from the file NAME_FILE names, as Docker and Kubernetes secrets are mounted. */
function secretValue(env: Env, name: string): string | undefined {
  const file = value(env, `${name}_FILE`);
  if (file === undefined) return value(env, name);
  if (value(env, name) !== undefined) throw new ConfigError(`Set either ${name} or ${name}_FILE, not both.`);
  let contents: string;
  try {
    contents = readFileSync(file, 'utf8').trim();
  } catch (error) {
    throw new ConfigError(`${name}_FILE: cannot read ${file} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}).`);
  }
  if (!contents) throw new ConfigError(`${name}_FILE: ${file} is empty.`);
  return contents;
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
    clientSecret: secretValue(env, 'LINKEDIN_CLIENT_SECRET'),
    scopes: scopes.length > 0 ? scopes : [...DEFAULT_SCOPES],
    apiVersion,
    apiBaseUrl: value(env, 'LINKEDIN_API_BASE_URL') ?? LINKEDIN_API_BASE,
    oauthBaseUrl: value(env, 'LINKEDIN_OAUTH_BASE_URL') ?? LINKEDIN_OAUTH_BASE,
  };
}

function count(env: Env, name: string, fallback: number, min = 0): number {
  const raw = value(env, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new ConfigError(`${name} must be a whole number${min > 0 ? ` of at least ${min}` : ''}, got "${raw}".`);
  }
  return parsed;
}

const SECRET_HINT = 'at least 32 characters (try: openssl rand -base64 32)';

/** `true`/`false`, a hop count, or the subnets Express accepts (e.g. `loopback, 10.0.0.0/8`). */
function trustProxy(raw: string | undefined): boolean | number | string {
  if (raw === undefined || raw === 'false') return false;
  if (raw === 'true') return true;
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

/**
 * The folders local files may come from unless LINKEDIN_FILE_DIRS says otherwise: where downloads (such as
 * LinkedIn's data export), screenshots and photos usually land, plus the working directory (Claude Code
 * starts the server in the project), unless that contains the home directory (Claude Desktop starts it in /).
 * On Windows, OneDrive's folder backup (on by default on many PCs) moves Desktop and Pictures into OneDrive.
 */
export function defaultFileDirs(
  cwd: string = process.cwd(),
  home: string = homedir(),
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const dirs = ['Downloads', 'Desktop', 'Pictures'].map((name) => join(home, name));
  if (platform === 'win32') {
    const oneDrives = new Set([env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter((dir): dir is string => !!dir));
    for (const oneDrive of oneDrives) dirs.push(join(oneDrive, 'Desktop'), join(oneDrive, 'Pictures'));
  }
  return isInside(cwd, home) ? dirs : [...dirs, cwd];
}

export function loadLocalConfig(env: Env = process.env, cwd: string = process.cwd()): LocalConfig {
  return {
    ...common(env),
    redirectUri: value(env, 'LINKEDIN_REDIRECT_URI') ?? DEFAULT_LOCAL_REDIRECT_URI,
    tokenFile: value(env, 'LINKEDIN_TOKEN_FILE') ?? defaultTokenFile(env),
    accessToken: value(env, 'LINKEDIN_ACCESS_TOKEN'),
    fileDirs: list(env, 'LINKEDIN_FILE_DIRS')?.map((dir) => resolve(cwd, expandHome(dir))) ?? defaultFileDirs(cwd, homedir(), env),
  };
}

export function loadRemoteConfig(env: Env = process.env, warn: (message: string) => void = () => {}): RemoteConfig {
  const base = common(env);
  const required = { LINKEDIN_CLIENT_ID: base.clientId, LINKEDIN_CLIENT_SECRET: base.clientSecret, PUBLIC_URL: value(env, 'PUBLIC_URL') };
  const missing = Object.entries(required).filter(([, setting]) => !setting).map(([name]) => name);
  if (missing.length > 0) throw new ConfigError(`Missing required environment variables: ${missing.join(', ')}.`);

  const publicUrl = URL.parse(value(env, 'PUBLIC_URL')!);
  if (!publicUrl) throw new ConfigError(`PUBLIC_URL "${value(env, 'PUBLIC_URL')}" is not a valid URL.`);
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
    throw new ConfigError('PUBLIC_URL must be an origin without a path, e.g. https://linkedin-mcp.example.com');
  }
  const loopback = isLoopbackHostname(publicUrl.hostname);
  if (publicUrl.protocol !== 'https:' && !(publicUrl.protocol === 'http:' && loopback)) {
    throw new ConfigError('PUBLIC_URL must use https (plain http is only allowed for localhost testing).');
  }

  const port = Number(value(env, 'PORT') ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`PORT "${env.PORT}" is not a valid port.`);

  let secret = secretValue(env, 'SERVER_SECRET');
  const ephemeralSecret = secret === undefined;
  if (secret === undefined) {
    // A random secret differs per restart and per replica, so a public server would keep disconnecting everyone.
    if (!loopback) throw new ConfigError(`SERVER_SECRET is required: set it to ${SECRET_HINT} and keep it across restarts.`);
    secret = randomBytes(32).toString('base64url');
    warn('SERVER_SECRET is not set; using a random one. Connections will stop working when the server restarts.');
  } else if (secret.length < 32) {
    throw new ConfigError(`SERVER_SECRET must be ${SECRET_HINT}.`);
  }
  const previousSecret = secretValue(env, 'SERVER_SECRET_PREVIOUS');
  if (previousSecret !== undefined && previousSecret.length < 32) throw new ConfigError(`SERVER_SECRET_PREVIOUS must be ${SECRET_HINT}.`);

  // A public server must say who may use it; local testing defaults to anyone.
  const allowedMembers = list(env, 'LINKEDIN_ALLOWED_MEMBERS') ?? (loopback ? ['*'] : undefined);
  if (!allowedMembers?.length) {
    throw new ConfigError(
      'LINKEDIN_ALLOWED_MEMBERS is required: list the LinkedIn emails or member IDs allowed to connect, or set it to * to allow anyone.',
    );
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
    previousSecret,
    allowedRedirectUris: list(env, 'OAUTH_ALLOWED_REDIRECT_URIS') ?? [...CLAUDE_REDIRECT_URIS, 'loopback'],
    allowedMembers: allowedMembers.map((member) => member.toLowerCase()),
    allowedHosts: list(env, 'ALLOWED_HOSTS'),
    trustProxy: trustProxy(value(env, 'TRUST_PROXY')),
    oauthRateLimit: count(env, 'RATE_LIMIT_OAUTH', 60),
    mcpRateLimit: count(env, 'RATE_LIMIT_MCP', 120),
    shutdownTimeoutMs: count(env, 'SHUTDOWN_TIMEOUT', 8) * 1000,
    keepAliveTimeoutMs: count(env, 'KEEP_ALIVE_TIMEOUT', 65, 1) * 1000,
  };
}
