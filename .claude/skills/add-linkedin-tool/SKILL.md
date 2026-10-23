---
name: add-linkedin-tool
description: Checklist for adding or changing a linkedin_* MCP tool in this connector — the REST call in src/linkedin/client.ts, registration in src/mcp/server.ts, scope gating, tests against the fake LinkedIn, and the README, usage guide, mcpb manifest and CHANGELOG entries. Use when asked to add a new LinkedIn capability or tool, or to change an existing tool's inputs or outputs.
---

# Adding a LinkedIn tool

Work through these steps in order. Read the neighbouring tool closest to the new one first (for example
`linkedin_react_to_post` for an engagement action, `linkedin_delete_post` for a post action) and copy its shape.

## 1. API call: `src/linkedin/client.ts`

- Add one method to `LinkedInClient` per LinkedIn endpoint. Go through the private `call` (versioned REST, retried
  on 426 by `ApiVersion`) or `callAndDiscard` when the body is not needed. Never call `fetch` directly.
- `src/linkedin/` is the only layer allowed to touch the global `fetch`; `test/architecture.test.ts` enforces the
  layering in `docs/architecture.md`. Fetching third-party URLs (media, previews) goes through
  `src/net/safe-fetch.ts`, which refuses private and loopback addresses.
- Put URN building and parsing in `src/linkedin/urn.ts` (`parsePostReference`, `personUrn`, `organizationUrn`).

## 2. Tool: `src/mcp/server.ts`

- `tool('linkedin_<verb>_<noun>', { title, description, inputSchema, outputSchema, annotations }, async (args) => …)`.
- The handler returns the structured result, which is type-checked against `outputSchema`. `tool` turns thrown errors
  into tool results via `errorResult` and reports every call to `onToolCall` (the remote audit log).
- Get the client with `connect()`; resolve the author with `memberUrn` / `actorUrn`.
- Text the user writes goes through `escapeLittleText` before it is sent, or LinkedIn can cut it off at `( ) [ ] * _ @ #`.
- Throw `UserInputError` (from `src/errors.ts`) for problems the user can fix; the message is shown to Claude as is.
- Set `annotations` honestly: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.
- Anything that publishes, edits or deletes says in its `description` that the user must approve the exact
  content first. Update `instructions()` if the tool adds a new kind of action.
- Tools that publish or edit take a strict input (`z.strictObject`, or `withOrganization`), so a mistyped argument
  fails instead of being dropped. A request that publishes something new goes through `publishing(...)`: after a
  timeout, a broken connection or a 500/502/504 it says where to look, not to try again, which could publish twice.
- **Scope gating:** a tool that needs a scope beyond the defaults (`openid profile email w_member_social`) is
  registered only inside an `if (scopes.has(...))` block, like the engagement tools. Acting as a Page uses
  `withOrganization(...)` and `w_organization_social`.
- **Remote mode never reads local disk:** anything that reads files must respect `localFileDirs`, which is
  `undefined` in remote mode.

## 3. Tests

- `test/tools.test.ts`: drive the tool through the MCP client with `harness({ scopes })` and `call(h, name, args)`.
  Assert on the requests the fake recorded (`h.linkedin.find('POST', '/rest/...')`), not just on the result.
  Cover: the happy path, scope gating (tool hidden without the scope, listed with it), a `UserInputError` path,
  and a LinkedIn error status.
- `test/helpers/fake-linkedin.ts`: add a default response for the new endpoint next to the existing routes, or use
  `h.linkedin.override(request => …)` in a single test.
- `test/client.test.ts` when the client method has logic of its own (paging, parsing, retries).
- Mutation testing runs on CI (`stryker.config.json`). Assert exact values (request bodies, URNs, messages) so
  mutants die.

## 4. Docs and packaging

- `README.md`: add the tool to the **Tools** table, including the scope it needs.
- `docs/usage.md`: add an example request if users would ask for it in a new way.
- `mcpb/manifest.json`: add `{ "name", "description" }` to `tools`.
- `CHANGELOG.md`: add an entry under `## [Unreleased]` → `### Added`, written for users.
- New scope? Update `LINKEDIN_SCOPES` docs in the README and `scripts/setup-claude-code.mjs` if setup asks for it.

## 5. Check

```bash
npm run check          # typecheck + tests
npm run build          # make sure the build config compiles too
```
