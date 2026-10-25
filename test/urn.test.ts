import { describe, expect, it } from 'vitest';
import { UserInputError } from '../src/errors.js';
import { isOrganizationUrn, organizationUrn, parsePostReference, personUrn, postUrl } from '../src/linkedin/urn.js';

describe('parsePostReference', () => {
  it.each([
    ['urn:li:share:7123456789012345678', 'urn:li:share:7123456789012345678'],
    ['urn:li:ugcPost:7123456789012345678', 'urn:li:ugcPost:7123456789012345678'],
    ['  urn:li:activity:7123456789012345678 ', 'urn:li:activity:7123456789012345678'],
    ['https://www.linkedin.com/feed/update/urn:li:share:7123456789012345678/', 'urn:li:share:7123456789012345678'],
    ['https://www.linkedin.com/feed/update/urn%3Ali%3AugcPost%3A7123456789012345678?utm_source=share', 'urn:li:ugcPost:7123456789012345678'],
    ['https://www.linkedin.com/posts/ada-lovelace_engines-activity-7123456789012345678-AbCd?utm_source=x', 'urn:li:activity:7123456789012345678'],
    ['https://www.linkedin.com/posts/ada-lovelace_engines-ugcPost-7123456789012345678-AbCd', 'urn:li:ugcPost:7123456789012345678'],
    [
      '<iframe src="https://www.linkedin.com/embed/feed/update/urn:li:share:7123456789012345678?collapsed=1" height="543" width="504" frameborder="0" allowfullscreen="" title="Embedded post"></iframe>',
      'urn:li:share:7123456789012345678',
    ],
  ])('parses %s', (input, expected) => {
    expect(parsePostReference(input)).toBe(expected);
  });

  it('rejects things that are not posts', () => {
    expect(() => parsePostReference('https://www.linkedin.com/in/ada')).toThrow(UserInputError);
    expect(() => parsePostReference('12345')).toThrow(UserInputError);
  });
});

describe('URN helpers', () => {
  it('builds person and organization URNs', () => {
    expect(personUrn('abc123')).toBe('urn:li:person:abc123');
    expect(personUrn('urn:li:person:abc123')).toBe('urn:li:person:abc123');
    expect(organizationUrn('2414183')).toBe('urn:li:organization:2414183');
    expect(organizationUrn('urn:li:organization:2414183')).toBe('urn:li:organization:2414183');
    expect(() => organizationUrn('acme')).toThrow(UserInputError);
  });

  it('tells Pages from members', () => {
    expect(isOrganizationUrn('urn:li:organization:2414183')).toBe(true);
    expect(isOrganizationUrn('urn:li:person:abc123')).toBe(false);
    // Only a URN: an ID or an address is not one yet.
    expect(isOrganizationUrn('2414183')).toBe(false);
    expect(isOrganizationUrn('see urn:li:organization:2414183')).toBe(false);
  });

  it("finds a Page's organization ID in the address of its admin view, and says where to look for it", () => {
    for (const address of [
      'https://www.linkedin.com/company/2414183/admin/dashboard/',
      ' linkedin.com/company/2414183 ',
      'https://www.LinkedIn.com/company/2414183?viewAsMember=true',
      'https://www.linkedin.com/company/2414183#about',
    ]) {
      expect(organizationUrn(address), address).toBe('urn:li:organization:2414183');
    }
    // The public address of most Pages has a name instead, and a longer number is not the ID.
    for (const address of ['https://www.linkedin.com/company/acme-corp/', 'https://www.linkedin.com/company/2414183acme/']) {
      expect(() => organizationUrn(address), address).toThrow(
        new UserInputError(
          `"${address}" is not a LinkedIn organization ID. Open the Page's admin view on linkedin.com: its address, linkedin.com/company/<ID>/admin/, ` +
            'holds the ID. Pass that number, that address, or urn:li:organization:<ID>.',
        ),
      );
    }
  });

  it('links to a post', () => {
    expect(postUrl('urn:li:share:1')).toBe('https://www.linkedin.com/feed/update/urn:li:share:1/');
  });
});
