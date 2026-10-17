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
  message: string;
}

export interface LoginStart {
  authorizationUrl: string;
  expiresInSeconds: number;
}

/** Supplies LinkedIn tokens to the tools: from local storage (stdio) or the connector's OAuth grant (HTTP). */
export interface LinkedInAuth {
  /** Returns a valid session or throws NotAuthenticatedError explaining how to sign in. */
  getSession(): Promise<LinkedInSession>;
  /** Caches the member looked up via userinfo so later calls skip the lookup. */
  rememberMember(member: MemberInfo): Promise<void>;
  status(): Promise<AuthStatus>;
  /** Starts an interactive browser sign-in (stdio mode only). */
  login?(): Promise<LoginStart>;
  /** Forgets stored credentials (stdio mode only). Returns whether anything was removed. */
  logout?(): Promise<boolean>;
}
