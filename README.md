# claude-linkedin-connector

An unofficial [Model Context Protocol](https://modelcontextprotocol.io) connector that lets Claude work with
your LinkedIn account: read your profile, publish posts (text, link previews, images, PDF/Office carousels),
edit and delete them, and, with extra LinkedIn API access, comment, react and post as a LinkedIn Page.

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
| `linkedin_create_post` | Publishes a post: text plus optionally **one** of a link preview, 1–20 images, or a document (PDF, PPT(X), DOC(X)) | default scopes |
| `linkedin_edit_post` | Replaces the text of a post you authored (by URN or URL) | default scopes |
| `linkedin_delete_post` | Deletes a post you authored (by URN or URL) | default scopes |
| `linkedin_comment_on_post` | Comments on a post | `w_member_social_feed` or `w_organization_social` |
| `linkedin_react_to_post` | Like, celebrate, support, love, insightful or funny | `w_member_social_feed` or `w_organization_social` |
| `linkedin_auth_status` | Shows whether LinkedIn is connected, as whom and until when | |
| `linkedin_login` | Returns a sign-in link (local mode only) | |
| `linkedin_logout` | Deletes the stored token (local mode only) | |

With the `w_organization_social` scope, posting, commenting and reacting also accept an `organization`
argument to act as a LinkedIn Page you administer. Tools whose scopes you haven't configured are not offered to Claude.

The connector tells Claude to show you the exact text and get your approval before publishing, editing,
commenting or deleting, and Claude also asks you to confirm each call. A few things it handles for you:

- **Text formatting.** LinkedIn treats characters such as `( ) [ ] * _ @ #` as markup and can silently cut a
  post off at the first one. The connector escapes them, keeping `#hashtags` clickable.
- **Link previews.** LinkedIn's API doesn't build previews itself, so the connector reads the page's title,
  description and image and uploads them with the link.
- **Media.** Images and documents can be local file paths (local mode), `http(s)` URLs or base64 `data:` URIs.
  Files are checked by content, so only real images and documents are ever uploaded.
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
grants on application. If you get it, add `w_member_social_feed` and/or `w_organization_social` to
`LINKEDIN_SCOPES`.

## 2a. Local setup (Claude Desktop, Claude Code)

Requires Node.js 24 or later.

```sh
git clone https://github.com/adamw7/claude-linkedin-connector.git
cd claude-linkedin-connector
npm ci          # also builds dist/
```

Alternatively, `npm install -g github:adamw7/claude-linkedin-connector` installs a
`claude-linkedin-connector` command.

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
      "command": "node",
      "args": ["/absolute/path/to/claude-linkedin-connector/dist/index.js"],
      "env": {
        "LINKEDIN_CLIENT_ID": "your-client-id",
        "LINKEDIN_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

### Claude Code

```sh
claude mcp add linkedin --scope user \
  -e LINKEDIN_CLIENT_ID=your-client-id \
  -e LINKEDIN_CLIENT_SECRET=your-client-secret \
  -- node /absolute/path/to/claude-linkedin-connector/dist/index.js
```

### Sign in

Ask Claude to "connect my LinkedIn account". It calls `linkedin_login` and gives you a link; approve access
in your browser and tell Claude you're done. You can also sign in from a terminal, with the same environment
variables set:

```sh
claude-linkedin-connector login     # or: node dist/index.js login
claude-linkedin-connector status
claude-linkedin-connector logout
```

The token is stored in `~/.config/claude-linkedin-connector/token.json` (`%APPDATA%\claude-linkedin-connector\`
on Windows), readable only by you. LinkedIn tokens last 60 days; after that, sign in again.

To skip the sign-in flow, set `LINKEDIN_ACCESS_TOKEN` to a token you obtained elsewhere, for example from
LinkedIn's OAuth token generator in the developer portal.

## 2b. Remote setup (Claude custom connector)

Run the server somewhere with a public HTTPS URL:

```sh
docker build -t claude-linkedin-connector .
docker run -p 3000:3000 \
  -e LINKEDIN_CLIENT_ID=your-client-id \
  -e LINKEDIN_CLIENT_SECRET=your-client-secret \
  -e PUBLIC_URL=https://linkedin-mcp.example.com \
  -e SERVER_SECRET="$(openssl rand -base64 32)" \
  claude-linkedin-connector
```

Without Docker, set the same variables and run `HOST=0.0.0.0 node dist/index.js http`.
Put it behind a TLS-terminating proxy or use a platform that provides HTTPS. Then:

1. Add `https://linkedin-mcp.example.com/oauth/callback` to your LinkedIn app's authorized redirect URLs.
2. In Claude, open **Settings → Connectors → Add custom connector** and enter
   `https://linkedin-mcp.example.com/mcp`. On Team and Enterprise plans an owner may need to add it for the
   organization.
3. Click **Connect**. You'll see the connector's consent screen, then LinkedIn's.

In Claude Code: `claude mcp add --transport http linkedin https://linkedin-mcp.example.com/mcp`, then run
`/mcp` to sign in.

To try it locally, set the LinkedIn variables, run `PUBLIC_URL=http://localhost:3000 node dist/index.js http`
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
- By default only Claude's callback URLs and localhost redirects may register. Set `LINKEDIN_ALLOWED_MEMBERS`
  to restrict which LinkedIn accounts can connect.

The server keeps no database, so it can be restarted or scaled freely as long as `SERVER_SECRET` stays the
same. Changing the secret disconnects everyone.

## Configuration

| Variable | Mode | Default | Description |
|---|---|---|---|
| `LINKEDIN_CLIENT_ID` | both | | LinkedIn app Client ID (required, except with `LINKEDIN_ACCESS_TOKEN`) |
| `LINKEDIN_CLIENT_SECRET` | both | | LinkedIn app Primary Client Secret |
| `LINKEDIN_SCOPES` | both | `openid profile email w_member_social` | Permissions to request; also decides which tools are offered |
| `LINKEDIN_API_VERSION` | both | `202609` | `LinkedIn-Version` header (YYYYMM); replaced automatically if LinkedIn retires it |
| `LINKEDIN_REDIRECT_URI` | local | `http://localhost:8723/callback` | Sign-in callback; must match the LinkedIn app exactly |
| `LINKEDIN_TOKEN_FILE` | local | per-user config dir | Where the token is stored |
| `LINKEDIN_ACCESS_TOKEN` | local | | Use this token instead of signing in |
| `PUBLIC_URL` | remote | | Public origin, e.g. `https://linkedin-mcp.example.com` (required) |
| `SERVER_SECRET` | remote | random | At least 32 characters. If unset, connections break on every restart |
| `HOST` / `PORT` | remote | `127.0.0.1` / `3000` | Listen address (the Docker image uses `0.0.0.0`) |
| `LINKEDIN_ALLOWED_MEMBERS` | remote | anyone | Comma-separated emails or member IDs allowed to connect |
| `OAUTH_ALLOWED_REDIRECT_URIS` | remote | Claude + `loopback` | Exact URIs, path prefixes like `https://host/path/*`, `loopback`, or `*` |
| `ALLOWED_HOSTS` | remote | | Reject requests whose `Host` header isn't listed |

See [`.env.example`](.env.example) for a template.

## Limitations

- LinkedIn only lets ordinary apps **write**. Reading your feed, your past posts, or other people's
  profiles requires partner-level access, so the connector can't do it.
- Only a post's text can be edited; attachments can't be changed after publishing. Video posts aren't supported yet.
- A post can have one kind of attachment: a link preview, images, or a document.
- In remote mode, media sent as `data:` URIs is limited to about 20 MB per request; pass larger files as URLs.
- LinkedIn applies daily rate limits per member and per app.
- Posts are plain text. LinkedIn doesn't render Markdown; line breaks and `#hashtags` work.

## Troubleshooting

| Problem | Fix |
|---|---|
| LinkedIn says the redirect URI doesn't match | Add the exact callback URL (scheme, host, port, path) to the app's **Auth** tab |
| `Port 8723 is already in use` | Set `LINKEDIN_REDIRECT_URI` to another localhost port and register it in the app |
| `LinkedIn denied permission` (403) | The app lacks the product for that feature, or you signed in before adding the scope. Fix the app, then sign in again |
| `access token … expired or been revoked` | Sign in again (local) or reconnect the connector (remote) |
| Remote connection fails after a restart | Set a fixed `SERVER_SECRET` |

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
  linkedin/           REST client, OAuth, text escaping, media, link previews, API versions
  auth/               local token storage and browser sign-in
  remote/             HTTP app, OAuth authorization server, client registration
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
a GitHub release with it attached and the changelog entry as notes.

## License

[MIT](LICENSE)

---

Not affiliated with, endorsed by, or sponsored by LinkedIn. LinkedIn is a trademark of LinkedIn Corporation.
