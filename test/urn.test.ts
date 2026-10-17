import { describe, expect, it } from 'vitest';
import { UserInputError } from '../src/errors.js';
import { organizationUrn, parsePostReference, personUrn, postUrl } from '../src/linkedin/urn.js';

describe('parsePostReference', () => {
  it.each([
    ['urn:li:share:7123456789012345678', 'urn:li:share:7123456789012345678'],
    ['urn:li:ugcPost:7123456789012345678', 'urn:li:ugcPost:7123456789012345678'],
    ['  urn:li:activity:7123456789012345678 ', 'urn:li:activity:7123456789012345678'],
    ['https://www.linkedin.com/feed/update/urn:li:share:7123456789012345678/', 'urn:li:share:7123456789012345678'],
    ['https://www.linkedin.com/feed/update/urn%3Ali%3AugcPost%3A7123456789012345678?utm_source=share', 'urn:li:ugcPost:7123456789012345678'],
    ['https://www.linkedin.com/posts/ada-lovelace_engines-activity-7123456789012345678-AbCd?utm_source=x', 'urn:li:activity:7123456789012345678'],
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

  it('links to a post', () => {
    expect(postUrl('urn:li:share:1')).toBe('https://www.linkedin.com/feed/update/urn:li:share:1/');
  });
});
