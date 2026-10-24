import { describe, expect, it } from 'vitest';
import { REAUTH_HINT } from '../src/auth/local-auth.js';
import { ConfigError, LinkedInApiError, LinkedInOAuthError, NotAuthenticatedError, sentence, UnconfirmedError, UserInputError } from '../src/errors.js';
import { describeError, errorKind, errorResult } from '../src/mcp/errors.js';
import { FetchError } from '../src/net/safe-fetch.js';

describe('sentence', () => {
  it('ends text with exactly one full stop', () => {
    expect(sentence('Scope not authorized')).toBe('Scope not authorized.');
    expect(sentence('Scope not authorized.')).toBe('Scope not authorized.');
    expect(sentence('')).toBe('.');
  });
});

describe('describeError', () => {
  it('passes through messages written for the user', () => {
    for (const error of [
      new NotAuthenticatedError('Sign in first.'),
      new UserInputError('Text is too long.'),
      new ConfigError('Missing LINKEDIN_CLIENT_ID.'),
      new FetchError('The image URL points to a private address.'),
      new UnconfirmedError('LinkedIn did not answer in time. The post may have been published anyway.'),
    ]) {
      expect(describeError(error, 'local')).toBe(error.message);
    }
  });

  it('tells local users to sign in again and remote users to reconnect', () => {
    const error = new LinkedInApiError(401, 'Revoked');
    expect(describeError(error, 'local')).toBe(
      'LinkedIn rejected the access token (it has expired or been revoked). To sign in again, run the linkedin_login tool with force: true. ' +
        'If LINKEDIN_ACCESS_TOKEN is set, replace it with a fresh token instead.',
    );
    expect(describeError(error, 'local')).toContain(REAUTH_HINT);
    expect(describeError(error, 'remote')).toMatch(/Disconnect and reconnect/);
    expect(describeError(new LinkedInApiError(403, 'Not enough permissions'), 'remote')).toMatch(
      /^LinkedIn denied permission for this action: Not enough permissions\. .*Disconnect and reconnect/,
    );
  });

  it('explains API version and rate-limit errors', () => {
    expect(describeError(new LinkedInApiError(426, 'Version not active'), 'local')).toBe(
      'LinkedIn accepts none of the API versions the connector tried: Version not active. Check the clock of the computer the connector runs on ' +
        'and update the connector to its latest release, or set LINKEDIN_API_VERSION to a version LinkedIn supports (YYYYMM).',
    );
    expect(describeError(new LinkedInApiError(429, 'Slow down', { retryAfter: '30' }), 'local')).toBe(
      "LinkedIn's rate limit was reached (retry after 30s). Try again later.",
    );
    expect(describeError(new LinkedInApiError(429, 'Slow down'), 'local')).toBe("LinkedIn's rate limit was reached. Try again later.");
  });

  it('never calls a request LinkedIn accepted rejected', () => {
    expect(describeError(new LinkedInApiError(201, 'LinkedIn accepted the post but did not return its ID.'), 'local')).toBe(
      'LinkedIn accepted the post but did not return its ID.',
    );
    expect(describeError(new LinkedInApiError(399, 'Unexpected answer.'), 'remote')).toBe('Unexpected answer.');
    expect(describeError(new LinkedInApiError(400, 'Bad request'), 'local')).toBe('LinkedIn rejected the request (HTTP 400): Bad request.');
  });

  it('distinguishes server errors from other rejections', () => {
    expect(describeError(new LinkedInApiError(503, 'Unavailable'), 'local')).toBe(
      'LinkedIn had an internal problem (HTTP 503): Unavailable. Try again in a moment.',
    );
    // A trailing period is not doubled.
    expect(describeError(new LinkedInApiError(422, 'Bad field.'), 'local')).toBe('LinkedIn rejected the request (HTTP 422): Bad field.');
  });

  it('describes OAuth failures, timeouts and anything else', () => {
    expect(describeError(new LinkedInOAuthError('invalid_grant', 'Code expired'), 'local')).toBe(
      'LinkedIn sign-in failed: invalid_grant: Code expired',
    );
    expect(describeError(new DOMException('timed out', 'TimeoutError'), 'local')).toBe('LinkedIn did not respond in time. Try again.');
    expect(describeError(new DOMException('aborted', 'AbortError'), 'local')).toBe('LinkedIn did not respond in time. Try again.');
    const offline = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
    expect(describeError(offline, 'local')).toBe('Could not reach LinkedIn (ENOTFOUND). Check the internet connection and try again.');
    expect(describeError(new TypeError('fetch failed'), 'local')).toBe('Could not reach LinkedIn. Check the internet connection and try again.');
    expect(describeError(new Error('boom'), 'local')).toBe('Unexpected error: boom');
    expect(describeError('plain string', 'local')).toBe('Unexpected error: plain string');
  });
});

describe('errorKind', () => {
  it("names a failure without its message, which can quote the tool's arguments", () => {
    expect(errorKind(new FetchError('Fetching https://cdn.example/a.png?X-Amz-Signature=abc failed with HTTP 403.'))).toBe('FetchError');
    expect(errorKind(new UserInputError('Could not find a LinkedIn post in "my draft".'))).toBe('UserInputError');
    expect(errorKind(new NotAuthenticatedError('Sign in first.'))).toBe('NotAuthenticatedError');
    expect(errorKind(new DOMException('timed out', 'TimeoutError'))).toBe('TimeoutError');
    expect(errorKind(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe('TypeError');
    expect(errorKind('plain string')).toBe('string');
  });

  it("keeps LinkedIn's status and error codes, and the network error's code", () => {
    const denied = new LinkedInApiError(403, 'Not enough permissions to access: urn:li:share:1', { code: 'ACCESS_DENIED', serviceErrorCode: 100 });
    expect(errorKind(denied)).toBe('LinkedInApiError: HTTP 403 ACCESS_DENIED (service error 100)');
    expect(errorKind(new LinkedInApiError(502, 'Bad gateway'))).toBe('LinkedInApiError: HTTP 502');
    expect(errorKind(new LinkedInOAuthError('invalid_grant', 'Code expired'))).toBe('LinkedInOAuthError: invalid_grant');
    const offline = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.linkedin.com'), { code: 'ENOTFOUND' }) });
    expect(errorKind(offline)).toBe('TypeError: fetch failed (ENOTFOUND)');
    expect(errorKind(new TypeError('fetch failed'))).toBe('TypeError: fetch failed');
  });

  it('names what LinkedIn answered when it may have published something anyway', () => {
    const gateway = new LinkedInApiError(504, 'Gateway Timeout', { code: 'GATEWAY_TIMEOUT' });
    expect(errorKind(new UnconfirmedError('The post "Our Q3 results" may have been published.', { cause: gateway }))).toBe(
      'UnconfirmedError: LinkedInApiError: HTTP 504 GATEWAY_TIMEOUT',
    );
    expect(errorKind(new UnconfirmedError('x', { cause: new DOMException('timed out', 'TimeoutError') }))).toBe('UnconfirmedError: TimeoutError');
  });
});

describe('errorResult', () => {
  it('wraps the description in an MCP error result', () => {
    expect(errorResult(new UserInputError('Nope.'), 'remote')).toEqual({ isError: true, content: [{ type: 'text', text: 'Nope.' }] });
  });
});

describe('error classes', () => {
  it('carry their names and details', () => {
    const api = new LinkedInApiError(400, 'Bad', { code: 'INVALID', method: 'POST', path: '/rest/posts' });
    expect(api).toBeInstanceOf(Error);
    expect(api.name).toBe('LinkedInApiError');
    expect(api.details).toEqual({ code: 'INVALID', method: 'POST', path: '/rest/posts' });
    expect(new LinkedInApiError(500, 'x').details).toEqual({});

    expect(new LinkedInOAuthError('access_denied').message).toBe('access_denied');
    expect(new LinkedInOAuthError('access_denied', 'User said no').message).toBe('access_denied: User said no');
    expect(new NotAuthenticatedError('x').name).toBe('NotAuthenticatedError');
    expect(new UserInputError('x').name).toBe('UserInputError');
    expect(new ConfigError('x').name).toBe('ConfigError');
    const cause = new Error('timed out');
    expect(new UnconfirmedError('x', { cause })).toMatchObject({ name: 'UnconfirmedError', cause });
  });
});
