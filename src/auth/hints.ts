/**
 * Claude reads this (linkedin_auth_status), so it names no terminal command: most installs (the Claude Desktop
 * extension, a clone set up with `npm run setup`) have no `claude-linkedin-connector` on the PATH, nor the app
 * credentials in the shell.
 */
export const SIGN_IN_HINT = "Ask Claude to run the linkedin_login tool, which opens LinkedIn's sign-in page in your browser.";

/** LinkedIn signs in whoever is signed in to linkedin.com in the browser, so signing in again alone doesn't switch accounts. */
export const SWITCH_ACCOUNT_HINT =
  'If you meant to switch to another LinkedIn account, sign out of linkedin.com in your browser first, then sign in again: LinkedIn signs in whoever is signed in there.';

/**
 * LinkedIn shows a redirect URL its app doesn't list, or a Client ID it doesn't know, on its own page and never
 * sends the browser back, so the connector can't tell that the sign-in failed: only say what to check.
 */
export function signInPageHint(redirectUri: string): string {
  return (
    `If LinkedIn shows an error instead of asking you to approve access, add ${redirectUri} to the authorized redirect URLs ` +
    `on the Auth tab of your LinkedIn app at https://www.linkedin.com/developers/apps, exactly as written, and check that the connector's Client ID is the app's.`
  );
}

/** For a stored token LinkedIn rejects: linkedin_login alone would report "already signed in". */
export const REAUTH_HINT =
  'To sign in again, run the linkedin_login tool with force: true. ' +
  'If LINKEDIN_ACCESS_TOKEN is set, replace it with a fresh token instead.';

/** LINKEDIN_ACCESS_TOKEN outranks the token a sign-in stores, so signing in again changes nothing while it is set. */
export const ACCESS_TOKEN_HINT =
  'Replace LINKEDIN_ACCESS_TOKEN with a fresh token, or remove it to sign in through the browser instead: ' +
  'while it is set, the connector ignores the token a sign-in stores.';

/** Starts the note, in "not signed in" messages, on why the last browser sign-in failed. */
export const LAST_FAILURE = 'The last sign-in attempt failed:';
