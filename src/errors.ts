/** Thrown when a LinkedIn REST or upload call returns a non-2xx response. */
export class LinkedInApiError extends Error {
  override readonly name = 'LinkedInApiError';

  constructor(
    readonly status: number,
    message: string,
    readonly details: {
      code?: string;
      serviceErrorCode?: number;
      method?: string;
      path?: string;
      retryAfter?: string;
    } = {},
  ) {
    super(message);
  }
}

/** Thrown when LinkedIn's OAuth endpoints reject a code or refresh token. */
export class LinkedInOAuthError extends Error {
  override readonly name = 'LinkedInOAuthError';

  constructor(
    readonly error: string,
    readonly description?: string,
  ) {
    super(description ? `${error}: ${description}` : error);
  }
}

/** There is no usable LinkedIn token; the message tells the user how to get one. */
export class NotAuthenticatedError extends Error {
  override readonly name = 'NotAuthenticatedError';
}

/** A tool argument is invalid in a way the input schema cannot express. */
export class UserInputError extends Error {
  override readonly name = 'UserInputError';
}

/** Required configuration is missing or malformed. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** `text` ending in a full stop, so a sentence can follow it; LinkedIn's own messages often lack one. */
export function sentence(text: string): string {
  return text.replace(/\.?$/, '.');
}
