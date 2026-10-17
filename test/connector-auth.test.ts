import { describe, expect, it } from 'vitest';
import { NotAuthenticatedError } from '../src/errors.js';
import { ConnectorAuth, grantFromAuthInfo } from '../src/remote/connector-auth.js';
import type { LinkedInGrant } from '../src/remote/oauth-server.js';

const NOW = 1_700_000_000_000;
const grant: LinkedInGrant = { at: 'li-token', exp: NOW + 3_600_000, sc: ['openid', 'w_member_social'], sub: 'abc123', name: 'Ada', email: 'ada@example.com' };

describe('grantFromAuthInfo', () => {
  it('extracts the LinkedIn grant from verified auth info', () => {
    expect(grantFromAuthInfo({ token: 't', clientId: 'c', scopes: [], extra: { linkedin: grant } })).toBe(grant);
  });

  it('ignores missing or malformed grants', () => {
    expect(grantFromAuthInfo(undefined)).toBeUndefined();
    expect(grantFromAuthInfo({ token: 't', clientId: 'c', scopes: [] })).toBeUndefined();
    expect(grantFromAuthInfo({ token: 't', clientId: 'c', scopes: [], extra: { linkedin: { at: 42 } } })).toBeUndefined();
  });
});

describe('ConnectorAuth', () => {
  it('turns the grant into a session', async () => {
    expect(await new ConnectorAuth(grant, () => NOW).getSession()).toEqual({
      accessToken: 'li-token',
      scopes: ['openid', 'w_member_social'],
      expiresAt: NOW + 3_600_000,
      memberId: 'abc123',
      name: 'Ada',
      email: 'ada@example.com',
    });
    expect(await new ConnectorAuth({ at: 'x', sc: [] }, () => NOW).getSession()).toEqual({ accessToken: 'x', scopes: [] });
  });

  it('refuses without a grant or within a minute of expiry', async () => {
    await expect(new ConnectorAuth(undefined).getSession()).rejects.toThrow(NotAuthenticatedError);
    await expect(new ConnectorAuth({ ...grant, exp: NOW + 59_000 }, () => NOW).getSession()).rejects.toThrow(/expired/);
    await expect(new ConnectorAuth({ ...grant, exp: NOW + 61_000 }, () => NOW).getSession()).resolves.toBeDefined();
  });

  it('remembers the member for the rest of the request', async () => {
    const auth = new ConnectorAuth({ at: 'x', sc: [] }, () => NOW);
    await auth.rememberMember({ id: 'm1', name: 'Grace' });
    expect(await auth.getSession()).toMatchObject({ memberId: 'm1', name: 'Grace' });
    const anonymous = new ConnectorAuth(undefined);
    await anonymous.rememberMember({ id: 'm1' });
    await expect(anonymous.getSession()).rejects.toThrow(NotAuthenticatedError);
  });

  it('reports its status', async () => {
    expect(await new ConnectorAuth(grant, () => NOW).status()).toEqual({
      authenticated: true,
      source: 'connector',
      scopes: ['openid', 'w_member_social'],
      name: 'Ada',
      email: 'ada@example.com',
      memberUrn: 'urn:li:person:abc123',
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
      message: 'Connected to LinkedIn as Ada.',
    });
    expect(await new ConnectorAuth(undefined).status()).toMatchObject({ authenticated: false, source: 'none', scopes: [] });
    expect((await new ConnectorAuth({ at: 'x', sc: [] }).status()).message).toBe('Connected to LinkedIn.');
  });
});
