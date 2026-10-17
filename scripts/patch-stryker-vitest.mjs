// Makes @stryker-mutator/vitest-runner 10 work with Vitest 5.
// Stryker filters each mutant run with a test-name regex built from names joined by ' ', but
// Vitest 5 matches it against full names joined by ' > ', so every test is skipped and every
// mutant "survives". Rewrite the join to match. Idempotent; drop once Stryker fixes it upstream.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runnerDir = dirname(require.resolve('@stryker-mutator/vitest-runner/package.json'));
const before = "return nameParts.join(' ').trim();";
const after = "return nameParts.filter(Boolean).join(' > ').trim();";

for (const file of ['stryker-setup.js', 'test-helpers.js']) {
  const path = join(runnerDir, 'dist', 'src', file);
  const source = await readFile(path, 'utf8');
  if (source.includes(after)) continue;
  if (!source.includes(before)) {
    throw new Error(`Unexpected contents in ${path}; revisit scripts/patch-stryker-vitest.mjs`);
  }
  await writeFile(path, source.replace(before, after));
}
