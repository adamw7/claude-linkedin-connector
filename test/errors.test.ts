import { describe, expect, it } from 'vitest';
import { SIGN_IN_HINT } from '../src/auth/local-auth.js';
import { ConfigError, LinkedInApiError, LinkedInOAuthError, NotAuthenticatedError, UserInputError } from '../src/errors.js';
import { describeError, errorResult } from '../src/mcp/errors.js';
import { FetchError } from '../src/net/safe-fetch.js';

describe('describeError', () => {
  it('passes through messages written for the user', () => {
    for (const error of [
      new NotAuthenticatedError('Sign in first.'),
      new UserInputError('Text is too long.'),
      new ConfigError('Missing LINKEDIN_CLIENT_ID.'),
      new FetchError('The image URL points to a private address.'),
    ]) {
      expect(describeError(error, 'local')).toBe(error.message);
    }
  });

  it('tells local users to sign in again and remote users to reconnect', () => {
    const error = new LinkedInApiError(401, 'Revoked');
    expect(describeError(error, 'local')).toContain(SIGN_IN_HINT);
    expect(describeError(error, 'remote')).toMatch(/Disconnect and reconnect/);
    expect(describeError(new LinkedInApiError(403, 'Not enough permissions'), 'remote')).toMatch(
      /^LinkedIn denied permission for this action: Not enough permissions\. .*Disconnect and reconnect/,
    );
  });

  it('explains API version and rate-limit errors', () => {
    expect(describeError(new LinkedInApiError(426, 'Version not active'), 'local')).toMatch(/LINKEDIN_API_VERSION/);
    expect(describeError(new LinkedInApiError(429, 'Slow down', { retryAfter: '30' }), 'local')).toBe(
      "LinkedIn's rate limit was reached (retry after 30s). Try again later.",
    );
    expect(describeError(new LinkedInApiError(429, 'Slow down'), 'local')).toBe("LinkedIn's rate limit was reached. Try again later.");
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
    expect(describeError(new Error('boom'), 'local')).toBe('Unexpected error: boom');
    expect(describeError('plain string', 'local')).toBe('Unexpected error: plain string');
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
  });
});
