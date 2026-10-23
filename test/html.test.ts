import { describe, expect, it } from 'vitest';
import { decodeHtmlEntities, escapeHtml, page } from '../src/html.js';

describe('escapeHtml', () => {
  it('escapes every HTML-significant character', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&#60;a href=&#34;x&#34; title=&#39;y&#39;&#62;&#38;&#60;/a&#62;');
    expect(escapeHtml('plain text')).toBe('plain text');
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes numeric entities', () => {
    expect(decodeHtmlEntities('&#169; &#x1F680; &unknown;')).toBe('© 🚀 &unknown;');
  });

  it('decodes the named entities pages use for typography, symbols and accented letters', () => {
    expect(decodeHtmlEntities('We launched 2.0 &mdash; it&rsquo;s here&hellip; &ldquo;Caf&eacute;&rdquo; &AMP; Gr&Uuml;&szlig;e &copy;&nbsp;2026')).toBe(
      'We launched 2.0 — it’s here… “Café” & GrÜße © 2026',
    );
    expect(decodeHtmlEntities('&Oslash;resund &ccedil;a &scaron; &AElig;')).toBe('Øresund ça š Æ');
    // Names that aren't entities, including inherited object keys, stay as written.
    expect(decodeHtmlEntities('&constructor; &toString; &xyz; &eunknown;')).toBe('&constructor; &toString; &xyz; &eunknown;');
  });
});

describe('page', () => {
  it('escapes the title but not the pre-escaped body', () => {
    const html = page('<Sign in>', '<h1>Hello</h1>');
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<title>&#60;Sign in&#62;</title>');
    expect(html).toContain('<main><h1>Hello</h1></main>');
  });
});
