import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { MemberInfo } from './types.js';
import { NAME } from '../version.js';

export interface StoredToken {
  version: 1;
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  refreshToken?: string;
  /** Epoch milliseconds. */
  refreshTokenExpiresAt?: number;
  scopes: string[];
  member?: MemberInfo;
  /** Epoch milliseconds. */
  obtainedAt: number;
}

export function defaultTokenFile(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, NAME, 'token.json');
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configHome, NAME, 'token.json');
}

function isStoredToken(value: unknown): value is StoredToken {
  const token = value as Partial<StoredToken> | null;
  return (
    typeof token === 'object' &&
    token !== null &&
    token.version === 1 &&
    typeof token.accessToken === 'string' &&
    Array.isArray(token.scopes)
  );
}

/** Persists the LinkedIn token in a JSON file readable only by the current user. */
export class TokenStore {
  constructor(readonly path: string) {}

  async read(): Promise<StoredToken | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return isStoredToken(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async write(token: StoredToken): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
    try {
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    // writeFile's mode only applies to new files; enforce it for overwritten ones too.
    await chmod(this.path, 0o600).catch(() => {});
  }

  async clear(): Promise<boolean> {
    try {
      await rm(this.path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
}
