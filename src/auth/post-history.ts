import { readJsonFile, writePrivateJsonFile } from './json-file.js';

/** A post published through the connector. */
export interface PublishedPost {
  postUrn: string;
  url: string;
  author: string;
  /** The text as the user wrote it, before escaping; updated by edits. */
  text: string;
  visibility: string;
  attachment: string;
  /** ISO 8601. */
  publishedAt: string;
  /** ISO 8601, when the text was last edited through the connector. */
  editedAt?: string;
}

/** Older posts are forgotten beyond this many. */
export const MAX_REMEMBERED_POSTS = 100;

function isPublishedPost(value: unknown): value is PublishedPost {
  const post = value as Partial<PublishedPost> | null | undefined;
  return typeof post?.postUrn === 'string' && typeof post.text === 'string' && typeof post.publishedAt === 'string';
}

/**
 * The posts published from this computer, newest first, kept in a JSON file readable only by the user.
 * LinkedIn doesn't let ordinary apps read a member's posts, so without it a post from an earlier
 * conversation could only be edited or deleted with a link the user kept.
 */
export class PostHistory {
  /** The update in progress; updates run one at a time so posts published at once are all remembered. */
  private updating: Promise<void> = Promise.resolve();

  constructor(readonly path: string, private readonly now: () => number = Date.now) {}

  async list(): Promise<PublishedPost[]> {
    const data = (await readJsonFile(this.path)) as { version?: unknown; posts?: unknown } | undefined;
    return data?.version === 1 && Array.isArray(data.posts) ? data.posts.filter(isPublishedPost) : [];
  }

  add(post: Omit<PublishedPost, 'publishedAt' | 'editedAt'>): Promise<void> {
    return this.update((posts) =>
      [{ ...post, publishedAt: this.timestamp() }, ...posts.filter((known) => known.postUrn !== post.postUrn)].slice(0, MAX_REMEMBERED_POSTS),
    );
  }

  edited(postUrn: string, text: string): Promise<void> {
    return this.update((posts) =>
      posts.some((post) => post.postUrn === postUrn)
        ? posts.map((post) => (post.postUrn === postUrn ? { ...post, text, editedAt: this.timestamp() } : post))
        : undefined,
    );
  }

  deleted(postUrn: string): Promise<void> {
    return this.update((posts) => {
      const remaining = posts.filter((post) => post.postUrn !== postUrn);
      return remaining.length < posts.length ? remaining : undefined;
    });
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  /** Applies `change` to the stored posts; it returns undefined when there is nothing to write. */
  private update(change: (posts: PublishedPost[]) => PublishedPost[] | undefined): Promise<void> {
    const run = async () => {
      const posts = change(await this.list());
      if (posts) await writePrivateJsonFile(this.path, { version: 1, posts });
    };
    const result = this.updating.then(run);
    this.updating = result.catch(() => {});
    return result;
  }
}
