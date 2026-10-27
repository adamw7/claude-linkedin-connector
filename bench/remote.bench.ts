import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { callTool, connectRemote, signIn, startRemote, type Remote } from './helpers/connector.js';
import { connectionsCsv } from './helpers/connections.js';

// The remote server over HTTP on loopback, as Claude reaches a custom connector: each MCP request is authenticated by
// opening the sealed access token, and gets a connector server of its own. The MCP client runs in the same process, so
// the times include its work too.

const TIMEOUT = 120_000;
const POST = 'Shipped v2.0 of our (open-source) connector, thanks to @Ada & the team! #AI '.repeat(30);
const PASTED = connectionsCsv(3_000);

let remote: Remote;
let client: Client;

beforeAll(async () => {
  remote = await startRemote();
  client = await connectRemote(remote, await signIn(remote));
});

afterAll(async () => {
  // Nothing a benchmark did may have gone wrong unnoticed: failed tool calls, MCP errors and server errors log warnings.
  expect(remote?.problems).toEqual([]);
  await client?.close();
  await remote?.close();
});

/** Forgets the requests the fake LinkedIn recorded, so a long benchmark doesn't fill memory with them. */
const forgetRequests = { afterEach: () => void (remote.linkedin.requests.length = 0) };

/** An MCP request with a token this server didn't issue, which it must turn away. */
async function forged(): Promise<void> {
  const response = await fetch(remote.mcpUrl, {
    method: 'POST',
    headers: { Authorization: 'Bearer forged', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  await response.arrayBuffer();
  if (response.status !== 401) throw new Error(`A forged token got HTTP ${response.status}`);
}

test('connects Claude: registration, consent, LinkedIn sign-in and token', { timeout: TIMEOUT }, async ({ bench }) => {
  const connected = await connectRemote(remote, await signIn(remote));
  expect(await callTool(connected, 'linkedin_auth_status')).toMatchObject({ authenticated: true, source: 'connector', name: 'Ada Lovelace' });
  await connected.close();

  await bench('connect Claude to the connector', forgetRequests, () => signIn(remote)).run();
});

test('serves tool calls over HTTP', { timeout: TIMEOUT }, async ({ bench }) => {
  expect((await client.listTools()).tools).toHaveLength(7);
  expect(await callTool(client, 'linkedin_get_profile')).toMatchObject({ memberUrn: 'urn:li:person:abc123' });
  remote.linkedin.requests.length = 0;
  expect(await callTool(client, 'linkedin_create_post', { text: POST })).toMatchObject({ author: 'urn:li:person:abc123' });
  // The member ID travels in the access token, so a post costs a single LinkedIn request.
  expect(remote.linkedin.requests.map(({ method, url }) => `${method} ${url.pathname}`)).toEqual(['POST /rest/posts']);
  expect(await callTool(client, 'linkedin_read_connections', { csv: PASTED, query: 'łukasz', limit: 10 })).toMatchObject({ total: 3_000 });
  await forged();

  await bench.compare(
    bench('turn away a forged token', forged),
    bench('ping', () => client.ping()),
    bench('list the tools', () => client.listTools()),
    bench('get the profile', forgetRequests, () => callTool(client, 'linkedin_get_profile')),
    bench('publish a text post', forgetRequests, () => callTool(client, 'linkedin_create_post', { text: POST })),
    bench('search 3,000 pasted connections', () => callTool(client, 'linkedin_read_connections', { csv: PASTED, query: 'łukasz', limit: 10 })),
  );
});
