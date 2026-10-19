#!/usr/bin/env node
// Packs the npm package, installs it the way `npm install -g` does (production dependencies only) and runs the
// installed command against a fake LinkedIn on loopback: signing in from the terminal, an MCP session over stdio that
// publishes a post with an image, and the remote server's startup and shutdown. Catches what the tests, which run
// src/, can't: a file left out of "files", a runtime dependency listed under devDependencies, a broken bin.
//
// Usage: node scripts/smoke-test-package.mjs [package]   (after npm ci; Linux and macOS)
//   package: anything `npm pack` takes; default: this checkout. E.g. claude-linkedin-connector@0.3.0 tests a release.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const spec = process.argv[2];
const work = mkdtempSync(join(tmpdir(), 'package-smoke-'));
const MEMBER = { sub: 'smoke123', name: 'Ada Lovelace', email: 'ada@example.com', email_verified: true };
/** 1x1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const children = [];

class SmokeTestFailure extends Error {}
function check(ok, message, detail) {
  if (!ok) throw new SmokeTestFailure(detail === undefined ? message : `${message}\n${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}`);
}

function npm(args, cwd = work) {
  const env = { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
  const result = spawnSync('npm', args, { cwd, encoding: 'utf8', env });
  check(result.status === 0, `npm ${args.join(' ')} failed`, result.stderr);
  return result.stdout;
}

/** LinkedIn's OAuth, REST and upload endpoints, just enough for one sign-in and one post. Records every request. */
async function startFakeLinkedIn() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    requests.push({ method: req.method, path: decodeURIComponent(url.pathname), headers: req.headers, body });
    const json = (status, value, headers = {}) => res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(value));
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /oauth/v2/authorization') {
      // The member approves at once.
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', 'smoke-code');
      back.searchParams.set('state', url.searchParams.get('state'));
      return res.writeHead(302, { Location: back.href }).end();
    }
    if (route === 'POST /oauth/v2/accessToken') {
      const form = new URLSearchParams(body.toString());
      if (form.get('client_secret') !== 'smoke-secret' || form.get('code') !== 'smoke-code') return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: 'smoke-token', expires_in: 5_184_000, scope: 'email,openid,profile,w_member_social' });
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/upload/')) return res.writeHead(201).end();
    if (req.headers.authorization !== 'Bearer smoke-token') return json(401, { status: 401, message: 'Invalid access token' });
    if (route === 'GET /v2/userinfo') return json(200, MEMBER);
    if (route === 'POST /rest/images' && url.searchParams.get('action') === 'initializeUpload') {
      return json(200, { value: { uploadUrl: `${base}/upload/image`, image: 'urn:li:image:D4Esmoke' } });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/rest/images/')) return json(200, { status: 'AVAILABLE' });
    if (route === 'POST /rest/posts') return res.writeHead(201, { 'x-restli-id': 'urn:li:share:7000000000000000001' }).end();
    return json(404, { status: 404, message: `No route for ${route}` });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    requests,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  return port;
}

/** Resolves with the exit code, or undefined if the process is still running after `ms`. */
function exited(child, ms) {
  return Promise.race([once(child, 'exit').then(([code]) => code), new Promise((resolve) => setTimeout(resolve, ms).unref())]);
}

/** Runs the installed command; `onOutput` sees stdout as it arrives. */
function run(bin, args, env, onOutput) {
  const child = spawn(bin, args, { cwd: work, env });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    onOutput?.(stdout);
  });
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill(), 30_000);
  return once(child, 'close').then(([status]) => {
    clearTimeout(timer);
    return { status, stdout, stderr };
  });
}

async function main() {
  console.log(`Packs ${spec ?? ROOT}`);
  const [pack] = JSON.parse(npm(['pack', '--json', '--pack-destination', work, ...(spec ? [spec] : [])], spec ? process.cwd() : ROOT));
  const files = pack.files.map((file) => file.path);
  const stray = files.filter((path) => !path.startsWith('dist/') && !['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE'].includes(path));
  check(stray.length === 0, 'the package contains files outside dist/ besides the README, changelog and license', stray);
  check(files.includes('dist/index.js'), 'the package has no dist/index.js', files);
  const unmapped = files.filter((path) => path.endsWith('.js') && !files.includes(`${path}.map`));
  check(unmapped.length === 0, 'compiled files without a source map', unmapped);

  console.log(`Installs ${pack.filename} with production dependencies only`);
  const prefix = join(work, 'prefix');
  npm(['install', '--global', '--prefix', prefix, join(work, pack.filename)]);
  const installed = join(prefix, 'lib', 'node_modules', pack.name);
  const bin = join(prefix, 'bin', pack.name);
  const env = (extra = {}) => ({ PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(work, 'home'), XDG_CONFIG_HOME: join(work, 'home'), ...extra });
  const version = await run(bin, ['--version'], env());
  check(version.status === 0 && version.stdout.trim() === pack.version, `--version does not print ${pack.version}`, version);
  for (const map of readdirSync(join(installed, 'dist'), { recursive: true }).filter((path) => path.endsWith('.map'))) {
    const { sourcesContent = [] } = JSON.parse(readFileSync(join(installed, 'dist', map), 'utf8'));
    check(sourcesContent.length > 0 && sourcesContent.every(Boolean), `dist/${map} does not carry its sources`);
  }

  const linkedin = await startFakeLinkedIn();
  try {
    const folder = join(work, 'files');
    const photo = join(folder, 'photo.png');
    mkdirSync(folder);
    writeFileSync(photo, PNG);
    const local = env({
      LINKEDIN_CLIENT_ID: 'smoke-client',
      LINKEDIN_CLIENT_SECRET: 'smoke-secret',
      LINKEDIN_API_BASE_URL: linkedin.base,
      LINKEDIN_OAUTH_BASE_URL: linkedin.base,
      LINKEDIN_REDIRECT_URI: `http://localhost:${await freePort()}/callback`,
      LINKEDIN_FILE_DIRS: folder,
    });

    console.log('Signs in from the terminal');
    let approved = false;
    const login = await run(bin, ['login', '--no-browser'], local, (output) => {
      const link = /http\S+\/oauth\/v2\/authorization\S+/.exec(output)?.[0];
      if (link && !approved) {
        approved = true;
        fetch(link).catch(() => {});
      }
    });
    check(login.status === 0 && login.stdout.includes('Signed in to LinkedIn as Ada Lovelace.'), 'login --no-browser did not sign in', login);

    console.log('Publishes a post with an image over stdio');
    const transport = new StdioClientTransport({ command: bin, args: [], env: local, cwd: work, stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => (stderr += chunk));
    const client = new Client({ name: 'package-smoke-test', version: '1.0.0' });
    await client.connect(transport).catch((error) => check(false, `the MCP server did not start (${error.message})`, stderr));
    check(client.getServerVersion()?.version === pack.version, `the MCP server does not report version ${pack.version}`, client.getServerVersion());
    const { tools } = await client.listTools();
    check(tools.some((tool) => tool.name === 'linkedin_create_post'), 'linkedin_create_post is not offered', tools.map((tool) => tool.name));
    const result = await client.callTool({
      name: 'linkedin_create_post',
      arguments: { text: 'Smoke test (npm package)', images: [{ source: photo, altText: 'A pixel' }] },
    });
    check(result.structuredContent?.postUrn === 'urn:li:share:7000000000000000001', 'linkedin_create_post failed', { result, stderr });
    const upload = linkedin.requests.find((request) => request.method === 'PUT');
    check(upload && sha256(upload.body) === sha256(PNG), 'the image was not uploaded byte for byte');
    const post = JSON.parse(linkedin.requests.find((request) => request.method === 'POST' && request.path === '/rest/posts')?.body ?? '{}');
    check(
      post.author === `urn:li:person:${MEMBER.sub}` && post.commentary === 'Smoke test \\(npm package\\)' && post.content?.media?.id === 'urn:li:image:D4Esmoke',
      'LinkedIn received an unexpected post',
      post,
    );
    await client.close();

    const logout = await run(bin, ['logout'], local);
    check(logout.status === 0 && logout.stdout.startsWith('Deleted '), 'logout did not delete the token', logout);

    console.log('Starts the remote server, serves OAuth metadata and shuts down on SIGTERM');
    const port = await freePort();
    const publicUrl = `http://127.0.0.1:${port}`;
    const server = spawn(bin, ['http'], { cwd: work, env: { ...local, PUBLIC_URL: publicUrl, PORT: String(port), LINKEDIN_ALLOWED_MEMBERS: '*' } });
    children.push(server);
    let logs = '';
    server.stderr.on('data', (chunk) => (logs += chunk));
    for (let i = 0; i < 100 && !logs.includes('"event":"listening"'); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    check(logs.includes('"event":"listening"'), 'the remote server did not start', logs);
    const metadata = await (await fetch(`${publicUrl}/.well-known/oauth-authorization-server`)).json();
    check(metadata.issuer === publicUrl, 'unexpected authorization server metadata', metadata);
    const mcp = await fetch(`${publicUrl}/mcp`);
    check(mcp.status === 401, `/mcp answered ${mcp.status} without a token instead of 401`);
    server.kill('SIGTERM');
    const code = await exited(server, 15_000);
    check(code === 0 && logs.includes('"event":"shutting_down"'), `exited with ${code} on SIGTERM`, logs);
  } finally {
    linkedin.close();
  }
  console.log(`Smoke test passed for ${pack.name}@${pack.version}`);
}

try {
  await main();
} catch (error) {
  console.error(`::error::${error instanceof SmokeTestFailure ? error.message : error.stack}`);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  rmSync(work, { recursive: true, force: true });
}
