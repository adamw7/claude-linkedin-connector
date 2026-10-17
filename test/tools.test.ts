import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthStatus, LinkedInAuth, LinkedInSession, LoginStart, MemberInfo } from '../src/auth/types.js';
import { NotAuthenticatedError } from '../src/errors.js';
import { ApiVersion } from '../src/linkedin/versions.js';
import { createConnectorServer } from '../src/mcp/server.js';
import { CONNECTIONS_CSV } from './helpers/connections.js';
import { API_BASE, FakeLinkedIn } from './helpers/fake-linkedin.js';
import { PDF, PNG, startServer, type TestServer } from './helpers/http.js';

const DEFAULT_SCOPES = ['openid', 'profile', 'email', 'w_member_social'];

class StubAuth implements LinkedInAuth {
  member: MemberInfo | undefined;
  signedIn = true;
  logins = 0;

  async getSession(): Promise<LinkedInSession> {
    if (!this.signedIn) throw new NotAuthenticatedError('You are not signed in to LinkedIn.');
    return { accessToken: 'li-token', scopes: DEFAULT_SCOPES, ...(this.member ? { memberId: this.member.id } : {}) };
  }
  async rememberMember(member: MemberInfo): Promise<void> {
    this.member = member;
  }
  async status(): Promise<AuthStatus> {
    return this.signedIn
      ? { authenticated: true, source: 'token-file', scopes: DEFAULT_SCOPES, message: 'Signed in as Ada.' }
      : { authenticated: false, source: 'none', scopes: [], message: 'Not signed in.' };
  }
}

class StubLocalAuth extends StubAuth {
  async login(): Promise<LoginStart> {
    this.logins += 1;
    return { authorizationUrl: 'https://www.linkedin.com/oauth/v2/authorization?state=x', expiresInSeconds: 600 };
  }
  async logout(): Promise<boolean> {
    const was = this.signedIn;
    this.signedIn = false;
    return was;
  }
}

interface Harness {
  client: Client;
  linkedin: FakeLinkedIn;
  auth: StubAuth;
}

async function harness(options: { scopes?: string[]; mode?: 'local' | 'remote'; auth?: StubAuth } = {}): Promise<Harness> {
  const linkedin = new FakeLinkedIn();
  const mode = options.mode ?? 'local';
  const auth = options.auth ?? (mode === 'local' ? new StubLocalAuth() : new StubAuth());
  const server = createConnectorServer({
    mode,
    auth,
    version: new ApiVersion('202609'),
    scopes: options.scopes ?? DEFAULT_SCOPES,
    apiBaseUrl: API_BASE,
    fetch: linkedin.fetch,
    allowPrivateNetwork: true,
    sleep: async () => {},
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, linkedin, auth };
}

async function call(h: Harness, name: string, args: Record<string, unknown> = {}) {
  const result = await h.client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
  return { isError: result.isError === true, text, data: result.structuredContent as Record<string, any> | undefined };
}

let web: TestServer;
let files: string;

beforeAll(async () => {
  files = await mkdtemp(join(tmpdir(), 'linkedin-tools-'));
  await writeFile(join(files, 'photo.png'), PNG);
  await writeFile(join(files, 'Connections.csv'), CONNECTIONS_CSV);
  web = await startServer((req, res) => {
    if (req.url === '/article') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><head><meta property="og:title" content="Engines &amp; Ideas"><meta property="og:description" content="A note."><meta property="og:image" content="/card.png"></head></html>');
    } else if (req.url === '/card.png') res.end(PNG);
    else if (req.url === '/talk.pdf') res.end(PDF);
    else if (req.url === '/Connections.csv') res.end(CONNECTIONS_CSV);
    else res.writeHead(404).end();
  });
});
afterAll(() => web.close());

describe('tool list', () => {
  it('exposes the core tools, plus login/logout locally', async () => {
    const { client } = await harness();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'linkedin_get_profile',
      'linkedin_read_connections',
      'linkedin_create_post',
      'linkedin_edit_post',
      'linkedin_delete_post',
      'linkedin_auth_status',
      'linkedin_login',
      'linkedin_logout',
    ]);
    const create = tools.find((t) => t.name === 'linkedin_create_post')!;
    expect(Object.keys(create.inputSchema.properties ?? {})).toEqual(['text', 'visibility', 'article', 'images', 'document']);
    expect(create.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(tools.find((t) => t.name === 'linkedin_delete_post')!.annotations).toMatchObject({ destructiveHint: true });
  });

  it('adds engagement tools and Page posting when the app has those scopes', async () => {
    const { client } = await harness({ scopes: [...DEFAULT_SCOPES, 'w_member_social_feed', 'w_organization_social'] });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('linkedin_comment_on_post');
    expect(tools.map((t) => t.name)).toContain('linkedin_react_to_post');
    expect(Object.keys(tools.find((t) => t.name === 'linkedin_create_post')!.inputSchema.properties ?? {})).toContain('organization');
  });

  it('has no login/logout tools in remote mode', async () => {
    const { client } = await harness({ mode: 'remote' });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('linkedin_login');
    expect(names).not.toContain('linkedin_logout');
  });
});

describe('linkedin_get_profile', () => {
  it('returns the profile and remembers the member', async () => {
    const h = await harness();
    const result = await call(h, 'linkedin_get_profile');
    expect(result.isError).toBe(false);
    expect(result.data).toEqual({
      memberUrn: 'urn:li:person:abc123',
      name: 'Ada Lovelace',
      givenName: 'Ada',
      familyName: 'Lovelace',
      email: 'ada@example.com',
      emailVerified: true,
      pictureUrl: 'https://media.licdn.com/ada.jpg',
      locale: 'en_GB',
    });
    expect(h.auth.member).toEqual({ id: 'abc123', name: 'Ada Lovelace', email: 'ada@example.com' });
  });
});

describe('linkedin_read_connections', () => {
  it('reads a local file newest first, without signing in', async () => {
    const h = await harness();
    h.auth.signedIn = false;
    const { isError, data } = await call(h, 'linkedin_read_connections', { file: join(files, 'Connections.csv') });
    expect(isError).toBe(false);
    expect(data).toMatchObject({ total: 3, matched: 3, offset: 0 });
    expect(data!.connections.map((c: { name: string }) => c.name)).toEqual(['Ada Lovelace', 'Grace Hopper', 'Alan Turing']);
    expect(data!.nextOffset).toBeUndefined();
    expect(h.linkedin.requests).toHaveLength(0);
  });

  it('filters by text, company and date, and pages', async () => {
    const h = await harness();
    const read = async (args: Record<string, unknown>) =>
      (await call(h, 'linkedin_read_connections', { csv: CONNECTIONS_CSV, ...args })).data!;
    const names = (data: Record<string, any>) => data.connections.map((c: { name: string }) => c.name);
    expect(names(await read({ query: 'ADMIRAL' }))).toEqual(['Grace Hopper']);
    expect(names(await read({ company: 'analytical' }))).toEqual(['Ada Lovelace', 'Alan Turing']);
    expect(names(await read({ connectedAfter: '2024-01-01', connectedBefore: '2025-12-31' }))).toEqual(['Grace Hopper']);
    const first = await read({ limit: 2 });
    expect(first).toMatchObject({ matched: 3, nextOffset: 2 });
    expect(names(await read({ limit: 2, offset: first.nextOffset }))).toEqual(['Alan Turing']);
  });

  it('reads URLs, and refuses local files in remote mode', async () => {
    const remote = await harness({ mode: 'remote' });
    expect((await call(remote, 'linkedin_read_connections', { file: `${web.url}/Connections.csv` })).data!.total).toBe(3);
    const local = await call(remote, 'linkedin_read_connections', { file: join(files, 'Connections.csv') });
    expect(local.isError).toBe(true);
    expect(local.text).toMatch(/Local files cannot be read/);
  });

  it('needs exactly one of file and csv, and rejects other files', async () => {
    const h = await harness();
    expect((await call(h, 'linkedin_read_connections')).text).toMatch(/either file or csv/);
    expect((await call(h, 'linkedin_read_connections', { file: join(files, 'photo.png') })).text).toMatch(/not a LinkedIn Connections\.csv/);
  });
});

describe('linkedin_create_post', () => {
  it('publishes escaped text as the signed-in member', async () => {
    const h = await harness();
    const result = await call(h, 'linkedin_create_post', { text: 'Big news (really)! #launch' });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ author: 'urn:li:person:abc123', visibility: 'PUBLIC', attachment: 'none' });
    expect(result.data!.url).toBe(`https://www.linkedin.com/feed/update/${result.data!.postUrn}/`);
    const post = h.linkedin.find('POST', '/rest/posts')[0]!;
    expect(post.json).toMatchObject({ author: 'urn:li:person:abc123', commentary: 'Big news \\(really\\)! #launch', visibility: 'PUBLIC' });
    expect(post.json).not.toHaveProperty('content');
  });

  it('skips the userinfo lookup once the member is known', async () => {
    const h = await harness();
    await call(h, 'linkedin_create_post', { text: 'One' });
    await call(h, 'linkedin_create_post', { text: 'Two', visibility: 'CONNECTIONS' });
    expect(h.linkedin.find('GET', '/v2/userinfo')).toHaveLength(1);
    expect(h.linkedin.find('POST', '/rest/posts')[1]!.json).toMatchObject({ visibility: 'CONNECTIONS' });
  });

  it('uploads several images as a multi-image post', async () => {
    const h = await harness();
    const dataUri = `data:image/png;base64,${PNG.toString('base64')}`;
    const result = await call(h, 'linkedin_create_post', {
      text: 'Album',
      images: [{ source: dataUri, altText: 'A pixel' }, { source: join(files, 'photo.png') }],
    });
    expect(result.data).toMatchObject({ attachment: 'images' });
    expect(h.linkedin.find('POST', '/rest/images')).toHaveLength(2);
    expect(h.linkedin.requests.filter((r) => r.method === 'PUT')).toHaveLength(2);
    const post = h.linkedin.find('POST', '/rest/posts')[0]!;
    expect(post.json).toMatchObject({
      content: { multiImage: { images: [{ id: expect.stringMatching(/^urn:li:image:/), altText: 'A pixel' }, { id: expect.stringMatching(/^urn:li:image:/) }] } },
    });
  });

  it('attaches a single image as media', async () => {
    const h = await harness();
    const result = await call(h, 'linkedin_create_post', { text: 'Pic', images: [{ source: join(files, 'photo.png'), altText: 'Me' }] });
    expect(result.data).toMatchObject({ attachment: 'image' });
    expect(h.linkedin.find('POST', '/rest/posts')[0]!.json).toMatchObject({ content: { media: { altText: 'Me' } } });
  });

  it('uploads a document from a URL, titled after the file', async () => {
    const h = await harness();
    const result = await call(h, 'linkedin_create_post', { text: 'Slides', document: { source: `${web.url}/talk.pdf` } });
    expect(result.data).toMatchObject({ attachment: 'document' });
    expect(h.linkedin.find('POST', '/rest/documents')).toHaveLength(1);
    expect(h.linkedin.find('POST', '/rest/posts')[0]!.json).toMatchObject({
      content: { media: { id: expect.stringMatching(/^urn:li:document:/), title: 'talk.pdf' } },
    });
  });

  it('builds the link preview from the page metadata', async () => {
    const h = await harness();
    const url = `${web.url}/article`;
    const result = await call(h, 'linkedin_create_post', { text: 'Read this', article: { url } });
    expect(result.data).toMatchObject({
      attachment: 'article',
      linkPreview: { title: 'Engines & Ideas', description: 'A note.', thumbnail: true },
    });
    expect(h.linkedin.find('POST', '/rest/images')).toHaveLength(1);
    expect(h.linkedin.find('POST', '/rest/posts')[0]!.json).toMatchObject({
      content: { article: { source: url, title: 'Engines & Ideas', description: 'A note.', thumbnail: expect.stringMatching(/^urn:li:image:/) } },
    });
  });

  it('still posts a link when the page cannot be previewed', async () => {
    const h = await harness();
    const url = `${web.url}/missing-page`;
    const result = await call(h, 'linkedin_create_post', { text: 'Link', article: { url, title: 'Custom' } });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ linkPreview: { title: 'Custom', thumbnail: false } });
    expect(h.linkedin.find('POST', '/rest/posts')[0]!.json).toMatchObject({ content: { article: { source: url, title: 'Custom' } } });
    expect(h.linkedin.find('POST', '/rest/images')).toHaveLength(0);
  });

  it('allows only one kind of attachment', async () => {
    const h = await harness();
    const result = await call(h, 'linkedin_create_post', {
      text: 'Both',
      article: { url: 'https://example.com' },
      images: [{ source: join(files, 'photo.png') }],
    });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('only one of') });
    expect(h.linkedin.requests).toHaveLength(0);
  });

  it('validates media before calling LinkedIn', async () => {
    const h = await harness();
    const result = await call(h, 'linkedin_create_post', { text: 'Oops', images: [{ source: join(files, 'nope.png') }] });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('Cannot read') });
    expect(h.linkedin.requests).toHaveLength(0);
  });

  it('refuses local files in remote mode', async () => {
    const h = await harness({ mode: 'remote' });
    const result = await call(h, 'linkedin_create_post', { text: 'x', images: [{ source: join(files, 'photo.png') }] });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('Local files cannot be read') });
  });

  it('waits for uploads to finish processing, and reports failures', async () => {
    const h = await harness();
    let polls = 0;
    h.linkedin.override((request) => {
      if (request.method === 'GET' && request.url.pathname.startsWith('/rest/documents/')) {
        polls += 1;
        return new Response(JSON.stringify({ status: polls < 3 ? 'PROCESSING' : 'AVAILABLE' }), { status: 200 });
      }
      return undefined;
    });
    expect((await call(h, 'linkedin_create_post', { text: 'Deck', document: { source: `${web.url}/talk.pdf`, title: 'Deck' } })).isError).toBe(false);
    expect(polls).toBe(3);

    h.linkedin.assetStatus = 'PROCESSING_FAILED';
    const failed = await call(h, 'linkedin_create_post', { text: 'Pic', images: [{ source: join(files, 'photo.png') }] });
    expect(failed).toMatchObject({ isError: true, text: expect.stringContaining('could not process') });
  });

  it('posts as a Page when allowed', async () => {
    const h = await harness({ scopes: [...DEFAULT_SCOPES, 'w_organization_social'] });
    const result = await call(h, 'linkedin_create_post', { text: 'Company news', organization: '2414183' });
    expect(result.data).toMatchObject({ author: 'urn:li:organization:2414183' });
    expect(h.linkedin.find('GET', '/v2/userinfo')).toHaveLength(0);
  });
});

describe('linkedin_edit_post', () => {
  it('replaces the text, escaped', async () => {
    const h = await harness();
    const result = await call(h, 'linkedin_edit_post', { post: 'urn:li:share:42', text: 'Now with (fixed) typos' });
    expect(result.data).toEqual({ updated: true, postUrn: 'urn:li:share:42', url: 'https://www.linkedin.com/feed/update/urn:li:share:42/' });
    expect(h.linkedin.find('POST', '/rest/posts/')[0]!.json).toEqual({ patch: { $set: { commentary: 'Now with \\(fixed\\) typos' } } });
  });
});

describe('linkedin_delete_post', () => {
  it('deletes by URL', async () => {
    const h = await harness();
    const result = await call(h, 'linkedin_delete_post', { post: 'https://www.linkedin.com/feed/update/urn:li:share:42/' });
    expect(result.data).toEqual({ deleted: true, postUrn: 'urn:li:share:42' });
    expect(h.linkedin.find('DELETE', '/rest/posts/')[0]!.url.pathname).toBe('/rest/posts/urn%3Ali%3Ashare%3A42');
  });

  it('explains when an activity URN cannot be deleted', async () => {
    const h = await harness();
    h.linkedin.override((r) => (r.method === 'DELETE' ? new Response('{"message":"Invalid post id"}', { status: 400 }) : undefined));
    const result = await call(h, 'linkedin_delete_post', { post: 'urn:li:activity:7' });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('not an activity URN') });
  });
});

describe('engagement tools', () => {
  const scopes = [...DEFAULT_SCOPES, 'w_member_social_feed', 'w_organization_social'];

  it('comments with escaped text', async () => {
    const h = await harness({ scopes });
    const result = await call(h, 'linkedin_comment_on_post', { post: 'urn:li:share:9', text: 'Congrats (well deserved)' });
    expect(result.data).toMatchObject({ postUrn: 'urn:li:share:9', actor: 'urn:li:person:abc123', commentId: expect.any(String) });
    expect(h.linkedin.find('POST', '/rest/socialActions/')[0]!.json).toMatchObject({ message: { text: 'Congrats \\(well deserved\\)' } });
  });

  it('maps friendly reaction names to API values', async () => {
    const h = await harness({ scopes });
    await call(h, 'linkedin_react_to_post', { post: 'urn:li:share:9', reaction: 'insightful' });
    await call(h, 'linkedin_react_to_post', { post: 'urn:li:share:9', organization: '77' });
    const reactions = h.linkedin.find('POST', '/rest/reactions');
    expect(reactions.map((r) => (r.json as { reactionType: string }).reactionType)).toEqual(['INTEREST', 'LIKE']);
    expect(reactions[1]!.url.searchParams.get('actor')).toBe('urn:li:organization:77');
  });

  it('requires a Page when only organization access is available', async () => {
    const h = await harness({ scopes: [...DEFAULT_SCOPES, 'w_organization_social'] });
    const result = await call(h, 'linkedin_react_to_post', { post: 'urn:li:share:9' });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('w_member_social_feed') });
  });
});

describe('errors', () => {
  it('tells the user how to sign in', async () => {
    const auth = new StubLocalAuth();
    auth.signedIn = false;
    const h = await harness({ auth });
    expect(await call(h, 'linkedin_create_post', { text: 'x' })).toMatchObject({ isError: true, text: 'You are not signed in to LinkedIn.' });
  });

  it.each([
    [401, 'local', /expired or been revoked.*linkedin_login/],
    [401, 'remote', /reconnect the LinkedIn connector/],
    [403, 'local', /denied permission for this action: Not enough permissions/],
    [422, 'local', /rejected the request \(HTTP 422\): Not enough permissions/],
    [429, 'local', /rate limit was reached \(retry after 60s\)/],
    [503, 'local', /internal problem \(HTTP 503\)/],
  ] as const)('explains HTTP %i (%s mode)', async (status, mode, message) => {
    const h = await harness({ mode });
    h.linkedin.override(() =>
      new Response(JSON.stringify({ status, message: 'Not enough permissions to access: posts.CREATE' }), {
        status,
        headers: { 'retry-after': '60' },
      }),
    );
    const result = await call(h, 'linkedin_get_profile');
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(message);
  });
});

describe('authentication tools', () => {
  it('reports status', async () => {
    const h = await harness();
    expect((await call(h, 'linkedin_auth_status')).data).toMatchObject({ authenticated: true, message: 'Signed in as Ada.' });
  });

  it('does not start a new sign-in when already signed in, unless forced', async () => {
    const h = await harness();
    expect((await call(h, 'linkedin_login')).data).toMatchObject({ alreadySignedIn: true });
    expect(h.auth.logins).toBe(0);
    const forced = await call(h, 'linkedin_login', { force: true });
    expect(forced.data).toMatchObject({ alreadySignedIn: false, authorizationUrl: expect.stringContaining('linkedin.com'), expiresInSeconds: 600 });
    expect(forced.data!.message).toContain('valid for 10 minutes');
  });

  it('signs out', async () => {
    const h = await harness();
    expect((await call(h, 'linkedin_logout')).data).toMatchObject({ removed: true });
    expect((await call(h, 'linkedin_logout')).data).toMatchObject({ removed: false });
  });
});
