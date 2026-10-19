/** A feature of LinkedIn's Community Management API, which a yes/no setting turns on by adding its scope. */
export interface Feature {
  scope: string;
  /** The setting's name in the Claude Desktop extension. */
  setting: string;
  /** The environment variable behind the setting. */
  variable: string;
}

export const COMMENTS: Feature = { scope: 'w_member_social_feed', setting: 'Comments and reactions', variable: 'LINKEDIN_COMMENTS' };
export const PAGES: Feature = { scope: 'w_organization_social', setting: 'Post as LinkedIn Pages', variable: 'LINKEDIN_PAGES' };
export const FEATURES = [COMMENTS, PAGES];

/** The product a LinkedIn app needs for each scope the connector asks for. */
const PRODUCTS: Record<string, string> = {
  openid: 'Sign In with LinkedIn using OpenID Connect',
  profile: 'Sign In with LinkedIn using OpenID Connect',
  email: 'Sign In with LinkedIn using OpenID Connect',
  w_member_social: 'Share on LinkedIn',
  w_member_social_feed: 'Community Management API',
  w_organization_social: 'Community Management API',
};

export interface RefusedScope {
  scope: string;
  /** The LinkedIn product that grants it, when the connector knows it. */
  product?: string;
  /** The setting that asked for it, when it is optional. */
  feature?: Feature;
}

/**
 * The scope LinkedIn refused to authorize because the app lacks the product that grants it, from the error it
 * redirects back with (`unauthorized_scope_error`, "Scope &quot;w_member_social_feed&quot; is not authorized for
 * your application"). Undefined for any other error.
 */
export function refusedScope(error: string, description: string, requested: string[]): RefusedScope | undefined {
  if (!/scope/i.test(error)) return undefined;
  // Split at anything a scope name can't contain, which also takes the quotes off, HTML-escaped or not.
  const words = new Set(description.split(/[^\w.:-]+/));
  const scope = requested.find((name) => words.has(name));
  if (scope === undefined) return undefined;
  return { scope, product: PRODUCTS[scope], feature: FEATURES.find((feature) => feature.scope === scope) };
}
