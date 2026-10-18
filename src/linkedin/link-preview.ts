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

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function clean(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const text = decodeHtmlEntities(value).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
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
  return parseLinkPreview(page.data.toString('utf8'), page.url);
}
