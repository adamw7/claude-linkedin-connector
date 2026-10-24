import { afterAll, describe, expect, it } from 'vitest';
import { fetchLinkPreview, parseLinkPreview } from '../src/linkedin/link-preview.js';
import { startServer, type TestServer } from './helpers/http.js';

describe('parseLinkPreview', () => {
  it('reads Open Graph tags in any attribute order', () => {
    const html = `<html><head>
      <title>Fallback</title>
      <meta content="Ship it &amp; celebrate" property="og:title">
      <meta property='og:description' content='How we &quot;shipped&quot; it'>
      <meta name="twitter:image" content="/img/card.png">
    </head></html>`;
    expect(parseLinkPreview(html, 'https://example.com/blog/post')).toEqual({
      title: 'Ship it & celebrate',
      description: 'How we "shipped" it',
      imageUrl: 'https://example.com/img/card.png',
    });
  });

  it('falls back to <title> and the meta description', () => {
    const html = '<title>\n  Plain   page </title><meta name="description" content="About us">';
    expect(parseLinkPreview(html, 'https://example.com/')).toEqual({ title: 'Plain page', description: 'About us' });
  });

  it('shortens long titles and descriptions by whole characters, so an emoji is never cut in half', () => {
    const html = `<title>${'a'.repeat(198)}🚀🚀 launch</title><meta name="description" content="${'🚀'.repeat(300)}">`;
    expect(parseLinkPreview(html, 'https://example.com/')).toEqual({ title: `${'a'.repeat(198)}🚀…`, description: '🚀'.repeat(300) });
    expect(parseLinkPreview(`<meta name="description" content="${'🚀'.repeat(301)}">`, 'https://example.com/')).toEqual({
      description: `${'🚀'.repeat(299)}…`,
    });
  });

  it('parses hostile pages in linear time', () => {
    const megabyte = 1024 * 1024;
    const start = performance.now();
    parseLinkPreview(`<meta ${'a'.repeat(megabyte)}>`, 'https://example.com/');
    parseLinkPreview('<meta'.repeat(megabyte / 5), 'https://example.com/');
    parseLinkPreview('<title'.repeat(megabyte / 6), 'https://example.com/');
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  it('ignores non-http image URLs', () => {
    expect(parseLinkPreview('<meta property="og:image" content="javascript:alert(1)">', 'https://example.com/')).toEqual({});
  });
});

describe('fetchLinkPreview', () => {
  let site: TestServer;
  afterAll(() => site?.close());

  it('reads the page in the encoding its header or <meta> tag names', async () => {
    // "Zażółć gęślą jaźń" in ISO-8859-2, as older Polish sites serve it.
    const latin2 = Buffer.from([0x5a, 0x61, 0xbf, 0xf3, 0xb3, 0xe6, 0x20, 0x67, 0xea, 0xb6, 0x6c, 0xb1, 0x20, 0x6a, 0x61, 0xbc, 0xf1]);
    const pages: Record<string, [string, Buffer]> = {
      '/header': ['text/html; charset=ISO-8859-2', Buffer.concat([Buffer.from('<title>'), latin2, Buffer.from('</title>')])],
      '/meta': ['text/html', Buffer.concat([Buffer.from('<meta charset="iso-8859-2"><meta property="og:title" content="'), latin2, Buffer.from('">')])],
      '/http-equiv': ['text/html', Buffer.concat([Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=windows-1252"><title>Caf'), Buffer.from([0xe9]), Buffer.from('</title>')])],
      '/utf8': ['text/html', Buffer.from('<title>Łódź</title>')],
      '/unknown': ['text/html; charset=x-made-up', Buffer.from('<title>Łódź</title>')],
    };
    site = await startServer((req, res) => {
      const [type, body] = pages[req.url ?? ''] ?? ['text/plain', Buffer.alloc(0)];
      res.writeHead(200, { 'Content-Type': type }).end(body);
    });
    const title = async (path: string) => (await fetchLinkPreview(site.url + path, { allowPrivateNetwork: true })).title;
    expect(await title('/header')).toBe('Zażółć gęślą jaźń');
    expect(await title('/meta')).toBe('Zażółć gęślą jaźń');
    expect(await title('/http-equiv')).toBe('Café');
    expect(await title('/utf8')).toBe('Łódź');
    expect(await title('/unknown')).toBe('Łódź');
  });
});
