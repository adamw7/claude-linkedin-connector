import { describe, expect, it } from 'vitest';
import { escapeHtml, page } from '../src/html.js';

describe('escapeHtml', () => {
  it('escapes every HTML-significant character', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&#60;a href=&#34;x&#34; title=&#39;y&#39;&#62;&#38;&#60;/a&#62;');
    expect(escapeHtml('plain text')).toBe('plain text');
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
