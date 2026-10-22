import { McpServer, type CallToolResult, type ToolAnnotations, type ToolCallback } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ACCESS_TOKEN_HINT, LAST_FAILURE, SIGN_IN_HINT, signInPageHint, SWITCH_ACCOUNT_HINT } from '../auth/local-auth.js';
import { MAX_REMEMBERED_POSTS, type PostHistory } from '../auth/post-history.js';
import type { LinkedInAuth, LinkedInSession } from '../auth/types.js';
import { LinkedInApiError, NotAuthenticatedError, UserInputError } from '../errors.js';
import { LinkedInClient, type AssetKind, type PostContent, type ReactionType } from '../linkedin/client.js';
import {
  countCompanies,
  findConnectionsExports,
  foldText,
  matchesWordStart,
  MAX_CONNECTIONS_BYTES,
  MAX_EXPORT_BYTES,
  NoConnectionsCsvError,
  parseConnections,
  type Connection,
} from '../linkedin/connections.js';
import { fetchLinkPreview, type LinkPreview } from '../linkedin/link-preview.js';
import { loadMedia, readSource, type LoadedMedia, type MediaKind } from '../linkedin/media.js';
import { COMMENTS, PAGES, type Feature } from '../linkedin/scopes.js';
import { escapeLittleText, textWarnings } from '../linkedin/text.js';
import { organizationUrn, parsePostReference, personUrn, postUrl } from '../linkedin/urn.js';
import type { ApiVersion } from '../linkedin/versions.js';
import { NAME, VERSION } from '../version.js';
import { describeError, errorResult, type Mode } from './errors.js';

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
  /** Local mode: remembers published posts, so later conversations can find them to edit or delete. */
  history?: PostHistory;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
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

/** The longest wait for LinkedIn to process one image, so a slow one leaves time for the rest. */
const IMAGE_WAIT_MS = 15_000;
/**
 * Stop waiting for uploads to finish processing this long after the post was asked for, and publish anyway.
 * MCP clients often give up on a tool call after 60 seconds (the SDK's default) while the post still goes out,
 * so waiting longer can make a published post look failed, and Claude may publish it again.
 */
const PROCESSING_DEADLINE_MS = 45_000;
/** How long a tool call waits for the user to finish signing in in the browser, within the same 60-second limit. */
const SIGN_IN_WAIT_MS = 45_000;

const ATTACHMENTS = ['none', 'article', 'image', 'images', 'document'] as const;

/** LinkedIn's limits on a post's and a comment's text. */
const MAX_POST_CHARACTERS = 3000;
const MAX_COMMENT_CHARACTERS = 1250;

/** Text of up to `max` characters. Text that is too long says by how much, which Claude can't count for itself. */
function limitedText(max: number, noun: string) {
  return z
    .string()
    .min(1)
    .max(max, {
      error: (issue) => {
        const { length } = issue.input as string;
        const over = length - max;
        return `The ${noun} is ${length} characters long; LinkedIn allows ${max}. Shorten it by at least ${over} character${over === 1 ? '' : 's'}.`;
      },
    });
}

/** A post's attachments, loaded and checked, ready to upload. */
interface PreparedPost {
  attachment: (typeof ATTACHMENTS)[number];
  images?: Array<{ media: LoadedMedia; altText?: string }>;
  document?: { media: LoadedMedia; title: string };
  /** `pageImageUrl` is where `thumbnail` came from when the page provided it. */
  article?: { url: string; title: string; description?: string; thumbnail?: LoadedMedia; pageImageUrl?: string };
  /** What would come out differently than the user may expect. */
  warnings: string[];
}

/** The LinkedIn client for the signed-in member, and their session; `feature` is one the call needs. */
type Connect = (feature?: Feature) => Promise<{ client: LinkedInClient; session: LinkedInSession }>;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function instructions(mode: Mode, engagement: boolean, history: boolean, folders: string | undefined): string {
  return [
    "Tools for the user's own LinkedIn account: read their profile and their exported list of connections, publish posts (text, a link, images or a document), and edit or delete them" +
      (engagement ? ', and comment on or react to posts.' : '.'),
    'Publishing is public and immediate. Show the user the exact text (and any media) and get their explicit approval before publishing, editing, commenting on or deleting anything.',
    'Before asking for approval of a post, check it with linkedin_preview_post and tell the user about its link preview card and any warnings.',
    'Write post text as plain text: LinkedIn does not render Markdown. Use line breaks for structure and a few #hashtags at most.',
    ...(history
      ? ["LinkedIn doesn't let apps read the user's posts. To edit or delete a post from an earlier conversation, find it with linkedin_list_posts, which remembers the posts published from this computer."]
      : []),
    `If linkedin_create_post times out, the post may have been published anyway: ${history ? 'check linkedin_list_posts' : 'ask the user to look on LinkedIn'} before trying again, so it isn't published twice.`,
    // An image attached to the chat reaches Claude as a picture, not as bytes it could pass on as a data: URI.
    "Images and documents the user attached to the chat can't be passed to these tools: only their contents reach you, not the file. " +
      (folders !== undefined
        ? `Ask the user to save the file in one of the folders local files may come from (${folders}) and pass its name or path.`
        : 'Ask the user for a link to the file itself.'),
    mode === 'local'
      ? "When the user isn't signed in, LinkedIn tools open the sign-in page in their browser and wait for it. If a tool says the user just signed in, call it again; if it gives a sign-in link instead, show the link and retry once they say they approved access."
      : 'If a tool says the LinkedIn authorization expired, ask the user to reconnect the connector in Claude.',
  ].join('\n');
}

/** Builds the MCP server exposing the LinkedIn tools. */
export function createConnectorServer(options: ConnectorOptions): McpServer {
  const { mode, auth, history } = options;
  const scopes = new Set(options.scopes);
  const organizations = scopes.has('w_organization_social');
  const memberEngagement = scopes.has('w_member_social_feed');
  const engagement = memberEngagement || organizations;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  // A remote server must never read its own disk.
  const localFileDirs = mode === 'local' ? (options.localFileDirs ?? []) : undefined;
  const folders = localFileDirs && (localFileDirs.join(', ') || 'no folder: local files are disabled');
  const mediaSources =
    localFileDirs !== undefined
      ? `a local file in ${folders} (its absolute path, or just its name), an http(s) URL or a base64 data: URI`
      : 'an http(s) URL or a base64 data: URI (data: URIs up to about 20 MB; use a URL for larger files)';
  /** Names a feature's setting for whoever can change it: the user (in the Claude Desktop extension or as a variable), or the server's operator. */
  const settingName = (feature: Feature) => (mode === 'local' ? `"${feature.setting}" (${feature.variable})` : feature.variable);

  const server = new McpServer(
    { name: NAME, title: 'LinkedIn', version: VERSION },
    { instructions: instructions(mode, engagement, history !== undefined, folders) },
  );

  /** Local mode: starts a browser sign-in and waits a while for the user to finish it. */
  const signIn = auth.login && (async (): Promise<SignInOutcome> => {
    const start = await auth.login!();
    // A page that didn't open can't be approved while this call waits: the user needs its link now.
    const finished = start.browserOpened
      ? await Promise.race([
          start.completion.then(
            (name) => ({ name }),
            (error: unknown) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
          ),
          sleep(SIGN_IN_WAIT_MS).then(() => undefined),
        ])
      : undefined;
    // A failed sign-in has closed its link, so there is nothing to open: the failure says what to do.
    if (finished && 'error' in finished) return { signedIn: false, message: finished.error.message.replace(/\.?$/, '.') };
    if (finished) {
      return { signedIn: true, name: finished.name, message: `Signed in to LinkedIn${finished.name ? ` as ${finished.name}` : ''}.` };
    }
    const minutes = Math.round(start.expiresInSeconds / 60);
    const link = start.browserOpened
      ? `The LinkedIn sign-in page is open in your browser; if it didn't appear, open this link (valid for ${minutes} minutes): ${start.authorizationUrl}`
      : `Open this link to sign in to LinkedIn and approve access (valid for ${minutes} minutes): ${start.authorizationUrl}`;
    const message = `${link} ${signInPageHint(start.redirectUri)}`;
    return { signedIn: false, authorizationUrl: start.authorizationUrl, expiresInSeconds: start.expiresInSeconds, message };
  });

  /**
   * Registers a tool whose handler returns its structured result. Failures become error results; every call is reported to `onToolCall`.
   * The handler gets the LinkedIn client from `connect`, which notes the session the call used.
   */
  const tool = <In extends z.ZodType, Out extends z.ZodType>(
    name: string,
    config: { title: string; description: string; inputSchema: In; outputSchema: Out; annotations: ToolAnnotations },
    handler: (args: z.output<In>, connect: Connect) => Promise<z.input<Out>>,
  ): void => {
    const callback = async (args: z.output<In>): Promise<CallToolResult> => {
      const start = performance.now();
      const report = (error?: unknown) =>
        options.onToolCall?.({ tool: name, ok: error === undefined, durationMs: Math.round(performance.now() - start), error });
      const used: { session?: LinkedInSession } = {};
      const connect: Connect = async (feature) => {
        const connected = await openClient(feature);
        used.session = connected.session;
        return connected;
      };
      try {
        const structured = (await handler(args, connect)) as Record<string, unknown>;
        report();
        return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
      } catch (error) {
        report(error);
        if (signIn && error instanceof NotAuthenticatedError) return signInFor(name, error, signIn);
        if (signIn && used.session && error instanceof LinkedInApiError && error.status === 401) {
          // A token LinkedIn no longer accepts is as good as none once it is forgotten: sign in now, as above, rather
          // than say how to, while status and linkedin_login would still report the user signed in.
          if (await forget(used.session)) {
            return signInFor(name, new NotAuthenticatedError('LinkedIn rejected your sign-in: it has expired or been revoked.'), signIn);
          }
          // Signing in again won't replace LINKEDIN_ACCESS_TOKEN, so don't suggest it.
          if ((await auth.status().catch(() => undefined))?.source === 'environment') {
            return errorResult(
              new NotAuthenticatedError(`LinkedIn rejected the access token in LINKEDIN_ACCESS_TOKEN (it has expired or been revoked). ${ACCESS_TOKEN_HINT}`),
              mode,
            );
          }
        }
        return errorResult(error, mode);
      }
    };
    server.registerTool(name, config, callback as ToolCallback<In>);
  };

  /** Forgets a token LinkedIn rejected; false when that didn't happen (so the user is told how to replace it). */
  const forget = (session: LinkedInSession): Promise<boolean> => auth.rejected?.(session).catch(() => false) ?? Promise.resolve(false);

  /** The client for the signed-in member; `feature` is one the call needs, which a sign-in from before it was turned on lacks. */
  const openClient: Connect = async (feature) => {
    const session = await auth.getSession();
    if (feature && !session.scopes.includes(feature.scope)) {
      // Local mode signs the user in again on this error, which also says if the LinkedIn app lacks the product.
      throw new NotAuthenticatedError(
        mode === 'local'
          ? `Your LinkedIn sign-in predates turning on ${settingName(feature)}, so LinkedIn doesn't allow this yet. ${SIGN_IN_HINT}`
          : `Your LinkedIn connection predates ${feature.variable} being turned on for this connector, so LinkedIn doesn't allow this yet. Disconnect and reconnect the LinkedIn connector in Claude's settings.`,
      );
    }
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

  /**
   * Runs `operation` for `actor`. The generic message for a 403 suggests signing in again, which won't fix the ones
   * explained here instead: a Page refuses its actions to members without the right role on it, and `refusal`, when
   * given, says why a post may refuse the member although their sign-in has the scope the action needs.
   */
  const actingAs = async <T>(actor: string, operation: () => Promise<T>, refusal?: (detail: string) => string): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof LinkedInApiError) || error.status !== 403) throw error;
      const detail = error.message.replace(/\.?$/, '.');
      if (actor.startsWith('urn:li:organization:')) {
        throw new UserInputError(
          `LinkedIn didn't let you act as the Page ${actor}: ${detail} ` +
            "Only a Page's super admins and content admins can post, comment and react as it: check your role on the Page, and that it is the right Page.",
        );
      }
      if (refusal) throw new UserInputError(refusal(detail));
      throw error;
    }
  };

  const sources = { localFileDirs, allowPrivateNetwork: options.allowPrivateNetwork };
  const load = (source: string, kind: MediaKind): Promise<LoadedMedia> => loadMedia(source, kind, sources);

  /** Uploads an image or document, then waits a while (until `deadline` at the latest) for LinkedIn to process it. */
  const upload = async (client: LinkedInClient, kind: AssetKind, owner: string, media: LoadedMedia, deadline: number): Promise<string> => {
    const { uploadUrl, urn } = await client.initializeUpload(kind, owner);
    await client.upload(uploadUrl, media.data);
    const until = kind === 'images' ? Math.min(deadline, now() + IMAGE_WAIT_MS) : deadline;
    for (let delay = 500; ; delay = Math.min(delay * 2, 4_000)) {
      // Status lookups are best effort; LinkedIn validates the asset when posting.
      const status = await client.getAssetStatus(kind, urn).catch(() => undefined);
      if (status === undefined || status === 'AVAILABLE') return urn;
      if (status === 'PROCESSING_FAILED') {
        throw new UserInputError(`LinkedIn could not process the uploaded ${kind === 'images' ? 'image' : 'document'}.`);
      }
      if (now() + delay > until) return urn;
      await sleep(delay);
    }
  };

  const organizationField = z
    .string()
    .optional()
    .describe(
      "Act as this LinkedIn Page instead of as the member: its organization ID (the number in the address of the Page's admin view, " +
        'linkedin.com/company/<ID>/admin/), that address, or urn:li:organization:<ID>. The user must be a super admin or content admin of the Page.',
    );
  // Strict, nested objects too, because these tools publish: an argument dropped silently (a mistyped key, or
  // `organization` without Pages) would publish something other than what the user approved, or as someone else.
  const pagesOff = `Acting as a Page needs ${settingName(PAGES)} turned on for this connector (Community Management API). Leave out "organization" to act as yourself.`;
  const withOrganization = <T extends z.ZodRawShape>(shape: T) =>
    (organizations
      ? z.strictObject({ ...shape, organization: organizationField })
      : z.strictObject(shape, {
          error: (issue) => (issue.code === 'unrecognized_keys' && issue.keys.includes('organization') ? pagesOff : undefined),
        })) as unknown as z.ZodObject<T & { organization: typeof organizationField }>;

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
    async (_args, connect) => {
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
        'If the user has no export yet, tell them to request one at https://www.linkedin.com/mypreferences/d/download-my-data (choose Connections). ' +
        (localFileDirs !== undefined
          ? 'Pass the file (Connections.csv or the zip archive LinkedIn sent), or its text as csv; with neither, the newest export that has them is read from the folders local files may come from. '
          : 'Pass the text of Connections.csv as csv when the user attached or pasted it (an attached zip archive cannot be passed on), or a link to the file. ') +
        'Filter with query, company and connection dates; text matches the start of words, ignoring case and accents. Results are newest first and paged with limit and offset. ' +
          'Set companyCounts to also see how many matching connections work at each company, e.g. to find where the network is concentrated.',
      inputSchema: z.object({
        file: z.string().optional().describe(`Connections.csv or LinkedIn's export zip archive, as ${mediaSources}.`),
        csv: z.string().optional().describe('The contents of Connections.csv, when the user pasted or attached the text.'),
        query: z
          .string()
          .optional()
          .describe(
            'Text that must start a word in the name, company, position, email or profile URL ("ann" finds Ann and Annette, not Joanna). Ignores case and accents.',
          ),
        company: z
          .union([z.string(), z.array(z.string()).min(1)])
          .optional()
          .describe(
            'Only connections whose company has a word starting with this text, or with any of these texts (e.g. ["xyz", "abc"] for everyone at xyz or abc). ' +
              '"ING" finds ING Bank but not Boeing. Ignores case and accents.',
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
        file: z.string().optional().describe('The export that was found and read, when no file or csv was passed.'),
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
      // Open world: `file` may be a link, which it downloads.
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      if (args.file !== undefined && args.csv !== undefined) throw new UserInputError('Pass either file or csv, not both.');
      // A remote server doesn't hold whole export archives in memory for anyone who asks.
      const maxBytes = mode === 'local' ? MAX_EXPORT_BYTES : MAX_CONNECTIONS_BYTES;
      const read = async (file: string) => parseConnections((await readSource(file, maxBytes, 'file', sources)).data);
      let found: string | undefined;
      let all: Connection[] | undefined;
      if (args.file === undefined && args.csv === undefined) {
        if (localFileDirs === undefined) throw new UserInputError('Pass either file or csv.');
        const exports = await findConnectionsExports(localFileDirs);
        const folders = localFileDirs.join(', ') || 'any folder: local files are disabled';
        if (exports.length === 0) {
          throw new UserInputError(
            `No LinkedIn data export was found in ${folders}. ` +
              'Request one at https://www.linkedin.com/mypreferences/d/download-my-data (choose Connections) and save the zip archive LinkedIn emails you in one of those folders, or pass its path.',
          );
        }
        // The newest export that has the connections: one requested for other data, such as messages, lacks them.
        for (const path of exports) {
          all = await read(path).catch((error: unknown) => {
            if (error instanceof NoConnectionsCsvError) return undefined;
            throw error;
          });
          if (all) {
            found = path;
            break;
          }
        }
        if (!all) {
          throw new UserInputError(
            `The LinkedIn data export${exports.length > 1 ? 's' : ''} in ${folders} (${exports.join(', ')}) ${exports.length > 1 ? 'have' : 'has'} no Connections.csv. ` +
              'Request your data again at https://www.linkedin.com/mypreferences/d/download-my-data, choose Connections, and save the zip archive LinkedIn emails you in one of those folders.',
          );
        }
      } else {
        all = args.file !== undefined ? await read(args.file) : parseConnections(args.csv!);
      }
      const query = args.query === undefined ? '' : foldText(args.query);
      const companies = [args.company ?? []].flat().map(foldText).filter(Boolean);
      const dated = (value: string | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);
      const matches = all.filter((connection) => {
        if (query) {
          const fields = [connection.name, connection.company, connection.position, connection.email, connection.profileUrl];
          if (!fields.some((field) => field && matchesWordStart(foldText(field), query))) return false;
        }
        if (companies.length > 0) {
          const company = foldText(connection.company ?? '');
          if (!company || !companies.some((name) => matchesWordStart(company, name))) return false;
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
        ...(found !== undefined ? { file: found } : {}),
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
    text: limitedText(MAX_POST_CHARACTERS, 'post text').describe(
      `The post text, max ${MAX_POST_CHARACTERS} characters. Plain text only (no Markdown); line breaks are kept and #hashtags become links. @mentions can't tag anyone: "@Name" shows as plain text. Special characters are escaped automatically.`,
    ),
    visibility: z
      .enum(['PUBLIC', 'CONNECTIONS'])
      .default('PUBLIC')
      .describe("PUBLIC: anyone on or off LinkedIn. CONNECTIONS: 1st-degree connections only (not for a Page's posts, which are public)."),
    article: z
      .strictObject({
        url: z.url({ protocol: /^https?$/ }).describe('The link to share.'),
        title: z.string().max(200).optional().describe("Preview title. Defaults to the page's own title."),
        description: z.string().max(300).optional().describe("Preview description. Defaults to the page's description."),
        thumbnail: z
          .string()
          .optional()
          .describe(`Preview image as ${mediaSources}. Defaults to the page's preview image.`),
      })
      .optional()
      .describe('Share a link with a preview card. A link in the text alone gets no card.'),
    images: z
      .array(
        z.strictObject({
          source: z.string().describe(`A JPEG, PNG or GIF as ${mediaSources}.`),
          altText: z.string().max(4000).optional().describe('Alternative text describing the image for screen readers.'),
        }),
      )
      .min(1)
      .max(20)
      .optional()
      .describe('Attach 1 to 20 images.'),
    document: z
      .strictObject({
        source: z.string().describe(`A PDF, PPT, PPTX, DOC or DOCX (max 100 MB, 300 pages) as ${mediaSources}.`),
        title: z.string().max(300).optional().describe('Title shown on the document. Defaults to the file name without its extension.'),
      })
      .optional()
      .describe('Attach a document, shown as a swipeable carousel.'),
  });

  /** Loads and checks everything a post needs without touching LinkedIn, so bad inputs fail before anything is published. */
  const preparePost = async (args: z.output<typeof createPostInput>): Promise<PreparedPost> => {
    if ([args.article, args.images, args.document].filter((value) => value !== undefined).length > 1) {
      throw new UserInputError('A post can have only one of: article, images or document.');
    }
    if (args.organization) {
      organizationUrn(args.organization);
      if (args.visibility === 'CONNECTIONS') {
        throw new UserInputError('A Page has followers, not connections, so its posts are public. Leave out visibility, or set it to PUBLIC.');
      }
    }
    const warnings = textWarnings(args.text);
    if (args.images) {
      const images = await Promise.all(
        args.images.map(async ({ source, altText }) => ({ media: await load(source, 'image'), altText: altText || undefined })),
      );
      return { attachment: images.length === 1 ? 'image' : 'images', images, warnings };
    }
    if (args.document) {
      const media = await load(args.document.source, 'document');
      // LinkedIn shows the title above the carousel: "Q3 results", not "Q3 results.pdf".
      const title = args.document.title ?? (media.filename?.replace(/\.(pdf|docx?|pptx?)$/i, '') || 'Document');
      return { attachment: 'document', document: { media, title }, warnings };
    }
    if (!args.article) {
      // LinkedIn's own editor turns a pasted link into the post's article; through the API, a link in the text gets no card.
      if (/https?:\/\/\S/i.test(args.text)) {
        warnings.push('The text has a link, but LinkedIn shows no preview card for links in the text. To show one, also pass the link as article.url.');
      }
      return { attachment: 'none', warnings };
    }

    const { url, title, description, thumbnail } = args.article;
    const hostname = new URL(url).hostname;
    // Undefined when the page can't be read.
    const page: LinkPreview | undefined =
      title && description && thumbnail
        ? {}
        : await fetchLinkPreview(url, { allowPrivateNetwork: options.allowPrivateNetwork }).catch(() => undefined);
    // The page's own preview image is a nice-to-have; post without it if it can't be used.
    const pageImage = !thumbnail && page?.imageUrl ? await load(page.imageUrl, 'image').catch(() => undefined) : undefined;
    const image = thumbnail ? await load(thumbnail, 'image') : pageImage;
    if (!title && !page?.title) {
      warnings.push(
        `The link preview's title is just "${hostname}": ${page ? 'the page has none' : `${url} could not be read`}. Pass article.title (and description) to set it.`,
      );
    }
    if (!image) {
      warnings.push(`The link preview has no image${page ? ': the page offers none in JPEG, PNG or GIF' : ''}. Pass article.thumbnail to add one.`);
    }
    return {
      attachment: 'article',
      article: {
        url,
        title: title ?? page?.title ?? hostname,
        description: description ?? page?.description,
        thumbnail: image,
        pageImageUrl: pageImage && page?.imageUrl,
      },
      warnings,
    };
  };

  /** Keeps the post history up to date. A post that was published must never be reported as failed because it couldn't be remembered. */
  const remember = async (update: (history: PostHistory) => Promise<void>): Promise<void> => {
    if (history) await update(history).catch(() => {});
  };

  tool(
    'linkedin_preview_post',
    {
      title: 'Preview a LinkedIn post',
      description:
        'Checks a post without publishing it or signing in: loads and verifies its images or document, builds the link preview card LinkedIn will show for an article, and warns about text LinkedIn would show literally, such as Markdown. ' +
        'Takes the same arguments as linkedin_create_post. Call it before asking the user to approve a post, and tell them about the preview card and any warnings.',
      inputSchema: createPostInput,
      outputSchema: z.object({
        characters: z.number().describe(`Length of the text; LinkedIn allows ${MAX_POST_CHARACTERS}.`),
        visibility: z.string(),
        attachment: z.enum(ATTACHMENTS),
        images: z.number().optional().describe('Number of images, all checked.'),
        document: z.object({ title: z.string() }).optional(),
        linkPreview: z
          .object({
            url: z.string(),
            title: z.string(),
            description: z.string().optional(),
            thumbnail: z.boolean(),
            imageUrl: z.string().optional().describe("The page's own preview image, when the card uses it."),
          })
          .optional()
          .describe('The card LinkedIn will show for an article.'),
        warnings: z.array(z.string()).describe('What would come out differently than the user may expect. Tell the user before they approve.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const { attachment, images, document, article, warnings } = await preparePost(args);
      return {
        characters: args.text.length,
        visibility: args.visibility,
        attachment,
        images: images?.length,
        document: document && { title: document.title },
        linkPreview: article && {
          url: article.url,
          title: article.title,
          description: article.description,
          thumbnail: article.thumbnail !== undefined,
          imageUrl: article.pageImageUrl,
        },
        warnings,
      };
    },
  );

  tool(
    'linkedin_create_post',
    {
      title: 'Publish a LinkedIn post',
      description:
        'Publishes a post to LinkedIn immediately, as the signed-in member' +
        (organizations ? ' or a LinkedIn Page they administer' : '') +
        '. Optionally attach ONE of: a link preview (article), images, or a document. Check it with linkedin_preview_post first, and only call this after the user has approved the exact text and attachments. Returns the post URN and URL.',
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
    async (args, connect) => {
      // From the start, like the client's timeout: loading and uploading the media take time too.
      const deadline = now() + PROCESSING_DEADLINE_MS;
      const post = await preparePost(args);
      const { client, session } = await connect(args.organization ? PAGES : undefined);
      const author = await actorUrn(client, session, args.organization);
      const { postUrn, linkPreview } = await actingAs(author, async () => {
        let content: PostContent | undefined;
        let preview: { title: string; description?: string; thumbnail: boolean } | undefined;
        if (post.images) {
          const images: Array<{ id: string; altText?: string }> = [];
          for (const { media, altText } of post.images) images.push({ id: await upload(client, 'images', author, media, deadline), altText });
          content = images.length === 1 ? { media: images[0]! } : { multiImage: { images } };
        } else if (post.document) {
          content = { media: { id: await upload(client, 'documents', author, post.document.media, deadline), title: post.document.title } };
        } else if (post.article) {
          const { url, title, description, thumbnail, pageImageUrl } = post.article;
          const uploading = thumbnail && upload(client, 'images', author, thumbnail, deadline);
          // As when loading it, the page's own image is optional: post without it if LinkedIn won't take it.
          const thumbnailUrn = await (pageImageUrl ? uploading?.catch(() => undefined) : uploading);
          content = { article: { source: url, title, description, thumbnail: thumbnailUrn } };
          preview = { title, description, thumbnail: thumbnailUrn !== undefined };
        }
        const urn = await client.createPost({ author, commentary: escapeLittleText(args.text), visibility: args.visibility, content });
        return { postUrn: urn, linkPreview: preview };
      });
      const url = postUrl(postUrn);
      const { attachment } = post;
      await remember((history) => history.add({ postUrn, url, author, text: args.text, visibility: args.visibility, attachment }));
      return { postUrn, url, author, visibility: args.visibility, attachment, linkPreview };
    },
  );

  /**
   * Runs an operation on an authored post, explaining why LinkedIn may reject it: the common activity-URN mix-up, or,
   * for a 403 when the sign-in has the scope for the member's posts, that the post isn't theirs. The generic 403
   * message suggests signing in again, which won't fix that.
   */
  const onOwnPost = async (connect: Connect, post: string, verb: string, operation: (client: LinkedInClient, urn: string) => Promise<void>) => {
    const urn = parsePostReference(post);
    const { client, session } = await connect();
    try {
      await operation(client, urn);
    } catch (error) {
      if (!(error instanceof LinkedInApiError)) throw error;
      if (urn.startsWith('urn:li:activity:') && error.status < 500) {
        throw new UserInputError(
          `LinkedIn could not ${verb} ${urn}. This needs the post's share or ugcPost URN (as returned by linkedin_create_post), not the activity URN that links copied from linkedin.com often contain. ` +
            `To find it, choose "Embed this post" in the post's menu on linkedin.com and pass the embed code, which contains urn:li:share:… or urn:li:ugcPost:…. LinkedIn said: ${error.message}`,
        );
      }
      if (error.status === 403 && session.scopes.includes('w_member_social')) {
        const page = session.scopes.includes(PAGES.scope)
          ? ' If a Page published it, you need to be a super admin or content admin of the Page.'
          : ` To ${verb} a Page's posts, ${settingName(PAGES)} must be turned on for this connector before you sign in.`;
        throw new UserInputError(
          `LinkedIn didn't let you ${verb} ${urn}: ${error.message.replace(/\.?$/, '.')} Only its author can ${verb} a post: check that you published it. ` +
            `Signing in again won't help with that.${page}`,
        );
      }
      throw error;
    }
    return urn;
  };

  const findPost = history
    ? 'Accepts the post URN returned by linkedin_create_post or linkedin_list_posts (which finds posts from earlier conversations), or the post URL.'
    : 'Accepts the post URN returned by linkedin_create_post or the post URL.';

  tool(
    'linkedin_edit_post',
    {
      title: 'Edit a LinkedIn post',
      description: `Replaces the text of a post the signed-in member (or their Page) authored; attachments stay as they are. ${findPost} Only call this after the user has approved the new text.`,
      inputSchema: z.object({
        post: z.string().describe("Post URN (urn:li:share:… or urn:li:ugcPost:…), post URL, or the post's embed code."),
        text: limitedText(MAX_POST_CHARACTERS, 'post text').describe(`The complete new post text, max ${MAX_POST_CHARACTERS} characters. Plain text only.`),
      }),
      outputSchema: z.object({ updated: z.boolean(), postUrn: z.string(), url: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args, connect) => {
      const urn = await onOwnPost(connect, args.post, 'edit', (client, urn) => client.updatePostText(urn, escapeLittleText(args.text)));
      await remember((history) => history.edited(urn, args.text));
      return { updated: true, postUrn: urn, url: postUrl(urn) };
    },
  );

  tool(
    'linkedin_delete_post',
    {
      title: 'Delete a LinkedIn post',
      description: `Permanently deletes a post the signed-in member (or their Page) authored. ${findPost} Confirm with the user first.`,
      inputSchema: z.object({
        post: z.string().describe("Post URN (urn:li:share:… or urn:li:ugcPost:…), post URL, or the post's embed code."),
      }),
      outputSchema: z.object({ deleted: z.boolean(), postUrn: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args, connect) => {
      const urn = await onOwnPost(connect, args.post, 'delete', (client, urn) => client.deletePost(urn));
      await remember((history) => history.deleted(urn));
      return { deleted: true, postUrn: urn };
    },
  );

  if (history) {
    tool(
      'linkedin_list_posts',
      {
        title: 'List posts published from Claude',
        description:
          "Lists the posts published with linkedin_create_post on this computer, newest first, with their URN and current text. LinkedIn's API doesn't let apps read the member's posts, so posts made elsewhere aren't included. " +
          'Use it to find a post from an earlier conversation to edit or delete; to edit one, change the text it returns.',
        inputSchema: z.object({
          query: z.string().optional().describe('Only posts whose text contains this. Ignores case and accents.'),
          limit: z.number().int().min(1).max(MAX_REMEMBERED_POSTS).default(10).describe('Maximum posts to return.'),
        }),
        outputSchema: z.object({
          posts: z.array(
            z.object({
              postUrn: z.string(),
              url: z.string(),
              author: z.string(),
              text: z.string(),
              visibility: z.string(),
              attachment: z.string(),
              publishedAt: z.string(),
              editedAt: z.string().optional(),
            }),
          ),
          matched: z.number().describe('Remembered posts matching the query.'),
        }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (args) => {
        const query = args.query === undefined ? '' : foldText(args.query);
        const matches = (await history.list()).filter((post) => !query || foldText(post.text).includes(query));
        return { posts: matches.slice(0, args.limit), matched: matches.length };
      },
    );
  }

  // ---------------------------------------------------------------- engagement (Community Management API)

  if (engagement) {
    /**
     * The post to act on, who acts (the member, or the Page given as `organization`), and `act`, which runs the
     * action (e.g. "comment on") for them. The sign-in has the action's scope, so a 403 is the post refusing it.
     */
    const engage = async (connect: Connect, { post, organization }: { post: string; organization?: string }, action: string) => {
      if (!organization && !memberEngagement) {
        throw new UserInputError(
          `Commenting and reacting as yourself needs ${settingName(COMMENTS)} turned on for this connector (Community Management API). Pass "organization" to act as a Page instead.`,
        );
      }
      const target = parsePostReference(post);
      const { client, session } = await connect(organization ? PAGES : COMMENTS);
      const actor = await actorUrn(client, session, organization);
      const act = <T>(operation: () => Promise<T>) =>
        actingAs(
          actor,
          operation,
          (detail) =>
            `LinkedIn didn't let you ${action} ${target}: ${detail} Check on linkedin.com that you can see the post and ${action} it. ` +
            "Your sign-in has the permission for this, so signing in again won't help.",
        );
      return { client, target, actor, act };
    };

    tool(
      'linkedin_comment_on_post',
      {
        title: 'Comment on a LinkedIn post',
        description:
          'Adds a comment to a LinkedIn post, publicly and immediately. Only call this after the user has approved the exact comment text.',
        inputSchema: withOrganization({
          post: z.string().describe('Post URN or URL.'),
          text: limitedText(MAX_COMMENT_CHARACTERS, 'comment').describe(`Comment text, max ${MAX_COMMENT_CHARACTERS} characters. Plain text only.`),
        }),
        outputSchema: z.object({ postUrn: z.string(), url: z.string(), commentId: z.string().optional(), actor: z.string() }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args, connect) => {
        const { client, target, actor, act } = await engage(connect, args, 'comment on');
        const commentId = await act(() => client.createComment(target, actor, escapeLittleText(args.text)));
        return { postUrn: target, url: postUrl(target), actor, commentId };
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
        outputSchema: z.object({ postUrn: z.string(), url: z.string(), reaction: z.string(), actor: z.string() }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async (args, connect) => {
        const { client, target, actor, act } = await engage(connect, args, 'react to');
        await act(() => client.createReaction(target, actor, REACTIONS[args.reaction]!));
        return { postUrn: target, url: postUrl(target), reaction: args.reaction, actor };
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

  if (signIn && auth.logout) {
    const logout = auth.logout.bind(auth);

    tool(
      'linkedin_login',
      {
        title: 'Sign in to LinkedIn',
        description:
          "Opens LinkedIn's sign-in page in the user's browser and waits a while for them to approve access. Use it when the user asks to connect or switch LinkedIn accounts. If it returns a link because the sign-in isn't finished yet, show the link to the user; once they say they approved access, retry what they asked for. " +
          'LinkedIn signs in whoever is signed in to linkedin.com in that browser: to switch accounts, the user must sign out of linkedin.com there first.',
        inputSchema: z.object({
          force: z
            .boolean()
            .default(false)
            .describe('Start a new sign-in even if already signed in, e.g. to switch accounts (after signing out of linkedin.com in the browser) or when LinkedIn rejected the stored token.'),
        }),
        outputSchema: z.object({
          alreadySignedIn: z.boolean(),
          signedIn: z.boolean().describe('Whether the user is signed in now, possibly after finishing the sign-in during this call.'),
          name: z.string().optional(),
          authorizationUrl: z.string().optional().describe('The sign-in link, while the sign-in is still waiting for the user.'),
          expiresInSeconds: z.number().optional(),
          message: z.string(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => {
        const before = await auth.status();
        if (!args.force && before.authenticated && !before.missingScopes) return { alreadySignedIn: true, signedIn: true, message: before.message };
        // The sign-in would succeed, and the tools would go on using LINKEDIN_ACCESS_TOKEN.
        if (before.source === 'environment') throw new UserInputError(`The connector uses the access token in LINKEDIN_ACCESS_TOKEN. ${ACCESS_TOKEN_HINT}`);
        const outcome = await signIn!();
        // Users force a sign-in to switch accounts, but LinkedIn keeps whoever is signed in to linkedin.com in the browser.
        if (args.force && outcome.signedIn && before.memberUrn !== undefined && (await auth.status()).memberUrn === before.memberUrn) {
          outcome.message += ` That is the account you were already signed in with. ${SWITCH_ACCOUNT_HINT}`;
        }
        return { alreadySignedIn: false, ...outcome };
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

interface SignInOutcome {
  signedIn: boolean;
  name?: string;
  authorizationUrl?: string;
  expiresInSeconds?: number;
  message: string;
}

/** A tool found the user signed out: sign them in now, so a retry works, rather than only saying how to. */
async function signInFor(tool: string, error: NotAuthenticatedError, signIn: () => Promise<SignInOutcome>): Promise<CallToolResult> {
  let text: string;
  try {
    const outcome = await signIn();
    const waiting = outcome.authorizationUrl !== undefined;
    let reason = error.message.replace(` ${SIGN_IN_HINT}`, '');
    // A sign-in that failed again says why itself, so the previous attempt's failure would only repeat it.
    if (!outcome.signedIn && !waiting) reason = reason.split(` ${LAST_FAILURE} `)[0]!;
    text = outcome.signedIn
      ? `${outcome.message} Nothing was done yet: call ${tool} again to continue.`
      : `${reason} ${outcome.message}${waiting ? ' Once you have approved access, try again.' : ''}`;
  } catch (cause) {
    // E.g. missing app credentials or a busy callback port: that is what the user has to fix first.
    text = describeError(cause, 'local');
  }
  return { isError: true, content: [{ type: 'text', text }] };
}
