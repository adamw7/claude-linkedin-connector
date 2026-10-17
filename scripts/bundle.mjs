// Bundles the CLI and all dependencies into one file for the Claude Desktop extension (.mcpb).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'mcpb/server/index.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  legalComments: 'inline',
  logLevel: 'info',
});
