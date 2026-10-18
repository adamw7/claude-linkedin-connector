import { isLoopbackHostname } from '../net/loopback.js';
import { safeFetch } from '../net/safe-fetch.js';
import type { Sealer } from './crypto.js';

export type ClientAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

export interface OAuthClient {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  authMethod: ClientAuthMethod;
  /** `metadata-document`: the client ID is a Client ID Metadata Document URL. */
  kind: 'registered' | 'metadata-document';
}

export interface RegistrationResult {
  status: number;
  body: Record<string, unknown>;
}

interface RegisteredClientPayload {
  v: 1;
  r: string[];
  m: ClientAuthMethod;
  n?: string;
}

const AUTH_METHODS: ClientAuthMethod[] = ['none', 'client_secret_post', 'client_secret_basic'];
const METADATA_CACHE_MS = 5 * 60_000;
const METADATA_CACHE_LIMIT = 500;

function clientName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 100) : undefined;
}

export function isLoopbackUrl(url: URL): boolean {
  return url.protocol === 'http:' && isLoopbackHostname(url.hostname);
}

/** Redirect URIs must be absolute, fragment-free, and https unless they are loopback. */
export function isValidRedirectUri(value: string): boolean {
  const url = URL.parse(value);
  if (!url || url.hash || value.includes('#') || url.username || url.password) return false;
  return url.protocol === 'https:' || isLoopbackUrl(url);
}

/** Exact match, except loopback ports, which native apps pick at runtime (RFC 8252 §7.3). */
export function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  const a = URL.parse(registered);
  const b = URL.parse(requested);
  if (!a || !b || !isLoopbackUrl(a) || !isLoopbackUrl(b)) return false;
  return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}

/**
 * Which redirect URIs clients may use. Entries are exact URIs,
 * `https://host/prefix*` wildcards, `loopback` (any http://localhost,
 * 127.0.0.1 or [::1] URI), or `*` (any valid redirect URI).
 */
export class RedirectPolicy {
  constructor(private readonly entries: string[]) {}

  allows(uri: string): boolean {
    if (!isValidRedirectUri(uri)) return false;
    // Compare the normalized form so `..` segments can't escape a prefix.
    const normalized = new URL(uri).href;
    return this.entries.some((entry) => {
      if (entry === '*') return true;
      if (entry === 'loopback') return isLoopbackUrl(new URL(uri));
      if (entry.endsWith('*')) return uri === normalized && normalized.startsWith(entry.slice(0, -1));
      return uri === entry;
    });
  }
}

export interface ClientRegistryOptions {
  allowPrivateNetwork?: boolean;
  /** Fetches a Client ID Metadata Document's body; defaults to a guarded HTTPS GET. */
  fetchDocument?: (url: string) => Promise<string>;
  now?: () => number;
}

/**
 * Resolves OAuth clients without a database: dynamically registered clients
 * (RFC 7591) get a signed client ID that embeds their metadata, and URL client
 * IDs are fetched as Client ID Metadata Documents.
 */
export class ClientRegistry {
  private readonly metadataCache = new Map<string, { client: OAuthClient | undefined; expiresAt: number }>();
  private readonly now: () => number;

  constructor(
    private readonly sealer: Sealer,
    private readonly policy: RedirectPolicy,
    private readonly options: ClientRegistryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  register(metadata: unknown): RegistrationResult {
    const fail = (error: string, description: string): RegistrationResult => ({
      status: 400,
      body: { error, error_description: description },
    });
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      return fail('invalid_client_metadata', 'Expected a JSON object.');
    }
    const m = metadata as Record<string, unknown>;
    const redirectUris = m.redirect_uris;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      redirectUris.length > 10 ||
      !redirectUris.every((uri): uri is string => typeof uri === 'string' && uri.length <= 2000)
    ) {
      return fail('invalid_redirect_uri', 'redirect_uris must be a list of 1 to 10 URLs.');
    }
    const rejected = redirectUris.find((uri) => !this.policy.allows(uri));
    if (rejected !== undefined) {
      return fail('invalid_redirect_uri', `Redirect URI not allowed by this server: ${rejected}`);
    }
    const method = m.token_endpoint_auth_method ?? 'client_secret_basic';
    if (typeof method !== 'string' || !AUTH_METHODS.includes(method as ClientAuthMethod)) {
      return fail('invalid_client_metadata', `Unsupported token_endpoint_auth_method. Use one of: ${AUTH_METHODS.join(', ')}.`);
    }
    if (m.grant_types !== undefined && !(Array.isArray(m.grant_types) && m.grant_types.includes('authorization_code'))) {
      return fail('invalid_client_metadata', 'Only the authorization_code grant is supported.');
    }
    if (m.response_types !== undefined && !(Array.isArray(m.response_types) && m.response_types.includes('code'))) {
      return fail('invalid_client_metadata', 'Only the "code" response type is supported.');
    }
    const name = clientName(m.client_name);
    const clientId = this.sealer.sign('client', { v: 1, r: redirectUris, m: method as ClientAuthMethod, n: name } satisfies RegisteredClientPayload);
    return {
      status: 201,
      body: {
        client_id: clientId,
        client_id_issued_at: Math.floor(this.now() / 1000),
        ...(method === 'none' ? {} : { client_secret: this.clientSecret(clientId), client_secret_expires_at: 0 }),
        redirect_uris: redirectUris,
        token_endpoint_auth_method: method,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        ...(name ? { client_name: name } : {}),
      },
    };
  }

  async resolve(clientId: string): Promise<OAuthClient | undefined> {
    if (clientId.startsWith('https://')) return this.resolveMetadataDocument(clientId);
    const payload = this.sealer.verify<RegisteredClientPayload>('client', clientId);
    if (!payload || payload.v !== 1 || !Array.isArray(payload.r) || !AUTH_METHODS.includes(payload.m)) return undefined;
    // Re-apply the policy so tightening it also cuts off existing registrations.
    const redirectUris = payload.r.filter((uri) => this.policy.allows(uri));
    if (redirectUris.length === 0) return undefined;
    return { clientId, redirectUris, authMethod: payload.m, kind: 'registered', clientName: payload.n };
  }

  /**
   * Public clients authenticate with PKCE alone. Metadata-document clients are
   * treated as public too: codes are bound to their published redirect URIs.
   */
  authenticate(client: OAuthClient, secret: string | undefined): boolean {
    if (client.authMethod === 'none' || client.kind === 'metadata-document') return true;
    // Any secret the Sealer accepts: clients registered before a SERVER_SECRET rotation keep working.
    return secret !== undefined && this.sealer.macMatches('client-secret', client.clientId, secret);
  }

  private clientSecret(clientId: string): string {
    return this.sealer.mac('client-secret', clientId);
  }

  private async resolveMetadataDocument(clientId: string): Promise<OAuthClient | undefined> {
    const cached = this.metadataCache.get(clientId);
    if (cached && cached.expiresAt > this.now()) return cached.client;
    const client = await this.fetchMetadataDocument(clientId);
    if (this.metadataCache.size >= METADATA_CACHE_LIMIT) {
      const oldest = this.metadataCache.keys().next().value;
      if (oldest !== undefined) this.metadataCache.delete(oldest);
    }
    this.metadataCache.set(clientId, { client, expiresAt: this.now() + (client ? METADATA_CACHE_MS : 30_000) });
    return client;
  }

  private async fetchMetadataDocument(clientId: string): Promise<OAuthClient | undefined> {
    const url = URL.parse(clientId);
    if (!url || url.protocol !== 'https:' || url.pathname === '/' || url.hash || url.username || url.password) return undefined;
    const fetchDocument =
      this.options.fetchDocument ??
      (async (target: string) => {
        const response = await safeFetch(target, {
          maxBytes: 64 * 1024,
          timeoutMs: 5_000,
          maxRedirects: 0,
          accept: 'application/json',
          allowPrivateNetwork: this.options.allowPrivateNetwork,
        });
        return response.data.toString('utf8');
      });
    let document: Record<string, unknown>;
    try {
      document = JSON.parse(await fetchDocument(clientId)) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    if (typeof document !== 'object' || document === null || document.client_id !== clientId) return undefined;
    if (!Array.isArray(document.redirect_uris)) return undefined;
    const redirectUris = document.redirect_uris.filter(
      (uri): uri is string => typeof uri === 'string' && this.policy.allows(uri),
    );
    if (redirectUris.length === 0) return undefined;
    return { clientId, redirectUris, authMethod: 'none', kind: 'metadata-document', clientName: clientName(document.client_name) };
  }
}
