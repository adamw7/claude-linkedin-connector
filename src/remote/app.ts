import express, { type Express, type RequestHandler } from 'express';
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
  const clients = new ClientRegistry(sealer, new RedirectPolicy(config.allowedRedirectUris), {
    ...(options.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
    ...(options.fetchClientMetadata ? { fetchDocument: options.fetchClientMetadata } : {}),
  });
  const oauth = createOAuthServer({
    config,
    sealer,
    clients,
    resource: mcpUrl,
    version: options.version,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const app = express();
  app.disable('x-powered-by');
  // A loopback bind is usually reached through a tunnel, so accept the public hostname too.
  const allowedHosts =
    config.allowedHosts ??
    (LOOPBACK_BINDS.has(config.host) ? [config.publicUrl.hostname, 'localhost', '127.0.0.1', '[::1]'] : undefined);
  if (allowedHosts) app.use(hostHeaderValidation(allowedHosts));
  // Tool calls can carry base64 images, so allow large JSON bodies.
  app.use(express.json({ limit: '30mb' }));

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
      version: options.version,
      scopes: config.scopes,
      apiBaseUrl: config.apiBaseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
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

  return { app, mcpUrl, close: () => handler.close() };
}
