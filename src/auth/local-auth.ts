import type { LocalConfig } from '../config.js';
import { ConfigError, NotAuthenticatedError, sentence } from '../errors.js';
import { LinkedInClient } from '../linkedin/client.js';
import { refreshAccessToken, TOKEN_EXPIRY_MARGIN_MS, type LinkedInOAuthApp, type LinkedInTokens } from '../linkedin/oauth.js';
import { personUrn } from '../linkedin/urn.js';
import type { ApiVersion } from '../linkedin/versions.js';
import { LoopbackLogin } from './loopback-login.js';
import { TokenStore, type StoredToken } from './token-store.js';
import type { AuthStatus, LinkedInAuth, LinkedInSession, LoginStart, MemberInfo } from './types.js';

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

/**
 * Without the LinkedIn app's credentials the browser sign-in can't start, so this, not SIGN_IN_HINT, is what to fix
 * first. Most users configure them in the Claude Desktop extension's settings, which it names as the extension does.
 */
export const CREDENTIALS_HINT =
  'LinkedIn sign-in needs your LinkedIn app\'s Client ID and Client Secret: enter them as "LinkedIn Client ID" and "LinkedIn Client Secret" in the Claude Desktop extension\'s settings, ' +
  'or set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET where the connector is configured (see the README). Or provide LINKEDIN_ACCESS_TOKEN directly.';

/** Starts the note, in "not signed in" messages, on why the last browser sign-in failed. */
export const LAST_FAILURE = 'The last sign-in attempt failed:';

export interface LocalAuthOptions {
  config: LocalConfig;
  version: ApiVersion;
  store?: TokenStore;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** Opens a sign-in page in the user's browser, resolving false if it couldn't; without it, sign-in only hands out the link. */
  openBrowser?: (url: string) => Promise<boolean>;
}

/** Tokens for stdio mode: LINKEDIN_ACCESS_TOKEN, or the file written by the browser sign-in. */
export class LocalAuth implements LinkedInAuth {
  readonly store: TokenStore;
  private readonly now: () => number;
  private envMember: MemberInfo | undefined;
  private loopback: LoopbackLogin | undefined;
  /** The sign-in page last opened in the browser, and whether that worked. */
  private opened: { url: string; result: Promise<boolean> } | undefined;

  constructor(private readonly options: LocalAuthOptions) {
    this.store = options.store ?? new TokenStore(options.config.tokenFile);
    this.now = options.now ?? Date.now;
  }

  private get config(): LocalConfig {
    return this.options.config;
  }

  private oauthApp(): LinkedInOAuthApp {
    const { clientId, clientSecret, scopes, oauthBaseUrl } = this.config;
    if (!clientId || !clientSecret) throw new ConfigError(CREDENTIALS_HINT);
    return { clientId, clientSecret, scopes, oauthBaseUrl, fetch: this.options.fetch };
  }

  private isExpired(expiresAt: number | undefined): boolean {
    return expiresAt !== undefined && expiresAt - TOKEN_EXPIRY_MARGIN_MS <= this.now();
  }

  async getSession(): Promise<LinkedInSession> {
    if (this.config.accessToken) {
      return { accessToken: this.config.accessToken, scopes: this.config.scopes, ...memberFields(this.envMember) };
    }
    let token = await this.store.read();
    if (!token) throw new NotAuthenticatedError(`You are not signed in to LinkedIn.${this.lastFailure()} ${this.signInHint()}`);
    if (this.isExpired(token.expiresAt)) {
      token = await this.tryRefresh(token);
      if (!token) throw new NotAuthenticatedError(`Your LinkedIn sign-in has expired.${this.lastFailure()} ${this.signInHint()}`);
    }
    return { accessToken: token.accessToken, scopes: token.scopes, expiresAt: token.expiresAt, ...memberFields(token.member) };
  }

  /** Whether a browser sign-in can start: it needs the LinkedIn app's credentials. */
  get canSignIn(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  /** How to sign in, or, without the app's credentials, that they come first: linkedin_login would only fail. */
  private signInHint(): string {
    return this.canSignIn ? SIGN_IN_HINT : CREDENTIALS_HINT;
  }

  /** Why the last browser sign-in failed, which only the browser showed: otherwise Claude just hands out another link. */
  private lastFailure(): string {
    const error = this.loopback?.lastError;
    return error ? ` ${LAST_FAILURE} ${sentence(error.message)}` : '';
  }

  private async tryRefresh(token: StoredToken): Promise<StoredToken | undefined> {
    if (!token.refreshToken || this.isExpired(token.refreshTokenExpiresAt)) return undefined;
    if (!this.canSignIn) return undefined;
    try {
      const refreshed = await refreshAccessToken(this.oauthApp(), token.refreshToken);
      const next = toStoredToken(refreshed, token.member, token.refreshToken, token.refreshTokenExpiresAt);
      await this.store.write(next);
      return next;
    } catch {
      return undefined;
    }
  }

  async rememberMember(member: MemberInfo): Promise<void> {
    if (this.config.accessToken) {
      this.envMember = member;
      return;
    }
    const token = await this.store.read();
    if (token && token.member?.id !== member.id) await this.store.write({ ...token, member });
  }

  async status(): Promise<AuthStatus> {
    let session: LinkedInSession;
    try {
      session = await this.getSession();
    } catch (error) {
      if (!(error instanceof NotAuthenticatedError)) throw error;
      return { authenticated: false, source: 'none', scopes: [], message: error.message };
    }
    const member = session.memberId ? { memberUrn: personUrn(session.memberId), name: session.name, email: session.email } : {};
    if (this.config.accessToken) {
      const message = 'Using the access token from LINKEDIN_ACCESS_TOKEN.';
      return { authenticated: true, source: 'environment', scopes: session.scopes, ...member, message };
    }
    const expires = session.expiresAt === undefined ? '' : ` until ${new Date(session.expiresAt).toISOString().slice(0, 10)}`;
    // Scopes added to LINKEDIN_SCOPES after signing in (e.g. for comments) need a new sign-in to take effect.
    const missingScopes = this.config.scopes.filter((scope) => !session.scopes.includes(scope));
    const missing =
      missingScopes.length === 0
        ? ''
        : ` That sign-in predates the ${missingScopes.join(', ')} permission${missingScopes.length > 1 ? 's' : ''} now configured: sign in again to grant ${missingScopes.length > 1 ? 'them' : 'it'}.`;
    return {
      authenticated: true,
      source: 'token-file',
      scopes: session.scopes,
      ...(missingScopes.length > 0 ? { missingScopes } : {}),
      expiresAt: session.expiresAt === undefined ? undefined : new Date(session.expiresAt).toISOString(),
      ...member,
      message: `Signed in${session.name ? ` as ${session.name}` : ''}${expires} (token stored in ${this.store.path}).${missing}`,
    };
  }

  async login(): Promise<LoginStart> {
    const flow = await this.startLoopback();
    const browserOpened = await this.open(flow.authorizationUrl);
    return {
      authorizationUrl: flow.authorizationUrl,
      expiresInSeconds: Math.max(0, Math.round((flow.expiresAt - this.now()) / 1000)),
      redirectUri: this.config.redirectUri,
      browserOpened,
      completion: flow.completion,
    };
  }

  /** Starts the sign-in and resolves with the member's name once the browser flow completes (CLI use). */
  async loginAndWait(onUrl: (url: string) => void): Promise<string | undefined> {
    const flow = await this.startLoopback();
    onUrl(flow.authorizationUrl);
    void this.open(flow.authorizationUrl);
    return flow.completion;
  }

  /**
   * Opens a sign-in page once: every tool call made while signed out (parallel ones, retries) joins the sign-in
   * that is waiting, and would otherwise open another tab of it. Each sign-in has its own URL. Resolves with
   * whether the page opened.
   */
  private open(authorizationUrl: string): Promise<boolean> {
    if (this.opened?.url !== authorizationUrl) {
      this.opened = { url: authorizationUrl, result: this.options.openBrowser?.(authorizationUrl) ?? Promise.resolve(false) };
    }
    return this.opened.result;
  }

  private startLoopback() {
    const app = this.oauthApp();
    this.loopback ??= new LoopbackLogin({
      app,
      redirectUri: this.config.redirectUri,
      onTokens: (tokens) => this.saveTokens(tokens),
    });
    return this.loopback.start();
  }

  async logout(): Promise<boolean> {
    this.envMember = undefined;
    return this.store.clear();
  }

  async rejected(session: LinkedInSession): Promise<boolean> {
    if (this.config.accessToken) return false;
    // Not a token stored since, by a sign-in that finished while this one was in use.
    if ((await this.store.read())?.accessToken !== session.accessToken) return false;
    return this.store.clear();
  }

  private async saveTokens(tokens: LinkedInTokens): Promise<string | undefined> {
    let member: MemberInfo | undefined;
    try {
      const { version, fetch } = this.options;
      const info = await new LinkedInClient({ accessToken: tokens.accessToken, version, apiBaseUrl: this.config.apiBaseUrl, fetch }).getUserInfo();
      member = { id: info.sub, name: info.name, email: info.email };
    } catch {
      // Without the openid/profile scopes there is no userinfo; posting will report the problem.
    }
    await this.store.write(toStoredToken(tokens, member));
    return member?.name;
  }
}

function toStoredToken(tokens: LinkedInTokens, member?: MemberInfo, previousRefreshToken?: string, previousRefreshExpiry?: number): StoredToken {
  return {
    version: 1,
    accessToken: tokens.accessToken,
    scopes: tokens.scopes,
    expiresAt: tokens.expiresAt,
    refreshToken: tokens.refreshToken ?? previousRefreshToken,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt ?? (tokens.refreshToken ? undefined : previousRefreshExpiry),
    member,
  };
}

function memberFields(member: MemberInfo | undefined): Partial<LinkedInSession> {
  return member ? { memberId: member.id, name: member.name, email: member.email } : {};
}
