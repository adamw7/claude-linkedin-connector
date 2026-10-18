import { McpServer, type CallToolResult, type ToolAnnotations, type ToolCallback } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { LinkedInAuth, LinkedInSession } from '../auth/types.js';
import { LinkedInApiError, UserInputError } from '../errors.js';
import { LinkedInClient, type AssetKind, type PostContent, type ReactionType } from '../linkedin/client.js';
import { countCompanies, foldText, MAX_CONNECTIONS_BYTES, parseConnections } from '../linkedin/connections.js';
import { fetchLinkPreview, type LinkPreview } from '../linkedin/link-preview.js';
import { loadMedia, readSource, type LoadedMedia, type MediaKind } from '../linkedin/media.js';
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
  /** Local mode: folders local file paths may point into. */
  localFileDirs?: string[];
  sleep?: (ms: number) => Promise<void>;
  /** Called after every tool call, e.g. for an audit log. */
  onToolCall?: (event: ToolCallEvent) => void;
}

export interface ToolCallEvent {
  tool: string;
  ok: boolean;
  durationMs: number;
  /** The failure, when `ok` is false. */
  error?: unknown;
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

const ATTACHMENTS = ['none', 'article', 'image', 'images', 'document'] as const;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function instructions(mode: Mode, engagement: boolean): string {
  return [
    "Tools for the user's own LinkedIn account: read their profile and their exported list of connections, publish posts (text, a link, images or a document), and edit or delete them" +
      (engagement ? ', and comment on or react to posts.' : '.'),
    'Publishing is public and immediate. Show the user the exact text (and any media) and get their explicit approval before publishing, editing, commenting on or deleting anything.',
    'Write post text as plain text: LinkedIn does not render Markdown. Use line breaks for structure and a few #hashtags at most.',
    mode === 'local'
      ? 'If a tool says the user is not signed in, call linkedin_login and give them the sign-in link; retry once they confirm they approved access.'
      : 'If a tool says the LinkedIn authorization expired, ask the user to reconnect the connector in Claude.',
  ].join('\n');
}

/** Builds the MCP server exposing the LinkedIn tools. */
export function createConnectorServer(options: ConnectorOptions): McpServer {
  const { mode, auth } = options;
  const scopes = new Set(options.scopes);
  const organizations = scopes.has('w_organization_social');
  const memberEngagement = scopes.has('w_member_social_feed');
  const engagement = memberEngagement || organizations;
  const sleep = options.sleep ?? defaultSleep;
  // A remote server must never read its own disk.
  const localFileDirs = mode === 'local' ? (options.localFileDirs ?? []) : undefined;
  const mediaSources =
    localFileDirs !== undefined
      ? `an absolute local file path (inside ${localFileDirs.join(', ') || 'no folder: local files are disabled'}), an http(s) URL or a base64 data: URI`
      : 'an http(s) URL or a base64 data: URI (data: URIs up to about 20 MB; use a URL for larger files)';

  const server = new McpServer(
    { name: NAME, title: 'LinkedIn', version: VERSION },
    { instructions: instructions(mode, engagement) },
  );

  /** Registers a tool whose handler returns its structured result. Failures become error results; every call is reported to `onToolCall`. */
  const tool = <In extends z.ZodType, Out extends z.ZodType>(
    name: string,
    config: { title: string; description: string; inputSchema: In; outputSchema: Out; annotations: ToolAnnotations },
    handler: (args: z.output<In>) => Promise<z.input<Out>>,
  ): void => {
    const callback = async (args: z.output<In>): Promise<CallToolResult> => {
      const start = performance.now();
      const report = (error?: unknown) =>
        options.onToolCall?.({ tool: name, ok: error === undefined, durationMs: Math.round(performance.now() - start), error });
      try {
        const structured = (await handler(args)) as Record<string, unknown>;
        report();
        return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
      } catch (error) {
        report(error);
        return errorResult(error, mode);
      }
    };
    server.registerTool(name, config, callback as ToolCallback<In>);
  };

  const connect = async (): Promise<{ client: LinkedInClient; session: LinkedInSession }> => {
    const session = await auth.getSession();
    const { version, apiBaseUrl, fetch } = options;
    return { client: new LinkedInClient({ accessToken: session.accessToken, version, apiBaseUrl, fetch }), session };
  };

  const memberUrn = async (client: LinkedInClient, session: LinkedInSession): Promise<string> => {
    if (session.memberId) return personUrn(session.memberId);
    try {
      const info = await client.getUserInfo();
      await auth.rememberMember({ id: info.sub, name: info.name, email: info.email });
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

  const sources = { localFileDirs, allowPrivateNetwork: options.allowPrivateNetwork };
  const load = (source: string, kind: MediaKind): Promise<LoadedMedia> => loadMedia(source, kind, sources);

  /** Uploads an image or document, then waits a while for LinkedIn to process it. */
  const upload = async (client: LinkedInClient, kind: AssetKind, owner: string, media: LoadedMedia): Promise<string> => {
    const { uploadUrl, urn } = await client.initializeUpload(kind, owner);
    await client.upload(uploadUrl, media.data);
    const deadline = Date.now() + ASSET_WAIT_MS[kind];
    for (let delay = 500; ; delay = Math.min(delay * 2, 4_000)) {
      // Status lookups are best effort; LinkedIn validates the asset when posting.
      const status = await client.getAssetStatus(kind, urn).catch(() => undefined);
      if (status === undefined || status === 'AVAILABLE') return urn;
      if (status === 'PROCESSING_FAILED') {
        throw new UserInputError(`LinkedIn could not process the uploaded ${kind === 'images' ? 'image' : 'document'}.`);
      }
      if (Date.now() + delay > deadline) return urn;
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

  tool(
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
    async () => {
      const { client } = await connect();
      const info = await client.getUserInfo();
      await auth.rememberMember({ id: info.sub, name: info.name, email: info.email });
      const locale = typeof info.locale === 'string' ? info.locale : [info.locale?.language, info.locale?.country].filter(Boolean).join('_');
      return {
        memberUrn: personUrn(info.sub),
        name: info.name,
        givenName: info.given_name,
        familyName: info.family_name,
        email: info.email,
        emailVerified: info.email_verified,
        pictureUrl: info.picture,
        locale: locale || undefined,
      };
    },
  );

  // ---------------------------------------------------------------- connections

  const connectionSchema = z.object({
    name: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    profileUrl: z.string().optional(),
    email: z.string().optional(),
    company: z.string().optional(),
    position: z.string().optional(),
    connectedOn: z.string().optional(),
  });
  const isoDate = z.iso.date();

  tool(
    'linkedin_read_connections',
    {
      title: 'Read exported LinkedIn connections',
      description:
        "Reads the user's 1st-degree connections from the Connections.csv file in LinkedIn's data export (LinkedIn's API does not offer connections). " +
        'If the user has no export yet, tell them to request one at https://www.linkedin.com/mypreferences/d/download-my-data (choose Connections) and to unzip it. ' +
        'Pass the file, or its text as csv. Filter with query, company and connection dates; matching ignores case and accents. Results are newest first and paged with limit and offset. ' +
          'Set companyCounts to also see how many matching connections work at each company, e.g. to find where the network is concentrated.',
      inputSchema: z.object({
        file: z.string().optional().describe(`Connections.csv as ${mediaSources}.`),
        csv: z.string().optional().describe('The contents of Connections.csv, when the user pasted or attached the text.'),
        query: z
          .string()
          .optional()
          .describe('Text that must appear in the name, company, position, email or profile URL. Ignores case and accents.'),
        company: z
          .union([z.string(), z.array(z.string()).min(1)])
          .optional()
          .describe(
            'Only connections whose company contains this text, or any of these texts (e.g. ["xyz", "abc"] for everyone at xyz or abc). Ignores case and accents.',
          ),
        connectedAfter: isoDate.optional().describe('Only connections made on or after this date (YYYY-MM-DD).'),
        connectedBefore: isoDate.optional().describe('Only connections made on or before this date (YYYY-MM-DD).'),
        limit: z.number().int().min(0).max(1000).default(100).describe('Maximum connections to return. 0 returns only the counts.'),
        offset: z.number().int().min(0).default(0).describe('Number of matching connections to skip, for paging.'),
        companyCounts: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('Also return the companies with the most matching connections, up to this many, with their counts.'),
      }),
      outputSchema: z.object({
        total: z.number().describe('Connections in the file.'),
        matched: z.number().describe('Connections matching the filters.'),
        offset: z.number(),
        connections: z.array(connectionSchema),
        nextOffset: z.number().optional().describe('Pass as offset to get the next page, when there are more matches.'),
        companies: z
          .array(z.object({ company: z.string(), count: z.number() }))
          .optional()
          .describe('Matching connections per company, most first, when companyCounts is set.'),
        companiesTotal: z.number().optional().describe('Distinct companies among the matching connections.'),
        withoutCompany: z.number().optional().describe('Matching connections with no company listed.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      if ((args.file === undefined) === (args.csv === undefined)) {
        throw new UserInputError('Pass either file or csv.');
      }
      const all = parseConnections(
        args.file !== undefined ? (await readSource(args.file, MAX_CONNECTIONS_BYTES, 'file', sources)).data : args.csv!,
      );
      const query = args.query === undefined ? '' : foldText(args.query);
      const companies = [args.company ?? []].flat().map(foldText).filter(Boolean);
      const dated = (value: string | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);
      const matches = all.filter((connection) => {
        if (query) {
          const fields = [connection.name, connection.company, connection.position, connection.email, connection.profileUrl];
          if (!fields.some((field) => field && foldText(field).includes(query))) return false;
        }
        if (companies.length > 0) {
          const company = foldText(connection.company ?? '');
          if (!company || !companies.some((name) => company.includes(name))) return false;
        }
        if (args.connectedAfter || args.connectedBefore) {
          const date = dated(connection.connectedOn);
          if (!date) return false;
          if (args.connectedAfter && date < args.connectedAfter) return false;
          if (args.connectedBefore && date > args.connectedBefore) return false;
        }
        return true;
      });
      // Newest first (the sort is stable); the export is usually in this order already, and undated rows go last.
      const sorted = matches.toSorted((a, b) => (dated(b.connectedOn) ?? '').localeCompare(dated(a.connectedOn) ?? ''));
      const page = sorted.slice(args.offset, args.offset + args.limit);
      const next = args.offset + page.length;
      const counts = args.companyCounts === undefined ? undefined : countCompanies(matches);
      return {
        total: all.length,
        matched: matches.length,
        offset: args.offset,
        connections: page,
        nextOffset: page.length > 0 && next < matches.length ? next : undefined,
        companies: counts?.slice(0, args.companyCounts),
        companiesTotal: counts?.length,
        withoutCompany: counts && matches.filter((connection) => !connection.company).length,
      };
    },
  );

  // ---------------------------------------------------------------- posts

  const createPostInput = withOrganization({
    text: z
      .string()
      .min(1)
      .max(3000)
      .describe(
        'The post text, max 3000 characters. Plain text only (no Markdown); line breaks are kept and #hashtags become links. @mentions can\'t tag anyone: "@Name" shows as plain text. Special characters are escaped automatically.',
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
        title: z.string().max(300).optional().describe('Title shown on the document. Defaults to the file name without its extension.'),
      })
      .optional()
      .describe('Attach a document, shown as a swipeable carousel.'),
  });

  tool(
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
        attachment: z.enum(ATTACHMENTS),
        linkPreview: z
          .object({ title: z.string(), description: z.string().optional(), thumbnail: z.boolean() })
          .optional()
          .describe('The preview card published with an article, so the user can be told if it came out bare.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      if ([args.article, args.images, args.document].filter((value) => value !== undefined).length > 1) {
        throw new UserInputError('A post can have only one of: article, images or document.');
      }
      // Load media before touching LinkedIn so bad inputs fail without side effects.
      const images = args.images ? await Promise.all(args.images.map((image) => load(image.source, 'image'))) : undefined;
      const document = args.document ? await load(args.document.source, 'document') : undefined;

      const { client, session } = await connect();
      const author = await actorUrn(client, session, args.organization);
      const publish = async (
        attachment: (typeof ATTACHMENTS)[number],
        content?: PostContent,
        linkPreview?: { title: string; description?: string; thumbnail: boolean },
      ) => {
        const postUrn = await client.createPost({ author, commentary: escapeLittleText(args.text), visibility: args.visibility, content });
        return { postUrn, url: postUrl(postUrn), author, visibility: args.visibility, attachment, linkPreview };
      };

      if (args.article) {
        const { url, title, description, thumbnail } = args.article;
        const preview: LinkPreview =
          title && description && thumbnail
            ? {}
            : await fetchLinkPreview(url, { allowPrivateNetwork: options.allowPrivateNetwork }).catch(() => ({}));
        // The page's own preview image is a nice-to-have; post without it if it can't be used.
        const thumbnailUrn = thumbnail
          ? await upload(client, 'images', author, await load(thumbnail, 'image'))
          : preview.imageUrl
            ? await load(preview.imageUrl, 'image').then((media) => upload(client, 'images', author, media)).catch(() => undefined)
            : undefined;
        const article = {
          source: url,
          title: title ?? preview.title ?? new URL(url).hostname,
          description: description ?? preview.description,
          thumbnail: thumbnailUrn,
        };
        return publish('article', { article }, { title: article.title, description: article.description, thumbnail: thumbnailUrn !== undefined });
      }
      if (images && args.images) {
        const entries: Array<{ id: string; altText?: string }> = [];
        for (const [index, media] of images.entries()) {
          entries.push({ id: await upload(client, 'images', author, media), altText: args.images[index]!.altText || undefined });
        }
        return entries.length === 1 ? publish('image', { media: entries[0]! }) : publish('images', { multiImage: { images: entries } });
      }
      if (document && args.document) {
        const id = await upload(client, 'documents', author, document);
        // LinkedIn shows the title above the carousel: "Q3 results", not "Q3 results.pdf".
        const title = args.document.title ?? (document.filename?.replace(/\.(pdf|docx?|pptx?)$/i, '') || 'Document');
        return publish('document', { media: { id, title } });
      }
      return publish('none');
    },
  );

  /** Runs an operation on an authored post, explaining the common activity-URN mix-up when LinkedIn rejects it. */
  const onOwnPost = async (post: string, verb: string, operation: (client: LinkedInClient, urn: string) => Promise<void>) => {
    const urn = parsePostReference(post);
    const { client } = await connect();
    try {
      await operation(client, urn);
    } catch (error) {
      if (urn.startsWith('urn:li:activity:') && error instanceof LinkedInApiError && error.status < 500) {
        throw new UserInputError(
          `LinkedIn could not ${verb} ${urn}. This needs the post's share or ugcPost URN (as returned by linkedin_create_post), not the activity URN that links copied from linkedin.com often contain. ` +
            `To find it, choose "Embed this post" in the post's menu on linkedin.com and pass the embed code, which contains urn:li:share:… or urn:li:ugcPost:…. LinkedIn said: ${error.message}`,
        );
      }
      throw error;
    }
    return urn;
  };

  tool(
    'linkedin_edit_post',
    {
      title: 'Edit a LinkedIn post',
      description:
        "Replaces the text of a post the signed-in member (or their Page) authored; attachments stay as they are. Accepts the post URN returned by linkedin_create_post or the post URL. Only call this after the user has approved the new text.",
      inputSchema: z.object({
        post: z.string().describe("Post URN (urn:li:share:… or urn:li:ugcPost:…), post URL, or the post's embed code."),
        text: z.string().min(1).max(3000).describe('The complete new post text, max 3000 characters. Plain text only.'),
      }),
      outputSchema: z.object({ updated: z.boolean(), postUrn: z.string(), url: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const urn = await onOwnPost(args.post, 'edit', (client, urn) => client.updatePostText(urn, escapeLittleText(args.text)));
      return { updated: true, postUrn: urn, url: postUrl(urn) };
    },
  );

  tool(
    'linkedin_delete_post',
    {
      title: 'Delete a LinkedIn post',
      description:
        'Permanently deletes a post the signed-in member (or their Page) authored. Accepts the post URN returned by linkedin_create_post or the post URL. Confirm with the user first.',
      inputSchema: z.object({
        post: z.string().describe("Post URN (urn:li:share:… or urn:li:ugcPost:…), post URL, or the post's embed code."),
      }),
      outputSchema: z.object({ deleted: z.boolean(), postUrn: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => ({ deleted: true, postUrn: await onOwnPost(args.post, 'delete', (client, urn) => client.deletePost(urn)) }),
  );

  // ---------------------------------------------------------------- engagement (Community Management API)

  if (engagement) {
    /** The post to act on, and who acts: the member, or the Page given as `organization`. */
    const engage = async ({ post, organization }: { post: string; organization?: string }) => {
      if (!organization && !memberEngagement) {
        throw new UserInputError(
          'Acting as yourself needs the w_member_social_feed scope (Community Management API). Pass "organization" to act as a Page instead.',
        );
      }
      const target = parsePostReference(post);
      const { client, session } = await connect();
      return { client, target, actor: await actorUrn(client, session, organization) };
    };

    tool(
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
      async (args) => {
        const { client, target, actor } = await engage(args);
        const commentId = await client.createComment(target, actor, escapeLittleText(args.text));
        return { postUrn: target, actor, commentId };
      },
    );

    tool(
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
      async (args) => {
        const { client, target, actor } = await engage(args);
        await client.createReaction(target, actor, REACTIONS[args.reaction]!);
        return { postUrn: target, reaction: args.reaction, actor };
      },
    );
  }

  // ---------------------------------------------------------------- authentication

  tool(
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
        missingScopes: z.array(z.string()).optional().describe('Configured scopes the sign-in predates; signing in again grants them.'),
        message: z.string(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => auth.status(),
  );

  if (auth.login && auth.logout) {
    const login = auth.login.bind(auth);
    const logout = auth.logout.bind(auth);

    tool(
      'linkedin_login',
      {
        title: 'Sign in to LinkedIn',
        description:
          'Starts LinkedIn sign-in and returns a link for the user to open in their browser. Use it when another tool says the user is not signed in, or when they ask to connect or switch LinkedIn accounts. Show the link to the user; once they say they approved access, retry what they asked for.',
        inputSchema: z.object({
          force: z.boolean().default(false).describe('Start a new sign-in even if already signed in, e.g. to switch accounts or when LinkedIn rejected the stored token.'),
        }),
        outputSchema: z.object({
          alreadySignedIn: z.boolean(),
          authorizationUrl: z.string().optional(),
          expiresInSeconds: z.number().optional(),
          message: z.string(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => {
        if (!args.force) {
          const status = await auth.status();
          if (status.authenticated && !status.missingScopes) return { alreadySignedIn: true, message: status.message };
        }
        const start = await login();
        return {
          alreadySignedIn: false,
          authorizationUrl: start.authorizationUrl,
          expiresInSeconds: start.expiresInSeconds,
          message: `Open this link to sign in to LinkedIn and approve access (valid for ${Math.round(start.expiresInSeconds / 60)} minutes): ${start.authorizationUrl}`,
        };
      },
    );

    tool(
      'linkedin_logout',
      {
        title: 'Sign out of LinkedIn',
        description: 'Deletes the locally stored LinkedIn token. LinkedIn tools stop working until the user signs in again.',
        inputSchema: z.object({}),
        outputSchema: z.object({ removed: z.boolean(), message: z.string() }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async () => {
        const removed = await logout();
        return {
          removed,
          message: removed
            ? 'Signed out: the stored LinkedIn token was deleted. To also revoke the app, visit https://www.linkedin.com/mypreferences/d/data-sharing-for-permitted-services'
            : 'There was no stored LinkedIn token.',
        };
      },
    );
  }

  return server;
}
