import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMENTS, PAGES, refusedScope } from '../src/linkedin/scopes.js';

describe('refusedScope', () => {
  const requested = ['openid', 'profile', 'email', 'w_member_social', 'w_member_social_feed', 'w_organization_social', 'r_ads'];
  const refused = (scope: string, error = 'unauthorized_scope_error') =>
    refusedScope(error, `Scope &quot;${scope}&quot; is not authorized for your application`, requested);

  it('finds the scope LinkedIn would not authorize, the product that grants it and the setting that asked for it', () => {
    expect(refused('w_member_social_feed')).toEqual({ scope: 'w_member_social_feed', product: 'Community Management API', feature: COMMENTS });
    expect(refused('w_organization_social', 'invalid_scope')).toEqual({ scope: 'w_organization_social', product: 'Community Management API', feature: PAGES });
    // Part of w_member_social_feed's name, but a scope of its own.
    expect(refused('w_member_social')).toEqual({ scope: 'w_member_social', product: 'Share on LinkedIn', feature: undefined });
    for (const scope of ['openid', 'profile', 'email']) {
      expect(refused(scope)).toEqual({ scope, product: 'Sign In with LinkedIn using OpenID Connect', feature: undefined });
    }
    expect(refused('r_ads')).toEqual({ scope: 'r_ads', product: undefined, feature: undefined });
    expect(refusedScope('unauthorized_scope_error', 'Scope "w_member_social_feed" is not authorized', requested)?.scope).toBe('w_member_social_feed');
  });

  it('ignores other errors, and scopes the connector did not ask for', () => {
    expect(refused('w_member_social_feed', 'user_cancelled_authorize')).toBeUndefined();
    expect(refused('r_liteprofile')).toBeUndefined();
  });

  it('names the settings as the Claude Desktop extension shows them', () => {
    const manifest = JSON.parse(readFileSync('mcpb/manifest.json', 'utf8')) as {
      server: { mcp_config: { env: Record<string, string> } };
      user_config: Record<string, { title: string }>;
    };
    // Messages name a setting both ways, e.g. "Folders for local files" (LINKEDIN_FILE_DIRS).
    const labels = {
      ...Object.fromEntries([COMMENTS, PAGES].map((feature) => [feature.variable, feature.setting])),
      LINKEDIN_FILE_DIRS: 'Folders for local files',
      LINKEDIN_REDIRECT_URI: 'Redirect URL',
    };
    for (const [variable, label] of Object.entries(labels)) {
      const key = /^\$\{user_config\.(\w+)\}$/.exec(manifest.server.mcp_config.env[variable] ?? '')?.[1];
      expect(key && manifest.user_config[key]?.title, variable).toBe(label);
    }
    expect([COMMENTS.scope, PAGES.scope]).toEqual(['w_member_social_feed', 'w_organization_social']);
  });
});
