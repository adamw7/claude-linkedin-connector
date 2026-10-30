import { readFileSync } from 'node:fs';
import { extractGraph, ImportKind, projectFiles, type FileInfo } from 'archunit';
import { describe, expect, it } from 'vitest';

// Architecture rules for src/, checked with ArchUnitTS. The intended layering, bottom to top:
//
//   errors, version, html, paths, json — leaf modules, no project imports
//   net                          — outbound HTTP, no LinkedIn or MCP knowledge
//   linkedin                     — LinkedIn API and OAuth client
//   auth, config                 — local sign-in and token storage, configuration
//   mcp                          — the MCP server and its tools, transport agnostic
//   remote                       — the HTTP transport and connector OAuth server
//   index                        — composition root
//
// Type-only imports count as dependencies too.

// ArchUnitTS registers this matcher on Vitest's global expect (hence `globals: true`) but ships no types for it.
declare module 'vitest' {
  interface Matchers<R, T> {
    toPassAsync(): Promise<void>;
  }
}

const notImporting = (pattern: RegExp) => (file: FileInfo) => !pattern.test(file.content);

// ArchUnitTS reports every file as depending on itself, so a target pattern must leave out the source file.
const srcExcept = (file: string) => new RegExp(`^src/(?!${file.replaceAll('.', '\\.')}$)`);

/** Each file's imports that run: type-only ones are erased by the compiler and load nothing. */
async function runtimeImports(): Promise<Map<string, string[]>> {
  const imports = new Map<string, string[]>();
  for (const { source, target, importKinds } of await extractGraph()) {
    const typeOnly = importKinds.includes(ImportKind.TYPE) && !importKinds.includes(ImportKind.VALUE);
    if (source !== target && !typeOnly) imports.set(source, [...(imports.get(source) ?? []), target]);
  }
  return imports;
}

/** Every file that loading `entries` loads, through any number of imports, the entries included. */
function loadedBy(imports: Map<string, string[]>, entries: string[]): Set<string> {
  const loaded = new Set<string>();
  const pending = [...entries];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (loaded.has(file)) continue;
    loaded.add(file);
    pending.push(...(imports.get(file) ?? []));
  }
  return loaded;
}

describe('architecture', () => {
  // Builds the import graph of all of src/, which takes 5 to 15 seconds on a busy 4-core machine.
  it('has no circular dependencies', async () => {
    await expect(projectFiles().inFolder('src/**').should().haveNoCycles()).toPassAsync();
  }, 60_000);

  it.each(['errors.ts', 'version.ts', 'html.ts', 'paths.ts', 'json.ts'])('keeps src/%s free of project imports', async (leaf) => {
    await expect(projectFiles().inPath(`src/${leaf}`).shouldNot().dependOnFiles().inPath(srcExcept(leaf))).toPassAsync();
  });

  it.each(['src/linkedin/**', 'src/auth/**', 'src/mcp/**', 'src/remote/**', 'src/config.ts'])(
    'keeps src/net independent of %s',
    async (target) => {
      await expect(projectFiles().inFolder('src/net/**').shouldNot().dependOnFiles().inPath(target)).toPassAsync();
    },
  );

  it.each(['src/auth/**', 'src/mcp/**', 'src/remote/**', 'src/config.ts'])(
    'keeps src/linkedin independent of %s',
    async (target) => {
      await expect(projectFiles().inFolder('src/linkedin/**').shouldNot().dependOnFiles().inPath(target)).toPassAsync();
    },
  );

  it.each(['src/mcp/**', 'src/remote/**'])('keeps src/auth independent of %s', async (target) => {
    await expect(projectFiles().inFolder('src/auth/**').shouldNot().dependOnFiles().inPath(target)).toPassAsync();
  });

  it.each(['src/mcp/**', 'src/remote/**'])('keeps src/config.ts independent of %s', async (target) => {
    await expect(projectFiles().inPath('src/config.ts').shouldNot().dependOnFiles().inPath(target)).toPassAsync();
  });

  it.each(['src/remote/**', 'src/config.ts'])('keeps the MCP server transport agnostic of %s', async (target) => {
    await expect(projectFiles().inFolder('src/mcp/**').shouldNot().dependOnFiles().inPath(target)).toPassAsync();
  });

  // Remote mode keeps no token on disk and signs nobody in through a browser, and the MCP server is shared by both
  // modes, so neither may reach the sign-in or the token storage, even through a module in between: a rule on direct
  // imports alone let the MCP server load them for the hints it shows. Of src/auth they may load the hints and the
  // interfaces. The CLI loads both modes, so the process still loads them; the code serving remote requests can't.
  it.each(['src/mcp/', 'src/remote/'])(
    'keeps %s off local sign-in and storage, directly or through other modules',
    async (folder) => {
      const imports = await runtimeImports();
      const entries = [...imports.keys()].filter((file) => file.startsWith(folder));
      expect(entries.length).toBeGreaterThan(0);
      const loaded = [...loadedBy(imports, entries)].filter((file) => file.startsWith('src/auth/'));
      expect(loaded.filter((file) => !['src/auth/hints.ts', 'src/auth/types.ts'].includes(file))).toEqual([]);
    },
    60_000,
  );

  it('imports the composition root from nowhere', async () => {
    await expect(projectFiles().inPath(srcExcept('index.ts')).shouldNot().dependOnFiles().inPath('src/index.ts')).toPassAsync();
  });

  it('never imports test code from src', async () => {
    await expect(projectFiles().inFolder('src/**').shouldNot().dependOnFiles().inFolder('test/**')).toPassAsync();
  });

  it('uses Express only in src/remote', async () => {
    const rule = projectFiles()
      .inFolder('src/**')
      .should()
      .adhereTo(
        (file) => file.path.includes('src/remote/') || notImporting(/from '(express|@modelcontextprotocol\/express)'/)(file),
        'only src/remote may import express',
      );
    await expect(rule).toPassAsync();
  });

  // stdout carries the MCP protocol in stdio mode, so a stray write there corrupts it. Other modules report through
  // an injected Logger or warn callback, which the composition root points at stderr.
  it('writes to the console, stdout and stderr only from the composition root and the JSON logger', async () => {
    const rule = projectFiles()
      .inFolder('src/**')
      .should()
      .adhereTo(
        (file) =>
          file.path.endsWith('src/index.ts') ||
          (file.path.endsWith('src/remote/logger.ts') ? notImporting(/\bconsole\.|process\.stdout\b/)(file) : notImporting(/\bconsole\.|process\.(stdout|stderr)\b/)(file)),
        'only src/index.ts may write to the console; src/remote/logger.ts may write to stderr',
      );
    await expect(rule).toPassAsync();
  });

  it('prints diagnostics with log() on stderr, never console.error, warn, info, debug or trace', async () => {
    const rule = projectFiles().inFolder('src/**').should().adhereTo(notImporting(/\bconsole\.(error|warn|info|debug|trace|dir|table)\b/), 'console.log is for command output only');
    await expect(rule).toPassAsync();
  });

  it('keeps stdout to the MCP protocol in stdio mode', () => {
    const source = readFileSync('src/index.ts', 'utf8');
    const runStdio = /^function runStdio\(\)[^\n]*\n([\s\S]*?)^\}$/m.exec(source)?.[1];
    expect(runStdio).toBeDefined();
    expect(runStdio).not.toMatch(/\bconsole\.|process\.stdout\b/);
  });

  it('creates the JSON logger only in the composition root; other modules take a Logger', async () => {
    const rule = projectFiles()
      .inFolder('src/**')
      .should()
      .adhereTo((file) => /src\/(index|remote\/logger)\.ts$/.test(file.path) || notImporting(/\bjsonLogger\(/)(file), 'only src/index.ts may call jsonLogger');
    await expect(rule).toPassAsync();
  });

  // Only the REST and OAuth clients, whose URLs are LinkedIn's: link-preview.ts and media.ts sit beside them but fetch
  // URLs the user gave, which must go through safeFetch's refusal of private and loopback addresses.
  it('calls the global fetch only from the LinkedIn clients; other outbound requests go through safeFetch', async () => {
    const rule = projectFiles()
      .inFolder('src/**')
      .should()
      .adhereTo(
        (file) => /src\/linkedin\/(client|oauth)\.ts$/.test(file.path) || notImporting(/(?<!typeof )globalThis\.fetch\b|(?<![\w.])fetch\(/)(file),
        'only src/linkedin/client.ts and src/linkedin/oauth.ts may call the global fetch',
      );
    await expect(rule).toPassAsync();
  });
});
