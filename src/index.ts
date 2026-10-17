#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { LocalAuth } from './auth/local-auth.js';
import { loadLocalConfig, loadRemoteConfig } from './config.js';
import { ConfigError } from './errors.js';
import { ApiVersion } from './linkedin/versions.js';
import { createConnectorServer } from './mcp/server.js';
import { createRemoteApp } from './remote/app.js';
import { NAME, VERSION } from './version.js';

const HELP = `${NAME} ${VERSION} — LinkedIn connector (MCP server) for Claude

Usage: ${NAME} [command]

Commands:
  stdio     Run the MCP server over stdio (default). For Claude Desktop and Claude Code.
  http      Run the remote MCP server (Streamable HTTP + OAuth). For claude.ai custom connectors.
  login     Sign in to LinkedIn in your browser and store the token locally.
            Add --no-browser to print the link instead of opening it.
  logout    Delete the locally stored LinkedIn token.
  status    Show whether you are signed in to LinkedIn.
  help      Show this help.
  version   Show the version.

Configuration is read from environment variables; see the README:
  https://github.com/adamw7/claude-linkedin-connector#configuration`;

/** stdout belongs to the MCP protocol in stdio mode, so diagnostics go to stderr. */
function log(message: string): void {
  process.stderr.write(`[${NAME}] ${message}\n`);
}

function openBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The URL is printed as well, so the user can open it manually.
  }
}

function localSetup() {
  const config = loadLocalConfig();
  const version = new ApiVersion(config.apiVersion, undefined, log);
  return { config, version, auth: new LocalAuth({ config, version }) };
}

function runStdio(): void {
  const { config, version, auth } = localSetup();
  serveStdio(
    () => createConnectorServer({ mode: 'local', auth, version, scopes: config.scopes, apiBaseUrl: config.apiBaseUrl }),
    { onerror: (error) => log(`MCP error: ${error.message}`) },
  );
  // Exit with the client even if a sign-in listener is still waiting for the browser.
  process.stdin.once('close', () => setTimeout(() => process.exit(0), 100).unref());
}

function runHttp(): void {
  const config = loadRemoteConfig(process.env, log);
  const version = new ApiVersion(config.apiVersion, undefined, log);
  const { app, mcpUrl, close } = createRemoteApp({ config, version });
  const server = app.listen(config.port, config.host, (error?: Error) => {
    if (error) {
      log(`Could not start the HTTP server: ${error.message}`);
      process.exit(1);
    }
    log(`Listening on ${config.host}:${config.port}`);
    log(`MCP endpoint (add this URL to Claude): ${mcpUrl.href}`);
    log(`LinkedIn redirect URL (add it to your LinkedIn app): ${new URL('/oauth/callback', config.publicUrl).href}`);
  });
  const shutdown = () => {
    server.close();
    void close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function runLogin(args: string[]): Promise<void> {
  const { config, auth } = localSetup();
  if (config.accessToken) {
    log('Note: LINKEDIN_ACCESS_TOKEN is set and takes precedence over the token stored by this login.');
  }
  const name = await auth.loginAndWait((url) => {
    console.log(`Open this link to sign in to LinkedIn:\n\n  ${url}\n`);
    if (!args.includes('--no-browser')) openBrowser(url);
    console.log(`Waiting for LinkedIn to redirect to ${config.redirectUri} ...`);
  });
  console.log(`Signed in to LinkedIn${name ? ` as ${name}` : ''}. Token saved to ${auth.store.path}`);
}

async function runLogout(): Promise<void> {
  const { auth } = localSetup();
  const removed = await auth.logout();
  console.log(removed ? `Deleted ${auth.store.path}.` : 'No stored LinkedIn token found.');
}

async function runStatus(): Promise<void> {
  const { auth } = localSetup();
  const status = await auth.status();
  console.log(status.message);
  if (status.authenticated && status.scopes.length > 0) console.log(`Scopes: ${status.scopes.join(' ')}`);
  if (!status.authenticated) process.exitCode = 1;
}

async function main(argv: string[]): Promise<void> {
  const [command = 'stdio', ...rest] = argv;
  switch (command) {
    case 'stdio':
      return runStdio();
    case 'http':
      return runHttp();
    case 'login':
      return runLogin(rest);
    case 'logout':
      return runLogout();
    case 'status':
      return runStatus();
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      return;
    default:
      log(`Unknown command "${command}".\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  log(error instanceof ConfigError ? error.message : `Error: ${(error as Error).message ?? String(error)}`);
  process.exit(1);
});
