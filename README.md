# claude-linkedin-connector

An unofficial [Model Context Protocol](https://modelcontextprotocol.io) connector that lets Claude work with
your LinkedIn account: read your profile, publish posts (text, link previews, images, PDF/Office carousels),
edit and delete them, and, with extra LinkedIn API access, comment, react and post as a LinkedIn Page.

**New here?** The [usage guide](docs/usage.md) walks through installing, signing in and example requests,
with screenshots.

It runs two ways:

| | **Local** (`stdio`) | **Remote** (`http`) |
|---|---|---|
| Works with | Claude Desktop, Claude Code | Claude on the web, desktop and mobile ("custom connector"), Claude Code |
| Sign-in | Browser sign-in on your computer; token stored in your user profile | Claude's built-in connector sign-in (OAuth) |
| Hosting | None | A server with a public HTTPS URL |

## Tools

| Tool | What it does | Needs |
|---|---|---|
| `linkedin_get_profile` | Your name, email, photo, locale and member URN | default scopes |
| `linkedin_read_connections` | Searches your connections in LinkedIn's data export (the zip archive or its `Connections.csv`) | nothing: no sign-in |
| `linkedin_preview_post` | Checks a post before publishing: loads its attachments, shows the link preview card it will get, and warns about Markdown and `@mentions` | nothing: no sign-in |
| `linkedin_create_post` | Publishes a post: text plus optionally **one** of a link preview, 1–20 images, or a document (PDF, PPT(X), DOC(X)) | default scopes |
| `linkedin_edit_post` | Replaces the text of a post you authored (by URN or URL) | default scopes |
| `linkedin_delete_post` | Deletes a post you authored (by URN or URL) | default scopes |
| `linkedin_list_posts` | Lists the posts published from Claude on this computer, with their text, so later conversations can edit or delete them (local mode only) | nothing: no sign-in |
| `linkedin_comment_on_post` | Comments on a post | `LINKEDIN_COMMENTS` or `LINKEDIN_PAGES` |
| `linkedin_react_to_post` | Like, celebrate, support, love, insightful or funny | `LINKEDIN_COMMENTS` or `LINKEDIN_PAGES` |
| `linkedin_auth_status` | Shows whether LinkedIn is connected, as whom and until when | |
| `linkedin_login` | Opens LinkedIn's sign-in page in your browser and waits for you to approve (local mode only) | |
| `linkedin_logout` | Deletes the stored token (local mode only) | |

With `LINKEDIN_PAGES` on, posting, commenting and reacting also accept an `organization` argument to act as a
LinkedIn Page you administer. Tools for features you haven't turned on are not offered to Claude.

The connector tells Claude to show you the exact text and get your approval before publishing, editing,
commenting or deleting, and Claude also asks you to confirm each call. Before you approve a post, Claude checks
it with `linkedin_preview_post`, so a missing file, an unsupported format or a link preview without an image
shows up while you can still fix it. A few things it handles for you:

- **Text formatting.** LinkedIn treats characters such as `( ) [ ] * _ @ #` as markup and can silently cut a
  post off at the first one. The connector escapes them, keeping `#hashtags` clickable.
- **Link previews.** LinkedIn's API doesn't build previews itself, so the connector reads the page's title,
  description and image and uploads them with the link. If the page has no usable title or image, the preview
  says so and you can supply your own.
- **Media.** Images and documents can be local file paths (local mode), `http(s)` URLs or base64 `data:` URIs.
  Local files (including `Connections.csv`) are only read from your Downloads, Desktop and Pictures folders
  (also the ones OneDrive keeps on Windows) and the server's working directory (unless that is your home
  directory or above it), so a page or document Claude reads can't get it to post other files on your
  computer. Set `LINKEDIN_FILE_DIRS` to change this.
  Files are checked by content, so only real images and documents are ever uploaded. If a file is a format
  LinkedIn doesn't take, such as an iPhone HEIC photo, a WebP image, a video or a Keynote file, or a link leads to
  a web page rather than the file, the connector says so and what to do instead.
- **Connections.** LinkedIn's API doesn't give apps your list of connections, so the connector reads the
  `Connections.csv` from your data export instead: on LinkedIn, open **Settings → Data privacy → Get a copy
  of your data**, choose **Connections**, and save the zip archive LinkedIn emails you. In local mode, just ask:
  the connector finds the newest export in your Downloads, Desktop and Pictures folders, zipped or extracted.
  You can also pass the archive's or `Connections.csv`'s path, a URL, or attach or paste the CSV. Claude can
  search it by name, company (one or several, e.g. everyone at xyz or abc), position or connection date, and
  count how many connections you have at each company. Matching ignores case and accents, so "Lodz" finds "Łódź". Email addresses appear
  only for connections who allow it.
- **Your posts.** LinkedIn's API doesn't let apps read your posts, so in local mode the connector remembers the
  last 100 it published (their link and text, kept with the sign-in token). "Fix the typo in my post about the
  launch" or "delete yesterday's post" then works in a new conversation too.
- **API versions.** LinkedIn retires each monthly API version after about a year. When that happens the
  connector switches to the newest live version automatically.

## 1. Create a LinkedIn app

1. Go to [linkedin.com/developers/apps](https://www.linkedin.com/developers/apps) and choose **Create app**.
   LinkedIn requires associating the app with a LinkedIn Page; any Page you administer works. If LinkedIn
   asks you to verify the app, follow its instructions.
2. On the **Products** tab, add **Sign In with LinkedIn using OpenID Connect** and **Share on LinkedIn**.
   Both are self-serve and approved immediately.
3. On the **Auth** tab, note the **Client ID** and **Primary Client Secret**, and add an
   **Authorized redirect URL**:
   - local mode: `http://localhost:8723/callback`
   - remote mode: `https://<your-server>/oauth/callback`

Comments, reactions and Page posting need LinkedIn's **Community Management API** product, which LinkedIn
grants on application. If you get it, turn on **Comments and reactions** and/or **Post as LinkedIn Pages** in
the Claude Desktop extension's settings (`--comments` / `--pages` for `npm run setup`, or
`LINKEDIN_COMMENTS=true` / `LINKEDIN_PAGES=true`), then sign in again to grant the new permissions.

## 2a. Local setup (Claude Desktop, Claude Code)

Requires Node.js 24 or later.

```sh
git clone https://github.com/adamw7/claude-linkedin-connector.git
cd claude-linkedin-connector
npm ci          # also builds dist/
```

Alternatively, `npm install -g claude-linkedin-connector` installs a `claude-linkedin-connector` command from
[npm](https://www.npmjs.com/package/claude-linkedin-connector).

### Claude Desktop: install as an extension

Download `claude-linkedin-connector.mcpb` from the
[latest release](https://github.com/adamw7/claude-linkedin-connector/releases/latest), or build it from a
clone with `npm run pack:mcpb`. Double-click the file (or drag it onto Claude Desktop's
**Settings → Extensions** page) and enter your LinkedIn Client ID and Client Secret. The extension bundles
everything it needs, so no clone or `npm ci` is required.

### Claude Desktop: manual configuration

Open **Settings → Developer → Edit Config** and add:

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/claude-linkedin-connector/dist/index.js"],
      "env": {
        "LINKEDIN_CLIENT_ID": "your-client-id",
        "LINKEDIN_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

Use the full path of Node.js 24 or later (`which node`, or `where node` on Windows): Claude Desktop doesn't get
the `PATH` your shell sets up (with nvm, for example), so a bare `node` may not be found or may be too old.

### Claude Code

From the clone, run:

```sh
npm run setup
```

It asks for your Client ID and Client Secret (or reads `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET`),
installs dependencies and builds, registers the connector for all your projects with `claude mcp add`, and
signs you in to LinkedIn in your browser. Put `--` before its options, or npm keeps them for itself:
`npm run setup -- --help` lists them, such as `--scope local` to use the connector only in this directory,
`--comments` and `--pages` for the Community Management API features (running it again with new ones signs you in again to grant them)
and `--no-login` to sign in later.

To register it by hand instead:

```sh
claude mcp add linkedin --scope user \
  -e LINKEDIN_CLIENT_ID=your-client-id \
  -e LINKEDIN_CLIENT_SECRET=your-client-secret \
  -- node /absolute/path/to/claude-linkedin-connector/dist/index.js
```

### Sign in

Ask Claude to "connect my LinkedIn account", or just ask for something that needs LinkedIn. The connector opens
LinkedIn's sign-in page in your browser; approve access there and Claude carries on. If the page doesn't open
(for example over SSH), Claude gives you the link instead. You can also sign in from a terminal, with the same
environment variables set:

```sh
claude-linkedin-connector login     # or: node dist/index.js login
claude-linkedin-connector status
claude-linkedin-connector logout
```

The token is stored in `~/.config/claude-linkedin-connector/token.json` (`%APPDATA%\claude-linkedin-connector\`
on Windows), readable only by you. LinkedIn tokens last 60 days; after that, sign in again. The posts you publish
are remembered in `posts.json` next to it; delete that file to make the connector forget them.

To skip the sign-in flow, set `LINKEDIN_ACCESS_TOKEN` to a token you obtained elsewhere, for example from
LinkedIn's OAuth token generator in the developer portal.

## 2b. Remote setup (Claude custom connector)

Run the server somewhere with a public HTTPS URL. Releases after 0.1.0 publish a Docker image for amd64 and
arm64; you can also build one from a clone with `docker build -t claude-linkedin-connector .`:

```sh
openssl rand -base64 32   # once: the SERVER_SECRET that seals tokens; keep it with your other secrets
docker run -p 3000:3000 \
  -e LINKEDIN_CLIENT_ID=your-client-id \
  -e LINKEDIN_CLIENT_SECRET=your-client-secret \
  -e PUBLIC_URL=https://linkedin-mcp.example.com \
  -e SERVER_SECRET=your-generated-secret \
  -e LINKEDIN_ALLOWED_MEMBERS=you@example.com \
  -e TRUST_PROXY=1 \
  ghcr.io/adamw7/claude-linkedin-connector:latest
```

Without Docker, set the same variables and run `HOST=0.0.0.0 node dist/index.js http`.
The [deployment guide](docs/deployment.md) has a production checklist and ready-made setups: Docker Compose with
automatic HTTPS, Kubernetes, and other container platforms.
Put it behind a TLS-terminating proxy (ideally accepting TLS 1.3 only) or use a platform that provides HTTPS, and set `TRUST_PROXY` to the
number of proxies in front of it so rate limits and logs see real client addresses.
`LINKEDIN_ALLOWED_MEMBERS` is required: list the LinkedIn emails or member IDs that may connect, or set
it to `*` to let anyone use your LinkedIn app. An email only matches if the account has verified it on
LinkedIn. `SERVER_SECRET` is required too: generate it once and keep it, since changing it disconnects everyone
(see [rotating it](docs/deployment.md#rotating-server_secret) to change it without that). Then:

1. Add `https://linkedin-mcp.example.com/oauth/callback` to your LinkedIn app's authorized redirect URLs.
2. In Claude, open **Settings → Connectors → Add custom connector** and enter
   `https://linkedin-mcp.example.com/mcp`. On Team and Enterprise plans an owner may need to add it for the
   organization.
3. Click **Connect**. You'll see the connector's consent screen, then LinkedIn's.

In Claude Code: `claude mcp add --transport http linkedin https://linkedin-mcp.example.com/mcp`, then run
`/mcp` to sign in.

To try it locally, set the LinkedIn variables, run `PUBLIC_URL=http://localhost:3000 node dist/index.js http`
(with a localhost `PUBLIC_URL`, anyone may connect unless you set `LINKEDIN_ALLOWED_MEMBERS`)
and point an MCP client at `http://localhost:3000/mcp`, or expose it through an HTTPS tunnel and use the
tunnel's URL as `PUBLIC_URL`.

### How the remote server handles sign-in

The server is its own small OAuth 2.1 authorization server, which is what Claude expects from a custom
connector, and delegates the actual sign-in to LinkedIn:

- Claude registers itself through dynamic client registration (or a client ID metadata document), then
  sends you to `/authorize`, which shows a consent screen naming the application and where it will redirect.
- After you approve, LinkedIn asks you to sign in. The server receives LinkedIn's token, encrypts it with
  `SERVER_SECRET` (AES-256-GCM) inside the access token it issues to Claude, and never stores it.
- Codes require PKCE (S256), expire after 5 minutes and are single-use (tracked per server instance). Access tokens are bound to the
  `/mcp` resource and expire with the LinkedIn token (at most 60 days), after which Claude asks you to reconnect.
- By default only Claude's callback URLs and localhost redirects may register, and only the LinkedIn accounts
  in `LINKEDIN_ALLOWED_MEMBERS` can finish connecting. The list is checked on every request too, so removing
  someone (and restarting) cuts off the tokens they already have.

The server keeps no database, so it can be restarted or scaled freely as long as `SERVER_SECRET` stays the
same. Changing the secret disconnects everyone, unless the old one stays in `SERVER_SECRET_PREVIOUS` for a while.

### Operating the remote server

- **Logs.** The server writes one JSON object per line to stderr: every request (method, path, status,
  duration, client IP), sign-ins (`member_authorized`, `member_not_allowed`), every tool call with the
  member who made it and whether it succeeded (`tool_call`), and server errors with stack traces. Each response
  has an `X-Request-Id` (your proxy's, if it sends one) that appears in the entries for that request. Query
  strings, request bodies, tokens and post text are never logged.
  The [deployment guide](docs/deployment.md#monitoring) lists every event.
- **Rate limits.** The OAuth endpoints allow `RATE_LIMIT_OAUTH` requests per minute per client IP, and
  `/mcp` allows `RATE_LIMIT_MCP` per connected LinkedIn account; over the limit the server answers `429`
  with `Retry-After`. Counts are kept in memory per instance, so with several replicas each one counts
  separately. Behind a proxy, set `TRUST_PROXY`, or every client shares the proxy's address and limit.
- **Shutdown.** On `SIGTERM` or `SIGINT` the server stops accepting connections and lets in-flight requests
  (uploads and posts can take a while) finish for up to `SHUTDOWN_TIMEOUT` seconds before cancelling them.
  Keep it below your platform's grace period (10 seconds for `docker stop`).
- **Health checks.** `GET /healthz` answers `{"status":"ok"}` whatever the `Host` header, so load balancer and
  Kubernetes probes work with `ALLOWED_HOSTS` set. The Docker image has a `HEALTHCHECK` built in.
- **Keep-alive.** Idle connections stay open for `KEEP_ALIVE_TIMEOUT` seconds (65). Keep it above your proxy's
  upstream idle timeout, or the proxy reuses connections the server is closing and some requests fail with 502.

## Configuration

| Variable | Mode | Default | Description |
|---|---|---|---|
| `LINKEDIN_CLIENT_ID` | both | | LinkedIn app Client ID (required, except with `LINKEDIN_ACCESS_TOKEN`) |
| `LINKEDIN_CLIENT_SECRET` | both | | LinkedIn app Primary Client Secret |
| `LINKEDIN_COMMENTS` | both | `false` | `true` to comment on and react to posts (adds the `w_member_social_feed` scope; needs the Community Management API) |
| `LINKEDIN_PAGES` | both | `false` | `true` to post, comment and react as LinkedIn Pages you administer (adds `w_organization_social`; needs the Community Management API) |
| `LINKEDIN_SCOPES` | both | `openid profile email w_member_social` | Permissions to request; also decides which tools are offered. `LINKEDIN_COMMENTS` and `LINKEDIN_PAGES` add to it |
| `LINKEDIN_API_VERSION` | both | `202609` | `LinkedIn-Version` header (YYYYMM); replaced automatically if LinkedIn retires it |
| `LINKEDIN_REDIRECT_URI` | local | `http://localhost:8723/callback` | Sign-in callback; must match the LinkedIn app exactly |
| `LINKEDIN_TOKEN_FILE` | local | per-user config dir | Where the token is stored |
| `LINKEDIN_ACCESS_TOKEN` | local | | Use this token instead of signing in |
| `LINKEDIN_FILE_DIRS` | local | `~/Downloads`, `~/Desktop`, `~/Pictures`, working directory | Comma-separated folders local images, documents and `Connections.csv` may be read from (symlinks out of them are refused) |
| `PUBLIC_URL` | remote | | Public origin, e.g. `https://linkedin-mcp.example.com` (required) |
| `SERVER_SECRET` | remote | | At least 32 characters; keep it the same across restarts and replicas. Required unless `PUBLIC_URL` is localhost, where a random one is used |
| `SERVER_SECRET_PREVIOUS` | remote | | The secret used before `SERVER_SECRET`, still accepted for tokens issued with it, while [rotating](docs/deployment.md#rotating-server_secret) |
| `HOST` / `PORT` | remote | `127.0.0.1` / `3000` | Listen address (the Docker image uses `0.0.0.0`) |
| `LINKEDIN_ALLOWED_MEMBERS` | remote | | Comma-separated emails or member IDs allowed to connect, or `*` for anyone. Required unless `PUBLIC_URL` is localhost |
| `OAUTH_ALLOWED_REDIRECT_URIS` | remote | Claude + `loopback` | Exact URIs, path prefixes like `https://host/path/*`, `loopback`, or `*` |
| `ALLOWED_HOSTS` | remote | | Reject requests whose `Host` header isn't listed |
| `TRUST_PROXY` | remote | `false` | Trust `X-Forwarded-For` from proxies: a hop count, `true`, or subnets such as `loopback, 10.0.0.0/8` |
| `RATE_LIMIT_OAUTH` | remote | `60` | Requests per minute per client IP to the OAuth endpoints; `0` disables |
| `RATE_LIMIT_MCP` | remote | `120` | Requests per minute per connected account to `/mcp`; `0` disables |
| `SHUTDOWN_TIMEOUT` | remote | `8` | Seconds to let in-flight requests finish on shutdown |
| `KEEP_ALIVE_TIMEOUT` | remote | `65` | Seconds idle connections stay open; keep it above your proxy's upstream idle timeout |

`LINKEDIN_CLIENT_SECRET`, `SERVER_SECRET` and `SERVER_SECRET_PREVIOUS` can also be read from a file, as Docker
and Kubernetes secrets are mounted: set `LINKEDIN_CLIENT_SECRET_FILE` (and so on) to its path instead.

See [`.env.example`](.env.example) for a template.

## Limitations

- LinkedIn only lets ordinary apps **write**. Reading your feed, your past posts, or other people's
  profiles requires partner-level access, so the connector can't do it. In local mode it remembers the posts it
  published itself; posts made on linkedin.com or in remote mode aren't among them.
- Only a post's text can be edited; attachments can't be changed after publishing. Video posts aren't supported yet.
- A post can have one kind of attachment: a link preview, images, or a document.
- In remote mode, media sent as `data:` URIs is limited to about 20 MB per request; pass larger files as URLs.
- LinkedIn applies daily rate limits per member and per app.
- Posts are plain text. LinkedIn doesn't render Markdown; line breaks and `#hashtags` work. `@mentions` show as
  plain text and don't tag anyone.

## Troubleshooting

| Problem | Fix |
|---|---|
| LinkedIn says the redirect URI doesn't match | Add the exact callback URL (scheme, host, port, path) to the app's **Auth** tab |
| `Port 8723 is already in use` | Set `LINKEDIN_REDIRECT_URI` to another localhost port and register it in the app |
| `invalid_client: Client authentication failed` when signing in | The Client ID or Client Secret is wrong, or the secret was regenerated: copy both again from the app's **Auth** tab |
| `LinkedIn denied permission` (403) | The app lacks the product for that feature, or you signed in before adding the scope. Fix the app, then sign in again |
| A file `is outside the folders this connector may read files from` | Move it to Downloads, Desktop or Pictures, or add its folder to `LINKEDIN_FILE_DIRS` (**Folders for local files** in the Claude Desktop extension's settings) |
| Editing or deleting a post fails with `not the activity URN` | Links copied from linkedin.com often point to the post's activity rather than the post. In local mode, ask Claude to find the post among the ones it published; otherwise use the URL Claude gave you when publishing, or the code from the post's **Embed this post** menu item |
| `access token … expired or been revoked` | Sign in again (local) or reconnect the connector (remote) |
| Remote connection fails after a restart | Set a fixed `SERVER_SECRET` |
| `SERVER_SECRET is required` on startup | Generate one with `openssl rand -base64 32`, store it with your other secrets and keep it |
| `LINKEDIN_ALLOWED_MEMBERS is required` on startup | List who may connect, or set it to `*` to allow anyone |
| Some requests fail with `502` behind a proxy or load balancer | Set `KEEP_ALIVE_TIMEOUT` above the proxy's upstream idle timeout (e.g. `620` on Google Cloud) |
| `Too many requests` (429) for everyone at once | The server is behind a proxy without `TRUST_PROXY`, so all clients share one address |

## Development

```sh
npm ci
npm run check          # typecheck + tests
npm run test:coverage  # tests with a coverage report in coverage/
npm run test:mutation  # Stryker mutation tests, report in reports/mutation/ (slow)
npm run build          # dist/
npm run bundle         # single-file build for the .mcpb
```

```
src/
  index.ts            CLI: stdio | http | login | logout | status
  config.ts           environment variables
  mcp/server.ts       MCP tools
  linkedin/           REST client, OAuth, text escaping, media, link previews, API versions, Connections.csv
  auth/               local token storage, post history and browser sign-in
  remote/             HTTP app, OAuth authorization server, client registration, logging, rate limits
  net/safe-fetch.ts   fetching URLs without reaching private networks
```

See [`docs/architecture.md`](docs/architecture.md) for C4 diagrams (context, containers, components).

Tests run against an in-memory fake of LinkedIn, including an end-to-end OAuth flow driven by the
official MCP client SDK. `test/architecture.test.ts` uses [ArchUnitTS](https://github.com/LukasNiessen/ArchUnitTS)
to keep the module layering above in place: no import cycles, `linkedin/` and `net/` know nothing of MCP
or sign-in, `mcp/` doesn't depend on the HTTP transport, and remote mode never touches local token storage.
CI reports coverage on every push and pull request; mutation tests run
nightly (and on demand) in the `Mutation tests` workflow.

### Releasing

1. Set the new version in `package.json` (`npm version --no-git-tag-version <version>` also updates
   `package-lock.json`), `mcpb/manifest.json` and `src/version.ts`; a test fails if they disagree.
2. Move the `Unreleased` notes in [`CHANGELOG.md`](CHANGELOG.md) under a `## [<version>] - <date>` heading.
3. Merge to `main`, then tag and push: `git tag v<version> && git push origin v<version>`.

The `Release` workflow checks the tag against the version, runs the tests, builds the `.mcpb` and publishes
a GitHub release with it attached and the changelog entry as notes. It then smoke tests the Docker image
(`scripts/smoke-test-image.sh`, which CI also runs) and pushes it for amd64 and arm64 to
`ghcr.io/adamw7/claude-linkedin-connector` as `<version>`, `<major.minor>` and `latest`. After the first push,
make the package public in its settings on GitHub (packages start out private), so `docker pull` works without
signing in.

Dependabot proposes dependency, GitHub Actions and base image updates weekly. Report vulnerabilities as described
in [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE)

---

Not affiliated with, endorsed by, or sponsored by LinkedIn. LinkedIn is a trademark of LinkedIn Corporation.
