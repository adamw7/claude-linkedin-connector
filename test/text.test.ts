import { describe, expect, it } from 'vitest';
import { escapeLittleText, textWarnings } from '../src/linkedin/text.js';

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

describe('textWarnings', () => {
  it('has nothing to say about plain text, hashtags, e-mail addresses and handles in URLs', () => {
    expect(textWarnings('Shipped v2! 🚀\n\n- faster\n- smaller\n\n#launch #1 priority, write to ada@example.com or see https://x.com/@ada')).toEqual([]);
    expect(textWarnings('2 * 3 = 6, snake_case, __init__ and a [note] (aside)')).toEqual([]);
  });

  it('flags Markdown that LinkedIn would show literally', () => {
    expect(textWarnings('This is **big** news')).toEqual([
      'The text uses Markdown bold (**like this**), which LinkedIn shows literally, asterisks and all.',
    ]);
    expect(textWarnings('Read [the post](https://example.com/post).')).toEqual([
      'The text has a Markdown link ([text](url)), which LinkedIn shows literally. Write the URL out instead: LinkedIn makes it clickable.',
    ]);
    expect(textWarnings('Intro\n## Results\nGood')).toEqual(['A line starts with "# ", a Markdown heading, which LinkedIn shows literally.']);
  });

  it('flags @mentions, which cannot tag anyone', () => {
    const mention = '@mentions don\'t tag anyone: "@Name" shows as plain text and nobody is notified.';
    expect(textWarnings('Thanks @Grace for the help')).toEqual([mention]);
    expect(textWarnings('@Łukasz did it')).toEqual([mention]);
  });
});
