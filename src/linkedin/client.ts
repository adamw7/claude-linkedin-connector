import { LinkedInApiError } from '../errors.js';
import { USER_AGENT } from '../version.js';
import type { ApiVersion } from './versions.js';

export const LINKEDIN_API_BASE = 'https://api.linkedin.com';

/** OpenID Connect userinfo for the authenticated member. */
export interface LinkedInUserInfo {
  sub: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  email?: string;
  email_verified?: boolean;
  locale?: { country?: string; language?: string } | string;
}

export type PostVisibility = 'PUBLIC' | 'CONNECTIONS';

export type PostContent =
  | { article: { source: string; title: string; description?: string; thumbnail?: string } }
  | { media: { id: string; title?: string; altText?: string } }
  | { multiImage: { images: Array<{ id: string; altText?: string }> } };

export interface PostRequest {
  author: string;
  commentary: string;
  visibility: PostVisibility;
  content?: PostContent;
}

export type AssetKind = 'images' | 'documents';

/** Reaction types as named by the API (the UI labels differ, see tools). */
export type ReactionType = 'LIKE' | 'PRAISE' | 'APPRECIATION' | 'EMPATHY' | 'INTEREST' | 'ENTERTAINMENT';

export interface LinkedInClientOptions {
  accessToken: string;
  version: ApiVersion;
  fetch?: typeof globalThis.fetch;
  apiBaseUrl?: string;
  timeoutMs?: number;
}

/** Thin client for the LinkedIn REST endpoints the connector uses. */
export class LinkedInClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly apiBase: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: LinkedInClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.apiBase = (options.apiBaseUrl ?? LINKEDIN_API_BASE).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async getUserInfo(): Promise<LinkedInUserInfo> {
    const response = await this.call('GET', '/v2/userinfo', { versioned: false });
    return (await response.json()) as LinkedInUserInfo;
  }

  /** Publishes a post and returns its URN (urn:li:share:… or urn:li:ugcPost:…). */
  async createPost(post: PostRequest): Promise<string> {
    const body = {
      author: post.author,
      commentary: post.commentary,
      visibility: post.visibility,
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      ...(post.content ? { content: post.content } : {}),
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };
    const response = await this.call('POST', '/rest/posts', { body });
    const id = response.headers.get('x-restli-id') ?? response.headers.get('x-linkedin-id');
    await response.body?.cancel();
    if (!id) throw new LinkedInApiError(response.status, 'LinkedIn created the post but did not return its ID.');
    return id;
  }

  /** Replaces a post's text (Rest.li partial update). */
  async updatePostText(postUrn: string, commentary: string): Promise<void> {
    const response = await this.call('POST', `/rest/posts/${encodeURIComponent(postUrn)}`, {
      body: { patch: { $set: { commentary } } },
      restliMethod: 'PARTIAL_UPDATE',
    });
    await response.body?.cancel();
  }

  async deletePost(postUrn: string): Promise<void> {
    const response = await this.call('DELETE', `/rest/posts/${encodeURIComponent(postUrn)}`, { restliMethod: 'DELETE' });
    await response.body?.cancel();
  }

  /** Registers an upload and returns the URL to PUT the bytes to plus the asset URN. */
  async initializeUpload(kind: AssetKind, owner: string): Promise<{ uploadUrl: string; urn: string }> {
    const response = await this.call('POST', `/rest/${kind}?action=initializeUpload`, {
      body: { initializeUploadRequest: { owner } },
    });
    const json = (await response.json()) as { value?: { uploadUrl?: string; image?: string; document?: string } };
    const uploadUrl = json.value?.uploadUrl;
    const urn = kind === 'images' ? json.value?.image : json.value?.document;
    if (!uploadUrl || !urn) {
      throw new LinkedInApiError(response.status, `LinkedIn returned an unexpected ${kind} upload response.`);
    }
    return { uploadUrl, urn };
  }

  async upload(uploadUrl: string, data: Uint8Array): Promise<void> {
    const response = await this.fetchImpl(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`,
        'Content-Type': 'application/octet-stream',
        'User-Agent': USER_AGENT,
      },
      body: data,
      signal: AbortSignal.timeout(Math.max(this.timeoutMs, 300_000)),
    });
    await this.check(response, 'PUT', 'upload');
    await response.body?.cancel();
  }

  /** Processing status of an uploaded asset, e.g. PROCESSING or AVAILABLE. */
  async getAssetStatus(kind: AssetKind, urn: string): Promise<string | undefined> {
    const response = await this.call('GET', `/rest/${kind}/${encodeURIComponent(urn)}`);
    const json = (await response.json()) as { status?: string };
    return json.status;
  }

  /** Comments on a post (or replies to a comment) and returns the comment ID if LinkedIn provides one. */
  async createComment(target: string, actor: string, text: string): Promise<string | undefined> {
    const response = await this.call('POST', `/rest/socialActions/${encodeURIComponent(target)}/comments`, {
      body: { actor, object: target, message: { text } },
    });
    const id = response.headers.get('x-restli-id') ?? undefined;
    await response.body?.cancel();
    return id;
  }

  async createReaction(target: string, actor: string, reactionType: ReactionType): Promise<void> {
    const response = await this.call('POST', `/rest/reactions?actor=${encodeURIComponent(actor)}`, {
      body: { root: target, reactionType },
    });
    await response.body?.cancel();
  }

  private async call(
    method: string,
    path: string,
    options: { body?: unknown; versioned?: boolean; restliMethod?: string } = {},
  ): Promise<Response> {
    const url = this.apiBase + path;
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const send = (version: string | undefined) => this.send(method, url, body, version, options.restliMethod);
    if (options.versioned === false) return this.check(await send(undefined), method, path);
    const version = this.options.version.value;
    let response = await send(version);
    if (response.status === 426) {
      const recovered = await this.options.version.recover(version, send);
      if (recovered) {
        await response.body?.cancel();
        response = recovered;
      }
    }
    return this.check(response, method, path);
  }

  private send(
    method: string,
    url: string,
    body: string | undefined,
    version: string | undefined,
    restliMethod: string | undefined,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.accessToken}`,
      'X-Restli-Protocol-Version': '2.0.0',
      'User-Agent': USER_AGENT,
    };
    if (version) headers['LinkedIn-Version'] = version;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (restliMethod) headers['X-RestLi-Method'] = restliMethod;
    return this.fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
  }

  private async check(response: Response, method: string, path: string): Promise<Response> {
    if (response.ok) return response;
    const text = await response.text().catch(() => '');
    let parsed: { message?: unknown; code?: unknown; serviceErrorCode?: unknown } = {};
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      // Non-JSON error body; fall back to the raw text.
    }
    const message =
      (typeof parsed.message === 'string' && parsed.message) ||
      text.slice(0, 500) ||
      response.statusText ||
      `HTTP ${response.status}`;
    throw new LinkedInApiError(response.status, message, {
      ...(typeof parsed.code === 'string' ? { code: parsed.code } : {}),
      ...(typeof parsed.serviceErrorCode === 'number' ? { serviceErrorCode: parsed.serviceErrorCode } : {}),
      ...(response.headers.get('retry-after') ? { retryAfter: response.headers.get('retry-after')! } : {}),
      method,
      path,
    });
  }
}
