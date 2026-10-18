# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- The README is shorter and starts with a three-step quick start for Claude Desktop, Claude Code and Claude on
  the web. Details moved to the guides: what the connector does with files and connections to the
  [usage guide](docs/usage.md), how remote sign-in and rate limits work to the
  [deployment guide](docs/deployment.md), and development and releasing to [docs/development.md](docs/development.md).

### Fixed

- Asking to post, comment or react as a LinkedIn Page when posting as Pages isn't turned on now fails with an
  explanation. Before, the Page was ignored and the post, comment or reaction went out as you. The tools that
  publish now also refuse other arguments they don't know, such as a mistyped one, instead of ignoring them.
- A malformed request to the page the connector opens on your computer while you sign in to LinkedIn no longer
  crashes the connector.
- A link or image URL that redirects to an invalid address, and a `file://` URL that names no file on your computer
  (such as one on a network share), now get an explanation instead of "Unexpected error".
- Stack traces from the npm package can be mapped back to the TypeScript source: its source maps now carry the
  source they point to, which the package doesn't include.

## [0.3.0] - 2026-10-18

### Added

- The connector is published to npm: `npm install -g claude-linkedin-connector` installs the
  `claude-linkedin-connector` command without cloning the repository.
- Signing in no longer needs a round trip through the chat. In Claude Desktop and Claude Code the connector opens
  LinkedIn's sign-in page in your browser and notices when you've approved, so you don't have to tell Claude
  you're done. Asking for something that needs LinkedIn before signing in starts the sign-in too. If the page
  can't be opened, for example over SSH, Claude gives you the link as before.
- `linkedin_read_connections` reads the zip archive LinkedIn emails you, so there's nothing to unzip. In local
  mode it also finds the newest export in your Downloads, Desktop and Pictures folders by itself, so "who do I
  know at Acme?" works without a file path.
- Comments, reactions and Page posting are now switched on with yes/no settings instead of LinkedIn scope names:
  **Comments and reactions** and **Post as LinkedIn Pages** in the Claude Desktop extension, `--comments` and
  `--pages` for `npm run setup`, or `LINKEDIN_COMMENTS=true` and `LINKEDIN_PAGES=true`. `LINKEDIN_SCOPES` still
  works. If you had added scopes in the extension's old **Scopes** setting, tick the matching boxes instead.

- `linkedin_list_posts` (local mode) lists the last 100 posts published from Claude on this computer, with their
  text. LinkedIn doesn't let apps read your posts, so until now a post from an earlier conversation could only
  be edited or deleted with a link you had kept, and fixing a typo meant pasting the whole text back. Now "fix
  the typo in my post about the launch" works in any conversation. The posts are kept in `posts.json` next to the
  sign-in token; delete it to make the connector forget them.
- `linkedin_preview_post` checks a post without publishing it, and Claude uses it before asking for your
  approval: it loads the images or document, so a wrong path or format shows up before you approve rather than
  after, shows the link preview card a link will get, and warns when the card would have no title or image, or
  when the text has Markdown or `@mentions` that LinkedIn would show literally.
- Each release publishes a Docker image of the remote server for amd64 and arm64 at
  `ghcr.io/adamw7/claude-linkedin-connector`, with an SBOM and build provenance. The image has a health check,
  runs as the unprivileged user 1000 (so Kubernetes' `runAsNonRoot` accepts it) and works with a read-only root
  file system.
- A [deployment guide](docs/deployment.md) for the remote server: a production checklist, a Docker Compose setup
  with automatic HTTPS in `deploy/`, a Kubernetes example, secret rotation, the log events and what to alert on.
- `SERVER_SECRET_PREVIOUS` rotates `SERVER_SECRET` without disconnecting anyone: tokens and client registrations
  issued with the previous secret keep working while it is set.
- `LINKEDIN_CLIENT_SECRET_FILE`, `SERVER_SECRET_FILE` and `SERVER_SECRET_PREVIOUS_FILE` read those secrets from a
  file, as Docker and Kubernetes secrets are mounted.
- Every remote server response carries an `X-Request-Id` (the proxy's, if it sends one), which is also logged
  with the request, its tool calls and server errors.
- [`SECURITY.md`](SECURITY.md) explains how to report vulnerabilities privately.

### Changed

- When an image or document isn't a format LinkedIn accepts, the error says what it is and what to do: convert
  an iPhone HEIC photo, a WebP, AVIF, TIFF, BMP or SVG image to JPEG or PNG; export a Keynote, Pages, Numbers,
  OpenDocument or Excel file as PDF; extract the file from a zip archive; attach a PDF as the document rather
  than an image (and vice versa). Videos are named as such, and a link that leads to a web page rather than the
  file (such as a cloud drive share link) is explained instead of reported as "not a JPEG, PNG or GIF image".
  A long path in these errors keeps its file name instead of being cut off before it.
- The remote server refuses to start without `SERVER_SECRET` unless `PUBLIC_URL` is localhost. The random secret
  it used instead changed with every restart and differed between replicas, so connections broke seemingly at
  random.
- Document posts are titled after the file name without its extension ("Q3 results", not "Q3 results.pdf")
  unless a title is given.
- The CLI refuses options a command doesn't take instead of ignoring them, and `status` exits with 1 when the
  sign-in predates scopes added to `LINKEDIN_SCOPES`.

### Fixed

- A post with a large document, or one LinkedIn was slow to process, could still be published after Claude had
  stopped waiting and reported a failure, so asking again posted it twice. The connector now stops waiting for
  LinkedIn to process uploads 45 seconds after the post was asked for, and if a post still times out, Claude
  checks whether it went out (with `linkedin_list_posts` in local mode, otherwise by asking you) before trying
  again.
- `/healthz` answers whatever the `Host` header. With `ALLOWED_HOSTS` set, load balancer and Kubernetes health
  checks, which use the server's IP address, got `403` and took the server out of service.
- Behind a proxy or load balancer that keeps idle connections longer than 5 seconds (AWS load balancers keep them
  for 60), some requests failed with `502`: the server closed idle connections after Node.js's default 5 seconds,
  just as the proxy reused them. It now keeps them for `KEEP_ALIVE_TIMEOUT` seconds, 65 by default.
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

- The connector only connects over TLS 1.3 or newer, for LinkedIn and for the links, images and documents it
  fetches. A website that only supports older TLS versions can no longer be used for link previews or as a
  source of images and documents. The Docker Compose setup in `deploy/` now accepts TLS 1.3 only too, and the
  [deployment guide](docs/deployment.md) explains how to do the same with other proxies.
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

[Unreleased]: https://github.com/adamw7/claude-linkedin-connector/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/adamw7/claude-linkedin-connector/compare/v0.1.0...v0.3.0
[0.1.0]: https://github.com/adamw7/claude-linkedin-connector/releases/tag/v0.1.0
