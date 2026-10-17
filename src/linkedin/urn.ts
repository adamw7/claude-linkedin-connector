import { UserInputError } from '../errors.js';

const POST_URN = /urn:li:(share|ugcPost|activity):(\d+)/;
const ACTIVITY_SLUG = /activity-(\d{10,})/;

export function personUrn(memberId: string): string {
  return memberId.startsWith('urn:li:person:') ? memberId : `urn:li:person:${memberId}`;
}

export function organizationUrn(idOrUrn: string): string {
  const id = idOrUrn.trim().replace(/^urn:li:organization:/, '');
  if (!/^\d+$/.test(id)) {
    throw new UserInputError(`"${idOrUrn}" is not a LinkedIn organization ID (expected digits or urn:li:organization:<digits>).`);
  }
  return `urn:li:organization:${id}`;
}

/**
 * Extracts a post URN from a URN or any LinkedIn post URL, e.g.
 * `https://www.linkedin.com/feed/update/urn:li:share:123/` or
 * `https://www.linkedin.com/posts/jane_slug-activity-7123456789012345678-AbCd`.
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
  const slug = ACTIVITY_SLUG.exec(text);
  if (slug) return `urn:li:activity:${slug[1]}`;
  throw new UserInputError(
    `Could not find a LinkedIn post in "${input}". Pass a post URN (urn:li:share:…, urn:li:ugcPost:… or urn:li:activity:…) or the post's URL.`,
  );
}

export function postUrl(urn: string): string {
  return `https://www.linkedin.com/feed/update/${urn}/`;
}
