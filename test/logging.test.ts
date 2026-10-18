import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Rules for what the remote server logs, checked on the source of every `logger(level, event, fields)` call.
// Logs are shipped to collectors and read by operators, so they must never carry tokens, codes or post text.

interface LogCall {
  file: string;
  event: string;
  fields: string[];
  /** The source of each field's value, by field name. */
  values: Record<string, string>;
}

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** Splits `source` at top-level commas, skipping strings, template literals and brackets. */
function splitTopLevel(source: string): string[] {
  const parts: string[] = [];
  const closers: string[] = [];
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"' || char === '`') quote = char;
    else if (OPENERS[char]) closers.push(OPENERS[char]);
    else if (char === closers.at(-1)) closers.pop();
    else if (char === ',' && closers.length === 0) {
      parts.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts.filter((part) => part !== '');
}

/** The source between the parenthesis at `open` and its match. */
function argumentsAt(source: string, open: number): string {
  let depth = 0;
  let quote: string | undefined;
  for (let i = open; i < source.length; i++) {
    const char = source[i]!;
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') if (--depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`Unbalanced logger call at offset ${open}`);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [],
  );
}

function logCalls(): LogCall[] {
  return sourceFiles('src').flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(/\blogger\(/g)].map((match) => {
      const [, eventSource = '', fieldsSource = '{}', ...rest] = splitTopLevel(argumentsAt(source, match.index + 'logger'.length));
      const event = /^'([^']*)'$/.exec(eventSource)?.[1];
      if (event === undefined) throw new Error(`${file}: the event of a logger call must be a string literal, got ${eventSource}`);
      if (rest.length > 0 || !/^\{[\s\S]*\}$/.test(fieldsSource)) {
        throw new Error(`${file}: the fields of the ${event} log call must be an object literal, got ${fieldsSource}`);
      }
      const values: Record<string, string> = {};
      for (const field of splitTopLevel(fieldsSource.slice(1, -1))) {
        const [, key, value] = /^(\w+)\s*(?::\s*([\s\S]+))?$/.exec(field) ?? [];
        if (key === undefined) throw new Error(`${file}: unsupported field "${field}" in the ${event} log call`);
        values[key] = value ?? key;
      }
      return { file, event, fields: Object.keys(values), values };
    });
  });
}

/** The events listed in the Monitoring table of the deployment guide. */
function documentedEvents(): string[] {
  const guide = readFileSync('docs/deployment.md', 'utf8');
  const section = guide.slice(guide.indexOf('## Monitoring'), guide.indexOf('\n## ', guide.indexOf('## Monitoring') + 1));
  return section
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .flatMap((line) => [...line.split('|')[1]!.matchAll(/`([^`]+)`/g)].map((match) => match[1]!));
}

const calls = logCalls();

describe('logging', () => {
  it('finds the logger calls', () => {
    expect(calls.length).toBeGreaterThanOrEqual(10);
  });

  it('names events in snake_case', () => {
    for (const { file, event } of calls) expect(event, file).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it('documents every logged event in the deployment guide, and logs every documented one', () => {
    const logged = [...new Set(calls.map((call) => call.event))].sort();
    expect(logged).toEqual([...new Set(documentedEvents())].sort());
  });

  it('never logs fields that hold secrets or user content', () => {
    const forbidden = /token|secret|password|^code$|state|verifier|authorization|cookie|body|text|commentary|args|arguments|query/i;
    for (const { file, event, fields } of calls) {
      for (const field of fields) expect(forbidden.test(field), `${file}: ${event}.${field}`).toBe(false);
    }
  });

  it('never logs request bodies, query strings or full URLs, which carry tokens, codes and post text', () => {
    const forbidden = /\.(body|query|params|originalUrl|url|arguments)\b|authorization|accessToken|refreshToken/i;
    for (const { file, event, values } of calls) {
      for (const [field, value] of Object.entries(values)) expect(value, `${file}: ${event}.${field}`).not.toMatch(forbidden);
    }
  });

  it('tags request-scoped events with the request ID', () => {
    for (const { file, event, fields } of calls.filter((call) => ['http_request', 'tool_call', 'unhandled_error'].includes(call.event))) {
      expect(fields, `${file}: ${event}`).toContain('requestId');
    }
  });
});
