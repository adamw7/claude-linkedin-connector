import type { AuthInfo } from '@modelcontextprotocol/server';
import type { AuthStatus, LinkedInAuth, LinkedInSession, MemberInfo } from '../auth/types.js';
import { NotAuthenticatedError } from '../errors.js';
import { personUrn } from '../linkedin/urn.js';
import type { LinkedInGrant } from './oauth-server.js';

const RECONNECT = "Disconnect and reconnect the LinkedIn connector in Claude's settings.";

export function grantFromAuthInfo(authInfo: AuthInfo | undefined): LinkedInGrant | undefined {
  const grant = authInfo?.extra?.linkedin as LinkedInGrant | undefined;
  return grant && typeof grant.at === 'string' ? grant : undefined;
}

/** Tokens for HTTP mode: the LinkedIn grant carried inside the caller's verified access token. */
export class ConnectorAuth implements LinkedInAuth {
  constructor(
    private grant: LinkedInGrant | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  async getSession(): Promise<LinkedInSession> {
    const grant = this.grant;
    if (!grant) throw new NotAuthenticatedError(`This request carries no LinkedIn authorization. ${RECONNECT}`);
    if (grant.exp !== undefined && grant.exp - 60_000 <= this.now()) {
      throw new NotAuthenticatedError(`The LinkedIn authorization has expired. ${RECONNECT}`);
    }
    return { accessToken: grant.at, scopes: grant.sc, expiresAt: grant.exp, memberId: grant.sub, name: grant.name, email: grant.email };
  }

  async rememberMember(member: MemberInfo): Promise<void> {
    if (this.grant) this.grant = { ...this.grant, sub: member.id, name: member.name ?? this.grant.name };
  }

  async status(): Promise<AuthStatus> {
    let session: LinkedInSession;
    try {
      session = await this.getSession();
    } catch (error) {
      if (!(error instanceof NotAuthenticatedError)) throw error;
      return { authenticated: false, source: 'none', scopes: [], message: error.message };
    }
    return {
      authenticated: true,
      source: 'connector',
      scopes: session.scopes,
      name: session.name,
      email: session.email,
      memberUrn: session.memberId && personUrn(session.memberId),
      expiresAt: session.expiresAt === undefined ? undefined : new Date(session.expiresAt).toISOString(),
      message: `Connected to LinkedIn${session.name ? ` as ${session.name}` : ''}.`,
    };
  }
}
