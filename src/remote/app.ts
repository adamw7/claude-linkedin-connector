import express, { type ErrorRequestHandler, type Express, type Request, type RequestHandler, type Response } from 'express';
import {
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidation,
  mcpAuthMetadataRouter,
  requireBearerAuth,
} from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { buildOAuthProtectedResourceMetadata, createMcpHandler } from '@modelcontextprotocol/server';
import type { RemoteConfig } from '../config.js';
import { escapeHtml } from '../html.js';
import type { ApiVersion } from '../linkedin/versions.js';
import { errorKind } from '../mcp/errors.js';
import { createConnectorServer } from '../mcp/server.js';
import { LOOPBACK_HOSTNAMES } from '../net/loopback.js';
import { HOMEPAGE } from '../version.js';
import { ClientRegistry, RedirectPolicy } from './clients.js';
import { ConnectorAuth, grantFromAuthInfo } from './connector-auth.js';
import { Sealer } from './crypto.js';
import { pathOf, requestId, requestLogger, silentLogger, type Logger } from './logger.js';
import { createOAuthServer, MAX_OAUTH_BODY } from './oauth-server.js';
import { sendPage } from './pages.js';
import { rateLimit } from './rate-limit.js';

export interface RemoteAppOptions {
  config: RemoteConfig;
  version: ApiVersion;
  /** Used for LinkedIn API and OAuth calls (tests). */
  fetch?: typeof globalThis.fetch;
  /** Permit fetching media and client metadata from private networks (tests only). */
  allowPrivateNetwork?: boolean;
  /** Overrides how Client ID Metadata Documents are fetched (tests). */
  fetchClientMetadata?: (url: string) => Promise<string>;
  /** Receives request, error and audit events; silent by default. */
  logger?: Logger;
}

export interface RemoteApp {
  app: Express;
  /** The MCP endpoint URL to add to Claude. */
  mcpUrl: URL;
  close: () => Promise<void>;
}

const LOOPBACK_BINDS = new Set(['127.0.0.1', 'localhost', '::1']);

/** MCP request bodies above this are rejected; base64 inflates media by a third, so data: URIs top out around 20 MB. */
const MAX_BODY = '30mb';

/** Endpoints a browser or OAuth client calls before it has a token; limited per client IP. */
const OAUTH_PATHS = ['/authorize', '/oauth/callback', '/token', '/register'];

function sendJsonError(req: Request, res: Response, status: number, message: string): void {
  if (pathOf(req) === '/mcp') {
    res.status(status).json({ jsonrpc: '2.0', error: { code: status < 500 ? -32600 : -32603, message }, id: null });
  } else {
    const error = status === 429 ? 'too_many_requests' : status < 500 ? 'invalid_request' : 'server_error';
    res.status(status).json({ error, error_description: message });
  }
}

/**
 * Answers body-parser failures (and anything else unhandled) with JSON instead
 * of Express's HTML page, which MCP clients show verbatim and which includes a
 * stack trace outside production. Server errors are logged with their stack.
 */
const jsonErrors = (logger: Logger): ErrorRequestHandler => (error: { status?: number; type?: string }, req, res, next) => {
  const status = typeof error.status === 'number' && error.status >= 400 && error.status < 600 ? error.status : 500;
  if (status >= 500) logger('error', 'unhandled_error', { method: req.method, path: pathOf(req), requestId: req.get('x-request-id'), error });
  if (res.headersSent) return next(error);
  const message =
    error.type === 'entity.too.large'
      ? pathOf(req) === '/mcp'
        ? `The request is larger than ${MAX_BODY.toUpperCase()}. Pass large images or documents as an http(s) URL instead of a data: URI.`
        : 'The request body is too large.'
      : error.type === 'entity.parse.failed'
        ? 'The request body is not valid JSON.'
        : error.type === 'encoding.unsupported'
          ? 'This Content-Encoding is not supported here. Send the request body uncompressed.'
          : status < 500
            ? 'The request could not be processed.'
            : 'Internal server error.';
  sendJsonError(req, res, status, message);
};

/** Browser-based MCP clients need CORS; tokens travel in a header, not cookies, so any origin is fine. */
const mcpCors: RequestHandler = (req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'Authorization, Content-Type',
    'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version',
    'Access-Control-Max-Age': '86400',
  });
  if (req.method === 'OPTIONS') res.status(204).end();
  else next();
};

/** The HTTP server for claude.ai custom connectors: OAuth + Streamable HTTP MCP endpoint. */
export function createRemoteApp(options: RemoteAppOptions): RemoteApp {
  const { config } = options;
  const mcpUrl = new URL('/mcp', config.publicUrl);
  const sealer = new Sealer(config.secret, config.previousSecret);
  const { version, fetch, allowPrivateNetwork } = options;
  const logger = options.logger ?? silentLogger;
  const clients = new ClientRegistry(sealer, new RedirectPolicy(config.allowedRedirectUris), {
    allowPrivateNetwork,
    fetchDocument: options.fetchClientMetadata,
  });
  const oauth = createOAuthServer({ config, sealer, clients, resource: mcpUrl, version, fetch, logger });
  const tooMany = (req: Request, res: Response) =>
    sendJsonError(req, res, 429, `Too many requests. Try again in ${res.get('Retry-After')} seconds.`);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(requestId, requestLogger(logger));
  // Ahead of the Host check: load balancers and orchestrators probe the container's own address.
  app.get('/healthz', (_req, res) => void res.json({ status: 'ok' }));
  // A loopback bind is usually reached through a tunnel, so accept the public hostname too.
  const allowedHosts =
    config.allowedHosts ??
    (LOOPBACK_BINDS.has(config.host) ? [config.publicUrl.hostname, ...LOOPBACK_HOSTNAMES] : undefined);
  if (allowedHosts) app.use(hostHeaderValidation(allowedHosts));

  const metadataOptions = {
    oauthMetadata: oauth.metadata,
    resourceServerUrl: mcpUrl,
    resourceName: 'LinkedIn',
    serviceDocumentationUrl: new URL(HOMEPAGE),
  };
  app.use(mcpAuthMetadataRouter(metadataOptions));
  const resourceMetadata = buildOAuthProtectedResourceMetadata(metadataOptions);
  app.get('/.well-known/oauth-protected-resource', (_req, res) => void res.set('Access-Control-Allow-Origin', '*').json(resourceMetadata));

  app.use(
    OAUTH_PATHS,
    rateLimit({ limit: config.oauthRateLimit, key: (req) => (req.method === 'OPTIONS' ? undefined : req.ip), reject: tooMany }),
    // OAuth clients don't compress these small bodies. Refusing compressed ones keeps decompression, and its bugs
    // (such as GHSA-27r3-jxmh-p828), out of reach of anyone who hasn't signed in.
    express.json({ limit: MAX_OAUTH_BODY, inflate: false }),
  );
  app.use(oauth.router);

  const handler = createMcpHandler(
    (ctx) => {
      const grant = grantFromAuthInfo(ctx.authInfo);
      return createConnectorServer({
        mode: 'remote',
        auth: new ConnectorAuth(grant),
        version,
        scopes: config.scopes,
        apiBaseUrl: config.apiBaseUrl,
        fetch,
        allowPrivateNetwork,
        // The audit trail: who called which tool and how it went. Never the arguments, which hold post text, nor
        // the error message, which can quote them.
        onToolCall: ({ tool, ok, durationMs, error }) =>
          logger(ok ? 'info' : 'warn', 'tool_call', {
            tool,
            ok,
            durationMs,
            member: grant?.sub,
            clientId: ctx.authInfo?.clientId,
            requestId: ctx.requestInfo?.headers.get('x-request-id') ?? undefined,
            error: ok ? undefined : errorKind(error),
          }),
      });
    },
    // Also reports requests the SDK rejected (bad protocol version and the like), hence warn.
    { onerror: (error) => logger('warn', 'mcp_error', { error }) },
  );
  const mcp = toNodeHandler(handler);
  const bearer = requireBearerAuth({
    verifier: oauth.verifier,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    expectedResource: mcpUrl,
  });
  const mcpLimit = rateLimit({
    limit: config.mcpRateLimit,
    key: ({ auth }) => auth && (grantFromAuthInfo(auth)?.sub ?? auth.clientId),
    reject: tooMany,
  });
  // Tool calls can carry base64 images, so allow large JSON bodies, but only from authenticated callers
  // within their rate limit: buffering 30 MB for anyone who asks would let strangers exhaust memory.
  const mcpBody = express.json({ limit: MAX_BODY });
  app.all('/mcp', mcpCors, bearer, mcpLimit, mcpBody, (req, res) => void mcp(req, res, req.body));

  app.get('/', (_req, res) =>
    sendPage(res, 200, 'LinkedIn connector for Claude', `<h1>LinkedIn connector for Claude</h1>
<p>This is an MCP server. In Claude, open <strong>Settings → Connectors → Add custom connector</strong> and enter:</p>
<p><code>${escapeHtml(mcpUrl.href)}</code></p>
<p><a href="${escapeHtml(HOMEPAGE)}">Documentation</a></p>`),
  );
  app.use(jsonErrors(logger));

  return { app, mcpUrl, close: () => handler.close() };
}
