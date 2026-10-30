import type { CallToolResult } from '@modelcontextprotocol/server';
import { REAUTH_HINT } from '../auth/hints.js';
import { ConfigError, LinkedInApiError, LinkedInOAuthError, NotAuthenticatedError, sentence, UnconfirmedError, UserInputError } from '../errors.js';
import { FetchError } from '../net/safe-fetch.js';

export type Mode = 'local' | 'remote';

const RECONNECT = "Disconnect and reconnect the LinkedIn connector in Claude's settings";

/** Remote mode: the one way to replace the LinkedIn authorization a connection carries. */
export const RECONNECT_HINT = `${RECONNECT}.`;

function reauthHint(mode: Mode): string {
  return mode === 'local' ? REAUTH_HINT : `${RECONNECT} to sign in again.`;
}

/** Whether a request was given up on for taking too long (`AbortSignal.timeout`) or aborted. */
export function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/** Whether this is undici's report of a network failure: a bare "fetch failed" with the reason in `cause`. */
export function isFetchFailure(error: unknown): error is TypeError {
  return error instanceof TypeError && error.message === 'fetch failed';
}

/** Turns any failure into a message that tells the user (via Claude) what went wrong and what to do. */
export function describeError(error: unknown, mode: Mode): string {
  if (
    error instanceof NotAuthenticatedError ||
    error instanceof UserInputError ||
    error instanceof ConfigError ||
    error instanceof FetchError ||
    error instanceof UnconfirmedError
  ) {
    return error.message;
  }
  if (error instanceof LinkedInApiError) {
    // LinkedIn did what was asked but its answer lacked something, e.g. a created post's ID: never say it was rejected,
    // which could get the post published again.
    if (error.status < 400) return error.message;
    const detail = sentence(error.message);
    switch (error.status) {
      case 401:
        return `LinkedIn rejected the access token (it has expired or been revoked). ${reauthHint(mode)}`;
      case 403:
        return (
          `LinkedIn denied permission for this action: ${detail} ` +
          'Check that your LinkedIn app has the product this feature needs and that you signed in with the matching scopes. ' +
          reauthHint(mode)
        );
      case 426:
        // The client already tried the versions of the past year, so the clock or the connector is off.
        return (
          `LinkedIn accepts none of the API versions the connector tried: ${detail} ` +
          'Check the clock of the computer the connector runs on and update the connector to its latest release, or set LINKEDIN_API_VERSION to a version LinkedIn supports (YYYYMM).'
        );
      case 429:
        return `LinkedIn's rate limit was reached${error.details.retryAfter ? ` (retry after ${error.details.retryAfter}s)` : ''}. Try again later.`;
      default:
        return error.status >= 500
          ? `LinkedIn had an internal problem (HTTP ${error.status}): ${detail} Try again in a moment.`
          : `LinkedIn rejected the request (HTTP ${error.status}): ${detail}`;
    }
  }
  if (error instanceof LinkedInOAuthError) return `LinkedIn sign-in failed: ${error.message}`;
  if (isTimeout(error)) return 'LinkedIn did not respond in time. Try again.';
  if (isFetchFailure(error)) {
    const cause = error.cause instanceof Error ? error.cause : undefined;
    const reason = (cause as NodeJS.ErrnoException | undefined)?.code ?? cause?.message;
    return `Could not reach LinkedIn${reason ? ` (${reason})` : ''}. Check the internet connection and try again.`;
  }
  return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Names a failure for the remote audit log: its kind, with LinkedIn's status and error code or the network error's
 * code. Never its message, which can quote the tool's arguments, such as an image URL with a signed query string.
 */
export function errorKind(error: unknown): string {
  if (error instanceof LinkedInApiError) {
    const { code, serviceErrorCode } = error.details;
    return `${error.name}: HTTP ${error.status}${code ? ` ${code}` : ''}${serviceErrorCode === undefined ? '' : ` (service error ${serviceErrorCode})`}`;
  }
  if (error instanceof LinkedInOAuthError) return `${error.name}: ${error.error}`;
  if (error instanceof UnconfirmedError) return `${error.name}: ${errorKind(error.cause)}`;
  if (isFetchFailure(error)) {
    const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
    return `${error.name}: fetch failed${code ? ` (${code})` : ''}`;
  }
  return error instanceof Error ? error.name : typeof error;
}

export function errorResult(error: unknown, mode: Mode): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: describeError(error, mode) }] };
}
