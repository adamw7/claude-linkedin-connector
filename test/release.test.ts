import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

const json = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));

describe('release metadata', () => {
  it('uses one version everywhere', () => {
    expect(json('package.json').version).toBe(VERSION);
    expect(json('mcpb/manifest.json').version).toBe(VERSION);
    expect(json('package-lock.json').version).toBe(VERSION);
  });

  it('has a changelog entry for the current version', () => {
    const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
    expect(changelog).toMatch(new RegExp(`^## \\[${VERSION.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'));
  });
});
