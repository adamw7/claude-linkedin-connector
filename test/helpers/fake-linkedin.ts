/** A recorded request made to the fake LinkedIn. */
export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string | Uint8Array | undefined;
  json: unknown;
}

type Override = (request: RecordedRequest) => Response | undefined | Promise<Response | undefined>;

export const MEMBER = {
  sub: 'abc123',
  name: 'Ada Lovelace',
  given_name: 'Ada',
  family_name: 'Lovelace',
  email: 'ada@example.com',
  email_verified: true,
  picture: 'https://media.licdn.com/ada.jpg',
  locale: { country: 'GB', language: 'en' },
};

export const API_BASE = 'https://api.linkedin.test';
export const OAUTH_BASE = 'https://www.linkedin.test';
const UPLOAD_BASE = 'https://upload.linkedin.test';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/**
 * An in-memory stand-in for LinkedIn's OAuth, REST and upload endpoints,
 * used as the `fetch` implementation. It records every request.
 */
export class FakeLinkedIn {
  readonly requests: RecordedRequest[] = [];
  /** Access tokens LinkedIn considers valid. */
  readonly validTokens = new Set<string>(['li-token']);
  /** API versions LinkedIn accepts. */
  activeVersions = new Set<string>(['202609', '202610']);
  grantedScope = 'email,openid,profile,w_member_social';
  assetStatus = 'AVAILABLE';
  private overrides: Override[] = [];
  private counter = 0;

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    let body: string | Uint8Array | undefined;
    if (typeof init?.body === 'string') body = init.body;
    else if (init?.body instanceof URLSearchParams) body = init.body.toString();
    else if (init?.body instanceof Uint8Array) body = init.body;
    let parsed: unknown;
    if (typeof body === 'string') {
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = undefined;
      }
    }
    const request: RecordedRequest = { method, url, headers, body, json: parsed };
    this.requests.push(request);
    for (const override of this.overrides) {
      const response = await override(request);
      if (response) return response;
    }
    return this.route(request);
  };

  /** Intercepts matching requests before the default routes. */
  override(handler: Override): void {
    this.overrides.push(handler);
  }

  find(method: string, pathPrefix: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && r.url.pathname.startsWith(pathPrefix));
  }

  private route(request: RecordedRequest): Response {
    const { method, url, headers } = request;
    const path = url.pathname;

    if (url.origin === OAUTH_BASE && path === '/oauth/v2/accessToken' && method === 'POST') {
      const form = new URLSearchParams(String(request.body));
      if (form.get('client_secret') !== 'test-secret') return json(401, { error: 'invalid_client', error_description: 'Client authentication failed' });
      if (form.get('grant_type') === 'authorization_code' && form.get('code') === 'li-code') {
        return json(200, { access_token: 'li-token', expires_in: 5_184_000, scope: this.grantedScope });
      }
      if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'li-refresh') {
        this.validTokens.add('li-token-refreshed');
        return json(200, { access_token: 'li-token-refreshed', expires_in: 5_184_000, scope: this.grantedScope, refresh_token: 'li-refresh-2', refresh_token_expires_in: 31_536_000 });
      }
      return json(400, { error: 'invalid_grant', error_description: 'Unable to retrieve access token: appid/redirect uri/code verifier does not match authorization code' });
    }

    if (url.origin === UPLOAD_BASE && method === 'PUT') {
      return new Response(null, { status: 201 });
    }

    if (url.origin !== API_BASE) return json(599, { message: `Unexpected request to ${url.href}` });

    const token = headers.get('authorization')?.replace(/^Bearer /, '');
    if (!token || !this.validTokens.has(token)) {
      return json(401, { status: 401, serviceErrorCode: 65601, code: 'REVOKED_ACCESS_TOKEN', message: 'The token used in the request has been revoked by the user' });
    }

    if (path === '/v2/userinfo' && method === 'GET') return json(200, MEMBER);

    const version = headers.get('linkedin-version');
    if (!version || !this.activeVersions.has(version)) {
      return json(426, { status: 426, code: 'NONEXISTENT_VERSION', message: `Requested version ${version}01 is not active` });
    }

    if (path === '/rest/posts' && method === 'POST') {
      const id = `urn:li:share:70000000000000000${++this.counter}`;
      return new Response(null, { status: 201, headers: { 'x-restli-id': id } });
    }
    if (path.startsWith('/rest/posts/') && method === 'DELETE') return new Response(null, { status: 204 });
    if (path.startsWith('/rest/posts/') && method === 'POST' && headers.get('x-restli-method') === 'PARTIAL_UPDATE') {
      return new Response(null, { status: 204 });
    }
    if ((path === '/rest/images' || path === '/rest/documents') && url.searchParams.get('action') === 'initializeUpload') {
      const kind = path === '/rest/images' ? 'image' : 'document';
      const n = ++this.counter;
      return json(200, {
        value: { uploadUrlExpiresAt: Date.now() + 3_600_000, uploadUrl: `${UPLOAD_BASE}/${kind}s/${n}`, [kind]: `urn:li:${kind}:D${n}` },
      });
    }
    if ((path.startsWith('/rest/images/') || path.startsWith('/rest/documents/')) && method === 'GET') {
      return json(200, { status: this.assetStatus });
    }
    if (/^\/rest\/socialActions\/[^/]+\/comments$/.test(path) && method === 'POST') {
      return new Response(null, { status: 201, headers: { 'x-restli-id': `urn:li:comment:(urn:li:activity:1,${++this.counter})` } });
    }
    if (path === '/rest/reactions' && method === 'POST') return new Response(null, { status: 201 });
    return json(404, { status: 404, message: `No route for ${method} ${path}` });
  }
}
