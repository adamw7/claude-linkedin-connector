/**
 * LinkedIn post and comment text uses the "little text" format, in which these
 * characters are markup. They must be backslash-escaped to appear literally;
 * left unescaped, LinkedIn can silently truncate the text at the first one.
 */
const RESERVED = new Set(['\\', '|', '{', '}', '@', '[', ']', '(', ')', '<', '>', '#', '*', '_', '~']);

/** A tag body containing at least one letter, e.g. `AI` or `2026goals` (but not `1`). */
const TAG_BODY = /^[\p{L}\p{N}]*\p{L}/u;

/** Characters that make a following `#` part of a word or URL rather than a hashtag. */
const NOT_HASHTAG_PREFIX = /[\p{L}\p{N}_&#/\\]/u;

export interface EscapeOptions {
  /** Keep `#tag` sequences unescaped so LinkedIn renders them as hashtags. Default true. */
  hashtags?: boolean;
}

/** Converts plain text into LinkedIn little text that renders exactly as written. */
export function escapeLittleText(text: string, options: EscapeOptions = {}): string {
  const keepHashtags = options.hashtags ?? true;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!RESERVED.has(ch) || (ch === '#' && keepHashtags && startsHashtag(text, i))) {
      out += ch;
    } else {
      out += `\\${ch}`;
    }
  }
  return out;
}

function startsHashtag(text: string, index: number): boolean {
  const prev = text[index - 1];
  if (prev !== undefined && NOT_HASHTAG_PREFIX.test(prev)) return false;
  return TAG_BODY.test(text.slice(index + 1, index + 101));
}
