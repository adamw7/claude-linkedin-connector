# claude-linkedin-connector

An unofficial [Model Context Protocol](https://modelcontextprotocol.io) connector that lets Claude work with
your LinkedIn account: read your profile, search your connections, publish posts (text, link previews, images,
PDF/Office carousels), edit and delete them, and, with extra LinkedIn API access, comment, react and post as a
LinkedIn Page.

## Quick start

**1. Create a LinkedIn app** (once, about five minutes):

1. At [linkedin.com/developers/apps](https://www.linkedin.com/developers/apps), choose **Create app**. LinkedIn
   asks you to associate it with a LinkedIn Page; any Page you administer works.
2. On the **Products** tab, add **Sign In with LinkedIn using OpenID Connect** and **Share on LinkedIn**. Both
   are approved immediately.
3. On the **Auth** tab, add the redirect URL `http://localhost:8723/callback` (for a remote server:
   `https://<your-server>/oauth/callback`), and copy the **Client ID** and **Primary Client Secret**.

**2. Install the connector** in the Claude you use:

| You use | Do this |
|---|---|
| **Claude Desktop** | Download `claude-linkedin-connector.mcpb` from the [latest release](https://github.com/adamw7/claude-linkedin-connector/releases/latest), double-click it and enter the Client ID and Client Secret. |
| **Claude Code** | With Node.js 24 or later: `git clone https://github.com/adamw7/claude-linkedin-connector.git && cd claude-linkedin-connector && npm run setup`. It asks for the Client ID and Client Secret, registers the connector and signs you in. |
| **Claude on the web or mobile** | Run the remote server on a host with HTTPS; see [Remote server](#remote-server). |

**3. Ask Claude**, for example "Connect my LinkedIn account", then "Draft a LinkedIn post announcing our 2.0
release" or "Who do I know at Acme?". LinkedIn's sign-in page opens in your browser the first time.

The [usage guide](docs/usage.md) walks through this with screenshots, lists more requests to try and explains
what to expect when posting.

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

Claude shows you the exact text and asks for your approval before publishing, editing, commenting or deleting.

**Comments, reactions and posting as a Page** need LinkedIn's **Community Management API** product, which
LinkedIn grants on application. If you get it, turn on **Comments and reactions** and/or **Post as LinkedIn
Pages** in the Claude Desktop extension's settings (`--comments` / `--pages` for `npm run setup`, or
`LINKEDIN_COMMENTS=true` / `LINKEDIN_PAGES=true`), then sign in again; until LinkedIn grants the product, signing
in with them turned on fails. Posting, commenting and reacting then also accept an `organization` argument to act
as a Page you're a super admin or content admin of: give Claude the address of the Page's admin view,
`linkedin.com/company/<ID>/admin/`, or the number in it. Tools for features you haven't turned on are not offered
to Claude.

## Other ways to install locally

- **From npm:** `npm install -g claude-linkedin-connector` installs a `claude-linkedin-connector` command
  ([npm page](https://www.npmjs.com/package/claude-linkedin-connector)), and `npx -y claude-linkedin-connector`
  runs it without installing. Releases are built by GitHub Actions with
  [provenance](https://docs.npmjs.com/generating-provenance-statements) (`npm audit signatures` checks it).
- **Claude Code, by hand:** `npm ci` in a clone builds `dist/`, then

  ```sh
  claude mcp add linkedin --scope user \
    -e LINKEDIN_CLIENT_ID=your-client-id \
    -e LINKEDIN_CLIENT_SECRET=your-client-secret \
    -- node /absolute/path/to/claude-linkedin-connector/dist/index.js
  ```

  With the npm package, end the command with `-- claude-linkedin-connector` instead. `npm run setup -- --help`
  lists the setup script's options, such as `--scope local` and `--no-login`.
- **Claude Desktop, by hand:** in **Settings → Developer → Edit Config**, add

  ```json
  {
    "mcpServers": {
      "linkedin": {
        "command": "/absolute/path/to/node",
        "args": ["/absolute/path/to/claude-linkedin-connector/dist/index.js"],
        "env": { "LINKEDIN_CLIENT_ID": "your-client-id", "LINKEDIN_CLIENT_SECRET": "your-client-secret" }
      }
    }
  }
  ```

  Use the full path of Node.js 24 or later (`which node`, or `where node` on Windows): Claude Desktop doesn't
  see the `PATH` your shell sets up, so a bare `node` may be missing or too old. For the npm package, the path is
  `$(npm root -g)/claude-linkedin-connector/dist/index.js`.

**Signing in from a terminal** works too, with the same environment variables set:
`claude-linkedin-connector login` (or `node dist/index.js login`), `status` and `logout`. The token is stored
in `~/.config/claude-linkedin-connector/token.json` (`%APPDATA%\claude-linkedin-connector\` on Windows), readable
only by you, and lasts 60 days. The posts you publish are remembered in `posts.json` next to it; delete it to make
the connector forget them. To skip signing in, set `LINKEDIN_ACCESS_TOKEN` to a token from LinkedIn's developer
portal.

## Remote server

Remote mode lets Claude on the web, desktop and mobile use the connector as a custom connector. Run the Docker
image on a host with a public HTTPS URL:

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

`LINKEDIN_ALLOWED_MEMBERS` lists the LinkedIn emails or member IDs that may connect, or `*` for anyone. An email
matches only the account's primary email, once LinkedIn has verified it; someone refused is told their member ID to
add instead. Keep `SERVER_SECRET` the same: changing it disconnects everyone. Without Docker, set the same
variables and run `HOST=0.0.0.0 node dist/index.js http`. Then:

1. Add `https://linkedin-mcp.example.com/oauth/callback` to your LinkedIn app's redirect URLs.
2. In Claude, open **Settings → Connectors → Add custom connector** and enter
   `https://linkedin-mcp.example.com/mcp` (on Team and Enterprise plans, an owner may need to add it).
3. Click **Connect**: you see the connector's consent screen, then LinkedIn's.

In Claude Code: `claude mcp add --transport http linkedin https://linkedin-mcp.example.com/mcp`, then `/mcp` to
sign in. To try it on your own computer, run `PUBLIC_URL=http://localhost:3000 node dist/index.js http` and use
`http://localhost:3000/mcp`.

The [deployment guide](docs/deployment.md) covers production: a checklist, Docker Compose with automatic HTTPS,
Kubernetes, how sign-in works, logs, rate limits and rotating the secret.

## Limitations

- LinkedIn only lets ordinary apps **write**. Reading your feed, your past posts, or other people's
  profiles requires partner-level access, so the connector can't do it. In local mode it remembers the posts it
  published itself; posts made on linkedin.com or in remote mode aren't among them.
- LinkedIn's API doesn't give apps your connections, so the connector reads the data export you download from
  LinkedIn instead (see the [usage guide](docs/usage.md#your-connections)).
- Only a post's text can be edited; attachments can't be changed after publishing. Video posts aren't supported yet.
- A post can have one kind of attachment: a link preview, images, or a document.
- Claude can't pass on images or documents you attach in the chat: it sees what's in them, not the files. Give a
  file on your computer (local mode) or a link instead.
- In remote mode, media sent as `data:` URIs is limited to about 20 MB per request; pass larger files as URLs.
- LinkedIn applies daily rate limits per member and per app.
- Posts are plain text. LinkedIn doesn't render Markdown; line breaks and `#hashtags` work. `@mentions` show as
  plain text and don't tag anyone.

## Troubleshooting
| Problem | Fix |
|---|---|
| LinkedIn shows an error instead of asking you to approve, e.g. that the redirect URI doesn't match | Add the exact callback URL (scheme, host, port, path) to the app's **Auth** tab, and check that the Client ID is the one shown there |
| `Port 8723 is already in use` | Set `LINKEDIN_REDIRECT_URI` (**Redirect URL** in the Claude Desktop extension's settings, `--redirect-uri` for `npm run setup`) to another localhost port and register it in the app |
| `Scope "w_member_social_feed" is not authorized for your application` | The app lacks the Community Management API: turn off **Comments and reactions** (`LINKEDIN_COMMENTS`) or **Post as LinkedIn Pages** (`LINKEDIN_PAGES`, for `w_organization_social`) until LinkedIn grants it. Another scope means a missing product from step 1 of the quick start |
| `invalid_client: Client authentication failed` when signing in | The Client ID or Client Secret is wrong, or the secret was regenerated: copy both again from the app's **Auth** tab |
| `LinkedIn denied permission` (403) | The app lacks the product for that feature, or you signed in before adding the scope. Fix the app, then sign in again. When the message says signing in again won't help, LinkedIn refused the post itself: only a post's author can edit or delete it |
| A file `is outside the folders this connector may read files from` | Move it to one of the folders listed, or set `LINKEDIN_FILE_DIRS` (**Folders for local files** in the Claude Desktop extension's settings, `--file-dirs` for `npm run setup`) to the value the message gives. The setting replaces the default folders, so that value lists them too. A file directly in your home folder has to be moved: allowing the home folder would open up all your files |
| `LinkedIn didn't let you act as the Page` | Only a Page's super admins and content admins can post, comment and react as it. Check your role, and that the number is the one in the address of the Page's admin view |
| Signing in again keeps the same LinkedIn account | LinkedIn signs in whoever is signed in to linkedin.com in your browser: sign out there first |
| Editing or deleting a post fails with `not the activity URN` | Links copied from linkedin.com often point to the post's activity rather than the post. In local mode, ask Claude to find the post among the ones it published; otherwise use the URL Claude gave you when publishing, or the code from the post's **Embed this post** menu item |
| `access token … expired or been revoked` | Sign in again (local) or reconnect the connector (remote) |
| Remote connection fails after a restart | Set a fixed `SERVER_SECRET` |
| `SERVER_SECRET is required` on startup | Generate one with `openssl rand -base64 32`, store it with your other secrets and keep it |
| `LINKEDIN_ALLOWED_MEMBERS is required` on startup | List who may connect, or set it to `*` to allow anyone |
| `This LinkedIn account is not allowed to use this connector` | Add the member ID the message gives (also the `member` of the `member_not_allowed` log entry) to `LINKEDIN_ALLOWED_MEMBERS` and restart. A listed email doesn't match if it isn't the account's primary email on LinkedIn, or LinkedIn hasn't verified it |
| Some requests fail with `502` behind a proxy or load balancer | Set `KEEP_ALIVE_TIMEOUT` above the proxy's upstream idle timeout (e.g. `620` on Google Cloud) |
| `Too many requests` (429) for everyone at once | The server is behind a proxy without `TRUST_PROXY`, so all clients share one address |

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
| `LINKEDIN_FILE_DIRS` | local | `~/Downloads`, `~/Desktop`, `~/Pictures`, working directory | Comma-separated folders local images, documents and `Connections.csv` may be read from, instead of the defaults (list them too to keep them). Symlinks out of them are refused |
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

## Development

```sh
npm ci
npm run check   # typecheck + tests
```

[`docs/development.md`](docs/development.md) covers the code layout, tests and releasing;
[`docs/architecture.md`](docs/architecture.md) has C4 diagrams. Report vulnerabilities as described in
[`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE)

---

Not affiliated with, endorsed by, or sponsored by LinkedIn. LinkedIn is a trademark of LinkedIn Corporation.
