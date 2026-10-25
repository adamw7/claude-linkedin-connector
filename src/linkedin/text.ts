/**
 * LinkedIn post and comment text uses the "little text" format, in which these
 * characters are markup. They must be backslash-escaped to appear literally;
 * left unescaped, LinkedIn can silently truncate the text at the first one.
 */
const RESERVED = /[\\|{}@[\]()<>#*_~]/g;

/** A tag body containing at least one letter, e.g. `AI` or `2026goals` (but not `1`). */
const TAG_BODY = /^[\p{L}\p{N}]*\p{L}/u;

/** Characters that make a following `#` part of a word or URL rather than a hashtag. */
const NOT_HASHTAG_PREFIX = /[\p{L}\p{N}_&#/\\]/u;

/** Converts plain text into LinkedIn little text that renders exactly as written; `#tag` stays a hashtag. */
export function escapeLittleText(text: string): string {
  return text.replace(RESERVED, (ch: string, index: number) => (ch === '#' && startsHashtag(text, index) ? ch : `\\${ch}`));
}

function startsHashtag(text: string, index: number): boolean {
  const prev = text[index - 1];
  if (prev !== undefined && NOT_HASHTAG_PREFIX.test(prev)) return false;
  return TAG_BODY.test(text.slice(index + 1, index + 101));
}

/** Ways LinkedIn would show plain text differently than its author probably meant, e.g. Markdown written out of habit. */
export function textWarnings(text: string): string[] {
  const warnings: string[] = [];
  // As in Markdown, the asterisks must hug the text: "x ** 2 + y ** 2" is arithmetic, not bold.
  if (/\*\*(?=\S)[^*\n]+(?<=\S)\*\*/.test(text)) {
    warnings.push('The text uses Markdown bold (**like this**), which LinkedIn shows literally, asterisks and all.');
  }
  if (/\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/.test(text)) {
    warnings.push('The text has a Markdown link ([text](url)), which LinkedIn shows literally. Write the URL out instead: LinkedIn makes it clickable.');
  }
  if (/^#{1,6} /m.test(text)) warnings.push('A line starts with "# ", a Markdown heading, which LinkedIn shows literally.');
  // Not e-mail addresses or URLs: the @ must not follow a letter, digit, dot, underscore or slash.
  if (/(?<![\p{L}\p{N}._/])@[\p{L}\p{N}_]/u.test(text)) {
    warnings.push('@mentions don\'t tag anyone: "@Name" shows as plain text and nobody is notified.');
  }
  return warnings;
}
