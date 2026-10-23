import { homedir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';

/** `path` with a leading `~` replaced by the home directory. */
export function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') || path.startsWith('~\\') ? homedir() + path.slice(1) : path;
}

/** Whether `path` is `dir` or lies somewhere below it. */
export function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
