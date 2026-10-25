import { readFileSync } from 'node:fs';
import { projectFiles, type FileInfo } from 'archunit';
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

  it.each(['local-auth.ts', 'token-store.ts', 'loopback-login.ts', 'post-history.ts', 'json-file.ts'])(
    'keeps remote mode off local sign-in and storage (src/auth/%s)',
    async (target) => {
      await expect(projectFiles().inFolder('src/remote/**').shouldNot().dependOnFiles().inPath(`src/auth/${target}`)).toPassAsync();
    },
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

  it('calls the global fetch only from the LinkedIn clients; other outbound requests go through safeFetch', async () => {
    const rule = projectFiles()
      .inFolder('src/**')
      .should()
      .adhereTo(
        (file) => file.path.includes('src/linkedin/') || notImporting(/(?<!typeof )globalThis\.fetch\b|(?<![\w.])fetch\(/)(file),
        'only src/linkedin may call the global fetch',
      );
    await expect(rule).toPassAsync();
  });
});
