import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseJson } from '../json.js';

/** Parses a JSON file; undefined when it doesn't exist or isn't valid JSON. */
export async function readJsonFile(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    // A missing file reads as empty, which isn't valid JSON either.
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return parseJson(text);
}

/** Writes JSON readable only by the current user, through a temporary file so a crash never leaves half of it. */
export async function writePrivateJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  // writeFile's mode only applies to new files; enforce it for overwritten ones too.
  await chmod(path, 0o600).catch(() => {});
}
