import { beforeEach, describe, expect, it } from 'vitest';
import { LinkedInApiError } from '../src/errors.js';
import { LinkedInClient } from '../src/linkedin/client.js';
import { ApiVersion } from '../src/linkedin/versions.js';
import { API_BASE, FakeLinkedIn, MEMBER } from './helpers/fake-linkedin.js';

describe('LinkedInClient', () => {
  let linkedin: FakeLinkedIn;
  let client: LinkedInClient;

  beforeEach(() => {
    linkedin = new FakeLinkedIn();
    client = new LinkedInClient({ accessToken: 'li-token', version: new ApiVersion('202609'), apiBaseUrl: API_BASE, fetch: linkedin.fetch });
  });

  it('reads userinfo without a version header', async () => {
    expect(await client.getUserInfo()).toEqual(MEMBER);
    const [request] = linkedin.requests;
    expect(request!.headers.get('authorization')).toBe('Bearer li-token');
    expect(request!.headers.get('linkedin-version')).toBeNull();
  });

  it('creates a post with versioned Rest.li headers and returns its URN', async () => {
    const urn = await client.createPost({ author: 'urn:li:person:abc123', commentary: 'Hello', visibility: 'PUBLIC' });
    expect(urn).toMatch(/^urn:li:share:\d+$/);
    const [request] = linkedin.find('POST', '/rest/posts');
    expect(request!.headers.get('linkedin-version')).toBe('202609');
    expect(request!.headers.get('x-restli-protocol-version')).toBe('2.0.0');
    expect(request!.headers.get('content-type')).toBe('application/json');
    expect(request!.json).toEqual({
      author: 'urn:li:person:abc123',
      commentary: 'Hello',
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    });
  });

  it('URL-encodes URNs in paths when deleting', async () => {
    await client.deletePost('urn:li:share:123');
    const [request] = linkedin.find('DELETE', '/rest/posts/');
    expect(request!.url.pathname).toBe('/rest/posts/urn%3Ali%3Ashare%3A123');
    expect(request!.headers.get('x-restli-method')).toBe('DELETE');
  });

  it('edits post text with a Rest.li partial update', async () => {
    await client.updatePostText('urn:li:share:123', 'Fixed typo');
    const [request] = linkedin.find('POST', '/rest/posts/');
    expect(request!.url.pathname).toBe('/rest/posts/urn%3Ali%3Ashare%3A123');
    expect(request!.headers.get('x-restli-method')).toBe('PARTIAL_UPDATE');
    expect(request!.json).toEqual({ patch: { $set: { commentary: 'Fixed typo' } } });
  });

  it('initializes and performs uploads', async () => {
    const { uploadUrl, urn } = await client.initializeUpload('images', 'urn:li:person:abc123');
    expect(urn).toMatch(/^urn:li:image:/);
    expect(linkedin.find('POST', '/rest/images')[0]!.json).toEqual({ initializeUploadRequest: { owner: 'urn:li:person:abc123' } });
    await client.upload(uploadUrl, Buffer.from('bytes'));
    const put = linkedin.requests.at(-1)!;
    expect(put.method).toBe('PUT');
    expect(put.headers.get('authorization')).toBe('Bearer li-token');
    expect(await client.getAssetStatus('images', urn)).toBe('AVAILABLE');
  });

  it('sends comments and reactions in the documented shapes', async () => {
    const id = await client.createComment('urn:li:share:1', 'urn:li:person:abc123', 'Nice');
    expect(id).toMatch(/^urn:li:comment:/);
    expect(linkedin.find('POST', '/rest/socialActions/urn%3Ali%3Ashare%3A1/comments')[0]!.json).toEqual({
      actor: 'urn:li:person:abc123',
      object: 'urn:li:share:1',
      message: { text: 'Nice' },
    });
    await client.createReaction('urn:li:share:1', 'urn:li:person:abc123', 'PRAISE');
    const reaction = linkedin.find('POST', '/rest/reactions')[0]!;
    expect(reaction.url.searchParams.get('actor')).toBe('urn:li:person:abc123');
    expect(reaction.json).toEqual({ root: 'urn:li:share:1', reactionType: 'PRAISE' });
  });

  it('turns error responses into LinkedInApiError', async () => {
    const revoked = new LinkedInClient({ accessToken: 'nope', version: new ApiVersion(), apiBaseUrl: API_BASE, fetch: linkedin.fetch });
    const error = await revoked.getUserInfo().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinkedInApiError);
    expect(error).toMatchObject({ status: 401, details: { code: 'REVOKED_ACCESS_TOKEN', serviceErrorCode: 65601 } });
    expect((error as Error).message).toContain('revoked');
  });

  it('recovers from a sunset API version and remembers the live one', async () => {
    const version = new ApiVersion('202409', () => new Date('2026-10-17T00:00:00Z'));
    const stale = new LinkedInClient({ accessToken: 'li-token', version, apiBaseUrl: API_BASE, fetch: linkedin.fetch });
    await stale.createPost({ author: 'urn:li:person:abc123', commentary: 'Hi', visibility: 'PUBLIC' });
    expect(version.value).toBe('202610');
    const posts = linkedin.find('POST', '/rest/posts');
    expect(posts.map((r) => r.headers.get('linkedin-version'))).toEqual(['202409', '202610']);
    // Subsequent calls use the discovered version directly.
    await stale.deletePost('urn:li:share:1');
    expect(linkedin.find('DELETE', '/rest/posts/')[0]!.headers.get('linkedin-version')).toBe('202610');
  });
});
