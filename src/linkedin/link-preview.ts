import { decodeHtmlEntities } from '../html.js';
import { safeFetch } from '../net/safe-fetch.js';

export interface LinkPreview {
  title?: string;
  description?: string;
  /** Absolute URL of the page's preview image. */
  imageUrl?: string;
}

const TITLE_KEYS = ['og:title', 'twitter:title'];
const DESCRIPTION_KEYS = ['og:description', 'twitter:description', 'description'];
const IMAGE_KEYS = ['og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src'];

/**
 * The page's text in the encoding its Content-Type header or a <meta> tag names (Windows-1252, ISO-8859-2,
 * Shift_JIS and the like on older sites), or UTF-8 when it names none or one there is no decoder for.
 */
function decodePage(data: Buffer, contentType: string | undefined): string {
  const charset =
    /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? '')?.[1] ??
    /<meta\b[^<>]*charset\s*=\s*["']?([\w.:-]+)/i.exec(data.subarray(0, 4096).toString('latin1'))?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(data);
  } catch {
    return data.toString('utf8');
  }
}

function clean(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const text = decodeHtmlEntities(value).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  // Cut whole characters: slicing UTF-16 units can split an emoji, leaving half of it to show as � on the card.
  const characters = [...text];
  return characters.length > maxLength ? `${characters.slice(0, maxLength - 1).join('')}…` : text;
}

/** Extracts Open Graph / Twitter card metadata, as LinkedIn's Posts API does not generate link previews itself. */
export function parseLinkPreview(html: string, pageUrl: string): LinkPreview {
  const meta = new Map<string, string>();
  // The page is untrusted: `[^<>]` and the lookbehind keep these scans linear, so a crafted page
  // (`<meta<meta…`, or a huge attribute name) can't stall the server for minutes.
  for (const tag of html.matchAll(/<meta\b[^<>]*>/gi)) {
    const attributes = new Map<string, string>();
    for (const attr of tag[0].matchAll(/(?<![a-zA-Z_:.-])([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attributes.set(attr[1]!.toLowerCase(), attr[2] ?? attr[3] ?? attr[4] ?? '');
    }
    const key = (attributes.get('property') ?? attributes.get('name'))?.toLowerCase();
    const content = attributes.get('content');
    if (key && content && !meta.has(key)) meta.set(key, content);
  }
  const first = (keys: string[]) => keys.map((key) => meta.get(key)).find(Boolean);
  const titleTag = /<title\b[^<>]*>([^<]*)<\/title>/i.exec(html)?.[1];

  const preview: LinkPreview = { title: clean(first(TITLE_KEYS) ?? titleTag, 200), description: clean(first(DESCRIPTION_KEYS), 300) };
  // Unparseable and non-http(s) image URLs are ignored.
  const image = first(IMAGE_KEYS);
  const imageUrl = image ? URL.parse(decodeHtmlEntities(image.trim()), pageUrl) : null;
  if (imageUrl?.protocol === 'http:' || imageUrl?.protocol === 'https:') preview.imageUrl = imageUrl.toString();
  return preview;
}

export async function fetchLinkPreview(url: string, options: { allowPrivateNetwork?: boolean } = {}): Promise<LinkPreview> {
  const page = await safeFetch(url, {
    maxBytes: 1024 * 1024,
    truncate: true,
    timeoutMs: 10_000,
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
    allowPrivateNetwork: options.allowPrivateNetwork,
  });
  if (page.contentType && !/html|xml/i.test(page.contentType)) return {};
  return parseLinkPreview(decodePage(page.data, page.contentType), page.url);
}
