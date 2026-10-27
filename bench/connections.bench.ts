import { utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { parseConnections } from '../src/linkedin/connections.js';
import { callTool, startLocal, type Local } from './helpers/connector.js';
import { connectionsCsv, exportArchive, MAX_CONNECTIONS } from './helpers/connections.js';

// linkedin_read_connections reads and searches the whole of Connections.csv on every call, so its time grows with the
// member's network, up to LinkedIn's limit of 30,000 connections.

const TIMEOUT = 120_000;
/** These take tens to hundreds of milliseconds a call: fewer samples and warm-up calls than the defaults (64 and 16) still settle. */
const SLOW = { iterations: 10, warmupIterations: 3 };
/** Ten times the connections should take about ten times as long; a step that is quadratic in them would take a hundred times. */
const TEN_TIMES_AT_MOST = 25;

const SMALL = MAX_CONNECTIONS / 10;
const SMALL_CSV = connectionsCsv(SMALL);
const LARGE_CSV = connectionsCsv(MAX_CONNECTIONS);
/** LinkedIn names its archives like this; the connector finds them by the name. */
const ARCHIVE = 'Basic_LinkedInDataExport_10-01-2026.zip';

let local: Local;

beforeAll(async () => {
  local = await startLocal();
  // Not named Connections.csv, so the tool reads it only when given it.
  await writeFile(join(local.files, 'small-network.csv'), SMALL_CSV);
  await writeFile(join(local.files, 'Connections.csv'), LARGE_CSV);
  await writeFile(join(local.files, ARCHIVE), exportArchive(LARGE_CSV));
  // The archive is the newest export, which the tool reads when not given a file.
  const yesterday = new Date(Date.now() - 86_400_000);
  await utimes(join(local.files, 'Connections.csv'), yesterday, yesterday);
});

afterAll(() => local?.close());

/** How many times longer `slower` took than `faster`, by their medians, which a stray garbage collection doesn't move. */
const ratio = (slower: { latency: { p50: number } }, faster: { latency: { p50: number } }) => slower.latency.p50 / faster.latency.p50;

test('parses Connections.csv in time proportional to its size', { timeout: TIMEOUT }, async ({ bench }) => {
  expect(parseConnections(SMALL_CSV)).toHaveLength(SMALL);
  expect(parseConnections(LARGE_CSV)).toHaveLength(MAX_CONNECTIONS);

  const result = await bench.compare(
    bench('parse 3,000 connections', () => void parseConnections(SMALL_CSV)),
    bench('parse 30,000 connections', () => void parseConnections(LARGE_CSV)),
    SLOW,
  );
  expect(ratio(result.get('parse 30,000 connections'), result.get('parse 3,000 connections'))).toBeLessThan(TEN_TIMES_AT_MOST);
});

test('searches connections in time proportional to their number', { timeout: TIMEOUT }, async ({ bench }) => {
  const search = (file: string) => callTool(local.client, 'linkedin_read_connections', { file, query: 'łukasz', limit: 10 });
  const small = await search('small-network.csv');
  const large = await search('Connections.csv');
  expect(small).toMatchObject({ total: SMALL, connections: expect.arrayContaining([expect.objectContaining({ firstName: 'Łukasz' })]) });
  expect(large).toMatchObject({ total: MAX_CONNECTIONS, connections: expect.arrayContaining([expect.objectContaining({ firstName: 'Łukasz' })]) });
  expect(large.matched).toBeGreaterThan(small.matched);

  const result = await bench.compare(
    bench('search 3,000 connections', () => search('small-network.csv')),
    bench('search 30,000 connections', () => search('Connections.csv')),
    SLOW,
  );
  expect(ratio(result.get('search 30,000 connections'), result.get('search 3,000 connections'))).toBeLessThan(TEN_TIMES_AT_MOST);
});

test('reads 30,000 connections with each kind of filter', { timeout: TIMEOUT }, async ({ bench }) => {
  const read = (args: Record<string, unknown>) => callTool(local.client, 'linkedin_read_connections', { file: 'Connections.csv', ...args });
  const companies = await read({ limit: 0, companyCounts: 5 });
  expect(companies).toMatchObject({ total: MAX_CONNECTIONS, connections: [], companiesTotal: 10 });
  expect(companies.companies).toHaveLength(5);
  // "ing" starts a word in ING Bank, not in Boeing.
  const atCompanies = (await read({ company: ['ing', 'acme'], limit: 1000 })).connections as Array<{ company: string }>;
  expect(new Set(atCompanies.map(({ company }) => company))).toEqual(new Set(['ING Bank', 'Acme, Inc.']));
  // Four connections a day.
  expect(await read({ connectedAfter: '2025-01-01', connectedBefore: '2025-12-31', limit: 0 })).toMatchObject({ matched: 4 * 365 });
  expect(await callTool(local.client, 'linkedin_read_connections', { limit: 1 })).toMatchObject({ file: join(local.files, ARCHIVE), total: MAX_CONNECTIONS });

  await bench.compare(
    bench('read the newest 100', () => read({})),
    bench('search by name', () => read({ query: 'łukasz' })),
    bench('filter by companies', () => read({ company: ['ing', 'acme'] })),
    bench('filter by connection date', () => read({ connectedAfter: '2025-01-01', connectedBefore: '2025-12-31' })),
    bench('count connections per company', () => read({ limit: 0, companyCounts: 10 })),
    bench('read from the export archive', () => read({ file: ARCHIVE })),
    bench('find the newest export and read it', () => callTool(local.client, 'linkedin_read_connections', {})),
    SLOW,
  );
});
