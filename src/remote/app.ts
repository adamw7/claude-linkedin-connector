import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
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
import { createConnectorServer } from '../mcp/server.js';
import { HOMEPAGE } from '../version.js';
import { ClientRegistry, RedirectPolicy } from './clients.js';
import { ConnectorAuth, grantFromAuthInfo } from './connector-auth.js';
import { Sealer } from './crypto.js';
import { createOAuthServer } from './oauth-server.js';
import { sendPage } from './pages.js';

export interface RemoteAppOptions {
  config: RemoteConfig;
  version: ApiVersion;
  /** Used for LinkedIn API and OAuth calls (tests). */
  fetch?: typeof globalThis.fetch;
  /** Permit fetching media and client metadata from private networks (tests only). */
  allowPrivateNetwork?: boolean;
  /** Overrides how Client ID Metadata Documents are fetched (tests). */
  fetchClientMetadata?: (url: string) => Promise<string>;
}

export interface RemoteApp {
  app: Express;
  /** The MCP endpoint URL to add to Claude. */
  mcpUrl: URL;
  close: () => Promise<void>;
}

const LOOPBACK_BINDS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Request bodies above this are rejected; base64 inflates media by a third, so data: URIs top out around 20 MB. */
const MAX_BODY = '30mb';

/**
 * Answers body-parser failures (and anything else unhandled) with JSON instead
 * of Express's HTML page, which MCP clients show verbatim and which includes a
 * stack trace outside production.
 */
const jsonErrors: ErrorRequestHandler = (error: { status?: number; type?: string }, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const status = typeof error.status === 'number' && error.status >= 400 && error.status < 600 ? error.status : 500;
  const message =
    error.type === 'entity.too.large'
      ? `The request is larger than ${MAX_BODY.toUpperCase()}. Pass large images or documents as an http(s) URL instead of a data: URI.`
      : error.type === 'entity.parse.failed'
        ? 'The request body is not valid JSON.'
        : status < 500
          ? 'The request could not be processed.'
          : 'Internal server error.';
  if (req.path === '/mcp') {
    res.status(status).json({ jsonrpc: '2.0', error: { code: status < 500 ? -32600 : -32603, message }, id: null });
  } else {
    res.status(status).json({ error: status < 500 ? 'invalid_request' : 'server_error', error_description: message });
  }
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
  const sealer = new Sealer(config.secret);
  const { version, fetch, allowPrivateNetwork } = options;
  const clients = new ClientRegistry(sealer, new RedirectPolicy(config.allowedRedirectUris), {
    allowPrivateNetwork,
    fetchDocument: options.fetchClientMetadata,
  });
  const oauth = createOAuthServer({ config, sealer, clients, resource: mcpUrl, version, fetch });

  const app = express();
  app.disable('x-powered-by');
  // A loopback bind is usually reached through a tunnel, so accept the public hostname too.
  const allowedHosts =
    config.allowedHosts ??
    (LOOPBACK_BINDS.has(config.host) ? [config.publicUrl.hostname, 'localhost', '127.0.0.1', '[::1]'] : undefined);
  if (allowedHosts) app.use(hostHeaderValidation(allowedHosts));
  // Tool calls can carry base64 images, so allow large JSON bodies.
  app.use(express.json({ limit: MAX_BODY }));

  const metadataOptions = {
    oauthMetadata: oauth.metadata,
    resourceServerUrl: mcpUrl,
    resourceName: 'LinkedIn',
    serviceDocumentationUrl: new URL(HOMEPAGE),
  };
  app.use(mcpAuthMetadataRouter(metadataOptions));
  const resourceMetadata = buildOAuthProtectedResourceMetadata(metadataOptions);
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*').json(resourceMetadata);
  });

  app.use(oauth.router);

  const handler = createMcpHandler((ctx) =>
    createConnectorServer({
      mode: 'remote',
      auth: new ConnectorAuth(grantFromAuthInfo(ctx.authInfo)),
      version,
      scopes: config.scopes,
      apiBaseUrl: config.apiBaseUrl,
      fetch,
      allowPrivateNetwork,
    }),
  );
  const mcp = toNodeHandler(handler);
  const bearer = requireBearerAuth({
    verifier: oauth.verifier,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    expectedResource: mcpUrl,
  });
  app.all('/mcp', mcpCors, bearer, (req, res) => void mcp(req, res, req.body));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/', (_req, res) => {
    sendPage(
      res,
      200,
      'LinkedIn connector for Claude',
      `<h1>LinkedIn connector for Claude</h1>
<p>This is an MCP server. In Claude, open <strong>Settings → Connectors → Add custom connector</strong> and enter:</p>
<p><code>${escapeHtml(mcpUrl.href)}</code></p>
<p><a href="${escapeHtml(HOMEPAGE)}">Documentation</a></p>`,
    );
  });
  app.use(jsonErrors);

  return { app, mcpUrl, close: () => handler.close() };
}
