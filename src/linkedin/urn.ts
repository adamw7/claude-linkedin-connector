import { UserInputError } from '../errors.js';

const POST_URN = /urn:li:(share|ugcPost|activity):(\d+)/;
const POST_SLUG = /(activity|ugcPost|share)-(\d{10,})/;
/** The address of a Page's admin view, the one place linkedin.com shows its organization ID: linkedin.com/company/<ID>/admin/. */
const COMPANY_URL = /linkedin\.com\/company\/(\d+)(?:[/?#]|$)/i;

export function personUrn(memberId: string): string {
  return memberId.startsWith('urn:li:person:') ? memberId : `urn:li:person:${memberId}`;
}

/** Whether `urn` names a LinkedIn Page (an organization) rather than a member. */
export function isOrganizationUrn(urn: string): boolean {
  return urn.startsWith('urn:li:organization:');
}

export function organizationUrn(idOrUrn: string): string {
  const trimmed = idOrUrn.trim();
  const id = COMPANY_URL.exec(trimmed)?.[1] ?? trimmed.replace(/^urn:li:organization:/, '');
  if (!/^\d+$/.test(id)) {
    throw new UserInputError(
      `"${idOrUrn}" is not a LinkedIn organization ID. Open the Page's admin view on linkedin.com: its address, linkedin.com/company/<ID>/admin/, ` +
        'holds the ID. Pass that number, that address, or urn:li:organization:<ID>.',
    );
  }
  return `urn:li:organization:${id}`;
}

/**
 * Extracts a post URN from a URN or any LinkedIn post URL, e.g.
 * `https://www.linkedin.com/feed/update/urn:li:share:123/` or
 * `https://www.linkedin.com/posts/jane_slug-activity-7123456789012345678-AbCd` (or `-ugcPost-…`).
 */
export function parsePostReference(input: string): string {
  let text = input.trim();
  try {
    text = decodeURIComponent(text);
  } catch {
    // Not percent-encoded; match against the raw input.
  }
  const urn = POST_URN.exec(text);
  if (urn) return `urn:li:${urn[1]}:${urn[2]}`;
  const slug = POST_SLUG.exec(text);
  if (slug) return `urn:li:${slug[1]}:${slug[2]}`;
  throw new UserInputError(
    `Could not find a LinkedIn post in "${input}". Pass a post URN (urn:li:share:…, urn:li:ugcPost:… or urn:li:activity:…) or the post's URL.`,
  );
}

export function postUrl(urn: string): string {
  return `https://www.linkedin.com/feed/update/${urn}/`;
}
