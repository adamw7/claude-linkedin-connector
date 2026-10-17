# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Breaking:** the remote server now refuses to start without `LINKEDIN_ALLOWED_MEMBERS`. List the
  LinkedIn emails or member IDs allowed to connect, or set it to `*` to keep allowing anyone. Servers
  with a localhost `PUBLIC_URL` still allow anyone by default.
- The remote server logs JSON lines to stderr instead of plain text.

### Added

- `linkedin_read_connections` reads the `Connections.csv` from LinkedIn's data export (LinkedIn's API doesn't
  offer connections) and returns your connections newest first, filtered by text, company or connection
  date and paged. It needs no LinkedIn sign-in.
- Structured logs for the remote server: requests, sign-ins, an audit entry for every tool call (who,
  which tool, outcome) and server errors with stack traces. Tokens, codes and post text are never logged.
- Rate limits for the remote server: `RATE_LIMIT_OAUTH` per client IP on the OAuth endpoints and
  `RATE_LIMIT_MCP` per connected account on `/mcp`, plus `TRUST_PROXY` to see client IPs behind a proxy.

### Fixed

- The remote server now lets in-flight requests finish on `SIGTERM`/`SIGINT` (up to `SHUTDOWN_TIMEOUT`
  seconds) instead of exiting immediately and cutting off uploads and posts.

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

[Unreleased]: https://github.com/adamw7/claude-linkedin-connector/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/adamw7/claude-linkedin-connector/releases/tag/v0.1.0
