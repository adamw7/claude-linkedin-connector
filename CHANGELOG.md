# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Document posts are titled after the file name without its extension ("Q3 results", not "Q3 results.pdf")
  unless a title is given.
- The CLI refuses options a command doesn't take instead of ignoring them, and `status` exits with 1 when the
  sign-in predates scopes added to `LINKEDIN_SCOPES`.

### Fixed

- `--help` after a command shows the help instead of running the command: `logout --help` deleted the stored
  token, and `login --help` started a sign-in.
- After adding scopes to `LINKEDIN_SCOPES` (e.g. for comments), `linkedin_login` and re-running `npm run setup`
  sign in again to grant them, instead of reporting that you are already signed in. `linkedin_auth_status`
  lists them as `missingScopes`.
- When a browser sign-in fails (for example with a mistyped Client Secret), the tools tell Claude why, instead
  of only that you aren't signed in, and `invalid_client` errors say which settings to check.
- `npm run setup` notices options npm kept for itself because `--` was left out (`npm run setup --scope local`
  set up user scope), explains mistyped options instead of printing a stack trace, and says what to do when
  signing in fails.
- On Windows, local files are also read from the Desktop and Pictures folders OneDrive keeps, where
  screenshots land when OneDrive backs up those folders.
- Starting the server from a terminal says it is waiting for Claude instead of printing nothing.
- Editing or deleting a post by an activity URN, which links copied from linkedin.com often contain, explains
  how to get the post's own URN; the tools also accept the post's embed code.
- Post URLs of the form `linkedin.com/posts/…-ugcPost-<id>-…` are recognized by the edit, delete,
  comment and react tools.
- Media and `Connections.csv` URLs whose file name has a `%` that isn't an escape (e.g. `100%.png`)
  no longer fail with "URI malformed".
- `data:` URIs whose media type carries parameters (e.g. `data:text/csv;charset=utf-8;base64,…`) are
  accepted.
- Two `linkedin_login` calls at once share one sign-in instead of the second failing with "port already
  in use".
- `PUBLIC_URL=http://[::1]:<port>` is accepted for local testing, like `localhost` and `127.0.0.1`.

### Security

- In local mode, tools only read local files from `~/Downloads`, `~/Desktop`, `~/Pictures` and the working
  directory (unless it contains the home directory), or the folders listed in the new `LINKEDIN_FILE_DIRS`.
  Before, a prompt injection could get Claude to post any PDF, Office document or image on the computer.
- Fetching link previews and media also refuses the local-use NAT64 prefix `64:ff9b:1::/48`.
- The `mcpb` CLI used to build and validate releases is a locked dev dependency instead of whatever
  `npx @anthropic-ai/mcpb@2` resolved to.
- The remote server only reads request bodies after checking the bearer token (for `/mcp`) or the rate limit
  (OAuth endpoints, now capped at 64 KB). Before, anyone could make it buffer and parse 30 MB per request
  without signing in.
- Link preview parsing runs in linear time. A crafted page (e.g. one huge `<meta …>` tag) could block the
  server for minutes when someone shared a link to it.
- `LINKEDIN_ALLOWED_MEMBERS` matches emails only when LinkedIn reports them verified, and is checked on every
  request, so removing a member cuts off their existing tokens.

## [0.1.0] - 2026-10-17

First release.

### Added

- MCP tools to read your LinkedIn profile, publish posts (text, link previews, 1–20 images, or a
  PDF/PPT(X)/DOC(X) document), edit a post's text and delete posts.
- Commenting, reacting and posting as a LinkedIn Page, offered when the Community Management API
  scopes (`w_member_social_feed`, `w_organization_social`) are configured.
- Local `stdio` mode for Claude Desktop and Claude Code, with browser sign-in and per-user token
  storage, plus `login`, `logout` and `status` CLI commands.
- Remote `http` mode for Claude custom connectors: a stateless OAuth 2.1 authorization server with
  dynamic client registration, PKCE and LinkedIn tokens encrypted inside the issued access tokens.
- Claude Desktop extension (`.mcpb`) and a Dockerfile for the remote server.
- Escaping of LinkedIn's markup characters, link preview generation, content-checked media uploads
  and automatic fallback when LinkedIn retires an API version.
- `linkedin_read_connections` reads the `Connections.csv` from LinkedIn's data export (LinkedIn's API doesn't
  offer connections) and returns your connections newest first, filtered by text, company or connection
  date and paged. It matches regardless of case and accents ("Lodz" finds "Łódź"), filters by several
  companies at once, and can count connections per company. It needs no LinkedIn sign-in.
- `npm run setup` sets the connector up in Claude Code in one command: it builds, registers the server
  with `claude mcp add` and signs you in to LinkedIn.
- For the remote server: `LINKEDIN_ALLOWED_MEMBERS` lists the LinkedIn accounts allowed to connect (`*`
  for anyone; required unless `PUBLIC_URL` is localhost); structured JSON logs on stderr, with an audit
  entry for every tool call and no tokens, codes or post text; rate limits (`RATE_LIMIT_OAUTH` per client
  IP, `RATE_LIMIT_MCP` per connected account, `TRUST_PROXY` to see client IPs behind a proxy); and a
  graceful shutdown that lets in-flight requests finish for up to `SHUTDOWN_TIMEOUT` seconds.

[Unreleased]: https://github.com/adamw7/claude-linkedin-connector/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/adamw7/claude-linkedin-connector/releases/tag/v0.1.0
