// Bundles the CLI and all dependencies into one file for the Claude Desktop extension (.mcpb).
import { copyFile } from 'node:fs/promises';
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'mcpb/server/index.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  legalComments: 'inline',
  logLevel: 'info',
});
await copyFile('LICENSE', 'mcpb/LICENSE');
