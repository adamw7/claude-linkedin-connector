import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { LinkedInAuth, LinkedInSession } from '../auth/types.js';
import { LinkedInApiError, UserInputError } from '../errors.js';
import { LinkedInClient, type AssetKind, type PostContent, type ReactionType } from '../linkedin/client.js';
import { fetchLinkPreview, type LinkPreview } from '../linkedin/link-preview.js';
import { loadMedia, type LoadedMedia, type MediaKind } from '../linkedin/media.js';
import { escapeLittleText } from '../linkedin/text.js';
import { organizationUrn, parsePostReference, personUrn, postUrl } from '../linkedin/urn.js';
import type { ApiVersion } from '../linkedin/versions.js';
import { NAME, VERSION } from '../version.js';
import { errorResult, type Mode } from './errors.js';

export interface ConnectorOptions {
  mode: Mode;
  auth: LinkedInAuth;
  version: ApiVersion;
  /** Scopes the LinkedIn app is configured with; optional tools appear only when their scope is present. */
  scopes: string[];
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Permit fetching media from private networks (tests only). */
  allowPrivateNetwork?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

const REACTIONS: Record<string, ReactionType> = {
  like: 'LIKE',
  celebrate: 'PRAISE',
  support: 'APPRECIATION',
  love: 'EMPATHY',
  insightful: 'INTEREST',
  funny: 'ENTERTAINMENT',
};

const ASSET_WAIT_MS: Record<AssetKind, number> = { images: 15_000, documents: 60_000 };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function instructions(mode: Mode, engagement: boolean): string {
  return [
    "Tools for the user's own LinkedIn account: read their profile, publish posts (text, a link, images or a document), and edit or delete them" +
      (engagement ? ', and comment on or react to posts.' : '.'),
    'Publishing is public and immediate. Show the user the exact text (and any media) and get their explicit approval before publishing, editing, commenting on or deleting anything.',
    'Write post text as plain text: LinkedIn does not render Markdown. Use line breaks for structure and a few #hashtags at most.',
    mode === 'local'
      ? 'If a tool says the user is not signed in, call linkedin_login and give them the sign-in link; retry once they confirm they approved access.'
      : 'If a tool says the LinkedIn authorization expired, ask the user to reconnect the connector in Claude.',
  ].join('\n');
}

function json(structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
}

/** Builds the MCP server exposing the LinkedIn tools. */
export function createConnectorServer(options: ConnectorOptions): McpServer {
  const { mode, auth } = options;
  const scopes = new Set(options.scopes);
  const organizations = scopes.has('w_organization_social');
  const memberEngagement = scopes.has('w_member_social_feed');
  const engagement = memberEngagement || organizations;
  const sleep = options.sleep ?? defaultSleep;
  const mediaSources =
    mode === 'local' ? 'a local file path, an http(s) URL or a base64 data: URI' : 'an http(s) URL or a base64 data: URI';

  const server = new McpServer(
    { name: NAME, title: 'LinkedIn', version: VERSION },
    { instructions: instructions(mode, engagement) },
  );

  const run = async (handler: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    try {
      return await handler();
    } catch (error) {
      return errorResult(error, mode);
    }
  };

  const connect = async (): Promise<{ client: LinkedInClient; session: LinkedInSession }> => {
    const session = await auth.getSession();
    const client = new LinkedInClient({
      accessToken: session.accessToken,
      version: options.version,
      ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    return { client, session };
  };

  const memberUrn = async (client: LinkedInClient, session: LinkedInSession): Promise<string> => {
    if (session.memberId) return personUrn(session.memberId);
    try {
      const info = await client.getUserInfo();
      await auth.rememberMember({ id: info.sub, ...(info.name ? { name: info.name } : {}), ...(info.email ? { email: info.email } : {}) });
      return personUrn(info.sub);
    } catch (error) {
      if (error instanceof LinkedInApiError && error.status === 403) {
        throw new UserInputError(
          'Could not look up your LinkedIn member ID: the token lacks the "openid" and "profile" scopes. Add the "Sign In with LinkedIn using OpenID Connect" product to your LinkedIn app and sign in again.',
        );
      }
      throw error;
    }
  };

  const actorUrn = async (client: LinkedInClient, session: LinkedInSession, organization: string | undefined) =>
    organization ? organizationUrn(organization) : memberUrn(client, session);

  const load = (source: string, kind: MediaKind): Promise<LoadedMedia> =>
    loadMedia(source, kind, {
      allowLocalFiles: mode === 'local',
      ...(options.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
    });

  const upload = async (client: LinkedInClient, kind: AssetKind, owner: string, media: LoadedMedia): Promise<string> => {
    const { uploadUrl, urn } = await client.initializeUpload(kind, owner);
    await client.upload(uploadUrl, media.data);
    await waitUntilAvailable(client, kind, urn);
    return urn;
  };

  const waitUntilAvailable = async (client: LinkedInClient, kind: AssetKind, urn: string): Promise<void> => {
    const deadline = Date.now() + ASSET_WAIT_MS[kind];
    for (let delay = 500; ; delay = Math.min(delay * 2, 4_000)) {
      let status: string | undefined;
      try {
        status = await client.getAssetStatus(kind, urn);
      } catch {
        return; // Status lookups are best effort; LinkedIn validates the asset when posting.
      }
      if (status === undefined || status === 'AVAILABLE') return;
      if (status === 'PROCESSING_FAILED') {
        throw new UserInputError(`LinkedIn could not process the uploaded ${kind === 'images' ? 'image' : 'document'}.`);
      }
      if (Date.now() + delay > deadline) return;
      await sleep(delay);
    }
  };

  const organizationField = z
    .string()
    .optional()
    .describe(
      'Act as this LinkedIn Page instead of as the member: its organization ID or urn:li:organization:<id>. The user must be an admin of the Page.',
    );
  const withOrganization = <T extends z.ZodRawShape>(shape: T) =>
    (organizations ? z.object({ ...shape, organization: organizationField }) : z.object(shape)) as unknown as z.ZodObject<
      T & { organization: typeof organizationField }
    >;

  // ---------------------------------------------------------------- profile

  server.registerTool(
    'linkedin_get_profile',
    {
      title: 'Get LinkedIn profile',
      description:
        "Returns the signed-in LinkedIn member's basic profile: name, email, profile photo URL, locale and member URN.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        memberUrn: z.string(),
        name: z.string().optional(),
        givenName: z.string().optional(),
        familyName: z.string().optional(),
        email: z.string().optional(),
        emailVerified: z.boolean().optional(),
        pictureUrl: z.string().optional(),
        locale: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run(async () => {
        const { client } = await connect();
        const info = await client.getUserInfo();
        await auth.rememberMember({ id: info.sub, ...(info.name ? { name: info.name } : {}), ...(info.email ? { email: info.email } : {}) });
        const locale = typeof info.locale === 'string' ? info.locale : [info.locale?.language, info.locale?.country].filter(Boolean).join('_');
        return json({
          memberUrn: personUrn(info.sub),
          ...(info.name ? { name: info.name } : {}),
          ...(info.given_name ? { givenName: info.given_name } : {}),
          ...(info.family_name ? { familyName: info.family_name } : {}),
          ...(info.email ? { email: info.email } : {}),
          ...(info.email_verified !== undefined ? { emailVerified: info.email_verified } : {}),
          ...(info.picture ? { pictureUrl: info.picture } : {}),
          ...(locale ? { locale } : {}),
        });
      }),
  );

  // ---------------------------------------------------------------- posts

  const createPostInput = withOrganization({
    text: z
      .string()
      .min(1)
      .max(3000)
      .describe(
        'The post text, max 3000 characters. Plain text only (no Markdown); line breaks are kept and #hashtags become links. Special characters are escaped automatically.',
      ),
    visibility: z
      .enum(['PUBLIC', 'CONNECTIONS'])
      .default('PUBLIC')
      .describe('PUBLIC: anyone on or off LinkedIn. CONNECTIONS: 1st-degree connections only.'),
    article: z
      .object({
        url: z.url({ protocol: /^https?$/ }).describe('The link to share.'),
        title: z.string().max(200).optional().describe("Preview title. Defaults to the page's own title."),
        description: z.string().max(300).optional().describe("Preview description. Defaults to the page's description."),
        thumbnail: z
          .string()
          .optional()
          .describe(`Preview image as ${mediaSources}. Defaults to the page's preview image.`),
      })
      .optional()
      .describe('Share a link with a preview card.'),
    images: z
      .array(
        z.object({
          source: z.string().describe(`A JPEG, PNG or GIF as ${mediaSources}.`),
          altText: z.string().max(4000).optional().describe('Alternative text describing the image for screen readers.'),
        }),
      )
      .min(1)
      .max(20)
      .optional()
      .describe('Attach 1 to 20 images.'),
    document: z
      .object({
        source: z.string().describe(`A PDF, PPT, PPTX, DOC or DOCX (max 100 MB, 300 pages) as ${mediaSources}.`),
        title: z.string().max(300).optional().describe('Title shown on the document. Defaults to the file name.'),
      })
      .optional()
      .describe('Attach a document, shown as a swipeable carousel.'),
  });

  server.registerTool(
    'linkedin_create_post',
    {
      title: 'Publish a LinkedIn post',
      description:
        'Publishes a post to LinkedIn immediately, as the signed-in member' +
        (organizations ? ' or a LinkedIn Page they administer' : '') +
        '. Optionally attach ONE of: a link preview (article), images, or a document. Only call this after the user has approved the exact text and attachments. Returns the post URN and URL.',
      inputSchema: createPostInput,
      outputSchema: z.object({
        postUrn: z.string(),
        url: z.string(),
        author: z.string(),
        visibility: z.string(),
        attachment: z.enum(['none', 'article', 'image', 'images', 'document']),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) =>
      run(async () => {
        const attachments = [args.article, args.images, args.document].filter((value) => value !== undefined);
        if (attachments.length > 1) {
          throw new UserInputError('A post can have only one of: article, images or document.');
        }
        // Load media before touching LinkedIn so bad inputs fail without side effects.
        const images = args.images ? await Promise.all(args.images.map((image) => load(image.source, 'image'))) : undefined;
        const document = args.document ? await load(args.document.source, 'document') : undefined;

        const { client, session } = await connect();
        const author = await actorUrn(client, session, args.organization);

        let content: PostContent | undefined;
        let attachment: 'none' | 'article' | 'image' | 'images' | 'document' = 'none';
        if (args.article) {
          const { url, title, description, thumbnail } = args.article;
          let preview: LinkPreview = {};
          if (!title || !description || !thumbnail) {
            preview = await fetchLinkPreview(url, options.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}).catch(() => ({}));
          }
          let thumbnailUrn: string | undefined;
          if (thumbnail) {
            thumbnailUrn = await upload(client, 'images', author, await load(thumbnail, 'image'));
          } else if (preview.imageUrl) {
            // The page's own preview image is a nice-to-have; post without it if it can't be used.
            thumbnailUrn = await load(preview.imageUrl, 'image')
              .then((media) => upload(client, 'images', author, media))
              .catch(() => undefined);
          }
          const articleTitle = title ?? preview.title ?? new URL(url).hostname;
          const articleDescription = description ?? preview.description;
          content = {
            article: {
              source: url,
              title: articleTitle,
              ...(articleDescription ? { description: articleDescription } : {}),
              ...(thumbnailUrn ? { thumbnail: thumbnailUrn } : {}),
            },
          };
          attachment = 'article';
        } else if (images && args.images) {
          const ids: string[] = [];
          for (const media of images) ids.push(await upload(client, 'images', author, media));
          const entries = ids.map((id, index) => {
            const altText = args.images![index]!.altText;
            return { id, ...(altText ? { altText } : {}) };
          });
          content = entries.length === 1 ? { media: entries[0]! } : { multiImage: { images: entries } };
          attachment = entries.length === 1 ? 'image' : 'images';
        } else if (document && args.document) {
          const id = await upload(client, 'documents', author, document);
          content = { media: { id, title: args.document.title ?? document.filename ?? 'Document' } };
          attachment = 'document';
        }

        const postUrn = await client.createPost({
          author,
          commentary: escapeLittleText(args.text),
          visibility: args.visibility,
          ...(content ? { content } : {}),
        });
        return json({ postUrn, url: postUrl(postUrn), author, visibility: args.visibility, attachment });
      }),
  );

  /** Runs an operation on an authored post, explaining the common activity-URN mix-up when LinkedIn rejects it. */
  const onOwnPost = async (urn: string, verb: string, operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      if (urn.startsWith('urn:li:activity:') && error instanceof LinkedInApiError && error.status < 500) {
        throw new UserInputError(
          `LinkedIn could not ${verb} ${urn}. This needs the post's share or ugcPost URN (as returned by linkedin_create_post), not an activity URN. LinkedIn said: ${error.message}`,
        );
      }
      throw error;
    }
  };

  server.registerTool(
    'linkedin_edit_post',
    {
      title: 'Edit a LinkedIn post',
      description:
        "Replaces the text of a post the signed-in member (or their Page) authored; attachments stay as they are. Accepts the post URN returned by linkedin_create_post or the post URL. Only call this after the user has approved the new text.",
      inputSchema: z.object({
        post: z.string().describe('Post URN (urn:li:share:… or urn:li:ugcPost:…) or post URL.'),
        text: z.string().min(1).max(3000).describe('The complete new post text, max 3000 characters. Plain text only.'),
      }),
      outputSchema: z.object({ updated: z.boolean(), postUrn: z.string(), url: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      run(async () => {
        const urn = parsePostReference(args.post);
        const { client } = await connect();
        await onOwnPost(urn, 'edit', () => client.updatePostText(urn, escapeLittleText(args.text)));
        return json({ updated: true, postUrn: urn, url: postUrl(urn) });
      }),
  );

  server.registerTool(
    'linkedin_delete_post',
    {
      title: 'Delete a LinkedIn post',
      description:
        'Permanently deletes a post the signed-in member (or their Page) authored. Accepts the post URN returned by linkedin_create_post or the post URL. Confirm with the user first.',
      inputSchema: z.object({
        post: z.string().describe('Post URN (urn:li:share:… or urn:li:ugcPost:…) or post URL.'),
      }),
      outputSchema: z.object({ deleted: z.boolean(), postUrn: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      run(async () => {
        const urn = parsePostReference(args.post);
        const { client } = await connect();
        await onOwnPost(urn, 'delete', () => client.deletePost(urn));
        return json({ deleted: true, postUrn: urn });
      }),
  );

  // ---------------------------------------------------------------- engagement (Community Management API)

  if (engagement) {
    const requireActor = (organization: string | undefined) => {
      if (!organization && !memberEngagement) {
        throw new UserInputError(
          'Acting as yourself needs the w_member_social_feed scope (Community Management API). Pass "organization" to act as a Page instead.',
        );
      }
    };

    server.registerTool(
      'linkedin_comment_on_post',
      {
        title: 'Comment on a LinkedIn post',
        description:
          'Adds a comment to a LinkedIn post, publicly and immediately. Only call this after the user has approved the exact comment text.',
        inputSchema: withOrganization({
          post: z.string().describe('Post URN or URL.'),
          text: z.string().min(1).max(1250).describe('Comment text, max 1250 characters. Plain text only.'),
        }),
        outputSchema: z.object({ postUrn: z.string(), commentId: z.string().optional(), actor: z.string() }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      (args) =>
        run(async () => {
          requireActor(args.organization);
          const target = parsePostReference(args.post);
          const { client, session } = await connect();
          const actor = await actorUrn(client, session, args.organization);
          const commentId = await client.createComment(target, actor, escapeLittleText(args.text));
          return json({ postUrn: target, actor, ...(commentId ? { commentId } : {}) });
        }),
    );

    server.registerTool(
      'linkedin_react_to_post',
      {
        title: 'React to a LinkedIn post',
        description: 'Adds a reaction (like, celebrate, support, love, insightful or funny) to a LinkedIn post.',
        inputSchema: withOrganization({
          post: z.string().describe('Post URN or URL.'),
          reaction: z
            .enum(['like', 'celebrate', 'support', 'love', 'insightful', 'funny'])
            .default('like')
            .describe('Reaction type.'),
        }),
        outputSchema: z.object({ postUrn: z.string(), reaction: z.string(), actor: z.string() }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      (args) =>
        run(async () => {
          requireActor(args.organization);
          const target = parsePostReference(args.post);
          const { client, session } = await connect();
          const actor = await actorUrn(client, session, args.organization);
          await client.createReaction(target, actor, REACTIONS[args.reaction]!);
          return json({ postUrn: target, reaction: args.reaction, actor });
        }),
    );
  }

  // ---------------------------------------------------------------- authentication

  server.registerTool(
    'linkedin_auth_status',
    {
      title: 'LinkedIn sign-in status',
      description: 'Reports whether LinkedIn is connected, as whom, until when, and with which scopes.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        authenticated: z.boolean(),
        source: z.string(),
        name: z.string().optional(),
        email: z.string().optional(),
        memberUrn: z.string().optional(),
        expiresAt: z.string().optional(),
        scopes: z.array(z.string()),
        message: z.string(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => run(async () => json({ ...(await auth.status()) })),
  );

  if (auth.login && auth.logout) {
    const login = auth.login.bind(auth);
    const logout = auth.logout.bind(auth);

    server.registerTool(
      'linkedin_login',
      {
        title: 'Sign in to LinkedIn',
        description:
          'Starts LinkedIn sign-in and returns a link for the user to open in their browser. Use it when another tool says the user is not signed in, or when they ask to connect or switch LinkedIn accounts. Show the link to the user; once they say they approved access, retry what they asked for.',
        inputSchema: z.object({
          force: z.boolean().default(false).describe('Start a new sign-in even if already signed in (e.g. to switch accounts).'),
        }),
        outputSchema: z.object({
          alreadySignedIn: z.boolean(),
          authorizationUrl: z.string().optional(),
          expiresInSeconds: z.number().optional(),
          message: z.string(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      (args) =>
        run(async () => {
          if (!args.force) {
            const status = await auth.status();
            if (status.authenticated) return json({ alreadySignedIn: true, message: status.message });
          }
          const start = await login();
          return json({
            alreadySignedIn: false,
            authorizationUrl: start.authorizationUrl,
            expiresInSeconds: start.expiresInSeconds,
            message: `Open this link to sign in to LinkedIn and approve access (valid for ${Math.round(start.expiresInSeconds / 60)} minutes): ${start.authorizationUrl}`,
          });
        }),
    );

    server.registerTool(
      'linkedin_logout',
      {
        title: 'Sign out of LinkedIn',
        description: 'Deletes the locally stored LinkedIn token. LinkedIn tools stop working until the user signs in again.',
        inputSchema: z.object({}),
        outputSchema: z.object({ removed: z.boolean(), message: z.string() }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      () =>
        run(async () => {
          const removed = await logout();
          return json({
            removed,
            message: removed
              ? 'Signed out: the stored LinkedIn token was deleted. To also revoke the app, visit https://www.linkedin.com/mypreferences/d/data-sharing-for-permitted-services'
              : 'There was no stored LinkedIn token.',
          });
        }),
    );
  }

  return server;
}
