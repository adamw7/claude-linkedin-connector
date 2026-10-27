import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { PDF, PNG, startServer, type TestServer } from '../test/helpers/http.js';
import { callTool, startLocal, type Local } from './helpers/connector.js';

// The tools in local mode, each call going from Claude's MCP client through the connector to LinkedIn and back. LinkedIn
// is the in-memory fake, so this times the connector itself: what it adds to LinkedIn's own response times.

/** Benchmarks run several seconds each; a test runs a group of them. */
const TIMEOUT = 120_000;

/** LinkedIn's longest post: 3,000 characters, with line breaks, an emoji, hashtags and characters little text escapes. */
const POST = [...'Shipped v2.0 of our (open-source) connector, thanks to @Ada & the team! 🚀 Details: [notes] <soon>\n#AI #OpenSource\n\n'.repeat(30)]
  .slice(0, 3000)
  .join('');

/** A photo-sized PNG (1 MB): LinkedIn's fake doesn't decode it, and the connector checks only its signature. */
const PHOTO = Buffer.concat([PNG, randomBytes(1024 * 1024)]);
const DOCUMENT = Buffer.concat([PDF, randomBytes(1024 * 1024)]);

let local: Local;
let web: TestServer;

beforeAll(async () => {
  local = await startLocal();
  await writeFile(join(local.files, 'photo.png'), PHOTO);
  await writeFile(join(local.files, 'Q3 results.pdf'), DOCUMENT);
  // The page an article links to, with the preview metadata LinkedIn's own editor reads.
  web = await startServer((req, res) => {
    if (req.url === '/card.png') return void res.end(PNG);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      '<!doctype html><html><head><title>Engines</title><meta property="og:title" content="Engines &amp; Ideas">' +
        '<meta property="og:description" content="A note on the Analytical Engine."><meta property="og:image" content="/card.png"></head>' +
        `<body>${'<p>Text of the article.</p>'.repeat(500)}</body></html>`,
    );
  });
});

afterAll(async () => {
  await local?.close();
  await web?.close();
});

/** The LinkedIn requests one tool call makes, as "METHOD path". */
async function linkedInRequests(name: string, args: Record<string, unknown>): Promise<string[]> {
  local.linkedin.requests.length = 0;
  await callTool(local.client, name, args);
  return local.linkedin.requests.map(({ method, url }) => `${method} ${url.pathname}`);
}

/** Forgets the requests the fake LinkedIn recorded, uploads included, so a long benchmark doesn't fill memory with them. */
const forgetRequests = { afterEach: () => void (local.linkedin.requests.length = 0) };

test('publishes posts with each kind of attachment', { timeout: TIMEOUT }, async ({ bench }) => {
  const article = { text: POST, article: { url: `${web.url}/article` } };
  const image = { text: POST, images: [{ source: 'photo.png', altText: 'The team at the launch' }] };
  const dataUri = { text: POST, images: [{ source: `data:image/png;base64,${PHOTO.toString('base64')}` }] };
  const document = { text: POST, document: { source: 'Q3 results.pdf' } };

  // What each benchmark times: one request for a text post (the member ID is in the token file), three more per upload.
  expect(await linkedInRequests('linkedin_create_post', { text: POST })).toEqual(['POST /rest/posts']);
  expect(await linkedInRequests('linkedin_create_post', image)).toEqual([
    'POST /rest/images',
    expect.stringMatching(/^PUT \/images\//),
    expect.stringMatching(/^GET \/rest\/images\//),
    'POST /rest/posts',
  ]);
  expect(await callTool(local.client, 'linkedin_preview_post', article)).toMatchObject({
    characters: 3000,
    attachment: 'article',
    linkPreview: { title: 'Engines & Ideas', thumbnail: true, imageUrl: `${web.url}/card.png` },
  });
  expect(await callTool(local.client, 'linkedin_create_post', document)).toMatchObject({ attachment: 'document' });

  await bench.compare(
    bench('preview a text post', () => callTool(local.client, 'linkedin_preview_post', { text: POST })),
    bench('preview a post with a link preview', () => callTool(local.client, 'linkedin_preview_post', article)),
    bench('publish a text post', forgetRequests, () => callTool(local.client, 'linkedin_create_post', { text: POST })),
    bench('publish a post with a link preview', forgetRequests, () => callTool(local.client, 'linkedin_create_post', article)),
    bench('publish a 1 MB image from a file', forgetRequests, () => callTool(local.client, 'linkedin_create_post', image)),
    bench('publish a 1 MB image as a data: URI', forgetRequests, () => callTool(local.client, 'linkedin_create_post', dataUri)),
    bench('publish a 1 MB PDF from a file', forgetRequests, () => callTool(local.client, 'linkedin_create_post', document)),
  );
});

test('reads the profile and manages posts', { timeout: TIMEOUT }, async ({ bench }) => {
  // A full post history, as after a hundred posts.
  for (let index = 0; index < 100; index++) await callTool(local.client, 'linkedin_create_post', { text: `Post ${index}` });
  const { postUrn } = await callTool(local.client, 'linkedin_create_post', { text: POST });

  expect((await local.client.listTools()).tools).toHaveLength(10);
  expect(await callTool(local.client, 'linkedin_get_profile')).toMatchObject({ memberUrn: 'urn:li:person:abc123', name: 'Ada Lovelace' });
  expect(await callTool(local.client, 'linkedin_auth_status')).toMatchObject({ authenticated: true, source: 'token-file' });
  expect((await callTool(local.client, 'linkedin_list_posts', { limit: 100 })).posts).toHaveLength(100);
  expect(await linkedInRequests('linkedin_edit_post', { post: postUrn, text: POST })).toEqual([expect.stringMatching(/^POST \/rest\/posts\//)]);

  await bench.compare(
    bench('list the tools', () => local.client.listTools()),
    bench('check the sign-in', () => callTool(local.client, 'linkedin_auth_status')),
    bench('get the profile', forgetRequests, () => callTool(local.client, 'linkedin_get_profile')),
    bench('list 100 published posts', () => callTool(local.client, 'linkedin_list_posts', { limit: 100 })),
    bench('edit a post', forgetRequests, () => callTool(local.client, 'linkedin_edit_post', { post: postUrn, text: POST })),
    // LinkedIn's fake deletes a post as often as it is asked to; only the first call changes the history.
    bench('delete a post', forgetRequests, () => callTool(local.client, 'linkedin_delete_post', { post: postUrn })),
  );
});
