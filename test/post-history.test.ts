import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_REMEMBERED_POSTS, PostHistory } from '../src/auth/post-history.js';

const post = (n: number) => ({
  postUrn: `urn:li:share:${n}`,
  url: `https://www.linkedin.com/feed/update/urn:li:share:${n}/`,
  author: 'urn:li:person:abc123',
  text: `Post ${n}`,
  visibility: 'PUBLIC',
  attachment: 'none',
});

describe('PostHistory', () => {
  let path: string;

  beforeEach(async () => {
    path = join(await mkdtemp(join(tmpdir(), 'linkedin-history-')), 'nested', 'posts.json');
  });

  it('starts empty and keeps posts newest first in a user-only file', async () => {
    const history = new PostHistory(path, () => Date.parse('2026-10-18T12:00:00Z'));
    expect(await history.list()).toEqual([]);
    await history.add(post(1));
    await history.add(post(2));
    expect(await history.list()).toEqual([
      { ...post(2), publishedAt: '2026-10-18T12:00:00.000Z' },
      { ...post(1), publishedAt: '2026-10-18T12:00:00.000Z' },
    ]);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it(`forgets the oldest posts beyond ${MAX_REMEMBERED_POSTS}`, async () => {
    const history = new PostHistory(path);
    for (let n = 1; n <= MAX_REMEMBERED_POSTS + 2; n++) await history.add(post(n));
    const posts = await history.list();
    expect(posts).toHaveLength(MAX_REMEMBERED_POSTS);
    expect(posts[0]!.postUrn).toBe(`urn:li:share:${MAX_REMEMBERED_POSTS + 2}`);
    expect(posts.at(-1)!.postUrn).toBe('urn:li:share:3');
  });

  it('remembers every post when several are published at once', async () => {
    const history = new PostHistory(path);
    await Promise.all([1, 2, 3, 4, 5].map((n) => history.add(post(n))));
    expect((await history.list()).map((known) => known.postUrn).sort()).toEqual([1, 2, 3, 4, 5].map((n) => `urn:li:share:${n}`));
  });

  it('keeps going after a failed update', async () => {
    const history = new PostHistory(path);
    // A file where the history's folder should be makes the write fail.
    await writeFile(dirname(path), 'in the way');
    await expect(history.add(post(1))).rejects.toThrow();
    await rm(dirname(path));
    await history.add(post(2));
    expect((await history.list()).map((known) => known.postUrn)).toEqual(['urn:li:share:2']);
  });

  it('lists a post once even if it is added again', async () => {
    const history = new PostHistory(path);
    await history.add(post(1));
    await history.add({ ...post(1), text: 'Again' });
    expect((await history.list()).map((known) => known.text)).toEqual(['Again']);
  });

  it('leaves the file alone when an edited or deleted post is not in it', async () => {
    const history = new PostHistory(path);
    await history.edited('urn:li:share:9', 'New text');
    await history.deleted('urn:li:share:9');
    expect(existsSync(path)).toBe(false);
  });

  it('ignores corrupt and unknown files and entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linkedin-history-'));
    const file = join(dir, 'posts.json');
    const history = new PostHistory(file);
    await writeFile(file, '{not json');
    expect(await history.list()).toEqual([]);
    await writeFile(file, JSON.stringify({ version: 2, posts: [post(1)] }));
    expect(await history.list()).toEqual([]);
    await writeFile(file, JSON.stringify({ version: 1, posts: [{ ...post(1), publishedAt: '2026-10-18T12:00:00.000Z' }, { postUrn: 7 }, null] }));
    expect((await history.list()).map((known) => known.postUrn)).toEqual(['urn:li:share:1']);
  });
});
