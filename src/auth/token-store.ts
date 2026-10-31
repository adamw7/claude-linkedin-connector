import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LinkedInTokens } from '../linkedin/oauth.js';
import type { MemberInfo } from './types.js';
import { NAME } from '../version.js';
import { readJsonFile, writePrivateJsonFile } from './json-file.js';

export interface StoredToken extends LinkedInTokens {
  version: 1;
  member?: MemberInfo;
}

export function defaultTokenFile(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, NAME, 'token.json');
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configHome, NAME, 'token.json');
}

function isStoredToken(value: unknown): value is StoredToken {
  const token = value as Partial<StoredToken> | null | undefined;
  return token?.version === 1 && typeof token.accessToken === 'string' && Array.isArray(token.scopes);
}

/** Persists the LinkedIn token in a JSON file readable only by the current user. */
export class TokenStore {
  constructor(readonly path: string) {}

  async read(): Promise<StoredToken | undefined> {
    const parsed = await readJsonFile(this.path);
    return isStoredToken(parsed) ? parsed : undefined;
  }

  write(token: StoredToken): Promise<void> {
    return writePrivateJsonFile(this.path, token);
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
