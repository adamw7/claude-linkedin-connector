import { mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_HINT, LAST_FAILURE, SIGN_IN_HINT, signInPageHint, SWITCH_ACCOUNT_HINT } from '../src/auth/local-auth.js';
import { PostHistory } from '../src/auth/post-history.js';
import type { AuthStatus, LinkedInAuth, LinkedInSession, LoginStart, MemberInfo } from '../src/auth/types.js';
import { ConfigError, NotAuthenticatedError } from '../src/errors.js';
import { ApiVersion } from '../src/linkedin/versions.js';
import { createConnectorServer } from '../src/mcp/server.js';
import { CONNECTIONS_CSV } from './helpers/connections.js';
import { API_BASE, FakeLinkedIn } from './helpers/fake-linkedin.js';
import { PDF, PNG, startServer, type TestServer } from './helpers/http.js';
import { zipArchive } from './helpers/zip.js';

const DEFAULT_SCOPES = ['openid', 'profile', 'email', 'w_member_social'];
/** What a sign-in that is still waiting says to check, should LinkedIn show an error page instead. */
const CHECK_APP = signInPageHint('http://localhost:8723/callback');
const PAGES_OFF =
  'Acting as a Page needs "Post as LinkedIn Pages" (LINKEDIN_PAGES) turned on for this connector (Community Management API). Leave out "organization" to act as yourself.';

class StubAuth implements LinkedInAuth {
  member: MemberInfo | undefined;
  signedIn = true;
  /** Why getSession fails while signed out. */
  signedOutMessage = 'You are not signed in to LinkedIn.';
  source: AuthStatus['source'] = 'token-file';
  /** What the sign-in granted; the harness grants what the connector is configured with. */
  scopes = DEFAULT_SCOPES;
  missingScopes: string[] | undefined;
  logins = 0;

  async getSession(): Promise<LinkedInSession> {
    if (!this.signedIn) throw new NotAuthenticatedError(this.signedOutMessage);
    return { accessToken: 'li-token', scopes: this.scopes, ...(this.member ? { memberId: this.member.id } : {}) };
  }
  async rememberMember(member: MemberInfo): Promise<void> {
    this.member = member;
  }
  async status(): Promise<AuthStatus> {
    return this.signedIn
      ? {
          authenticated: true,
          source: this.source,
          scopes: this.scopes,
          missingScopes: this.missingScopes,
          ...(this.member ? { memberUrn: `urn:li:person:${this.member.id}` } : {}),
          message: 'Signed in as Ada.',
        }
      : { authenticated: false, source: 'none', scopes: [], message: 'Not signed in.' };
  }
}

class StubLocalAuth extends StubAuth {
  /** How the next browser sign-in ends: the member's name, a failure, or never (the user hasn't finished). */
  completion: Promise<string | undefined> = new Promise(() => {});
  browserOpened = true;
  /** Who the next sign-in signs in, when not whoever was signed in before. */
  signsInAs: MemberInfo | undefined;
  rejected?: (session: LinkedInSession) => Promise<boolean>;

  async login(): Promise<LoginStart> {
    this.logins += 1;
    this.member = this.signsInAs ?? this.member;
    return {
      authorizationUrl: 'https://www.linkedin.com/oauth/v2/authorization?state=x',
      expiresInSeconds: 600,
      redirectUri: 'http://localhost:8723/callback',
      browserOpened: this.browserOpened,
      completion: this.completion,
    };
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

/** Time that passes only when the server sleeps or a test moves it on. */
class FakeClock {
  time = 0;
  readonly now = () => this.time;
  readonly sleep = async (ms: number) => {
    this.time += ms;
  };
}

async function harness(
  options: { scopes?: string[]; mode?: 'local' | 'remote'; auth?: StubAuth; history?: PostHistory; clock?: FakeClock; localFileDirs?: string[] } = {},
): Promise<Harness> {
  const linkedin = new FakeLinkedIn();
  const mode = options.mode ?? 'local';
  const auth = options.auth ?? (mode === 'local' ? new StubLocalAuth() : new StubAuth());
  if (!options.auth) auth.scopes = options.scopes ?? DEFAULT_SCOPES;
  const server = createConnectorServer({
    mode,
    auth,
    version: new ApiVersion('202609'),
    scopes: options.scopes ?? DEFAULT_SCOPES,
    apiBaseUrl: API_BASE,
    fetch: linkedin.fetch,
    allowPrivateNetwork: true,
    localFileDirs: options.localFileDirs ?? [files],
    history: options.history,
    sleep: options.clock?.sleep ?? (async () => {}),
    now: options.clock?.now,
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
/** Requests for /counted, a page with full preview metadata. */
let pageFetches = 0;

beforeAll(async () => {
  files = await mkdtemp(join(tmpdir(), 'linkedin-tools-'));
  await writeFile(join(files, 'photo.png'), PNG);
  await writeFile(join(files, 'Connections.csv'), CONNECTIONS_CSV);
  web = await startServer((req, res) => {
    if (req.url === '/article') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><head><meta property="og:title" content="Engines &amp; Ideas"><meta property="og:description" content="A note."><meta property="og:image" content="/card.png"></head></html>');
    } else if (req.url === '/counted') {
      pageFetches += 1;
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><head><meta property="og:title" content="Counted"><meta property="og:image" content="/card.png"></head></html>');
    } else if (req.url?.startsWith('/docs/')) res.end(PDF);
    else if (req.url === '/bare') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><body>No metadata here</body></html>');
    } else if (req.url === '/webp-card') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><head><title>Modern</title><meta property="og:image" content="/card.webp"></head></html>');
    } else if (req.url === '/card.webp') res.end(Buffer.from('RIFF\x24\0\0\0WEBPVP8 '));
    else if (req.url === '/card.png') res.end(PNG);
    else if (req.url === '/talk.pdf') res.end(PDF);
    else if (req.url?.startsWith('/download?') || req.url === '/file' || req.url === '/path-in-name') {
      // As cloud drives' download links name the file, which their URLs don't.
      const disposition = {
        '/file': 'attachment; filename="Board deck.pdf"',
        '/path-in-name': 'attachment; filename="..\\\\..\\\\Windows\\\\deck.pdf"',
      }[req.url];
      res.setHeader('Content-Disposition', disposition ?? `attachment; filename="Q3 results.pdf"; filename*=UTF-8''Q3%20results%20%E2%80%93%20final.pdf`);
      res.end(PDF);
    } else if (req.url === '/Connections.csv') res.end(CONNECTIONS_CSV);
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
      'linkedin_preview_post',
      'linkedin_create_post',
      'linkedin_edit_post',
      'linkedin_delete_post',
      'linkedin_auth_status',
      'linkedin_login',
      'linkedin_logout',
    ]);
    expect(tools.find((t) => t.name === 'linkedin_preview_post')!.annotations).toMatchObject({ readOnlyHint: true });
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

  it('tells clients what each tool does to the account, so read-only ones can run without asking', async () => {
    const h = await harness({ scopes: [...DEFAULT_SCOPES, 'w_member_social_feed'], history: new PostHistory(join(files, 'unused-posts.json')) });
    const tools = (await h.client.listTools()).tools;
    const contract = Object.fromEntries(tools.map((t) => [t.name, [t.title, t.annotations]]));
    const reads = { readOnlyHint: true, openWorldHint: false };
    const publishes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
    const changes = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
    expect(contract).toEqual({
      linkedin_get_profile: ['Get LinkedIn profile', reads],
      // It downloads the export when given a link to it.
      linkedin_read_connections: ['Read exported LinkedIn connections', { readOnlyHint: true, openWorldHint: true }],
      linkedin_preview_post: ['Preview a LinkedIn post', { readOnlyHint: true, openWorldHint: true }],
      linkedin_create_post: ['Publish a LinkedIn post', publishes],
      linkedin_edit_post: ['Edit a LinkedIn post', changes],
      linkedin_delete_post: ['Delete a LinkedIn post', changes],
      linkedin_list_posts: ['List posts published from Claude', reads],
      linkedin_comment_on_post: ['Comment on a LinkedIn post', publishes],
      linkedin_react_to_post: ['React to a LinkedIn post', { ...publishes, idempotentHint: true }],
      linkedin_auth_status: ['LinkedIn sign-in status', reads],
      linkedin_login: ['Sign in to LinkedIn', { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }],
      linkedin_logout: ['Sign out of LinkedIn', { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }],
    });
    const outputs = (name: string) => Object.keys(tools.find((t) => t.name === name)!.outputSchema?.properties ?? {});
    expect(outputs('linkedin_preview_post')).toEqual(['characters', 'visibility', 'attachment', 'images', 'document', 'linkPreview', 'warnings']);
    expect(outputs('linkedin_list_posts')).toEqual(['posts', 'matched']);
    expect(outputs('linkedin_delete_post')).toEqual(['deleted', 'postUrn']);
  });

  it('tells Claude how to get files that were attached to the chat', async () => {
    const attached = "Images and documents the user attached to the chat can't be passed to these tools: only their contents reach you, not the file. ";
    expect((await harness({ localFileDirs: ['/home/ada/Downloads', '/home/ada/Desktop'] })).client.getInstructions()).toContain(
      `${attached}Ask the user to save the file in one of the folders local files may come from (/home/ada/Downloads, /home/ada/Desktop) and pass its name or path.`,
    );
    const remote = await harness({ mode: 'remote' });
    expect(remote.client.getInstructions()).toContain(`${attached}Ask the user for a link to the file itself.`);
    const connections = (await remote.client.listTools()).tools.find((t) => t.name === 'linkedin_read_connections')!;
    expect(connections.description).toContain(
      'Pass the text of Connections.csv as csv when the user attached or pasted it (an attached zip archive cannot be passed on), or a link to the file.',
    );
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

  it('passes on a locale LinkedIn writes as a string, and leaves out a missing one', async () => {
    const profile = async (locale: unknown) => {
      const h = await harness();
      h.linkedin.override(({ url }) => (url.pathname === '/v2/userinfo' ? Response.json({ sub: 'abc123', locale }) : undefined));
      return (await call(h, 'linkedin_get_profile')).data!;
    };
    expect((await profile('pl_PL')).locale).toBe('pl_PL');
    expect((await profile({ language: 'de' })).locale).toBe('de');
    expect(await profile(undefined)).toEqual({ memberUrn: 'urn:li:person:abc123' });
    expect(await profile({})).toEqual({ memberUrn: 'urn:li:person:abc123' });
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

  it('lists undated connections last, and leaves them out when filtering by date', async () => {
    const h = await harness();
    const csv = [
      'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
      'Undated,One,,,,,',
      'Old,Friend,,,,,01 Jan 2020',
      'Unreadable,Date,,,,,sometime in 2023',
      'New,Friend,,,,,01 Jan 2026',
    ].join('\n');
    const names = async (args: Record<string, unknown>) =>
      (await call(h, 'linkedin_read_connections', { csv, ...args })).data!.connections.map((c: { name: string }) => c.name);
    expect(await names({})).toEqual(['New Friend', 'Old Friend', 'Undated One', 'Unreadable Date']);
    expect(await names({ connectedAfter: '2019-01-01' })).toEqual(['New Friend', 'Old Friend']);
    expect(await names({ connectedBefore: '2030-01-01' })).toEqual(['New Friend', 'Old Friend']);
  });

  it('matches companies and text regardless of accents, and any of several companies', async () => {
    const h = await harness();
    const csv = [
      'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
      'Zofia,Wójcik,,,Łódzka Spółka,Księgowa,01 Oct 2026',
      'Jan,Kowalski,,,XYZ Sp. z o.o.,Engineer,02 Sep 2026',
      'Anna,Nowak,,,abc Group,Designer,03 Aug 2026',
      'Piotr,Zieliński,,,Other,Engineer,04 Jul 2026',
    ].join('\n');
    const names = async (args: Record<string, unknown>) =>
      (await call(h, 'linkedin_read_connections', { csv, ...args })).data!.connections.map((c: { name: string }) => c.name);
    expect(await names({ company: 'lodzka spolka' })).toEqual(['Zofia Wójcik']);
    expect(await names({ query: 'WOJCIK' })).toEqual(['Zofia Wójcik']);
    expect(await names({ query: 'zielinski' })).toEqual(['Piotr Zieliński']);
    expect(await names({ company: ['xyz', 'ABC'] })).toEqual(['Jan Kowalski', 'Anna Nowak']);
    expect(await names({ company: ['xyz', 'abc'], query: 'engineer' })).toEqual(['Jan Kowalski']);
  });

  it('matches the start of words, so a short company name finds only that company', async () => {
    const h = await harness();
    const csv = [
      'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
      'Anna,Bank,,,ING Bank,Analyst,01 Oct 2026',
      'Joanna,Boe,,,Boeing,Engineer,02 Sep 2026',
      'Marek,Agent,,,Digital Marketing Agency,Lead,03 Aug 2026',
      'Ewa,Young,,,EY,Consultant,04 Jul 2026',
      'Dan,Mouse,,,Disney,Producer,05 Jun 2026',
    ].join('\n');
    const names = async (args: Record<string, unknown>) =>
      (await call(h, 'linkedin_read_connections', { csv, ...args })).data!.connections.map((c: { name: string }) => c.name);
    expect(await names({ company: 'ING' })).toEqual(['Anna Bank']);
    expect(await names({ company: ['ey', 'boeing'] })).toEqual(['Joanna Boe', 'Ewa Young']);
    expect(await names({ query: 'ann' })).toEqual(['Anna Bank']);
    expect(await names({ query: 'ey' })).toEqual(['Ewa Young']);
  });

  it('counts connections per company, optionally without listing them', async () => {
    const h = await harness();
    const { data } = await call(h, 'linkedin_read_connections', { csv: CONNECTIONS_CSV, limit: 0, companyCounts: 1 });
    expect(data).toMatchObject({
      total: 3,
      matched: 3,
      connections: [],
      companies: [{ company: 'Analytical Engines', count: 2 }],
      companiesTotal: 2,
      withoutCompany: 0,
    });
    expect(data!.nextOffset).toBeUndefined();
    const filtered = await call(h, 'linkedin_read_connections', { csv: CONNECTIONS_CSV, query: 'grace', companyCounts: 10 });
    expect(filtered.data!.companies).toEqual([{ company: 'US Navy', count: 1 }]);
    expect((await call(h, 'linkedin_read_connections', { csv: CONNECTIONS_CSV })).data!.companies).toBeUndefined();
  });

  it('reads URLs, and refuses local files in remote mode', async () => {
    const remote = await harness({ mode: 'remote' });
    expect((await call(remote, 'linkedin_read_connections', { file: `${web.url}/Connections.csv` })).data!.total).toBe(3);
    const local = await call(remote, 'linkedin_read_connections', { file: join(files, 'Connections.csv') });
    expect(local.isError).toBe(true);
    expect(local.text).toMatch(/Local files cannot be read/);
  });

  it('reads the zip archive LinkedIn sends, and finds the newest export when given no file', async () => {
    const downloads = await mkdtemp(join(tmpdir(), 'linkedin-downloads-'));
    const archive = join(downloads, 'Basic_LinkedInDataExport_10-18-2026.zip');
    await writeFile(archive, zipArchive({ 'Profile.csv': 'First Name,Last Name', 'Connections.csv': CONNECTIONS_CSV }));
    const h = await harness({ localFileDirs: [downloads] });
    expect((await call(h, 'linkedin_read_connections', { file: archive, limit: 0 })).data).toEqual({ total: 3, matched: 3, offset: 0, connections: [] });
    expect((await call(h, 'linkedin_read_connections', { limit: 0 })).data).toEqual({ file: archive, total: 3, matched: 3, offset: 0, connections: [] });
  });

  it('passes over a newer export without Connections.csv, such as one requested for messages', async () => {
    const downloads = await mkdtemp(join(tmpdir(), 'linkedin-downloads-'));
    const older = join(downloads, 'Basic_LinkedInDataExport_10-18-2026.zip');
    const newer = join(downloads, 'Basic_LinkedInDataExport_10-20-2026.zip');
    await writeFile(older, zipArchive({ 'Connections.csv': CONNECTIONS_CSV }));
    await writeFile(newer, zipArchive({ 'messages.csv': 'CONVERSATION ID,FROM' }));
    await utimes(older, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const h = await harness({ localFileDirs: [downloads] });
    expect((await call(h, 'linkedin_read_connections', { limit: 0 })).data).toEqual({ file: older, total: 3, matched: 3, offset: 0, connections: [] });
    // Given by name, the archive without the connections is still refused.
    expect((await call(h, 'linkedin_read_connections', { file: newer })).text).toMatch(/^This zip archive has no Connections\.csv\./);
    // Only an archive without the connections is passed over: a newer Connections.csv that isn't one says so.
    await writeFile(join(downloads, 'Connections.csv'), 'Date,Amount\n2026-10-01,12.50\n');
    expect((await call(h, 'linkedin_read_connections')).text).toMatch(/^This is not a LinkedIn Connections\.csv/);
  });

  it('names the exports when none has Connections.csv', async () => {
    const downloads = await mkdtemp(join(tmpdir(), 'linkedin-downloads-'));
    const desktop = await mkdtemp(join(tmpdir(), 'linkedin-desktop-'));
    const archive = join(downloads, 'Basic_LinkedInDataExport_10-20-2026.zip');
    await writeFile(archive, zipArchive({ 'messages.csv': 'CONVERSATION ID,FROM' }));
    expect(await call(await harness({ localFileDirs: [downloads, desktop] }), 'linkedin_read_connections')).toMatchObject({
      isError: true,
      text:
        `The LinkedIn data export in ${downloads}, ${desktop} (${archive}) has no Connections.csv. Request your data again at ` +
        'https://www.linkedin.com/mypreferences/d/download-my-data, choose Connections, and save the zip archive LinkedIn emails you in one of those folders.',
    });
    const second = join(desktop, 'Basic_LinkedInDataExport_10-19-2026.zip');
    await writeFile(second, zipArchive({ 'Profile.csv': 'First Name,Last Name' }));
    await utimes(second, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    expect((await call(await harness({ localFileDirs: [downloads, desktop] }), 'linkedin_read_connections')).text).toBe(
      `The LinkedIn data exports in ${downloads}, ${desktop} (${archive}, ${second}) have no Connections.csv. Request your data again at ` +
        'https://www.linkedin.com/mypreferences/d/download-my-data, choose Connections, and save the zip archive LinkedIn emails you in one of those folders.',
    );
  });

  it('says how to get an export when none is found', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'linkedin-downloads-'));
    expect(await call(await harness({ localFileDirs: [empty] }), 'linkedin_read_connections')).toMatchObject({
      isError: true,
      text:
        `No LinkedIn data export was found in ${empty}. Request one at https://www.linkedin.com/mypreferences/d/download-my-data (choose Connections) ` +
        'and save the zip archive LinkedIn emails you in one of those folders, or pass its path.',
    });
  });

  it('needs file or csv in remote mode, not both, and rejects other files', async () => {
    expect((await call(await harness({ mode: 'remote' }), 'linkedin_read_connections')).text).toBe('Pass either file or csv.');
    const h = await harness();
    expect((await call(h, 'linkedin_read_connections', { file: join(files, 'Connections.csv'), csv: CONNECTIONS_CSV })).text).toBe(
      'Pass either file or csv, not both.',
    );
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

  it('explains a missing openid/profile scope and publishes nothing', async () => {
    const h = await harness();
    h.linkedin.override(({ url }) =>
      url.pathname === '/v2/userinfo' ? Response.json({ message: 'Not enough permissions' }, { status: 403 }) : undefined,
    );
    const result = await call(h, 'linkedin_create_post', { text: 'Hello' });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('"openid" and "profile" scopes') });
    expect(h.linkedin.find('POST', '/rest/posts')).toHaveLength(0);
  });

  it("reports why the member couldn't be looked up, and publishes nothing", async () => {
    const h = await harness();
    h.linkedin.override(({ url }) => (url.pathname === '/v2/userinfo' ? Response.json({ message: 'Service unavailable' }, { status: 503 }) : undefined));
    const result = await call(h, 'linkedin_create_post', { text: 'Hello' });
    expect(result).toMatchObject({ isError: true, text: 'LinkedIn had an internal problem (HTTP 503): Service unavailable. Try again in a moment.' });
    expect(h.linkedin.find('POST', '/rest/posts')).toHaveLength(0);
    expect(h.auth.member).toBeUndefined();
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

  it('uploads a document from a URL, titled after the file without its extension', async () => {
    const h = await harness();
    const result = await call(h, 'linkedin_create_post', { text: 'Slides', document: { source: `${web.url}/talk.pdf` } });
    expect(result.data).toMatchObject({ attachment: 'document' });
    expect(h.linkedin.find('POST', '/rest/documents')).toHaveLength(1);
    expect(h.linkedin.find('POST', '/rest/posts')[0]!.json).toMatchObject({
      content: { media: { id: expect.stringMatching(/^urn:li:document:/), title: 'talk' } },
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

  it("posts without the page's own image when LinkedIn won't take it", async () => {
    const h = await harness();
    h.linkedin.override((r) => (r.url.pathname === '/rest/images' ? Response.json({ message: 'Upload unavailable' }, { status: 500 }) : undefined));
    const url = `${web.url}/article`;
    const result = await call(h, 'linkedin_create_post', { text: 'Read this', article: { url } });
    expect(result).toMatchObject({ isError: false, data: { linkPreview: { title: 'Engines & Ideas', description: 'A note.', thumbnail: false } } });
    expect(h.linkedin.find('POST', '/rest/posts')[0]!.json).toMatchObject({
      content: { article: { source: url, title: 'Engines & Ideas', description: 'A note.' } },
    });
    expect((h.linkedin.find('POST', '/rest/posts')[0]!.json as any).content.article).not.toHaveProperty('thumbnail');
  });

  it("fails without publishing when LinkedIn won't take the thumbnail the user chose", async () => {
    const h = await harness();
    h.linkedin.override((r) => (r.url.pathname === '/rest/images' ? Response.json({ message: 'Upload unavailable' }, { status: 500 }) : undefined));
    const result = await call(h, 'linkedin_create_post', {
      text: 'Read this',
      article: { url: `${web.url}/article`, thumbnail: join(files, 'photo.png') },
    });
    expect(result).toMatchObject({ isError: true, text: 'LinkedIn had an internal problem (HTTP 500): Upload unavailable. Try again in a moment.' });
    expect(h.linkedin.find('POST', '/rest/posts')).toHaveLength(0);
  });

  it('reads the page only for the parts of the preview not given', async () => {
    const h = await harness();
    const url = `${web.url}/counted`;
    pageFetches = 0;
    const given = await call(h, 'linkedin_create_post', {
      text: 'Mine',
      article: { url, title: 'My title', description: 'My description', thumbnail: join(files, 'photo.png') },
    });
    expect(given.data).toMatchObject({ linkPreview: { title: 'My title', description: 'My description', thumbnail: true } });
    expect(pageFetches).toBe(0);

    const partly = await call(h, 'linkedin_create_post', { text: 'Mine', article: { url, description: 'My description' } });
    expect(partly.data).toMatchObject({ linkPreview: { title: 'Counted', description: 'My description', thumbnail: true } });
    expect(pageFetches).toBe(1);
  });

  it('titles a document without a file name "Document"', async () => {
    const h = await harness();
    await call(h, 'linkedin_create_post', { text: 'Deck', document: { source: `data:application/pdf;base64,${PDF.toString('base64')}` } });
    expect(h.linkedin.find('POST', '/rest/posts')[0]!.json).toMatchObject({ content: { media: { title: 'Document' } } });
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
    expect(failed).toMatchObject({ isError: true, text: 'LinkedIn could not process the uploaded image.' });
    const documents = await harness();
    documents.linkedin.assetStatus = 'PROCESSING_FAILED';
    const failedDocument = await call(documents, 'linkedin_create_post', { text: 'Deck', document: { source: `${web.url}/talk.pdf`, title: 'Deck' } });
    expect(failedDocument).toMatchObject({ isError: true, text: 'LinkedIn could not process the uploaded document.' });
    expect(documents.linkedin.find('POST', '/rest/posts')).toHaveLength(0);
  });

  it("posts without waiting when LinkedIn can't say whether an upload is ready, as it checks the upload when posting", async () => {
    const h = await harness();
    h.linkedin.override((request) =>
      request.method === 'GET' && request.url.pathname.startsWith('/rest/images/') ? Response.json({ message: 'Unavailable' }, { status: 503 }) : undefined,
    );
    expect((await call(h, 'linkedin_create_post', { text: 'Pic', images: [{ source: join(files, 'photo.png') }] })).isError).toBe(false);
    expect(h.linkedin.find('GET', '/rest/images/')).toHaveLength(1);
    expect(h.linkedin.find('POST', '/rest/posts')).toHaveLength(1);
  });

  /** Keeps every upload processing; records when LinkedIn was asked about each and when the post was created. */
  const stillProcessing = (h: Harness, clock: FakeClock, uploadMs = 0) => {
    const polls: number[] = [];
    let postedAt: number | undefined;
    h.linkedin.override((request) => {
      if (request.method === 'PUT') clock.time += uploadMs;
      if (request.method === 'POST' && request.url.pathname === '/rest/posts') postedAt = clock.time;
      if (request.method !== 'GET' || !/^\/rest\/(images|documents)\//.test(request.url.pathname)) return undefined;
      polls.push(clock.time);
      return new Response(JSON.stringify({ status: 'PROCESSING' }), { status: 200 });
    });
    return { polls, postedAt: () => postedAt };
  };

  it.each([
    ['a document', 'document', () => ({ document: { source: `${web.url}/talk.pdf` } })],
    ['an image', 'image', () => ({ images: [{ source: join(files, 'photo.png') }] })],
  ])('stops waiting for %s to process 45 seconds after the post was asked for, upload included, and publishes', async (_, attachment, media) => {
    const clock = new FakeClock();
    const h = await harness({ clock });
    // A large file on a slow connection: MCP clients often give up after 60 seconds, but the post would still go out.
    const linkedin = stillProcessing(h, clock, 35_000);
    const result = await call(h, 'linkedin_create_post', { text: 'Big file', ...media() });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ attachment });
    expect(linkedin.polls).toEqual([35_000, 35_500, 36_500, 38_500, 42_500]);
    expect(linkedin.postedAt()).toBe(42_500);
  });

  it('waits up to 15 seconds for each image', async () => {
    const clock = new FakeClock();
    const h = await harness({ clock });
    const linkedin = stillProcessing(h, clock);
    const photo = { source: join(files, 'photo.png') };
    expect((await call(h, 'linkedin_create_post', { text: 'Two', images: [photo, photo] })).isError).toBe(false);
    expect(linkedin.polls).toEqual([0, 500, 1_500, 3_500, 7_500, 11_500, 11_500, 12_000, 13_000, 15_000, 19_000, 23_000]);
    expect(linkedin.postedAt()).toBe(23_000);
  });

  it('posts as a Page when allowed', async () => {
    const h = await harness({ scopes: [...DEFAULT_SCOPES, 'w_organization_social'] });
    const result = await call(h, 'linkedin_create_post', { text: 'Company news', organization: '2414183' });
    expect(result.data).toMatchObject({ author: 'urn:li:organization:2414183' });
    expect(h.linkedin.find('GET', '/v2/userinfo')).toHaveLength(0);
  });

  it("accepts the address of the Page's admin view as the Page", async () => {
    const h = await harness({ scopes: [...DEFAULT_SCOPES, 'w_organization_social'] });
    const result = await call(h, 'linkedin_create_post', { text: 'Company news', organization: 'https://www.linkedin.com/company/2414183/admin/dashboard/' });
    expect(result.data).toMatchObject({ author: 'urn:li:organization:2414183' });
  });

  it("keeps a Page's posts public, before anything is uploaded", async () => {
    const h = await harness({ scopes: [...DEFAULT_SCOPES, 'w_organization_social'] });
    const args = { text: 'Company news', organization: '2414183', visibility: 'CONNECTIONS', images: [{ source: join(files, 'photo.png') }] };
    for (const name of ['linkedin_preview_post', 'linkedin_create_post']) {
      expect(await call(h, name, args)).toEqual({
        isError: true,
        data: undefined,
        text: 'A Page has followers, not connections, so its posts are public. Leave out visibility, or set it to PUBLIC.',
      });
    }
    expect(h.linkedin.requests).toHaveLength(0);
    expect((await call(h, 'linkedin_create_post', { text: 'For my network', visibility: 'CONNECTIONS' })).data).toMatchObject({ visibility: 'CONNECTIONS' });
  });

  it('never calls a post LinkedIn accepted rejected, so it is not published twice', async () => {
    const h = await harness();
    h.linkedin.override((r) => (r.method === 'POST' && r.url.pathname === '/rest/posts' ? new Response(null, { status: 201 }) : undefined));
    expect(await call(h, 'linkedin_create_post', { text: 'My news' })).toMatchObject({
      isError: true,
      text: 'LinkedIn accepted the post but did not return its ID, so it has probably been published. Look for it on LinkedIn before trying again, so it is not published twice.',
    });
  });

  it('says a post may have been published when LinkedIn failed without saying, rather than to try again', async () => {
    const h = await harness({ scopes: [...DEFAULT_SCOPES, 'w_organization_social'] });
    let failure: () => Response = () => Response.json({ message: 'Gateway Timeout' }, { status: 504 });
    h.linkedin.override((r) => (r.method === 'POST' && r.url.pathname === '/rest/posts' ? failure() : undefined));
    const check = 'The post may have been published anyway: look for it among your recent activity on LinkedIn before trying again, so it is not published twice.';
    expect(await call(h, 'linkedin_create_post', { text: 'My news' })).toEqual({
      isError: true,
      data: undefined,
      text: `LinkedIn had an internal problem (HTTP 504): Gateway Timeout. ${check}`,
    });
    failure = () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    expect((await call(h, 'linkedin_create_post', { text: 'My news' })).text).toBe(`LinkedIn did not answer in time. ${check}`);
    failure = () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
    };
    expect((await call(h, 'linkedin_create_post', { text: 'My news' })).text).toBe(`The connection to LinkedIn broke (UND_ERR_SOCKET). ${check}`);
    expect((await call(h, 'linkedin_create_post', { text: 'Company news', organization: '2414183' })).text).toBe(
      "The connection to LinkedIn broke (UND_ERR_SOCKET). The post may have been published anyway: look for it among the Page's posts on LinkedIn before trying again, so it is not published twice.",
    );
    // A request that never reached LinkedIn, or that it turned away, can be sent again.
    failure = () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.linkedin.com'), { code: 'ENOTFOUND' }) });
    };
    expect((await call(h, 'linkedin_create_post', { text: 'My news' })).text).toBe(
      'Could not reach LinkedIn (ENOTFOUND). Check the internet connection and try again.',
    );
    failure = () => Response.json({ message: 'Unavailable' }, { status: 503 });
    expect((await call(h, 'linkedin_create_post', { text: 'My news' })).text).toBe('LinkedIn had an internal problem (HTTP 503): Unavailable. Try again in a moment.');
    // Nothing is published before the post itself.
    h.linkedin.override((r) => {
      if (r.method === 'POST' && r.url.pathname === '/rest/images') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    expect((await call(h, 'linkedin_create_post', { text: 'Pic', images: [{ source: join(files, 'photo.png') }] })).text).toBe(
      'LinkedIn did not respond in time. Try again.',
    );
  });

  const unconfirmed = 'The post may have been published anyway: look for it among your recent activity on LinkedIn before trying again, so it is not published twice.';
  const network = (code?: string) => new TypeError('fetch failed', code ? { cause: Object.assign(new Error(code), { code }) } : undefined);
  it.each<[string, () => Response, string]>([
    ['a 502', () => Response.json({ message: 'Bad Gateway' }, { status: 502 }), `LinkedIn had an internal problem (HTTP 502): Bad Gateway. ${unconfirmed}`],
    ['an abort', () => { throw new DOMException('aborted', 'AbortError'); }, `LinkedIn did not answer in time. ${unconfirmed}`],
    ['a network failure without a code', () => { throw network(); }, `The connection to LinkedIn broke. ${unconfirmed}`],
    ['ECONNRESET', () => { throw network('ECONNRESET'); }, `The connection to LinkedIn broke (ECONNRESET). ${unconfirmed}`],
    ['EAI_AGAIN', () => { throw network('EAI_AGAIN'); }, 'Could not reach LinkedIn (EAI_AGAIN). Check the internet connection and try again.'],
    ['ECONNREFUSED', () => { throw network('ECONNREFUSED'); }, 'Could not reach LinkedIn (ECONNREFUSED). Check the internet connection and try again.'],
    ['EHOSTUNREACH', () => { throw network('EHOSTUNREACH'); }, 'Could not reach LinkedIn (EHOSTUNREACH). Check the internet connection and try again.'],
    ['ENETUNREACH', () => { throw network('ENETUNREACH'); }, 'Could not reach LinkedIn (ENETUNREACH). Check the internet connection and try again.'],
    ['UND_ERR_CONNECT_TIMEOUT', () => { throw network('UND_ERR_CONNECT_TIMEOUT'); }, 'Could not reach LinkedIn (UND_ERR_CONNECT_TIMEOUT). Check the internet connection and try again.'],
    ['a 429', () => Response.json({ message: 'Slow down' }, { status: 429 }), "LinkedIn's rate limit was reached. Try again later."],
    ['a 422', () => Response.json({ message: 'Bad field' }, { status: 422 }), 'LinkedIn rejected the request (HTTP 422): Bad field.'],
    ['a bug', () => { throw new TypeError("Cannot read properties of undefined (reading 'id')"); }, "Unexpected error: Cannot read properties of undefined (reading 'id')"],
    ['an unknown error', () => { throw new Error('boom'); }, 'Unexpected error: boom'],
  ])('after %s, says whether the post may have been published', async (_name, failure, text) => {
    const h = await harness();
    h.linkedin.override((r) => (r.method === 'POST' && r.url.pathname === '/rest/posts' ? failure() : undefined));
    expect(await call(h, 'linkedin_create_post', { text: 'My news' })).toEqual({ isError: true, data: undefined, text });
  });

  it("explains that only a Page's admins can post as it, since signing in again won't help", async () => {
    const h = await harness({ scopes: [...DEFAULT_SCOPES, 'w_organization_social'] });
    h.linkedin.override((r) =>
      r.method === 'POST' && r.url.pathname.startsWith('/rest/images') ? new Response('{"message":"Not enough permissions"}', { status: 403 }) : undefined,
    );
    const photo = { images: [{ source: join(files, 'photo.png') }] };
    expect((await call(h, 'linkedin_create_post', { text: 'Company news', organization: '2414183', ...photo })).text).toBe(
      "LinkedIn didn't let you act as the Page urn:li:organization:2414183: Not enough permissions. " +
        "Only a Page's super admins and content admins can post, comment and react as it: check your role on the Page, and that it is the right Page.",
    );
    // As the member, a 403 is about the app's products or the sign-in.
    expect((await call(h, 'linkedin_create_post', { text: 'My news', ...photo })).text).toMatch(/^LinkedIn denied permission for this action: Not enough permissions\./);
    expect(h.linkedin.find('POST', '/rest/posts')).toHaveLength(0);
    // Other refusals keep their own explanation.
    h.linkedin.override((r) => (r.method === 'POST' && r.url.pathname === '/rest/posts' ? new Response('{"message":"Duplicate post"}', { status: 422 }) : undefined));
    expect((await call(h, 'linkedin_create_post', { text: 'Company news', organization: '2414183' })).text).toBe(
      'LinkedIn rejected the request (HTTP 422): Duplicate post.',
    );
  });

  it('signs in again when the sign-in predates posting as Pages', async () => {
    const h = await harness({ scopes: [...DEFAULT_SCOPES, 'w_organization_social'] });
    h.auth.scopes = DEFAULT_SCOPES;
    expect(await call(h, 'linkedin_create_post', { text: 'Company news', organization: '2414183' })).toEqual({
      isError: true,
      data: undefined,
      text:
        'Your LinkedIn sign-in predates turning on "Post as LinkedIn Pages" (LINKEDIN_PAGES), so LinkedIn doesn\'t allow this yet. ' +
        "The LinkedIn sign-in page is open in your browser; if it didn't appear, open this link (valid for 10 minutes): " +
        `https://www.linkedin.com/oauth/v2/authorization?state=x ${CHECK_APP} Once you have approved access, try again.`,
    });
    expect(h.auth.logins).toBe(1);
    expect(h.linkedin.requests).toHaveLength(0);
    // Posting as yourself needs nothing new.
    expect((await call(h, 'linkedin_create_post', { text: 'My news' })).isError).toBe(false);
  });

  it('refuses to act as a Page when Pages are not turned on, rather than posting as the member', async () => {
    const h = await harness();
    const create = (await h.client.listTools()).tools.find((t) => t.name === 'linkedin_create_post')!;
    expect(create.inputSchema.additionalProperties).toBe(false);
    for (const name of ['linkedin_create_post', 'linkedin_preview_post']) {
      expect(await call(h, name, { text: 'Company news', organization: '2414183' })).toEqual({
        isError: true,
        data: undefined,
        text: `Input validation error: Invalid arguments for tool ${name}: ${PAGES_OFF}`,
      });
    }
    // Other mistakes keep their own explanation.
    const invalid = 'Input validation error: Invalid arguments for tool linkedin_create_post: ';
    expect((await call(h, 'linkedin_create_post', { text: 'Hi', visibilty: 'CONNECTIONS' })).text).toBe(`${invalid}Unrecognized key: "visibilty"`);
    expect((await call(h, 'linkedin_create_post', { text: '' })).text).toBe(`${invalid}text: Too small: expected string to have >=1 characters`);
    expect(h.linkedin.requests).toHaveLength(0);
  });

  it('refuses arguments it does not know instead of ignoring them', async () => {
    const h = await harness({ scopes: [...DEFAULT_SCOPES, 'w_organization_social'] });
    expect((await call(h, 'linkedin_create_post', { text: 'Only for my network', visibilty: 'CONNECTIONS' })).text).toBe(
      'Input validation error: Invalid arguments for tool linkedin_create_post: Unrecognized key: "visibilty"',
    );
    expect(h.linkedin.requests).toHaveLength(0);
  });

  it('refuses unknown keys in images, documents and links, which would otherwise publish without them', async () => {
    const h = await harness();
    const create = (await h.client.listTools()).tools.find((t) => t.name === 'linkedin_create_post')!;
    const properties = create.inputSchema.properties as Record<string, { additionalProperties?: boolean; items?: { additionalProperties?: boolean } }>;
    expect([properties.article!.additionalProperties, properties.images!.items!.additionalProperties, properties.document!.additionalProperties]).toEqual([
      false,
      false,
      false,
    ]);
    const photo = join(files, 'photo.png');
    for (const name of ['linkedin_create_post', 'linkedin_preview_post']) {
      const invalid = `Input validation error: Invalid arguments for tool ${name}: `;
      expect((await call(h, name, { text: 'Our results', images: [{ source: photo, alt_text: 'A chart' }] })).text).toBe(
        `${invalid}images.0: Unrecognized key: "alt_text"`,
      );
      expect((await call(h, name, { text: 'Our results', document: { source: photo, name: 'Q3 results' } })).text).toBe(
        `${invalid}document: Unrecognized key: "name"`,
      );
      expect((await call(h, name, { text: 'Our results', article: { url: 'https://example.com/q3', image: photo } })).text).toBe(
        `${invalid}article: Unrecognized key: "image"`,
      );
    }
    expect(h.linkedin.requests).toHaveLength(0);
  });
});

describe('linkedin_preview_post', () => {
  it('checks a post without signing in or calling LinkedIn, and flags Markdown', async () => {
    const auth = new StubLocalAuth();
    auth.signedIn = false;
    const h = await harness({ auth });
    const result = await call(h, 'linkedin_preview_post', { text: 'Big **news** from @Grace', visibility: 'CONNECTIONS' });
    expect(result.isError).toBe(false);
    expect(result.data).toEqual({
      characters: 24,
      visibility: 'CONNECTIONS',
      attachment: 'none',
      warnings: [
        'The text uses Markdown bold (**like this**), which LinkedIn shows literally, asterisks and all.',
        '@mentions don\'t tag anyone: "@Name" shows as plain text and nobody is notified.',
      ],
    });
    expect(h.linkedin.requests).toHaveLength(0);
  });

  it('shows the link preview card the post will get', async () => {
    const h = await harness();
    const url = `${web.url}/article`;
    const { data } = await call(h, 'linkedin_preview_post', { text: 'Read this', article: { url } });
    expect(data).toEqual({
      characters: 9,
      visibility: 'PUBLIC',
      attachment: 'article',
      linkPreview: { url, title: 'Engines & Ideas', description: 'A note.', thumbnail: true, imageUrl: `${web.url}/card.png` },
      warnings: [],
    });
    expect(h.linkedin.requests).toHaveLength(0);
  });

  it('warns when the link preview would come out bare', async () => {
    const h = await harness();
    const hostname = new URL(web.url).hostname;
    const bare = await call(h, 'linkedin_preview_post', { text: 'Look', article: { url: `${web.url}/bare` } });
    expect(bare.data!.linkPreview).toEqual({ url: `${web.url}/bare`, title: hostname, thumbnail: false });
    expect(bare.data!.warnings).toEqual([
      `The link preview's title is just "${hostname}": the page has none. Pass article.title (and description) to set it.`,
      'The link preview has no image: the page offers none in JPEG, PNG or GIF. Pass article.thumbnail to add one.',
    ]);

    const webp = await call(h, 'linkedin_preview_post', { text: 'Look', article: { url: `${web.url}/webp-card` } });
    expect(webp.data!.linkPreview).toEqual({ url: `${web.url}/webp-card`, title: 'Modern', thumbnail: false });
    expect(webp.data!.warnings).toEqual(['The link preview has no image: the page offers none in JPEG, PNG or GIF. Pass article.thumbnail to add one.']);

    const missing = `${web.url}/missing-page`;
    const unreadable = await call(h, 'linkedin_preview_post', { text: 'Look', article: { url: missing } });
    expect(unreadable.data!.warnings).toEqual([
      `The link preview's title is just "${hostname}": ${missing} could not be read. Pass article.title (and description) to set it.`,
      'The link preview has no image. Pass article.thumbnail to add one.',
    ]);
    const withThumbnail = await call(h, 'linkedin_preview_post', {
      text: 'Look',
      article: { url: missing, title: 'Mine', thumbnail: join(files, 'photo.png') },
    });
    expect(withThumbnail.data!.linkPreview).toEqual({ url: missing, title: 'Mine', thumbnail: true });
    expect(withThumbnail.data!.warnings).toEqual([]);
  });

  it('warns that a link in the text gets no preview card, unless it is also the article', async () => {
    const h = await harness();
    const linked = await call(h, 'linkedin_preview_post', { text: 'Out now: https://example.com/launch' });
    expect(linked.data!.warnings).toEqual([
      'The text has a link, but LinkedIn shows no preview card for links in the text. To show one, also pass the link as article.url.',
    ]);
    expect((await call(h, 'linkedin_preview_post', { text: 'Out now (HTTP://example.com)' })).data!.warnings).toHaveLength(1);
    expect((await call(h, 'linkedin_preview_post', { text: 'Always use https:// for logins' })).data!.warnings).toEqual([]);
    const url = `${web.url}/article`;
    expect((await call(h, 'linkedin_preview_post', { text: `Read ${url}`, article: { url } })).data!.warnings).toEqual([]);
    // A post with images can't have a card as well.
    const photo = { images: [{ source: join(files, 'photo.png') }] };
    expect((await call(h, 'linkedin_preview_post', { text: 'More on https://example.com', ...photo })).data!.warnings).toEqual([]);
  });

  it('says by how much text is too long, which Claude cannot count', async () => {
    const h = await harness({ scopes: [...DEFAULT_SCOPES, 'w_member_social_feed'] });
    const invalid = (name: string, text: string) => ({ isError: true, data: undefined, text: `Input validation error: Invalid arguments for tool ${name}: text: ${text}` });
    const long = 'x'.repeat(3214);
    const tooLong = 'The post text is 3214 characters long; LinkedIn allows 3000. Shorten it by at least 214 characters.';
    expect(await call(h, 'linkedin_preview_post', { text: long })).toEqual(invalid('linkedin_preview_post', tooLong));
    expect(await call(h, 'linkedin_create_post', { text: long })).toEqual(invalid('linkedin_create_post', tooLong));
    expect(await call(h, 'linkedin_edit_post', { post: 'urn:li:share:1', text: long })).toEqual(invalid('linkedin_edit_post', tooLong));
    expect(await call(h, 'linkedin_comment_on_post', { post: 'urn:li:share:1', text: 'x'.repeat(1251) })).toEqual(
      invalid('linkedin_comment_on_post', 'The comment is 1251 characters long; LinkedIn allows 1250. Shorten it by at least 1 character.'),
    );
    expect(h.linkedin.requests).toHaveLength(0);
    expect((await call(h, 'linkedin_preview_post', { text: 'x'.repeat(3000) })).data).toMatchObject({ characters: 3000 });
    expect((await call(h, 'linkedin_comment_on_post', { post: 'urn:li:share:1', text: 'x'.repeat(1250) })).isError).toBe(false);
  });

  it('counts an emoji as one character, as the limit does', async () => {
    const h = await harness();
    // 3001 characters, but 3011 UTF-16 units: an emoji is two of those.
    const text = `${'x'.repeat(2990)}${'🚀'.repeat(11)}`;
    expect((await call(h, 'linkedin_create_post', { text })).text).toBe(
      'Input validation error: Invalid arguments for tool linkedin_create_post: text: The post text is 3001 characters long; LinkedIn allows 3000. Shorten it by at least 1 character.',
    );
    expect((await call(h, 'linkedin_preview_post', { text: '🚀'.repeat(3000) })).data).toMatchObject({ characters: 3000 });
    expect((await call(h, 'linkedin_preview_post', { text: 'Launch 🚀' })).data).toMatchObject({ characters: 8 });
  });

  it('treats a blank title, description, thumbnail or alt text as not given', async () => {
    const h = await harness();
    const article = await call(h, 'linkedin_preview_post', { text: 'Read', article: { url: `${web.url}/article`, title: '', description: ' ', thumbnail: '' } });
    expect(article.data).toMatchObject({ linkPreview: { title: 'Engines & Ideas', description: 'A note.', thumbnail: true }, warnings: [] });
    await call(h, 'linkedin_create_post', { text: 'Slides', document: { source: `${web.url}/talk.pdf`, title: '' } });
    await call(h, 'linkedin_create_post', { text: 'Pic', images: [{ source: join(files, 'photo.png'), altText: '  ' }] });
    const [slides, pic] = h.linkedin.find('POST', '/rest/posts').map((r) => r.json as { content: { media: Record<string, unknown> } });
    expect(slides!.content.media.title).toBe('talk');
    expect(pic!.content.media).not.toHaveProperty('altText');
  });

  it('checks images and documents, and reports problems before anything is approved', async () => {
    const h = await harness();
    const images = await call(h, 'linkedin_preview_post', {
      text: 'Album',
      images: [{ source: join(files, 'photo.png') }, { source: `data:image/png;base64,${PNG.toString('base64')}` }],
    });
    expect(images.data).toMatchObject({ attachment: 'images', images: 2, warnings: [] });
    const document = await call(h, 'linkedin_preview_post', { text: 'Slides', document: { source: `${web.url}/talk.pdf` } });
    expect(document.data).toMatchObject({ attachment: 'document', document: { title: 'talk' } });
    const wrong = await call(h, 'linkedin_preview_post', { text: 'Slides', images: [{ source: `${web.url}/talk.pdf` }] });
    expect(wrong).toMatchObject({ isError: true, text: expect.stringContaining("is a PDF, not a JPEG, PNG or GIF image. Attach it as the post's document instead.") });
    expect(h.linkedin.requests).toHaveLength(0);
  });

  it('does not read the page when the whole preview is given, but checks the thumbnail', async () => {
    const h = await harness();
    const url = `${web.url}/counted`;
    pageFetches = 0;
    const given = await call(h, 'linkedin_preview_post', {
      text: 'Mine',
      article: { url, title: 'My title', description: 'My description', thumbnail: join(files, 'photo.png') },
    });
    expect(given.data).toMatchObject({
      linkPreview: { url, title: 'My title', description: 'My description', thumbnail: true },
      warnings: [],
    });
    expect(given.data!.linkPreview.imageUrl).toBeUndefined();
    expect(pageFetches).toBe(0);

    const unusable = await call(h, 'linkedin_preview_post', {
      text: 'Mine',
      article: { url, title: 'My title', description: 'My description', thumbnail: `${web.url}/talk.pdf` },
    });
    expect(unusable).toMatchObject({ isError: true, text: expect.stringContaining('/talk.pdf" is a PDF, not a JPEG, PNG or GIF image.') });
  });

  it('shows the title a document will get', async () => {
    const h = await harness();
    const untitled = await call(h, 'linkedin_preview_post', { text: 'Deck', document: { source: `data:application/pdf;base64,${PDF.toString('base64')}` } });
    expect(untitled.data).toMatchObject({ attachment: 'document', document: { title: 'Document' } });
    const titled = await call(h, 'linkedin_preview_post', { text: 'Deck', document: { source: `${web.url}/talk.pdf`, title: 'Q3 results' } });
    expect(titled.data).toMatchObject({ document: { title: 'Q3 results' } });
  });

  it.each([
    ['notes.doc', 'notes'],
    ['deck.ppt', 'deck'],
    ['Deck.PPTX', 'Deck'],
    ['report.docx', 'report'],
    ['q3.pdf.final.pdf', 'q3.pdf.final'],
    ['slides.key', 'slides.key'],
  ])('titles a document named %s "%s"', async (name, title) => {
    const h = await harness();
    const { data } = await call(h, 'linkedin_preview_post', { text: 'Deck', document: { source: `${web.url}/docs/${name}` } });
    expect(data!.document).toEqual({ title });
  });

  it.each([
    ['/download?id=7', 'Q3 results – final'],
    ['/file', 'Board deck'],
    ['/path-in-name', 'deck'],
  ])('titles a document from %s by the file name its server gives, "%s"', async (path, title) => {
    const h = await harness();
    const { data } = await call(h, 'linkedin_preview_post', { text: 'Deck', document: { source: `${web.url}${path}` } });
    expect(data!.document).toEqual({ title });
  });

  it('is what Claude is told to check posts with', async () => {
    const h = await harness();
    expect(h.client.getInstructions()).toContain('Before asking for approval of a post, check it with linkedin_preview_post');
    const create = (await h.client.listTools()).tools.find((t) => t.name === 'linkedin_create_post')!;
    expect(create.description).toContain('Check it with linkedin_preview_post first');
  });

  it('checks the Page ID', async () => {
    const h = await harness({ scopes: [...DEFAULT_SCOPES, 'w_organization_social'] });
    const result = await call(h, 'linkedin_preview_post', { text: 'News', organization: 'acme' });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('"acme" is not a LinkedIn organization ID') });
  });
});

describe('post history', () => {
  let historyFile: string;
  let clock: number;
  const at = (iso: string) => {
    clock = Date.parse(iso);
  };
  const withHistory = async (options: { scopes?: string[] } = {}) => harness({ ...options, history: new PostHistory(historyFile, () => clock) });

  beforeEach(async () => {
    historyFile = join(await mkdtemp(join(tmpdir(), 'linkedin-history-')), 'posts.json');
  });

  it('is offered, and mentioned to Claude, only when there is a history', async () => {
    const h = await withHistory();
    expect((await h.client.listTools()).tools.map((t) => t.name)).toContain('linkedin_list_posts');
    expect(h.client.getInstructions()).toContain('find it with linkedin_list_posts');
    expect((await harness()).client.getInstructions()).not.toContain('linkedin_list_posts');
  });

  it('is where Claude checks whether a post that timed out went out, before posting again', async () => {
    const timedOut = 'If linkedin_create_post times out, the post may have been published anyway: ';
    expect((await withHistory()).client.getInstructions()).toContain(
      `${timedOut}check linkedin_list_posts before trying again, so it isn't published twice.`,
    );
    expect((await harness({ mode: 'remote' })).client.getInstructions()).toContain(
      `${timedOut}ask the user to look on LinkedIn before trying again, so it isn't published twice.`,
    );
  });

  it('remembers published posts, follows edits and forgets deleted ones', async () => {
    const h = await withHistory();
    at('2026-10-01T09:00:00Z');
    const first = (await call(h, 'linkedin_create_post', { text: 'Launch day (finally)!' })).data!;
    at('2026-10-02T09:00:00Z');
    const second = (await call(h, 'linkedin_create_post', { text: 'Slides', document: { source: `${web.url}/talk.pdf` }, visibility: 'CONNECTIONS' })).data!;

    expect((await call(h, 'linkedin_list_posts')).data).toEqual({
      matched: 2,
      posts: [
        {
          postUrn: second.postUrn,
          url: second.url,
          author: 'urn:li:person:abc123',
          text: 'Slides',
          visibility: 'CONNECTIONS',
          attachment: 'document',
          publishedAt: '2026-10-02T09:00:00.000Z',
        },
        {
          postUrn: first.postUrn,
          url: first.url,
          author: 'urn:li:person:abc123',
          text: 'Launch day (finally)!',
          visibility: 'PUBLIC',
          attachment: 'none',
          publishedAt: '2026-10-01T09:00:00.000Z',
        },
      ],
    });

    at('2026-10-03T09:00:00Z');
    expect((await call(h, 'linkedin_edit_post', { post: first.url, text: 'Launch day!' })).isError).toBe(false);
    expect((await call(h, 'linkedin_delete_post', { post: second.postUrn })).isError).toBe(false);
    expect((await call(h, 'linkedin_list_posts')).data).toEqual({
      matched: 1,
      posts: [expect.objectContaining({ postUrn: first.postUrn, text: 'Launch day!', editedAt: '2026-10-03T09:00:00.000Z' })],
    });
    expect(JSON.parse(await readFile(historyFile, 'utf8'))).toMatchObject({ version: 1, posts: [{ postUrn: first.postUrn }] });
  });

  it('finds posts by their text and limits how many it returns', async () => {
    const h = await withHistory();
    at('2026-10-01T09:00:00Z');
    for (const text of ['Hiring in Łódź', 'Our Q3 results', 'Hiring in Kraków']) await call(h, 'linkedin_create_post', { text });
    const texts = (data: Record<string, any> | undefined) => data!.posts.map((post: { text: string }) => post.text);
    const hiring = (await call(h, 'linkedin_list_posts', { query: 'HIRING IN LODZ' })).data;
    expect(texts(hiring)).toEqual(['Hiring in Łódź']);
    const limited = (await call(h, 'linkedin_list_posts', { query: 'hiring', limit: 1 })).data;
    expect(limited).toMatchObject({ matched: 2 });
    expect(texts(limited)).toEqual(['Hiring in Kraków']);
  });

  it('remembers who published a post as a Page', async () => {
    const h = await withHistory({ scopes: [...DEFAULT_SCOPES, 'w_organization_social'] });
    await call(h, 'linkedin_create_post', { text: 'Company news', organization: '2414183' });
    expect((await call(h, 'linkedin_list_posts')).data!.posts[0]).toMatchObject({ author: 'urn:li:organization:2414183' });
  });

  it('never fails a published post because the history cannot be written', async () => {
    const h = await harness({ history: new PostHistory(join(files, 'photo.png', 'posts.json')) });
    const result = await call(h, 'linkedin_create_post', { text: 'Still published' });
    expect(result).toMatchObject({ isError: false, data: { postUrn: expect.stringMatching(/^urn:li:share:/) } });
    expect((await call(h, 'linkedin_edit_post', { post: result.data!.postUrn, text: 'Edited' })).isError).toBe(false);
    expect((await call(h, 'linkedin_delete_post', { post: result.data!.postUrn })).isError).toBe(false);
  });

  it('keeps a post as it was when editing or deleting it fails', async () => {
    const h = await withHistory();
    at('2026-10-01T09:00:00Z');
    const { postUrn } = (await call(h, 'linkedin_create_post', { text: 'Original' })).data!;
    h.linkedin.override((r) =>
      r.url.pathname.startsWith('/rest/posts/') ? Response.json({ message: 'Not enough permissions' }, { status: 403 }) : undefined,
    );
    at('2026-10-02T09:00:00Z');
    expect((await call(h, 'linkedin_edit_post', { post: postUrn, text: 'Changed' })).isError).toBe(true);
    expect((await call(h, 'linkedin_delete_post', { post: postUrn })).isError).toBe(true);
    expect((await call(h, 'linkedin_list_posts')).data).toEqual({
      matched: 1,
      posts: [expect.objectContaining({ postUrn, text: 'Original', publishedAt: '2026-10-01T09:00:00.000Z' })],
    });
    expect((await call(h, 'linkedin_list_posts')).data!.posts[0].editedAt).toBeUndefined();
  });

  it('returns the 10 newest posts unless asked for more', async () => {
    const h = await withHistory();
    at('2026-10-01T09:00:00Z');
    for (let n = 1; n <= 12; n++) await call(h, 'linkedin_create_post', { text: `Post ${n}` });
    const texts = (data: Record<string, any> | undefined) => data!.posts.map((post: { text: string }) => post.text);
    const recent = (await call(h, 'linkedin_list_posts')).data;
    expect(recent).toMatchObject({ matched: 12 });
    expect(texts(recent)).toEqual(['Post 12', 'Post 11', 'Post 10', 'Post 9', 'Post 8', 'Post 7', 'Post 6', 'Post 5', 'Post 4', 'Post 3']);
    expect(texts((await call(h, 'linkedin_list_posts', { limit: 12 })).data)).toHaveLength(12);
    expect((await call(h, 'linkedin_list_posts', { query: '  ' })).data).toMatchObject({ matched: 12 });
    expect((await call(h, 'linkedin_list_posts', { limit: 0 })).isError).toBe(true);
  });

  it('remembers what each post carried', async () => {
    const h = await withHistory();
    await call(h, 'linkedin_create_post', { text: 'Link', article: { url: `${web.url}/article` } });
    await call(h, 'linkedin_create_post', { text: 'Pic', images: [{ source: join(files, 'photo.png') }] });
    await call(h, 'linkedin_create_post', { text: 'Album', images: [{ source: join(files, 'photo.png') }, { source: join(files, 'photo.png') }] });
    const posts = (await call(h, 'linkedin_list_posts')).data!.posts as Array<{ text: string; attachment: string }>;
    expect(posts.map(({ text, attachment }) => [text, attachment])).toEqual([
      ['Album', 'images'],
      ['Pic', 'image'],
      ['Link', 'article'],
    ]);
  });

  it('points the edit and delete tools at it only when there is one', async () => {
    const descriptions = async (h: Harness) =>
      Object.fromEntries((await h.client.listTools()).tools.map((t) => [t.name, t.description ?? '']));
    const withList = await descriptions(await withHistory());
    const without = await descriptions(await harness());
    for (const name of ['linkedin_edit_post', 'linkedin_delete_post']) {
      expect(withList[name]).toContain('linkedin_list_posts (which finds posts from earlier conversations)');
      expect(without[name]).toContain('Accepts the post URN returned by linkedin_create_post or the post URL.');
      expect(without[name]).not.toContain('linkedin_list_posts');
    }
  });

  it('does not remember posts that failed', async () => {
    const h = await withHistory();
    h.linkedin.override((r) => (r.method === 'POST' && r.url.pathname === '/rest/posts' ? Response.json({ message: 'Duplicate' }, { status: 422 }) : undefined));
    expect((await call(h, 'linkedin_create_post', { text: 'Twice' })).isError).toBe(true);
    expect((await call(h, 'linkedin_list_posts')).data).toEqual({ matched: 0, posts: [] });
  });
});

describe('linkedin_edit_post', () => {
  it('replaces the text, escaped', async () => {
    const h = await harness();
    const result = await call(h, 'linkedin_edit_post', { post: 'urn:li:share:42', text: 'Now with (fixed) typos' });
    expect(result.data).toEqual({ updated: true, postUrn: 'urn:li:share:42', url: 'https://www.linkedin.com/feed/update/urn:li:share:42/' });
    expect(h.linkedin.find('POST', '/rest/posts/')[0]!.json).toEqual({ patch: { $set: { commentary: 'Now with \\(fixed\\) typos' } } });
  });

  it('refuses arguments it does not know, rather than report a change it dropped', async () => {
    const h = await harness();
    const edit = (await h.client.listTools()).tools.find((t) => t.name === 'linkedin_edit_post')!;
    expect(edit.inputSchema.additionalProperties).toBe(false);
    expect(await call(h, 'linkedin_edit_post', { post: 'urn:li:share:42', text: 'For my network only', visibility: 'CONNECTIONS' })).toEqual({
      isError: true,
      data: undefined,
      text: 'Input validation error: Invalid arguments for tool linkedin_edit_post: Unrecognized key: "visibility"',
    });
    expect(h.linkedin.requests).toHaveLength(0);
  });
});

describe('editing and deleting errors', () => {
  const failWith = (h: Harness, status: number) =>
    h.linkedin.override((r) => (r.url.pathname.startsWith('/rest/posts/') ? Response.json({ message: 'Invalid post id' }, { status }) : undefined));

  it("reports LinkedIn's answer as is for a post's own URN", async () => {
    const h = await harness();
    failWith(h, 400);
    expect((await call(h, 'linkedin_edit_post', { post: 'urn:li:share:42', text: 'New' })).text).toBe(
      'LinkedIn rejected the request (HTTP 400): Invalid post id.',
    );
  });

  it('explains activity URNs for editing too, but not when LinkedIn itself failed', async () => {
    const h = await harness();
    failWith(h, 400);
    expect((await call(h, 'linkedin_edit_post', { post: 'urn:li:activity:7', text: 'New' })).text).toMatch(
      /^LinkedIn could not edit urn:li:activity:7\. This needs the post's share or ugcPost URN .* LinkedIn said: Invalid post id$/,
    );
    const failing = await harness();
    failWith(failing, 500);
    expect((await call(failing, 'linkedin_delete_post', { post: 'urn:li:activity:7' })).text).toBe(
      'LinkedIn had an internal problem (HTTP 500): Invalid post id. Try again in a moment.',
    );
  });
});

describe('linkedin_delete_post', () => {
  it('deletes by URL', async () => {
    const h = await harness();
    const result = await call(h, 'linkedin_delete_post', { post: 'https://www.linkedin.com/feed/update/urn:li:share:42/' });
    expect(result.data).toEqual({ deleted: true, postUrn: 'urn:li:share:42' });
    expect(h.linkedin.find('DELETE', '/rest/posts/')[0]!.url.pathname).toBe('/rest/posts/urn%3Ali%3Ashare%3A42');
  });

  it("explains that only a post's author can edit or delete it, rather than suggest signing in again", async () => {
    const forbidden = (h: Harness) =>
      h.linkedin.override((r) => (r.url.pathname.startsWith('/rest/posts/') ? Response.json({ message: 'Not enough permissions' }, { status: 403 }) : undefined));
    const h = await harness();
    forbidden(h);
    expect((await call(h, 'linkedin_edit_post', { post: 'urn:li:share:7', text: 'New' })).text).toBe(
      "LinkedIn didn't let you edit urn:li:share:7: Not enough permissions. Only its author can edit a post: check that you published it. " +
        "Signing in again won't help with that. To edit a Page's posts, \"Post as LinkedIn Pages\" (LINKEDIN_PAGES) must be turned on for this connector before you sign in.",
    );
    const pages = await harness({ scopes: [...DEFAULT_SCOPES, 'w_organization_social'] });
    forbidden(pages);
    expect((await call(pages, 'linkedin_delete_post', { post: 'urn:li:ugcPost:8' })).text).toBe(
      "LinkedIn didn't let you delete urn:li:ugcPost:8: Not enough permissions. Only its author can delete a post: check that you published it. " +
        "Signing in again won't help with that. If a Page published it, you need to be a super admin or content admin of the Page.",
    );
    // Without the scope to edit and delete posts, the sign-in is the problem after all.
    const unscoped = await harness({ scopes: ['openid', 'profile'] });
    forbidden(unscoped);
    expect((await call(unscoped, 'linkedin_delete_post', { post: 'urn:li:share:7' })).text).toMatch(/^LinkedIn denied permission for this action: .*linkedin_login/);
  });

  it('says LinkedIn could not be reached, even for an activity URN', async () => {
    const h = await harness();
    h.linkedin.override((r) => {
      if (r.method === 'DELETE') throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' }) });
      return undefined;
    });
    expect(await call(h, 'linkedin_delete_post', { post: 'urn:li:activity:7' })).toMatchObject({
      isError: true,
      text: 'Could not reach LinkedIn (ECONNRESET). Check the internet connection and try again.',
    });
  });

  it('explains when an activity URN cannot be deleted', async () => {
    const h = await harness();
    h.linkedin.override((r) => (r.method === 'DELETE' ? new Response('{"message":"Invalid post id"}', { status: 400 }) : undefined));
    const result = await call(h, 'linkedin_delete_post', { post: 'urn:li:activity:7' });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('not the activity URN that links copied from linkedin.com often contain') });
    expect(result.text).toMatch(/^LinkedIn could not delete urn:li:activity:7\. /);
    expect(result.text).toContain('"Embed this post"');
  });
});

describe('engagement tools', () => {
  const scopes = [...DEFAULT_SCOPES, 'w_member_social_feed', 'w_organization_social'];

  it('comments with escaped text', async () => {
    const h = await harness({ scopes });
    const result = await call(h, 'linkedin_comment_on_post', { post: 'urn:li:share:9', text: 'Congrats (well deserved)' });
    expect(result.data).toEqual({
      postUrn: 'urn:li:share:9',
      url: 'https://www.linkedin.com/feed/update/urn:li:share:9/',
      actor: 'urn:li:person:abc123',
      commentId: 'urn:li:comment:(urn:li:activity:1,1)',
    });
    expect(h.linkedin.find('POST', '/rest/socialActions/')[0]!.json).toMatchObject({ message: { text: 'Congrats \\(well deserved\\)' } });
  });

  it('says a comment may have been posted when LinkedIn failed without saying, rather than to try again', async () => {
    const h = await harness({ scopes });
    h.linkedin.override((r) => (r.method === 'POST' ? Response.json({ message: 'Internal error' }, { status: 500 }) : undefined));
    expect(await call(h, 'linkedin_comment_on_post', { post: 'urn:li:share:9', text: 'Congrats' })).toEqual({
      isError: true,
      data: undefined,
      text:
        'LinkedIn had an internal problem (HTTP 500): Internal error. The comment may have been posted anyway: ' +
        'look for it on https://www.linkedin.com/feed/update/urn:li:share:9/ before trying again, so it is not posted twice.',
    });
    // A reaction can be added again.
    expect((await call(h, 'linkedin_react_to_post', { post: 'urn:li:share:9' })).text).toBe(
      'LinkedIn had an internal problem (HTTP 500): Internal error. Try again in a moment.',
    );
  });

  it('maps friendly reaction names to API values', async () => {
    const h = await harness({ scopes });
    expect((await call(h, 'linkedin_react_to_post', { post: 'urn:li:share:9', reaction: 'insightful' })).data).toEqual({
      postUrn: 'urn:li:share:9',
      url: 'https://www.linkedin.com/feed/update/urn:li:share:9/',
      reaction: 'insightful',
      actor: 'urn:li:person:abc123',
    });
    await call(h, 'linkedin_react_to_post', { post: 'urn:li:share:9', organization: '77' });
    const reactions = h.linkedin.find('POST', '/rest/reactions');
    expect(reactions.map((r) => (r.json as { reactionType: string }).reactionType)).toEqual(['INTEREST', 'LIKE']);
    expect(reactions[1]!.url.searchParams.get('actor')).toBe('urn:li:organization:77');
  });

  it('requires a Page when only organization access is available', async () => {
    const h = await harness({ scopes: [...DEFAULT_SCOPES, 'w_organization_social'] });
    expect((await call(h, 'linkedin_react_to_post', { post: 'urn:li:share:9' })).text).toBe(
      'Commenting and reacting as yourself needs "Comments and reactions" (LINKEDIN_COMMENTS) turned on for this connector (Community Management API). Pass "organization" to act as a Page instead.',
    );
    const remote = await harness({ mode: 'remote', scopes: [...DEFAULT_SCOPES, 'w_organization_social'] });
    expect((await call(remote, 'linkedin_react_to_post', { post: 'urn:li:share:9' })).text).toBe(
      'Commenting and reacting as yourself needs LINKEDIN_COMMENTS turned on for this connector (Community Management API). Pass "organization" to act as a Page instead.',
    );
    expect(h.linkedin.requests).toHaveLength(0);
  });

  it('refuses to act as a Page when Pages are not turned on, rather than acting as the member', async () => {
    const h = await harness({ scopes: [...DEFAULT_SCOPES, 'w_member_social_feed'] });
    for (const [name, args] of [
      ['linkedin_comment_on_post', { post: 'urn:li:share:9', text: 'Congrats' }],
      ['linkedin_react_to_post', { post: 'urn:li:share:9' }],
    ] as const) {
      expect((await call(h, name, { ...args, organization: '77' })).text).toBe(`Input validation error: Invalid arguments for tool ${name}: ${PAGES_OFF}`);
    }
    // Only the server's operator can turn it on.
    const remote = await harness({ mode: 'remote', scopes: [...DEFAULT_SCOPES, 'w_member_social_feed'] });
    expect((await call(remote, 'linkedin_react_to_post', { post: 'urn:li:share:9', organization: '77' })).text).toBe(
      'Input validation error: Invalid arguments for tool linkedin_react_to_post: ' +
        'Acting as a Page needs LINKEDIN_PAGES turned on for this connector (Community Management API). Leave out "organization" to act as yourself.',
    );
    expect(h.linkedin.requests).toHaveLength(0);
  });

  it('signs in again when the sign-in predates comments and reactions', async () => {
    const h = await harness({ scopes });
    h.auth.scopes = [...DEFAULT_SCOPES, 'w_organization_social'];
    const result = await call(h, 'linkedin_comment_on_post', { post: 'urn:li:share:9', text: 'Congrats' });
    expect(result.text).toMatch(
      /^Your LinkedIn sign-in predates turning on "Comments and reactions" \(LINKEDIN_COMMENTS\), so LinkedIn doesn't allow this yet\. The LinkedIn sign-in page is open/,
    );
    expect(h.auth.logins).toBe(1);
    expect(h.linkedin.requests).toHaveLength(0);
    // Acting as a Page needs only Pages.
    expect((await call(h, 'linkedin_comment_on_post', { post: 'urn:li:share:9', text: 'Congrats', organization: '77' })).isError).toBe(false);
  });

  it('asks to reconnect in remote mode when the connection predates a feature', async () => {
    const h = await harness({ mode: 'remote', scopes });
    h.auth.scopes = DEFAULT_SCOPES;
    expect((await call(h, 'linkedin_react_to_post', { post: 'urn:li:share:9', organization: '77' })).text).toBe(
      "Your LinkedIn connection predates LINKEDIN_PAGES being turned on for this connector, so LinkedIn doesn't allow this yet. " +
        "Disconnect and reconnect the LinkedIn connector in Claude's settings.",
    );
    expect(h.linkedin.requests).toHaveLength(0);
  });

  it("explains a refusal without suggesting a new sign-in: only a Page's admins act as it, and a post may refuse the member", async () => {
    const h = await harness({ scopes });
    h.linkedin.override((r) =>
      r.url.pathname.startsWith('/rest/socialActions/') || r.url.pathname === '/rest/reactions' ? new Response('{"message":"Forbidden"}', { status: 403 }) : undefined,
    );
    for (const [name, args, action] of [
      ['linkedin_comment_on_post', { post: 'urn:li:share:9', text: 'Congrats' }, 'comment on'],
      ['linkedin_react_to_post', { post: 'urn:li:share:9' }, 'react to'],
    ] as const) {
      expect((await call(h, name, { ...args, organization: '77' })).text).toMatch(/^LinkedIn didn't let you act as the Page urn:li:organization:77: Forbidden\. Only a Page's/);
      expect((await call(h, name, args)).text).toBe(
        `LinkedIn didn't let you ${action} urn:li:share:9: Forbidden. Check on linkedin.com that you can see the post and ${action} it. ` +
          "Your sign-in has the permission for this, so signing in again won't help.",
      );
    }
    // Other refusals keep the generic explanation.
    const duplicate = await harness({ scopes });
    duplicate.linkedin.override((r) => (r.url.pathname === '/rest/reactions' ? new Response('{"message":"Duplicate"}', { status: 409 }) : undefined));
    expect((await call(duplicate, 'linkedin_react_to_post', { post: 'urn:li:share:9' })).text).toBe('LinkedIn rejected the request (HTTP 409): Duplicate.');
  });
});

describe('errors', () => {
  it('opens the sign-in page when the user is not signed in, and gives the link while it waits', async () => {
    const auth = new StubLocalAuth();
    auth.signedIn = false;
    const h = await harness({ auth });
    expect(await call(h, 'linkedin_create_post', { text: 'x' })).toEqual({
      isError: true,
      data: undefined,
      text:
        "You are not signed in to LinkedIn. The LinkedIn sign-in page is open in your browser; if it didn't appear, open this link (valid for 10 minutes): " +
        `https://www.linkedin.com/oauth/v2/authorization?state=x ${CHECK_APP} Once you have approved access, try again.`,
    });
    expect(auth.logins).toBe(1);
    expect(h.linkedin.requests).toHaveLength(0);
  });

  it('asks Claude to call the tool again once the user finished signing in', async () => {
    const auth = new StubLocalAuth();
    auth.signedIn = false;
    auth.completion = Promise.resolve('Ada Lovelace');
    const h = await harness({ auth });
    expect(await call(h, 'linkedin_create_post', { text: 'x' })).toMatchObject({
      isError: true,
      text: 'Signed in to LinkedIn as Ada Lovelace. Nothing was done yet: call linkedin_create_post again to continue.',
    });
    expect(h.linkedin.requests).toHaveLength(0);
  });

  it('signs in again when LinkedIn rejects the stored token, after forgetting it', async () => {
    const auth = new StubLocalAuth();
    const rejected: LinkedInSession[] = [];
    auth.rejected = async (session) => {
      rejected.push(session);
      auth.signedIn = false;
      return true;
    };
    const h = await harness({ auth });
    h.linkedin.override(() => Response.json({ message: 'Invalid access token' }, { status: 401 }));
    expect(await call(h, 'linkedin_get_profile')).toMatchObject({
      isError: true,
      text:
        "LinkedIn rejected your sign-in: it has expired or been revoked. The LinkedIn sign-in page is open in your browser; if it didn't appear, open this link " +
        `(valid for 10 minutes): https://www.linkedin.com/oauth/v2/authorization?state=x ${CHECK_APP} Once you have approved access, try again.`,
    });
    expect(rejected).toEqual([expect.objectContaining({ accessToken: 'li-token' })]);
    expect(auth.logins).toBe(1);
  });

  it('only says how to sign in again when it cannot forget the rejected token', async () => {
    const auth = new StubLocalAuth();
    auth.rejected = async () => false;
    const h = await harness({ auth });
    h.linkedin.override(() => Response.json({ message: 'Invalid access token' }, { status: 401 }));
    expect((await call(h, 'linkedin_get_profile')).text).toMatch(/^LinkedIn rejected the access token \(it has expired or been revoked\)\. To sign in again, run the linkedin_login/);
    auth.rejected = async () => {
      throw new Error('EACCES');
    };
    expect((await call(h, 'linkedin_get_profile')).text).toMatch(/^LinkedIn rejected the access token/);
    expect(auth.logins).toBe(0);
  });

  it('says to replace LINKEDIN_ACCESS_TOKEN when LinkedIn rejects it, since a sign-in would not replace it', async () => {
    const auth = new StubLocalAuth();
    auth.source = 'environment';
    auth.rejected = async () => false;
    const h = await harness({ auth });
    h.linkedin.override(() => Response.json({ message: 'Invalid access token' }, { status: 401 }));
    expect(await call(h, 'linkedin_get_profile')).toEqual({
      isError: true,
      data: undefined,
      text: `LinkedIn rejected the access token in LINKEDIN_ACCESS_TOKEN (it has expired or been revoked). ${ACCESS_TOKEN_HINT}`,
    });
    // A forced sign-in would succeed, and the tools would go on using LINKEDIN_ACCESS_TOKEN.
    expect(await call(h, 'linkedin_login', { force: true })).toEqual({
      isError: true,
      data: undefined,
      text: `The connector uses the access token in LINKEDIN_ACCESS_TOKEN. ${ACCESS_TOKEN_HINT}`,
    });
    expect((await call(h, 'linkedin_login')).data).toMatchObject({ alreadySignedIn: true });
    expect(auth.logins).toBe(0);
  });

  it('reports why the sign-in could not start', async () => {
    const auth = new StubLocalAuth();
    auth.signedIn = false;
    auth.login = async () => {
      throw new ConfigError('LinkedIn sign-in needs your LinkedIn app credentials.');
    };
    const h = await harness({ auth });
    expect(await call(h, 'linkedin_get_profile')).toMatchObject({ isError: true, text: 'LinkedIn sign-in needs your LinkedIn app credentials.' });
  });

  it('only says how to reconnect in remote mode', async () => {
    const auth = new StubAuth();
    auth.signedIn = false;
    const h = await harness({ auth, mode: 'remote' });
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
    expect(forced.data).toEqual({
      alreadySignedIn: false,
      signedIn: false,
      authorizationUrl: 'https://www.linkedin.com/oauth/v2/authorization?state=x',
      expiresInSeconds: 600,
      message:
        "The LinkedIn sign-in page is open in your browser; if it didn't appear, open this link (valid for 10 minutes): https://www.linkedin.com/oauth/v2/authorization?state=x " +
        // LinkedIn shows these mistakes on its own page, without coming back to the connector.
        'If LinkedIn shows an error instead of asking you to approve access, add http://localhost:8723/callback to the authorized redirect URLs ' +
        "on the Auth tab of your LinkedIn app at https://www.linkedin.com/developers/apps, exactly as written, and check that the connector's Client ID is the app's.",
    });
  });

  it('waits for the sign-in to finish', async () => {
    const auth = new StubLocalAuth();
    auth.signedIn = false;
    auth.completion = Promise.resolve('Ada Lovelace');
    const h = await harness({ auth });
    expect((await call(h, 'linkedin_login')).data).toEqual({
      alreadySignedIn: false,
      signedIn: true,
      name: 'Ada Lovelace',
      message: 'Signed in to LinkedIn as Ada Lovelace.',
    });
  });

  it('says it signed in without a name when LinkedIn gave none', async () => {
    const auth = new StubLocalAuth();
    auth.signedIn = false;
    auth.completion = Promise.resolve(undefined);
    const h = await harness({ auth });
    expect((await call(h, 'linkedin_login')).data).toEqual({ alreadySignedIn: false, signedIn: true, message: 'Signed in to LinkedIn.' });
  });

  it('says how to switch accounts when a forced sign-in kept the same one', async () => {
    const auth = new StubLocalAuth();
    auth.member = { id: 'abc123' };
    auth.completion = Promise.resolve('Ada Lovelace');
    const h = await harness({ auth });
    expect((await call(h, 'linkedin_login', { force: true })).data!.message).toBe(
      `Signed in to LinkedIn as Ada Lovelace. That is the account you were already signed in with. ${SWITCH_ACCOUNT_HINT}`,
    );
    // Not forced: signing in again to grant new permissions was the point.
    auth.missingScopes = ['w_member_social_feed'];
    expect((await call(h, 'linkedin_login')).data!.message).toBe('Signed in to LinkedIn as Ada Lovelace.');
    auth.signsInAs = { id: 'grace' };
    expect((await call(h, 'linkedin_login', { force: true })).data!.message).toBe('Signed in to LinkedIn as Ada Lovelace.');
    // Nobody to compare with.
    auth.member = undefined;
    auth.signsInAs = undefined;
    expect((await call(h, 'linkedin_login', { force: true })).data!.message).toBe('Signed in to LinkedIn as Ada Lovelace.');
    // Still waiting for the user: nothing to compare yet.
    auth.member = { id: 'abc123' };
    auth.completion = new Promise(() => {});
    expect((await call(h, 'linkedin_login', { force: true })).data!.message).toMatch(/^The LinkedIn sign-in page is open in your browser; .*state=x If LinkedIn shows an error/);
  });

  it('gives the link to open at once when no browser could be opened', async () => {
    const clock = new FakeClock();
    const auth = new StubLocalAuth();
    auth.signedIn = false;
    auth.browserOpened = false;
    const h = await harness({ auth, clock });
    expect((await call(h, 'linkedin_login')).data!.message).toBe(
      `Open this link to sign in to LinkedIn and approve access (valid for 10 minutes): https://www.linkedin.com/oauth/v2/authorization?state=x ${CHECK_APP}`,
    );
    expect(await call(h, 'linkedin_get_profile')).toMatchObject({
      isError: true,
      text:
        'You are not signed in to LinkedIn. Open this link to sign in to LinkedIn and approve access (valid for 10 minutes): ' +
        `https://www.linkedin.com/oauth/v2/authorization?state=x ${CHECK_APP} Once you have approved access, try again.`,
    });
    // Nobody can approve a page that didn't open, so there was nothing to wait for; one that opened gets 45 seconds.
    expect(clock.time).toBe(0);
    auth.browserOpened = true;
    await call(h, 'linkedin_login');
    expect(clock.time).toBe(45_000);
  });

  it('says why the sign-in failed', async () => {
    const auth = new StubLocalAuth();
    auth.signedIn = false;
    auth.completion = Promise.reject(new Error('LinkedIn sign-in was not completed: The user cancelled'));
    const h = await harness({ auth });
    // The failed sign-in's link no longer works, so none is handed out.
    expect((await call(h, 'linkedin_login')).data).toEqual({
      alreadySignedIn: false,
      signedIn: false,
      message: 'LinkedIn sign-in was not completed: The user cancelled.',
    });
    expect(await call(h, 'linkedin_get_profile')).toEqual({
      isError: true,
      data: undefined,
      text: 'You are not signed in to LinkedIn. LinkedIn sign-in was not completed: The user cancelled.',
    });
    // Signed out since, the reason names that failure: a sign-in that fails again says why only once.
    auth.signedOutMessage = `You are not signed in to LinkedIn. ${LAST_FAILURE} LinkedIn sign-in was not completed: The user cancelled. ${SIGN_IN_HINT}`;
    expect((await call(h, 'linkedin_get_profile')).text).toBe('You are not signed in to LinkedIn. LinkedIn sign-in was not completed: The user cancelled.');
    // While a new sign-in waits for the user, why the last one failed is still news.
    auth.completion = new Promise(() => {});
    expect((await call(h, 'linkedin_get_profile')).text).toBe(
      `You are not signed in to LinkedIn. ${LAST_FAILURE} LinkedIn sign-in was not completed: The user cancelled. ` +
        "The LinkedIn sign-in page is open in your browser; if it didn't appear, open this link (valid for 10 minutes): " +
        `https://www.linkedin.com/oauth/v2/authorization?state=x ${CHECK_APP} Once you have approved access, try again.`,
    );
  });

  it('signs in again when the stored sign-in predates scopes that are now configured', async () => {
    const h = await harness();
    h.auth.missingScopes = ['w_member_social_feed'];
    expect((await call(h, 'linkedin_auth_status')).data).toMatchObject({ authenticated: true, missingScopes: ['w_member_social_feed'] });
    expect((await call(h, 'linkedin_login')).data).toMatchObject({ alreadySignedIn: false, authorizationUrl: expect.any(String) });
    expect(h.auth.logins).toBe(1);
  });

  it('signs out', async () => {
    const h = await harness();
    expect((await call(h, 'linkedin_logout')).data).toMatchObject({ removed: true });
    expect((await call(h, 'linkedin_logout')).data).toMatchObject({ removed: false });
  });
});
