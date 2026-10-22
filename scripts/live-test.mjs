#!/usr/bin/env node
// Runs the built connector against the real LinkedIn API, which the tests and smoke tests never reach (they use a
// fake LinkedIn): LinkedIn's error responses, the API version the connector sends and its fallback when LinkedIn has
// retired it, uploads and their processing, publishing, editing and deleting posts through the MCP tools, and the
// remote server's sign-in. Without options it changes nothing on LinkedIn; see HELP below for the options that do.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { crc32, deflateSync } from 'node:zlib';
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENTRY = join(ROOT, 'dist', 'index.js');
const HELP = `Runs the built connector against the real LinkedIn API.

Usage: npm run build && node scripts/live-test.mjs [options]

Without options it changes nothing on LinkedIn. It signs in with LINKEDIN_ACCESS_TOKEN (a token from the OAuth 2.0
tools of your app in the LinkedIn developer portal) or the token \`claude-linkedin-connector login\` stored; without
either, only the checks that need no sign-in run.

Options:
  --login      sign in through the browser first (needs LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET); the token is
               kept in a temporary folder, apart from yours
  --upload     also upload an image and a document without posting them, which nobody sees
  --publish    also publish test posts visible to your connections (text, images, a document, a link), edit and
               delete them
  --comments   with --publish: comment on and react to a test post (needs the Community Management API)
  --page <id>  with --publish: also post as the Page with this organization ID (needs the Community Management API)
  --keep       with --publish: leave the test posts on LinkedIn to see how they came out; delete them yourself
  --remote     also connect to the remote server (\`http\`) the way Claude does, through its consent screen and
               LinkedIn's, in your browser (needs LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET and
               http://localhost:3000/oauth/callback, or PORT's, among your app's redirect URLs)

Behind a proxy, set NODE_USE_ENV_PROXY=1 so that Node sends its requests through HTTPS_PROXY.`;

let options;
try {
  ({ values: options } = parseArgs({
    options: {
      login: { type: 'boolean', default: false },
      upload: { type: 'boolean', default: false },
      publish: { type: 'boolean', default: false },
      comments: { type: 'boolean', default: false },
      page: { type: 'string' },
      keep: { type: 'boolean', default: false },
      remote: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }));
} catch (error) {
  console.error(`${error.message}\n\n${HELP}`);
  process.exit(2);
}
if (options.help) {
  console.log(HELP);
  process.exit(0);
}
if ((options.comments || options.page || options.keep) && !options.publish) {
  console.error('--comments, --page and --keep are about test posts: add --publish.');
  process.exit(2);
}
if (!existsSync(ENTRY)) {
  console.error(`${ENTRY} doesn't exist: run npm run build first.`);
  process.exit(2);
}

// The connector's own code, so that what runs here is what users run.
const { openBrowser } = await import('../dist/auth/open-browser.js');
const { TokenStore, defaultTokenFile } = await import('../dist/auth/token-store.js');
const { LinkedInApiError, LinkedInOAuthError } = await import('../dist/errors.js');
const { LINKEDIN_API_BASE, LinkedInClient } = await import('../dist/linkedin/client.js');
const { exchangeAuthorizationCode, LINKEDIN_OAUTH_BASE } = await import('../dist/linkedin/oauth.js');
const { ApiVersion, DEFAULT_API_VERSION } = await import('../dist/linkedin/versions.js');
const { describeError } = await import('../dist/mcp/errors.js');
const { requireModernTls } = await import('../dist/net/tls.js');

requireModernTls();
const apiBase = process.env.LINKEDIN_API_BASE_URL || LINKEDIN_API_BASE;
const oauthBase = process.env.LINKEDIN_OAUTH_BASE_URL || LINKEDIN_OAUTH_BASE;
/** A LinkedIn-Version that doesn't exist yet. */
const FUTURE_VERSION = `${new Date().getUTCFullYear() + 2}01`;
const INVALID_TOKEN = 'live-test-invalid-token';
const work = mkdtempSync(join(tmpdir(), 'linkedin-live-'));
/** The connector's environment: the test's token and post history (posts.json, next to it) stay apart from yours. */
const connectorEnv = { ...process.env, LINKEDIN_TOKEN_FILE: join(work, 'token.json'), LINKEDIN_FILE_DIRS: work };
delete connectorEnv.LINKEDIN_ACCESS_TOKEN;
if (options.comments) connectorEnv.LINKEDIN_COMMENTS = 'true';
if (options.page) connectorEnv.LINKEDIN_PAGES = 'true';

// ------------------------------------------------------------------ results

const results = [];
class Failure extends Error {}
class Skipped extends Error {}
let notes = [];
const note = (text) => notes.push(text);
const skip = (reason) => {
  throw new Skipped(reason);
};
function check(ok, message, detail) {
  if (!ok) throw new Failure(detail === undefined ? message : `${message}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

async function step(name, run) {
  notes = [];
  let outcome = 'PASS';
  let detail;
  try {
    await run();
  } catch (error) {
    outcome = error instanceof Skipped ? 'SKIP' : 'FAIL';
    detail = error instanceof Failure || error instanceof Skipped ? error.message : explain(error);
  }
  results.push(outcome);
  console.log(`${outcome}  ${name}`);
  for (const line of [...(detail ? [detail] : []), ...notes]) console.log(`      ${line.replace(/\n/g, '\n      ')}`);
}

// ------------------------------------------------------------------ helpers

/**
 * An unexpected error: a network failure's reasons (fetch only says "fetch failed", and a proxy's refusal comes two
 * causes down, under "Request was cancelled."), otherwise its stack.
 */
function explain(error) {
  if (error instanceof TypeError && error.message === 'fetch failed' && error.cause) {
    const reasons = [];
    for (let cause = error.cause; cause && reasons.length < 5; cause = cause.cause) {
      reasons.push([typeof cause.code === 'string' ? cause.code : undefined, cause.message].filter(Boolean).join(' '));
    }
    return `Could not reach LinkedIn: ${reasons.join(' <- ')}`;
  }
  return error?.stack ?? String(error);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** What LinkedIn answered, in one line, for the report. */
async function summarize(response) {
  const text = (await response.text()).replace(/\s+/g, ' ').trim();
  return `HTTP ${response.status}${text ? ` ${text.slice(0, 200)}` : ''}`;
}
function versioned(path, version, token) {
  return fetch(apiBase + path, { headers: { Authorization: `Bearer ${token}`, 'LinkedIn-Version': version, 'X-Restli-Protocol-Version': '2.0.0' } });
}

/** The built connector over stdio, as Claude runs it. */
async function connect(env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => (stderr += chunk));
  const client = new Client({ name: 'live-test', version: '1.0.0' });
  await client.connect(transport);
  return {
    stderr: () => stderr,
    close: () => client.close(),
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args }, { timeout: 120_000 });
      const text = (result.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
      return { ...result, text };
    },
  };
}

/** A solid-colour PNG, made here so the test needs no image files. */
function png(width, height, rgb) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width * 3 }, (_, i) => rgb[i % 3]))]);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

/** A PDF with one line of text on each page. */
function pdf(pages) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [i, text] of pages.entries()) {
    const stream = `BT /F1 32 Tf 60 180 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 720 405] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let out = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = out.length;
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ------------------------------------------------------------------ the checks

async function main() {
  console.log(`Live test of ${ENTRY} against ${apiBase} (API version ${DEFAULT_API_VERSION})`);
  if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
    console.log('Note: HTTPS_PROXY is set but NODE_USE_ENV_PROXY is not, so Node connects directly. Set NODE_USE_ENV_PROXY=1 to use the proxy.');
  }
  console.log('');

  // ---------------------------------------------------------------- no sign-in needed

  await step("LinkedIn's token endpoint refuses made-up app credentials in the format the connector reads", async () => {
    const form = { grant_type: 'authorization_code', code: 'not-a-code', redirect_uri: 'http://localhost:8723/callback', client_id: 'live-test-unknown-app', client_secret: 'not-a-secret' };
    note(`POST /oauth/v2/accessToken: ${await summarize(await fetch(`${oauthBase}/oauth/v2/accessToken`, { method: 'POST', body: new URLSearchParams(form) }))}`);
    const error = await exchangeAuthorizationCode(
      { clientId: 'live-test-unknown-app', clientSecret: 'not-a-secret', scopes: ['openid'], oauthBaseUrl: oauthBase },
      'not-a-code',
      'http://localhost:8723/callback',
    ).then(() => undefined, (cause) => cause);
    check(error instanceof LinkedInOAuthError, 'it did not answer with an OAuth error', error?.message ?? 'it issued a token');
    check(!error.error.startsWith('http_'), 'its answer has no "error" field', error.message);
    note(`The connector says: ${describeError(error, 'local')}`);
  });

  await step('A token LinkedIn rejects gets the "expired or been revoked" message', async () => {
    note(`GET /v2/userinfo with an invalid token: ${await summarize(await fetch(`${apiBase}/v2/userinfo`, { headers: { Authorization: `Bearer ${INVALID_TOKEN}` } }))}`);
    const connector = await connect({ ...connectorEnv, LINKEDIN_ACCESS_TOKEN: INVALID_TOKEN });
    try {
      const result = await connector.call('linkedin_get_profile');
      const expected = 'LinkedIn rejected the access token in LINKEDIN_ACCESS_TOKEN (it has expired or been revoked).';
      check(result.isError === true && result.text.startsWith(expected), 'unexpected answer', result.text);
    } finally {
      await connector.close();
    }
  });

  await step(`LinkedIn answers a LinkedIn-Version it doesn't have with 426, before looking at the token`, async () => {
    const future = await versioned('/rest/posts?q=author&author=urn%3Ali%3Aperson%3Ax&count=1', FUTURE_VERSION, INVALID_TOKEN);
    const current = await versioned('/rest/posts?q=author&author=urn%3Ali%3Aperson%3Ax&count=1', DEFAULT_API_VERSION, INVALID_TOKEN);
    const futureStatus = future.status;
    note(`Version ${FUTURE_VERSION}: ${await summarize(future)}`);
    note(`Version ${DEFAULT_API_VERSION}: ${await summarize(current)}`);
    if (futureStatus !== 426) skip('LinkedIn checks the token first, so this needs a sign-in (see the version checks below).');
    check(current.status !== 426, `LinkedIn no longer accepts ${DEFAULT_API_VERSION}, the connector's default`);
  });

  // ---------------------------------------------------------------- signed in, read-only

  let token;
  let source;
  if (options.login) {
    console.log('\nSigning in through the browser (the token goes to a temporary folder)...');
    const code = await new Promise((resolve) => spawn(process.execPath, [ENTRY, 'login'], { env: connectorEnv, stdio: 'inherit' }).on('exit', resolve));
    token = (await new TokenStore(connectorEnv.LINKEDIN_TOKEN_FILE).read())?.accessToken;
    if (code !== 0 || !token) throw new Failure('Signing in failed (see above).');
    source = 'the browser sign-in';
  } else if (process.env.LINKEDIN_ACCESS_TOKEN) {
    token = process.env.LINKEDIN_ACCESS_TOKEN.trim();
    source = 'LINKEDIN_ACCESS_TOKEN';
  } else {
    const file = process.env.LINKEDIN_TOKEN_FILE || defaultTokenFile();
    const stored = await new TokenStore(file).read();
    if (stored?.expiresAt !== undefined && stored.expiresAt <= Date.now()) {
      console.log(`\nThe sign-in stored in ${file} has expired: sign in again, or set LINKEDIN_ACCESS_TOKEN.`);
    } else if (stored) {
      token = stored.accessToken;
      source = file;
    }
  }
  if (!token) {
    console.log('\nNo sign-in: set LINKEDIN_ACCESS_TOKEN, run "claude-linkedin-connector login", or pass --login for the checks that need one.');
    return;
  }
  console.log(`\nSigned in with ${source}.`);
  // The connector reads the token from LINKEDIN_ACCESS_TOKEN, except after --login, where it uses the stored one.
  const env = options.login ? connectorEnv : { ...connectorEnv, LINKEDIN_ACCESS_TOKEN: token };
  const connector = await connect(env);
  const created = [];
  try {
    let memberUrn;
    await step('The connector reads your profile', async () => {
      const status = await connector.call('linkedin_auth_status');
      check(status.structuredContent?.authenticated === true, 'linkedin_auth_status', status.text);
      const profile = await connector.call('linkedin_get_profile');
      check(!profile.isError, 'linkedin_get_profile failed', profile.text);
      const { memberUrn: urn, name, email, locale } = profile.structuredContent;
      check(/^urn:li:person:[\w-]+$/.test(urn), 'unexpected member URN', urn);
      memberUrn = urn;
      note(`${name ?? '(no name: the token lacks the profile scope)'}, ${urn}; email ${email ? 'present' : 'absent'}; locale ${locale ?? 'absent'}`);
    });
    if (!memberUrn) return;

    await step(`LinkedIn accepts the API version the connector sends (${DEFAULT_API_VERSION})`, async () => {
      const path = `/rest/posts?q=author&author=${encodeURIComponent(memberUrn)}&count=1`;
      const current = await versioned(path, DEFAULT_API_VERSION, token);
      const status = current.status;
      note(`GET /rest/posts?q=author with ${DEFAULT_API_VERSION}: ${await summarize(current)}`);
      note(`... with ${FUTURE_VERSION}: ${await summarize(await versioned(path, FUTURE_VERSION, token))}`);
      check(status !== 426, `LinkedIn no longer accepts ${DEFAULT_API_VERSION}: update DEFAULT_API_VERSION in src/linkedin/versions.ts`);
    });

    await step('The connector switches to a live API version when LinkedIn has retired the one it sends', async () => {
      const version = new ApiVersion('202001');
      const client = new LinkedInClient({ accessToken: token, version, apiBaseUrl: apiBase });
      const answer = await client.getAssetStatus('images', 'urn:li:image:C4E00AQLiveTestNone').then(
        (status) => `status ${status}`,
        (error) => (error instanceof LinkedInApiError ? `HTTP ${error.status} ${error.message}` : error.message),
      );
      note(`Then looking up a made-up image got: ${answer}`);
      check(version.value !== '202001', 'it kept sending 202001');
      note(`Switched from 202001 to ${version.value}.`);
    });

    // -------------------------------------------------------------- invisible writes

    if (options.upload) {
      for (const [kind, label, data] of [
        ['images', 'an image', png(1200, 627, [10, 102, 194])],
        ['documents', 'a document', pdf(['claude-linkedin-connector', 'live test, page 2'])],
      ]) {
        await step(`Uploading ${label} without posting it, and waiting for LinkedIn to process it`, async () => {
          const client = new LinkedInClient({ accessToken: token, version: new ApiVersion(), apiBaseUrl: apiBase });
          const { uploadUrl, urn } = await client.initializeUpload(kind, memberUrn);
          note(`${urn}, uploaded to ${new URL(uploadUrl).host}`);
          await client.upload(uploadUrl, data);
          const started = Date.now();
          const seen = [];
          for (;;) {
            const status = await client.getAssetStatus(kind, urn).catch((error) =>
              error instanceof LinkedInApiError ? `lookup refused (HTTP ${error.status} ${error.message})` : `lookup failed (${error.message})`,
            );
            if (seen.at(-1) !== status) seen.push(status);
            if (!['WAITING_UPLOAD', 'PROCESSING'].includes(status) || Date.now() - started > 120_000) break;
            await sleep(2_000);
          }
          note(`Status: ${seen.join(' → ')}, after ${Math.round((Date.now() - started) / 1000)} s`);
          check(seen.at(-1) === 'AVAILABLE', 'it never became AVAILABLE');
        });
      }
    }

    // -------------------------------------------------------------- posts, through the connector's tools

    if (!options.publish) return;
    const card = join(work, 'card.png');
    const second = join(work, 'second.png');
    const deck = join(work, 'Live test.pdf');
    writeFileSync(card, png(1200, 627, [10, 102, 194]));
    writeFileSync(second, png(1080, 1080, [244, 162, 97]));
    writeFileSync(deck, pdf(['claude-linkedin-connector', 'live test, page 2']));
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const intro = `Test post from the claude-linkedin-connector live test (${stamp} UTC), please ignore${options.keep ? '.' : ': it is deleted right away.'}`;
    const markup = 'These should show as typed: \\ | { } @ [ ] ( ) < > * _ ~ and the hashtags as links: #ClaudeConnectorTest #LiveTest2026';

    const publish = async (args) => {
      const preview = await connector.call('linkedin_preview_post', args);
      check(!preview.isError, 'linkedin_preview_post failed', preview.text);
      const result = await connector.call('linkedin_create_post', args);
      check(!result.isError, 'linkedin_create_post failed', result.text);
      const { postUrn, url } = result.structuredContent;
      created.push({ postUrn, url });
      check(/^urn:li:(share|ugcPost):\d+$/.test(postUrn), 'unexpected post URN', postUrn);
      note(url);
      return result.structuredContent;
    };

    let first;
    await step('A text post with the characters LinkedIn treats as markup, for your connections', async () => {
      first = await publish({
        text: `${intro}\n${markup}`,
        visibility: 'CONNECTIONS',
      });
    });

    await step('Editing its text', async () => {
      check(first, 'there is no post to edit');
      const result = await connector.call('linkedin_edit_post', { post: first.postUrn, text: `${intro} (Edited.)\n${markup}` });
      check(result.structuredContent?.updated === true, 'linkedin_edit_post failed', result.text);
    });

    await step('A post with an image and alt text', () =>
      publish({ text: `${intro} One image.`, visibility: 'CONNECTIONS', images: [{ source: card, altText: 'A plain blue test card' }] }),
    );
    await step('A post with two images', () =>
      publish({ text: `${intro} Two images.`, visibility: 'CONNECTIONS', images: [{ source: card }, { source: second }] }),
    );
    await step('A post with a PDF document (carousel), titled after the file', async () => {
      const post = await publish({ text: `${intro} A document.`, visibility: 'CONNECTIONS', document: { source: deck } });
      check(post.attachment === 'document', 'unexpected attachment', post.attachment);
    });
    await step('A link post with its own title, description and image', async () => {
      const post = await publish({
        text: `${intro} A link.`,
        visibility: 'CONNECTIONS',
        article: { url: 'https://github.com/adamw7/claude-linkedin-connector', title: 'claude-linkedin-connector', description: 'Live test link preview.', thumbnail: card },
      });
      check(post.linkPreview?.thumbnail === true, 'the card has no image', post.linkPreview);
    });

    await step('linkedin_list_posts remembers them', async () => {
      const list = await connector.call('linkedin_list_posts', { limit: 100 });
      const remembered = new Set(list.structuredContent?.posts?.map((post) => post.postUrn));
      check(created.every((post) => remembered.has(post.postUrn)), 'some are missing', list.text);
    });

    if (options.comments) {
      await step('Commenting on and reacting to a test post', async () => {
        check(first, 'there is no post to comment on');
        const comment = await connector.call('linkedin_comment_on_post', { post: first.postUrn, text: 'Test comment (please ignore).' });
        check(!comment.isError, 'linkedin_comment_on_post failed', comment.text);
        note(`Comment ${comment.structuredContent.commentId ?? '(LinkedIn returned no ID)'}`);
        const reaction = await connector.call('linkedin_react_to_post', { post: first.postUrn, reaction: 'like' });
        check(!reaction.isError, 'linkedin_react_to_post failed', reaction.text);
      });
    }

    if (options.page) {
      await step(`Posting as the Page ${options.page}`, async () => {
        const post = await publish({ text: `${intro} As a Page.`, organization: options.page });
        check(post.author === `urn:li:organization:${options.page.replace(/\D/g, '')}`, 'unexpected author', post.author);
      });
    }
  } finally {
    if (created.length > 0 && !options.keep) {
      await step('Deleting the test posts', async () => {
        const left = [];
        for (const post of created) {
          const result = await connector.call('linkedin_delete_post', { post: post.postUrn });
          if (result.structuredContent?.deleted !== true) left.push(`${post.url} (${result.text})`);
        }
        check(left.length === 0, 'some are still on LinkedIn: delete them there', left.join('\n'));
        const again = await connector.call('linkedin_delete_post', { post: created[0].postUrn });
        note(`Deleting one a second time: ${again.text.slice(0, 200)}`);
      });
    } else if (created.length > 0) {
      console.log(`\nThe test posts are still on LinkedIn (--keep). Check that the characters in the first one show as typed and its`);
      console.log(`hashtags as links, then delete them:\n${created.map((post) => `  ${post.url}`).join('\n')}`);
    }
    await connector.close();
  }
}

/** Remote mode: connects as Claude does, through the server's consent screen and LinkedIn's, in the user's browser. */
async function remote() {
  const port = Number(process.env.PORT || 3000);
  const base = `http://localhost:${port}`;
  const server = spawn(process.execPath, [ENTRY, 'http'], {
    env: { ...connectorEnv, PUBLIC_URL: base, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let logs = '';
  server.stderr.on('data', (chunk) => (logs += chunk));
  const callback = createServer();
  try {
    await step(`Remote mode: connecting through the consent screen and LinkedIn's, then reading your profile`, async () => {
      for (let i = 0; i < 100 && !logs.includes('"event":"listening"'); i++) await sleep(100);
      check(logs.includes('"event":"listening"'), 'the server did not start', logs.slice(-500));
      // Claude's side: a redirect URI for the authorization code, here on loopback.
      await new Promise((resolve) => callback.listen(0, '127.0.0.1', resolve));
      const redirectUrl = `http://127.0.0.1:${callback.address().port}/callback`;
      const landed = new Promise((resolve) =>
        callback.on('request', (req, res) => {
          res.end('The live test has the result: go back to the terminal.');
          resolve(new URL(req.url, redirectUrl));
        }),
      );
      const saved = {};
      const provider = {
        redirectUrl,
        clientMetadata: { client_name: 'claude-linkedin-connector live test', redirect_uris: [redirectUrl], token_endpoint_auth_method: 'none' },
        clientInformation: () => saved.client,
        saveClientInformation: (client) => (saved.client = client),
        tokens: () => saved.tokens,
        saveTokens: (tokens) => (saved.tokens = tokens),
        redirectToAuthorization: (url) => (saved.authorizationUrl = url),
        saveCodeVerifier: (verifier) => (saved.verifier = verifier),
        codeVerifier: () => saved.verifier,
        saveDiscoveryState: (state) => (saved.discovery = state),
        discoveryState: () => saved.discovery,
      };
      const mcpUrl = new URL('/mcp', base);
      const refused = await new Client({ name: 'live-test', version: '1.0.0' })
        .connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }))
        .then(() => undefined, (error) => error);
      check(refused instanceof UnauthorizedError, 'the server let the client in without a sign-in', refused?.message);
      console.log(`\nApprove in your browser (${base}/oauth/callback must be among your app's redirect URLs):\n  ${saved.authorizationUrl}\n`);
      await openBrowser(saved.authorizationUrl.href);
      // Unref'd: once the browser is back, the script mustn't wait out the 5 minutes before exiting.
      const landing = await Promise.race([landed, new Promise((resolve) => setTimeout(resolve, 300_000).unref())]);
      check(landing, 'nobody approved within 5 minutes');
      check(!landing.searchParams.has('error'), 'the sign-in failed', landing.searchParams.get('error_description') ?? landing.searchParams.get('error'));
      const transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
      await transport.finishAuth(landing.searchParams);
      const client = new Client({ name: 'live-test', version: '1.0.0' });
      await client.connect(transport);
      try {
        const status = (await client.callTool({ name: 'linkedin_auth_status', arguments: {} })).structuredContent;
        check(status?.authenticated === true && status.source === 'connector', 'linkedin_auth_status', status);
        const profile = await client.callTool({ name: 'linkedin_get_profile', arguments: {} });
        check(!profile.isError, 'linkedin_get_profile failed', profile.content?.[0]?.text);
        // Only a verified email may match LINKEDIN_ALLOWED_MEMBERS.
        note(`${status.name ?? '(no name)'}; email ${status.email ? 'verified, so the allowlist can name it' : 'not verified: list the member ID instead'}`);
      } finally {
        await client.close();
      }
    });
  } finally {
    callback.close();
    server.kill('SIGTERM');
  }
}

try {
  await main();
  if (options.remote) await remote();
} catch (error) {
  results.push('FAIL');
  console.error(`FAIL  ${error instanceof Failure ? error.message : explain(error)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
const count = (outcome) => results.filter((result) => result === outcome).length;
console.log(`\nLive test against ${apiBase}: ${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped.`);
process.exitCode = count('FAIL') > 0 ? 1 : 0;
