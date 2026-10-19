#!/usr/bin/env node
// Builds the connector, registers it with Claude Code and signs in to LinkedIn, in one command:
//   node scripts/setup-claude-code.mjs        (or: npm run setup)
// Uses only Node built-ins, so it runs before `npm ci`.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENTRY = join(ROOT, 'dist', 'index.js');
const DEFAULT_SCOPES = 'openid profile email w_member_social';
/** The scopes --comments and --pages add, as LINKEDIN_COMMENTS and LINKEDIN_PAGES do (src/linkedin/scopes.ts). */
const FEATURE_SCOPES = { comments: 'w_member_social_feed', pages: 'w_organization_social' };
const IS_WINDOWS = process.platform === 'win32';
/** How to run this script again with options, for messages. */
const SETUP = process.env.npm_lifecycle_event ? 'npm run setup --' : 'node scripts/setup-claude-code.mjs';

const HELP = `Sets up the LinkedIn connector in Claude Code.

Usage: node scripts/setup-claude-code.mjs [options]     (or: npm run setup -- [options])

Steps: installs dependencies and builds dist/, registers the MCP server with \`claude mcp add\`,
then signs you in to LinkedIn in your browser.

Options:
  --client-id <id>         LinkedIn app Client ID (default: $LINKEDIN_CLIENT_ID, else asks)
  --client-secret <secret> LinkedIn app Client Secret (default: $LINKEDIN_CLIENT_SECRET, else asks)
  --comments               Let Claude comment on and react to posts (needs the Community Management API)
  --pages                  Let Claude act as LinkedIn Pages you administer (needs the Community Management API)
  --scopes <scopes>        LinkedIn permissions (default: $LINKEDIN_SCOPES, else "${DEFAULT_SCOPES}")
  --scope <user|local>     Claude Code config scope: user = every project (default), local = this clone only
  --name <name>            MCP server name (default: linkedin)
  --yes, -y                Replace an existing server with the same name without asking
  --skip-build             Use the existing dist/ instead of running npm
  --no-login               Don't sign in to LinkedIn now
  --help, -h               Show this help

Before running it, create a LinkedIn app with http://localhost:8723/callback as a redirect URL; see the README.`;

class SetupError extends Error {}

function step(message) {
  console.log(`\n==> ${message}`);
}

// Windows can only run npm.cmd / claude.cmd through cmd.exe, which has its own quoting rules on top of the
// usual ones; this follows cross-spawn. Executables (node.exe, a native claude.exe) are spawned directly.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function cmdArgument(arg) {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  // Escaped once for cmd.exe /c and once more for the batch file it runs.
  return quoted.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}

/** Resolves a command on the PATH to the file Windows would run, e.g. C:\...\npm.cmd. */
function whereIs(command) {
  const result = spawnSync('where', [command], { encoding: 'utf8', windowsHide: true });
  // `where` also lists npm's extensionless shell-script shims, which Windows can't run.
  return result.stdout
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /\.(exe|cmd|bat|com)$/i.test(line));
}

function spawnArgs(command, args) {
  if (!IS_WINDOWS) return [command, args, {}];
  const file = /[\\/]/.test(command) ? command : whereIs(command);
  if (!file) return [command, args, {}]; // fails with ENOENT below
  if (!/\.(cmd|bat)$/i.test(file)) return [file, args, {}];
  const line = [file.replace(CMD_META, '^$1'), ...args.map(cmdArgument)].join(' ');
  return [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { windowsVerbatimArguments: true }];
}

function run(command, args, { env, quiet = false } = {}) {
  const [file, fileArgs, extra] = spawnArgs(command, args);
  const result = spawnSync(file, fileArgs, {
    cwd: ROOT,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
    ...extra,
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') throw new SetupError(`\`${command}\` was not found on your PATH.`);
    throw result.error;
  }
  return result;
}

function runOrFail(command, args, options) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    const output = options?.quiet ? `\n${(result.stderr || result.stdout).trim()}` : '';
    throw new SetupError(`\`${command} ${args[0]}\` failed (exit code ${result.status}).${output}`);
  }
  return result;
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Reads a line from the terminal without echoing it. */
function askSecret(question) {
  process.stdout.write(question);
  const { stdin } = process;
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve, reject) => {
    let answer = '';
    const done = (error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(answer.trim());
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return done();
        if (char === '\u0003' || char === '\u0004') return done(new SetupError('Cancelled.'));
        if (char === '\u007f' || char === '\b') answer = answer.slice(0, -1);
        else if (char >= ' ') answer += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function confirm(question) {
  return /^y(es)?$/i.test(await ask(`${question} [y/N] `));
}

// Without `--`, `npm run setup --scope local` hands the options to npm, which keeps them as its own config
// (npm_config_*) and runs this script without them. `--yes` isn't checked: npm_config_yes may come from .npmrc.
const NPM_CONFIG_OPTIONS = {
  client_id: '--client-id',
  client_secret: '--client-secret',
  scopes: '--scopes',
  comments: '--comments',
  pages: '--pages',
  scope: '--scope',
  name: '--name',
  skip_build: '--skip-build',
  login: '--no-login',
};

function checkOptionsReachedSetup(env) {
  if (!env.npm_lifecycle_event) return;
  const kept = Object.entries(NPM_CONFIG_OPTIONS)
    .filter(([key]) => env[`npm_config_${key}`] !== undefined)
    // An npm scope (@org, e.g. from .npmrc) is npm's own; only a Claude Code scope was meant for setup.
    .filter(([key]) => key !== 'scope' || ['user', 'local', 'project'].includes(env.npm_config_scope))
    .map(([, option]) => option);
  if (kept.length > 0) {
    throw new SetupError(
      `npm kept ${kept.join(', ')} for itself instead of passing ${kept.length > 1 ? 'them' : 'it'} to setup. ` +
        'Put -- before the setup options: npm run setup -- <options>',
    );
  }
}

function parseOptions() {
  try {
    return parseArgs({
      options: {
        'client-id': { type: 'string' },
        'client-secret': { type: 'string' },
        scopes: { type: 'string' },
        comments: { type: 'boolean', default: false },
        pages: { type: 'boolean', default: false },
        scope: { type: 'string', default: 'user' },
        name: { type: 'string', default: 'linkedin' },
        yes: { type: 'boolean', short: 'y', default: false },
        'skip-build': { type: 'boolean', default: false },
        'no-login': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }).values;
  } catch (error) {
    // The first sentence names the problem; the rest is about positional arguments starting with "-".
    throw new SetupError(`${error.message.split('. ')[0]}. Run "${SETUP} --help" to see the options.`);
  }
}

async function main() {
  checkOptionsReachedSetup(process.env);
  const options = parseOptions();
  if (options.help) {
    console.log(HELP);
    return;
  }
  // Project scope would write the Client Secret into .mcp.json, which is meant to be committed.
  if (!['user', 'local'].includes(options.scope)) {
    const hint = options.scope === 'project' ? '' : ' LinkedIn permissions go in --scopes.';
    throw new SetupError(`--scope must be "user" or "local", not "${options.scope}".${hint}`);
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) throw new SetupError(`Node.js 24 or later is required; you have ${process.versions.node}.`);
  if (run('claude', ['--version'], { quiet: true }).status !== 0) {
    throw new SetupError('`claude --version` failed. Is Claude Code installed?');
  }

  const interactive = Boolean(process.stdin.isTTY);
  const value = async (option, envName, question, secret) => {
    const given = options[option] ?? process.env[envName];
    if (given) return given;
    if (!interactive) throw new SetupError(`Pass --${option} or set ${envName}.`);
    const answer = secret ? await askSecret(question) : await ask(question);
    if (!answer) throw new SetupError(`A ${question.replace(/:\s*$/, '')} is required.`);
    return answer;
  };
  console.log('LinkedIn app credentials are on the Auth tab of https://www.linkedin.com/developers/apps');
  const clientId = await value('client-id', 'LINKEDIN_CLIENT_ID', 'LinkedIn Client ID: ', false);
  const clientSecret = await value('client-secret', 'LINKEDIN_CLIENT_SECRET', 'LinkedIn Client Secret: ', true);
  const scopes = [(options.scopes ?? process.env.LINKEDIN_SCOPES ?? DEFAULT_SCOPES).trim()];
  for (const [feature, scope] of Object.entries(FEATURE_SCOPES)) {
    if (options[feature] && !scopes[0].split(/[\s,]+/).includes(scope)) scopes.push(scope);
  }
  const env = { LINKEDIN_CLIENT_ID: clientId, LINKEDIN_CLIENT_SECRET: clientSecret, LINKEDIN_SCOPES: scopes.join(' ') };

  if (options['skip-build']) {
    if (!existsSync(ENTRY)) throw new SetupError(`${ENTRY} doesn't exist; run without --skip-build.`);
  } else if (existsSync(join(ROOT, 'node_modules'))) {
    step('Building');
    runOrFail('npm', ['run', 'build']);
  } else {
    step('Installing dependencies and building');
    runOrFail('npm', ['ci']);
  }

  step(`Registering "${options.name}" with Claude Code (${options.scope} scope)`);
  if (run('claude', ['mcp', 'get', options.name], { quiet: true }).status === 0) {
    const replace = options.yes || (interactive && (await confirm(`A server named "${options.name}" already exists. Replace it?`)));
    if (!replace) {
      throw new SetupError(`"${options.name}" already exists. Run "${SETUP} --yes" to replace it, or pick another name with --name.`);
    }
    // Remove it from both scopes, so Claude Code doesn't end up with two servers of the same name.
    for (const scope of ['user', 'local']) run('claude', ['mcp', 'remove', options.name, '--scope', scope], { quiet: true });
  }
  const server = { type: 'stdio', command: process.execPath, args: [ENTRY], env };
  runOrFail('claude', ['mcp', 'add-json', options.name, JSON.stringify(server), '--scope', options.scope], {
    quiet: true,
  });
  console.log(`Added. \`claude mcp get ${options.name}\` shows it.`);

  if (options['no-login']) {
    console.log('\nDone. In Claude Code, ask Claude to "connect my LinkedIn account" to sign in.');
    return;
  }
  step('Signing in to LinkedIn');
  if (run(process.execPath, [ENTRY, 'status'], { env, quiet: true }).status === 0) {
    console.log('Already signed in.');
  } else if (run(process.execPath, [ENTRY, 'login'], { env }).status !== 0) {
    throw new SetupError(
      `Signing in to LinkedIn failed (see above). "${options.name}" is registered with Claude Code: once the problem is fixed, ` +
        `run "${SETUP} --yes" again, or ask Claude to "connect my LinkedIn account".`,
    );
  }
  console.log('\nDone. Start `claude` and ask it to, for example, "show my LinkedIn profile".');
}

main().catch((error) => {
  console.error(`\nSetup failed: ${error instanceof SetupError ? error.message : (error?.stack ?? error)}`);
  process.exitCode = 1;
});
