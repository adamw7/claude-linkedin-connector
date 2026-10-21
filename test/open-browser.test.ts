import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openBrowser } from '../src/auth/open-browser.js';

const URL = 'https://www.linkedin.com/oauth/v2/authorization?state=x';

describe.skipIf(process.platform === 'win32')('openBrowser', () => {
  let dir: string;
  const path = process.env.PATH;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opener-'));
    process.env.PATH = dir;
  });
  afterEach(() => {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  });

  /** Stand-ins for xdg-open (Linux) and open (macOS), the only commands on the PATH. */
  function opener(script: string): void {
    for (const name of ['xdg-open', 'open']) {
      writeFileSync(join(dir, name), `#!/bin/sh\nPATH=/usr/bin:/bin\n${script}\n`);
      chmodSync(join(dir, name), 0o755);
    }
  }

  it('resolves true once the opener has handed the page to the browser', async () => {
    opener(`printf '%s' "$1" > "${join(dir, 'opened')}"`);
    expect(await openBrowser(URL)).toBe(true);
    expect(readFileSync(join(dir, 'opened'), 'utf8')).toBe(URL);
  });

  it('resolves false without an opener, as in WSL and on servers, or when it found no browser', async () => {
    expect(await openBrowser(URL)).toBe(false);
    // xdg-open: "no method available for opening".
    opener('exit 3');
    expect(await openBrowser(URL)).toBe(false);
  });

  it('counts an opener still running after a while as having opened the page', async () => {
    opener('sleep 2');
    expect(await openBrowser(URL, 100)).toBe(true);
  });
});
