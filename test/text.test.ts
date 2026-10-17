import { describe, expect, it } from 'vitest';
import { escapeLittleText } from '../src/linkedin/text.js';

describe('escapeLittleText', () => {
  it('leaves ordinary text, emoji and line breaks untouched', () => {
    const text = 'Shipped v2 today! 🚀\n\nThanks everyone, "quotes" & apostrophes\' too.';
    expect(escapeLittleText(text)).toBe(text);
  });

  it('escapes every reserved character', () => {
    expect(escapeLittleText('a (b) [c] {d} <e> | @f *g* _h_ ~i~ \\j')).toBe(
      'a \\(b\\) \\[c\\] \\{d\\} \\<e\\> \\| \\@f \\*g\\* \\_h\\_ \\~i\\~ \\\\j',
    );
  });

  it('keeps hashtags clickable', () => {
    expect(escapeLittleText('Loving #TypeScript and #AI.\n#2026goals')).toBe('Loving #TypeScript and #AI.\n#2026goals');
  });

  it('escapes # when it is not a hashtag', () => {
    expect(escapeLittleText('C# rocks, we are #1, see https://example.com/page#intro')).toBe(
      'C\\# rocks, we are \\#1, see https://example.com/page\\#intro',
    );
    expect(escapeLittleText('# heading')).toBe('\\# heading');
    expect(escapeLittleText('##double')).toBe('\\#\\#double');
  });

  it('treats hashtags after punctuation as hashtags', () => {
    expect(escapeLittleText('(#ai)')).toBe('\\(#ai\\)');
  });

  it('can escape hashtags too', () => {
    expect(escapeLittleText('#AI', { hashtags: false })).toBe('\\#AI');
  });
});
