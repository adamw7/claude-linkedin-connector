import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ConfigError, sentence } from '../errors.js';
import { decodeHtmlEntities, escapeHtml, page } from '../html.js';
import { buildAuthorizationUrl, exchangeAuthorizationCode, type LinkedInOAuthApp, type LinkedInTokens } from '../linkedin/oauth.js';
import { refusedScope, type RefusedScope } from '../linkedin/scopes.js';
import { isLoopbackHostname } from '../net/loopback.js';

export interface LoopbackLoginOptions {
  app: LinkedInOAuthApp;
  redirectUri: string;
  /** Persists the tokens and returns the member's display name for the success page. */
  onTokens: (tokens: LinkedInTokens) => Promise<string | undefined>;
  timeoutMs?: number;
}

export interface LoopbackLoginHandle {
  authorizationUrl: string;
  /** Resolves with the member's name once the browser flow completes. */
  completion: Promise<string | undefined>;
  /** Epoch milliseconds after which the flow is abandoned. */
  expiresAt: number;
}

/** The setting as the Claude Desktop extension names it, then as an environment variable. */
const REDIRECT_SETTING = '"Redirect URL" (LINKEDIN_REDIRECT_URI)';

export function validateLoopbackRedirect(redirectUri: string): URL {
  const url = URL.parse(redirectUri);
  if (!url) throw new ConfigError(`${REDIRECT_SETTING} "${redirectUri}" is not a valid URL.`);
  if (url.protocol !== 'http:' || !isLoopbackHostname(url.hostname) || !url.port || url.port === '0') {
    throw new ConfigError(`${REDIRECT_SETTING} must look like http://localhost:<port>/<path> (got "${redirectUri}").`);
  }
  return url;
}

const APPS = 'https://www.linkedin.com/developers/apps';

/** What to do when LinkedIn won't authorize a scope because the app lacks its product; otherwise signing in just fails. */
function refusedScopeHelp({ scope, product, feature }: RefusedScope): string {
  if (feature) {
    return (
      `Your LinkedIn app doesn't have the Community Management API product, which "${feature.setting}" needs. ` +
      `Turn that setting off (${feature.variable}, or remove ${scope} from LINKEDIN_SCOPES), or add the product to the app at ${APPS}; then sign in again.`
    );
  }
  return product
    ? `Your LinkedIn app doesn't have the ${product} product: add it at ${APPS}, then sign in again.`
    : `Your LinkedIn app doesn't have the product that grants ${scope}: add that product at ${APPS}, or remove ${scope} from LINKEDIN_SCOPES; then sign in again.`;
}

function respond(res: ServerResponse, status: number, title: string, body: string): void {
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' };
  res.writeHead(status, headers).end(page(title, body));
}

/**
 * Runs LinkedIn's authorization-code flow through the user's browser, with a
 * temporary HTTP listener on the loopback redirect URI to receive the code.
 */
export class LoopbackLogin {
  private active: LoopbackLoginHandle | undefined;
  /** A start still binding the listener, so concurrent calls share it instead of racing for the port. */
  private starting: Promise<LoopbackLoginHandle> | undefined;
  /** Why the most recent sign-in failed, until another one starts; only the browser showed it otherwise. */
  lastError: Error | undefined;

  constructor(private readonly options: LoopbackLoginOptions) {}

  /** Starts a sign-in, or returns the one already waiting for the browser. */
  async start(): Promise<LoopbackLoginHandle> {
    if (this.active && this.active.expiresAt > Date.now()) return this.active;
    this.starting ??= this.begin().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async begin(): Promise<LoopbackLoginHandle> {
    const redirect = validateLoopbackRedirect(this.options.redirectUri);
    const state = randomBytes(32).toString('base64url');
    const timeoutMs = this.options.timeoutMs ?? 10 * 60_000;

    const { promise: completion, resolve: resolveCompletion, reject: rejectCompletion } = Promise.withResolvers<string | undefined>();
    // Callers that care await it; don't crash the process if nobody does.
    completion.catch(() => {});

    const servers: Server[] = [];
    let timer: NodeJS.Timeout | undefined;
    let flow: LoopbackLoginHandle | undefined;
    let finished = false;
    const finish = (error?: Error, name?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const server of servers) {
        server.close();
        server.closeIdleConnections();
      }
      if (this.active === flow) this.active = undefined;
      this.lastError = error;
      if (error) rejectCompletion(error);
      else resolveCompletion(name);
    };

    const onRequest = async (req: IncomingMessage, res: ServerResponse) => {
      // Not `new URL`: Node accepts request targets such as `//[` that don't parse, and a throw here would crash the server.
      const url = URL.parse(req.url ?? '/', redirect.href);
      if (!url || url.pathname !== redirect.pathname) return void res.writeHead(404, { Connection: 'close' }).end();
      if (finished || url.searchParams.get('state') !== state) {
        return respond(res, 400, 'Sign-in link expired', '<h1>This sign-in link has expired</h1><p>Start the LinkedIn sign-in again from Claude.</p>');
      }
      const error = url.searchParams.get('error');
      if (error) {
        // LinkedIn HTML-escapes quotes in descriptions: Scope &quot;w_member_social_feed&quot; is not authorized.
        const description = decodeHtmlEntities(url.searchParams.get('error_description') ?? error);
        const refused = refusedScope(error, description, this.options.app.scopes);
        const message = refused ? `${sentence(description)} ${refusedScopeHelp(refused)}` : description;
        respond(res, 400, 'Sign-in cancelled', `<h1>LinkedIn sign-in was not completed</h1><p>${escapeHtml(message)}</p>`);
        return finish(new Error(`LinkedIn sign-in was not completed: ${message}`));
      }
      const code = url.searchParams.get('code');
      if (!code) return respond(res, 400, 'Missing code', '<h1>LinkedIn did not return an authorization code</h1>');
      try {
        const tokens = await exchangeAuthorizationCode(this.options.app, code, this.options.redirectUri);
        const name = await this.options.onTokens(tokens);
        const who = name ? ` as <strong>${escapeHtml(name)}</strong>` : '';
        respond(res, 200, 'Connected to LinkedIn', `<h1>Connected to LinkedIn${who}</h1><p>You can close this tab and return to Claude.</p>`);
        finish(undefined, name);
      } catch (cause) {
        const message = (cause as Error).message;
        respond(res, 500, 'Sign-in failed', `<h1>LinkedIn sign-in failed</h1><p>${escapeHtml(message)}</p>`);
        finish(cause instanceof Error ? cause : new Error(message));
      }
    };

    const port = Number(redirect.port);
    const hosts = redirect.hostname === 'localhost' ? ['127.0.0.1', '::1'] : [redirect.hostname.replace(/^\[|\]$/g, '')];
    for (const [index, host] of hosts.entries()) {
      const server = createServer((req, res) => void onRequest(req, res));
      try {
        // Rejects with the 'error' the server emits instead of listening, such as EADDRINUSE.
        await once(server.listen(port, host), 'listening');
        servers.push(server);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // `localhost` may also resolve to ::1; skip it quietly where IPv6 is unavailable.
        if (index > 0 && (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT')) continue;
        for (const started of servers) started.close();
        if (code === 'EADDRINUSE') {
          throw new ConfigError(
            `Port ${port} is already in use, so the sign-in callback cannot listen on ${redirect.origin}. ` +
              'Another LinkedIn sign-in may be waiting (for example in another Claude window or terminal): finish it or close it and try again. ' +
              `Otherwise free the port, or set ${REDIRECT_SETTING} to another localhost port and add it to your LinkedIn app's authorized redirect URLs.`,
          );
        }
        throw error;
      }
    }

    timer = setTimeout(() => finish(new Error('LinkedIn sign-in timed out. Start it again.')), timeoutMs);
    timer.unref();
    flow = {
      authorizationUrl: buildAuthorizationUrl(this.options.app, this.options.redirectUri, state),
      completion,
      expiresAt: Date.now() + timeoutMs,
    };
    this.active = flow;
    this.lastError = undefined;
    return flow;
  }
}
