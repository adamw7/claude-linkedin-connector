import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientRegistry, isValidRedirectUri, RedirectPolicy, redirectUriMatches, type OAuthClient } from '../src/remote/clients.js';
import { Sealer } from '../src/remote/crypto.js';
import { fakeTransport } from './helpers/fake-transport.js';

const sealer = new Sealer('s'.repeat(32));
const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const DOC_URL = 'https://client.example/oauth/metadata.json';

describe('redirect URI rules', () => {
  it('accepts https and loopback http redirect URIs only', () => {
    expect(isValidRedirectUri(CLAUDE)).toBe(true);
    expect(isValidRedirectUri('http://localhost:3000/cb')).toBe(true);
    expect(isValidRedirectUri('http://127.0.0.1/cb')).toBe(true);
    expect(isValidRedirectUri('http://[::1]:8080/cb')).toBe(true);
    for (const uri of [
      'http://example.com/cb',
      'https://example.com/cb#frag',
      'https://example.com/cb#',
      'https://user:pass@example.com/cb',
      'javascript:alert(1)',
      'not a url',
      '/relative',
    ]) {
      expect(isValidRedirectUri(uri), uri).toBe(false);
    }
  });

  it('matches exactly, except for loopback ports', () => {
    expect(redirectUriMatches(CLAUDE, CLAUDE)).toBe(true);
    expect(redirectUriMatches(CLAUDE, `${CLAUDE}/`)).toBe(false);
    expect(redirectUriMatches('http://127.0.0.1/cb', 'http://127.0.0.1:51234/cb')).toBe(true);
    expect(redirectUriMatches('http://127.0.0.1:1/cb?x=1', 'http://127.0.0.1:2/cb?x=1')).toBe(true);
    expect(redirectUriMatches('http://127.0.0.1/cb', 'http://localhost:51234/cb')).toBe(false);
    expect(redirectUriMatches('http://127.0.0.1/cb', 'http://127.0.0.1:51234/other')).toBe(false);
    expect(redirectUriMatches('http://127.0.0.1/cb', 'http://127.0.0.1:51234/cb?x=1')).toBe(false);
    expect(redirectUriMatches('https://example.com/cb', 'https://example.com:8443/cb')).toBe(false);
  });
});

describe('RedirectPolicy', () => {
  it('allows exact entries', () => {
    const policy = new RedirectPolicy([CLAUDE]);
    expect(policy.allows(CLAUDE)).toBe(true);
    expect(policy.allows('https://claude.ai/other')).toBe(false);
  });

  it('allows prefix wildcards without letting dot segments escape them', () => {
    const policy = new RedirectPolicy(['https://app.example/oauth/*']);
    expect(policy.allows('https://app.example/oauth/callback')).toBe(true);
    expect(policy.allows('https://app.example/oauth/../admin')).toBe(false);
    expect(policy.allows('https://app.example/other')).toBe(false);
    expect(policy.allows('https://app.example.evil/oauth/callback')).toBe(false);
  });

  it('allows any loopback URI with `loopback`', () => {
    const policy = new RedirectPolicy(['loopback']);
    expect(policy.allows('http://localhost:1234/cb')).toBe(true);
    expect(policy.allows('http://[::1]/cb')).toBe(true);
    expect(policy.allows(CLAUDE)).toBe(false);
  });

  it('allows any valid URI with `*`, but never an invalid one', () => {
    const policy = new RedirectPolicy(['*']);
    expect(policy.allows('https://anything.example/cb')).toBe(true);
    expect(policy.allows('http://anything.example/cb')).toBe(false);
    expect(policy.allows('https://anything.example/cb#x')).toBe(false);
  });
});

describe('ClientRegistry', () => {
  function registry(entries = [CLAUDE, 'loopback'], options: ConstructorParameters<typeof ClientRegistry>[2] = {}) {
    return new ClientRegistry(sealer, new RedirectPolicy(entries), { now: () => 1_700_000_000_000, ...options });
  }

  describe('register', () => {
    it('issues a confidential client by default', () => {
      const result = registry().register({ redirect_uris: [CLAUDE], client_name: '  Claude  ' });
      expect(result.status).toBe(201);
      expect(result.body).toMatchObject({
        client_id_issued_at: 1_700_000_000,
        client_secret_expires_at: 0,
        redirect_uris: [CLAUDE],
        token_endpoint_auth_method: 'client_secret_basic',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        client_name: 'Claude',
      });
      expect(result.body.client_secret).toEqual(expect.any(String));
    });

    it('issues no secret to public clients', () => {
      const result = registry().register({ redirect_uris: ['http://127.0.0.1/cb'], token_endpoint_auth_method: 'none' });
      expect(result.status).toBe(201);
      expect(result.body).not.toHaveProperty('client_secret');
      expect(result.body).not.toHaveProperty('client_name');
    });

    it('truncates long client names', () => {
      const result = registry().register({ redirect_uris: [CLAUDE], client_name: 'x'.repeat(500) });
      expect(result.body.client_name).toHaveLength(100);
    });

    it.each([
      ['a non-object', [CLAUDE], 'invalid_client_metadata'],
      ['null', null, 'invalid_client_metadata'],
      ['no redirect URIs', {}, 'invalid_redirect_uri'],
      ['an empty redirect URI list', { redirect_uris: [] }, 'invalid_redirect_uri'],
      ['too many redirect URIs', { redirect_uris: Array.from({ length: 11 }, (_, i) => `http://127.0.0.1/${i}`) }, 'invalid_redirect_uri'],
      ['a non-string redirect URI', { redirect_uris: [42] }, 'invalid_redirect_uri'],
      ['an overlong redirect URI', { redirect_uris: [`${CLAUDE}?${'x'.repeat(2000)}`] }, 'invalid_redirect_uri'],
      ['a disallowed redirect URI', { redirect_uris: ['https://evil.example/cb'] }, 'invalid_redirect_uri'],
      ['an unknown auth method', { redirect_uris: [CLAUDE], token_endpoint_auth_method: 'private_key_jwt' }, 'invalid_client_metadata'],
      ['an unsupported grant type', { redirect_uris: [CLAUDE], grant_types: ['client_credentials'] }, 'invalid_client_metadata'],
      ['an unsupported response type', { redirect_uris: [CLAUDE], response_types: ['token'] }, 'invalid_client_metadata'],
    ])('rejects %s', (_label, metadata, error) => {
      const result = registry().register(metadata);
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error, error_description: expect.any(String) });
    });

    it('accepts grant and response types that include the supported ones', () => {
      const result = registry().register({
        redirect_uris: [CLAUDE],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
      expect(result.status).toBe(201);
    });
  });

  describe('resolve and authenticate', () => {
    it('resolves registered clients from their signed ID', async () => {
      const reg = registry();
      const { body } = reg.register({ redirect_uris: [CLAUDE], client_name: 'Claude' });
      const client = await reg.resolve(body.client_id as string);
      expect(client).toEqual({
        clientId: body.client_id,
        clientName: 'Claude',
        redirectUris: [CLAUDE],
        authMethod: 'client_secret_basic',
        kind: 'registered',
      });
      expect(reg.authenticate(client!, body.client_secret as string)).toBe(true);
      expect(reg.authenticate(client!, 'wrong')).toBe(false);
      expect(reg.authenticate(client!, undefined)).toBe(false);
    });

    it('lets public clients through without a secret', async () => {
      const reg = registry();
      const { body } = reg.register({ redirect_uris: [CLAUDE], token_endpoint_auth_method: 'none' });
      const client = await reg.resolve(body.client_id as string);
      expect(reg.authenticate(client!, undefined)).toBe(true);
    });

    it('rejects client IDs signed by another server or tampered with', async () => {
      const { body } = registry().register({ redirect_uris: [CLAUDE] });
      const other = new ClientRegistry(new Sealer('o'.repeat(32)), new RedirectPolicy([CLAUDE]));
      expect(await other.resolve(body.client_id as string)).toBeUndefined();
      expect(await registry().resolve('garbage')).toBeUndefined();
      expect(await registry().resolve(sealer.sign('client', { v: 2, r: [CLAUDE], m: 'none' }))).toBeUndefined();
      expect(await registry().resolve(sealer.sign('client', { v: 1, r: [CLAUDE], m: 'bogus' }))).toBeUndefined();
      expect(await registry().resolve(sealer.sign('consent', { v: 1, r: [CLAUDE], m: 'none' }))).toBeUndefined();
    });

    it('keeps clients registered before a SERVER_SECRET rotation working', async () => {
      const { body } = registry().register({ redirect_uris: [CLAUDE] });
      const rotated = new ClientRegistry(new Sealer('n'.repeat(32), 's'.repeat(32)), new RedirectPolicy([CLAUDE]));
      const client = await rotated.resolve(body.client_id as string);
      expect(client).toMatchObject({ clientId: body.client_id, redirectUris: [CLAUDE], authMethod: 'client_secret_basic' });
      expect(rotated.authenticate(client!, body.client_secret as string)).toBe(true);
      expect(rotated.authenticate(client!, 'wrong')).toBe(false);
      // Once the previous secret is dropped, so are the clients registered with it.
      expect(await new ClientRegistry(new Sealer('n'.repeat(32)), new RedirectPolicy([CLAUDE])).resolve(body.client_id as string)).toBeUndefined();
    });

    it('re-applies the redirect policy to existing registrations', async () => {
      const { body } = registry().register({ redirect_uris: [CLAUDE, 'http://127.0.0.1/cb'] });
      const narrowed = await registry([CLAUDE]).resolve(body.client_id as string);
      expect(narrowed?.redirectUris).toEqual([CLAUDE]);
      expect(await registry(['https://other.example/cb']).resolve(body.client_id as string)).toBeUndefined();
    });
  });

  describe('Client ID Metadata Documents', () => {
    function documentRegistry(document: unknown, now = { t: 0 }) {
      const fetched: string[] = [];
      const reg = registry([CLAUDE], {
        now: () => now.t,
        fetchDocument: async (url) => {
          fetched.push(url);
          return typeof document === 'string' ? document : JSON.stringify(document);
        },
      });
      return { reg, fetched };
    }

    it('resolves URL client IDs as public clients', async () => {
      const { reg } = documentRegistry({ client_id: DOC_URL, client_name: 'Example', redirect_uris: [CLAUDE, 'https://evil.example/cb', 7] });
      const client = await reg.resolve(DOC_URL);
      expect(client).toEqual<OAuthClient>({ clientId: DOC_URL, clientName: 'Example', redirectUris: [CLAUDE], authMethod: 'none', kind: 'metadata-document' });
      expect(reg.authenticate(client!, undefined)).toBe(true);
    });

    it.each([
      ['a mismatched client_id', { client_id: 'https://other.example/doc', redirect_uris: [CLAUDE] }],
      ['no redirect URIs', { client_id: DOC_URL }],
      ['no allowed redirect URIs', { client_id: DOC_URL, redirect_uris: ['https://evil.example/cb'] }],
      ['invalid JSON', '{not json'],
      ['JSON null', 'null'],
    ])('rejects a document with %s', async (_label, document) => {
      expect(await documentRegistry(document).reg.resolve(DOC_URL)).toBeUndefined();
    });

    it('rejects unsuitable client ID URLs without fetching them', async () => {
      const { reg, fetched } = documentRegistry({ redirect_uris: [CLAUDE] });
      for (const url of ['https://client.example/', 'https://client.example/doc#x', 'https://u:p@client.example/doc']) {
        expect(await reg.resolve(url)).toBeUndefined();
      }
      expect(fetched).toEqual([]);
    });

    it('treats fetch failures as an unknown client', async () => {
      const reg = registry([CLAUDE], {
        fetchDocument: async () => {
          throw new Error('network down');
        },
      });
      expect(await reg.resolve(DOC_URL)).toBeUndefined();
    });

    it('keeps at most 500 documents cached, dropping the oldest', async () => {
      const fetched: string[] = [];
      const reg = registry([CLAUDE], {
        fetchDocument: async (url) => {
          fetched.push(url);
          return JSON.stringify({ client_id: url, redirect_uris: [CLAUDE] });
        },
      });
      const ids = Array.from({ length: 501 }, (_, i) => `https://client.example/${i}`);
      for (const id of ids) await reg.resolve(id);
      await reg.resolve(ids[1]!);
      expect(fetched).toHaveLength(501);
      await reg.resolve(ids[0]!);
      expect(fetched).toHaveLength(502);
    });

    describe('fetched over the network', () => {
      afterEach(() => vi.restoreAllMocks());
      const DOCUMENT = JSON.stringify({ client_id: DOC_URL, redirect_uris: [CLAUDE] });
      const host = ['client.example'];

      it('fetches the document as JSON', async () => {
        const requests = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'application/json' }, body: DOCUMENT }), host);
        expect(await registry([CLAUDE]).resolve(DOC_URL)).toMatchObject({ clientId: DOC_URL, kind: 'metadata-document' });
        expect(requests[0]).toMatchObject({ url: new URL(DOC_URL), headers: { Accept: 'application/json' } });
      });

      it('does not follow redirects', async () => {
        const requests = fakeTransport(() => ({ status: 302, headers: { Location: 'https://client.example/elsewhere.json' } }), host);
        expect(await registry([CLAUDE]).resolve(DOC_URL)).toBeUndefined();
        expect(requests).toHaveLength(1);
      });

      it('refuses documents over 64 KB', async () => {
        const padded = JSON.stringify({ client_id: DOC_URL, redirect_uris: [CLAUDE], padding: 'x'.repeat(70 * 1024) });
        fakeTransport(() => ({ status: 200, body: padded }), host);
        expect(await registry([CLAUDE]).resolve(DOC_URL)).toBeUndefined();
      });

      it('refuses client IDs on private addresses', async () => {
        const requests = fakeTransport(() => ({ status: 200, body: DOCUMENT }), []);
        expect(await registry([CLAUDE]).resolve('https://localhost/oauth/metadata.json')).toBeUndefined();
        expect(await registry([CLAUDE]).resolve('https://10.0.0.1/oauth/metadata.json')).toBeUndefined();
        expect(requests).toEqual([]);
      });
    });

    it('caches documents, and failures for a shorter time', async () => {
      const now = { t: 0 };
      const { reg, fetched } = documentRegistry({ client_id: DOC_URL, redirect_uris: [CLAUDE] }, now);
      await reg.resolve(DOC_URL);
      now.t = 4 * 60_000;
      await reg.resolve(DOC_URL);
      expect(fetched).toHaveLength(1);
      now.t = 6 * 60_000;
      await reg.resolve(DOC_URL);
      expect(fetched).toHaveLength(2);

      const failing = documentRegistry({ client_id: 'mismatch', redirect_uris: [CLAUDE] }, now);
      now.t = 0;
      await failing.reg.resolve(DOC_URL);
      now.t = 20_000;
      await failing.reg.resolve(DOC_URL);
      expect(failing.fetched).toHaveLength(1);
      now.t = 31_000;
      await failing.reg.resolve(DOC_URL);
      expect(failing.fetched).toHaveLength(2);
    });
  });
});
