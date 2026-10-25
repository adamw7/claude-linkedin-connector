# CLAUDE.md

An MCP connector for LinkedIn (profile, posts, media, comments, reactions, `Connections.csv` search) in
TypeScript on Node.js 24. One code base, two modes: **local** (`stdio`, token file on disk) and **remote**
(`http`, Express, stateless, OAuth 2.1 authorization server; the LinkedIn token is sealed inside the access
token with `SERVER_SECRET`). User docs: `README.md`, `docs/usage.md`, `docs/deployment.md` (remote mode in
production). Contributors: `docs/development.md` (tests, releasing). Design: `docs/architecture.md`.

## Commands

```bash
npm run check        # typecheck + tests: run before every push (there is no separate linter)
npm run typecheck    # tsc over src and test
npm test             # vitest; one file: npx vitest run test/text.test.ts
npm run build        # tsc -p tsconfig.build.json -> dist/
npm run test:mutation  # Stryker; slow, CI runs it incrementally
npm run pack:mcpb    # bundle the Claude Desktop extension
docker build -t connector . && scripts/smoke-test-image.sh connector  # the remote image; CI runs both
node scripts/smoke-test-package.mjs  # packs, installs and runs the npm package; CI runs it
npm audit --omit=dev --audit-level=high  # known vulnerabilities in what ships; the Audit workflow runs it daily, Release before publishing
node scripts/live-test.mjs  # dist/ against the real LinkedIn API; read-only without options, as CI runs it weekly; options by hand (see docs/development.md)
```

## Layout and layering

Each layer imports only from layers below it; `test/architecture.test.ts` enforces this.

| Layer | Path | Rule |
|---|---|---|
| Leaf | `src/errors.ts`, `src/version.ts`, `src/html.ts`, `src/paths.ts`, `src/json.ts` | No project imports |
| Network | `src/net/` | `safeFetch` refuses private/loopback addresses; no LinkedIn or MCP knowledge |
| LinkedIn | `src/linkedin/` | REST + OAuth clients; the only code that may call the global `fetch` |
| Auth, config | `src/auth/`, `src/config.ts` | Local sign-in, token storage, `LINKEDIN_*` env vars |
| MCP | `src/mcp/` | Tools (`server.ts`), transport agnostic |
| Remote | `src/remote/` | The only code that may use Express; never uses local token storage |
| Composition root | `src/index.ts` | CLI; imported by nothing |

## Conventions

- Tools are named `linkedin_<verb>_<noun>`; tools needing extra scopes are only registered when the scope is
  configured. See `.claude/skills/add-linkedin-tool/SKILL.md` before adding or changing a tool.
- User-written text sent to LinkedIn goes through `escapeLittleText` (`src/linkedin/text.ts`).
- Errors the user can fix are `UserInputError`; their message reaches Claude verbatim, so write it for the user.
- Security is load-bearing: third-party URLs go through `safeFetch`; local files are read only from
  `LINKEDIN_FILE_DIRS` (never in remote mode); media is checked by content, not extension.
- Logging: only `src/index.ts` writes to the console (stdout is the MCP protocol in stdio mode; diagnostics go to
  stderr); other modules take an injected `Logger` or `warn` callback. Remote log events are snake_case string
  literals with object-literal fields, listed in the `docs/deployment.md` Monitoring table, and never carry
  tokens, codes, query strings, bodies or post text. `test/logging.test.ts` enforces this.
- Tests run against `test/helpers/fake-linkedin.ts` (an in-memory LinkedIn used as `fetch`), never the real API.
  Assert exact request bodies and messages so mutation testing passes.
- ESM with `.js` import suffixes, `strict` + `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (use `import type`).
- A non-draft pull request from this repository squash-merges itself once its head is green
  (`.github/workflows/automerge.yml`, `docs/development.md`); open it as a draft or label it `no-automerge` to keep it
  open.
- Every user-visible change gets a `CHANGELOG.md` entry under `## [Unreleased]`, written for users.
  The version lives in `package.json`, `package-lock.json`, `src/version.ts` and `mcpb/manifest.json`; `test/release.test.ts`
  keeps them in sync.
