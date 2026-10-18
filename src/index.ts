#!/usr/bin/env node
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { LocalAuth } from './auth/local-auth.js';
import { openBrowser } from './auth/open-browser.js';
import { PostHistory } from './auth/post-history.js';
import { loadLocalConfig, loadRemoteConfig } from './config.js';
import { ConfigError } from './errors.js';
import { ApiVersion } from './linkedin/versions.js';
import { createConnectorServer } from './mcp/server.js';
import { createRemoteApp } from './remote/app.js';
import { jsonLogger } from './remote/logger.js';
import { drainServer } from './remote/shutdown.js';
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

function usageError(message: string): void {
  log(`${message}\n\n${HELP}`);
  process.exitCode = 2;
}

function localSetup(browser = true) {
  const config = loadLocalConfig();
  const version = new ApiVersion(config.apiVersion, undefined, log);
  return { config, version, auth: new LocalAuth({ config, version, ...(browser ? { openBrowser } : {}) }) };
}

function runStdio(): void {
  const { config, version, auth } = localSetup();
  if (process.stdin.isTTY) {
    log(`Waiting for MCP messages on stdin. Claude starts this server itself: press Ctrl+C to quit, or run "${NAME} help" for the other commands.`);
  }
  serveStdio(
    () =>
      createConnectorServer({
        mode: 'local',
        auth,
        version,
        scopes: config.scopes,
        apiBaseUrl: config.apiBaseUrl,
        localFileDirs: config.fileDirs,
        history: new PostHistory(config.postHistoryFile),
      }),
    { onerror: (error) => log(`MCP error: ${error.message}`) },
  );
  // Exit with the client even if a sign-in listener is still waiting for the browser.
  process.stdin.once('close', () => setTimeout(() => process.exit(0), 100).unref());
}

/** The HTTP server logs JSON lines to stderr, for log collectors. */
function runHttp(): void {
  const logger = jsonLogger();
  const warn = (message: string) => logger('warn', 'warning', { message });
  const config = loadRemoteConfig(process.env, warn);
  const version = new ApiVersion(config.apiVersion, undefined, warn);
  const { app, mcpUrl, close } = createRemoteApp({ config, version, logger });
  const server = app.listen(config.port, config.host, (error?: Error) => {
    if (error) {
      logger('error', 'listen_failed', { error });
      process.exit(1);
    }
    logger('info', 'listening', {
      version: VERSION,
      address: `${config.host}:${config.port}`,
      mcpUrl: mcpUrl.href,
      linkedInRedirectUrl: new URL('/oauth/callback', config.publicUrl).href,
      allowedMembers: config.allowedMembers.includes('*') ? 'anyone' : config.allowedMembers.length,
    });
  });
  // Outlast the idle timeout of a load balancer in front, which otherwise reuses a connection just as the server
  // closes it and answers 502 (Node's default is 5 seconds; AWS load balancers keep connections for 60).
  server.keepAliveTimeout = config.keepAliveTimeoutMs;
  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger('info', 'shutting_down', { signal });
    void drainServer(server, close, config.shutdownTimeoutMs, logger).then((clean) => process.exit(clean ? 0 : 1));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.on('uncaughtException', (error) => {
    logger('error', 'uncaught_exception', { error });
    process.exit(1);
  });
  process.on('unhandledRejection', (error) => logger('error', 'unhandled_rejection', { error }));
}

async function runLogin(browser: boolean): Promise<void> {
  const { config, auth } = localSetup(browser);
  if (config.accessToken) {
    log('Note: LINKEDIN_ACCESS_TOKEN is set and takes precedence over the token stored by this login.');
  }
  const name = await auth.loginAndWait((url) => {
    console.log(`Open this link to sign in to LinkedIn:\n\n  ${url}\n`);
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
  // Non-zero whenever signing in would help, so `npm run setup` signs in again after scopes were added.
  if (!status.authenticated || status.missingScopes) process.exitCode = 1;
}

interface Command {
  /** The options it takes besides --help, which shows the help instead of running it. Anything else is an error. */
  options?: ParseArgsOptionsConfig;
  run: (values: Record<string, unknown>) => void | Promise<void>;
}

const COMMANDS = new Map<string, Command>([
  ['stdio', { run: runStdio }],
  ['http', { run: runHttp }],
  ['login', { options: { 'no-browser': { type: 'boolean' } }, run: (values) => runLogin(!values['no-browser']) }],
  ['logout', { run: runLogout }],
  ['status', { run: runStatus }],
]);

async function main(argv: string[]): Promise<void> {
  const [command = 'stdio', ...rest] = argv;
  if (['help', '--help', '-h'].includes(command)) return console.log(HELP);
  if (['version', '--version', '-v'].includes(command)) return console.log(VERSION);
  const entry = COMMANDS.get(command);
  if (!entry) return usageError(`Unknown command "${command}".`);
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({ args: rest, options: { ...entry.options, help: { type: 'boolean', short: 'h' } } }));
  } catch (error) {
    // The first sentence names the problem; the rest is about positional arguments starting with "-".
    return usageError(`${command}: ${(error as Error).message.split('. ')[0]}.`);
  }
  return values.help ? console.log(HELP) : entry.run(values);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  log(error instanceof ConfigError ? error.message : `Error: ${(error as Error).message ?? String(error)}`);
  process.exit(1);
});
