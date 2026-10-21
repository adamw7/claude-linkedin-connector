/** A usable LinkedIn access token plus what we know about its owner. */
export interface LinkedInSession {
  accessToken: string;
  /** LinkedIn member ID (the OpenID Connect `sub`), when already known. */
  memberId?: string;
  name?: string;
  email?: string;
  scopes: string[];
  /** Epoch milliseconds. */
  expiresAt?: number;
}

export interface MemberInfo {
  id: string;
  name?: string;
  email?: string;
}

export interface AuthStatus {
  authenticated: boolean;
  /** Where the token comes from. */
  source: 'environment' | 'token-file' | 'connector' | 'none';
  name?: string;
  email?: string;
  memberUrn?: string;
  /** ISO 8601. */
  expiresAt?: string;
  scopes: string[];
  /** Configured scopes the token lacks because it predates them; signing in again grants them. */
  missingScopes?: string[];
  message: string;
}

export interface LoginStart {
  authorizationUrl: string;
  expiresInSeconds: number;
  /** Where LinkedIn sends the browser back to; the LinkedIn app must list it among its redirect URLs. */
  redirectUri: string;
  /**
   * Whether the sign-in page was opened in the user's browser, by this call or an earlier one joining the same
   * sign-in; they may still need the link if it didn't appear. False when it couldn't be opened (e.g. there is no
   * xdg-open): nobody can approve the sign-in until they open the link themselves.
   */
  browserOpened: boolean;
  /** Settles when the browser sign-in finishes: with the member's name, or rejected with why it failed. */
  completion: Promise<string | undefined>;
}

/** Supplies LinkedIn tokens to the tools: from local storage (stdio) or the connector's OAuth grant (HTTP). */
export interface LinkedInAuth {
  /** Returns a valid session or throws NotAuthenticatedError explaining how to sign in. */
  getSession(): Promise<LinkedInSession>;
  /** Caches the member looked up via userinfo so later calls skip the lookup. */
  rememberMember(member: MemberInfo): Promise<void>;
  status(): Promise<AuthStatus>;
  /** Starts an interactive browser sign-in, opening it in the browser when possible (stdio mode only). */
  login?(): Promise<LoginStart>;
  /** Forgets stored credentials (stdio mode only). Returns whether anything was removed. */
  logout?(): Promise<boolean>;
  /**
   * LinkedIn rejected the session's token (it was revoked, or expired early): forgets it, so the user counts as
   * signed out and a sign-in replaces it (stdio mode only). Returns false when it isn't the stored token, such as
   * LINKEDIN_ACCESS_TOKEN, which only the user can replace.
   */
  rejected?(session: LinkedInSession): Promise<boolean>;
}
