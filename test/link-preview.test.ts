import { describe, expect, it } from 'vitest';
import { decodeHtmlEntities, parseLinkPreview } from '../src/linkedin/link-preview.js';

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

  it('ignores non-http image URLs', () => {
    expect(parseLinkPreview('<meta property="og:image" content="javascript:alert(1)">', 'https://example.com/')).toEqual({});
  });

  it('decodes numeric entities', () => {
    expect(decodeHtmlEntities('&#169; &#x1F680; &unknown;')).toBe('© 🚀 &unknown;');
  });
});
