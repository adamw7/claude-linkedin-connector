import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readJsonFile, writePrivateJsonFile } from '../src/auth/json-file.js';

describe('JSON files', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'linkedin-json-'));
  });

  it('round-trips values, creating missing folders', async () => {
    const path = join(dir, 'a', 'b', 'value.json');
    expect(await readJsonFile(path)).toBeUndefined();
    await writePrivateJsonFile(path, { version: 1, list: ['x'] });
    expect(await readJsonFile(path)).toEqual({ version: 1, list: ['x'] });
    expect(await readFile(path, 'utf8')).toBe('{\n  "version": 1,\n  "list": [\n    "x"\n  ]\n}\n');
  });

  it.skipIf(process.platform === 'win32')('makes files and new folders private to the user, also when they existed', async () => {
    const path = join(dir, 'private', 'value.json');
    await writePrivateJsonFile(path, 1);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'private'))).mode & 0o777).toBe(0o700);
    await chmod(path, 0o644);
    await writePrivateJsonFile(path, 2);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('reads files that are not JSON as missing', async () => {
    const path = join(dir, 'broken.json');
    await writeFile(path, '{"half": ');
    expect(await readJsonFile(path)).toBeUndefined();
  });

  it('reports other read errors', async () => {
    await expect(readJsonFile(dir)).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('leaves no temporary file behind when it cannot replace the file', async () => {
    // A folder (with something in it) where the file should go: the final rename fails.
    const path = join(dir, 'taken');
    await mkdir(path);
    await writeFile(join(path, 'keep'), '');
    await expect(writePrivateJsonFile(path, { lost: true })).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['taken']);
  });
});
