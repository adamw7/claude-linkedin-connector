# Architecture

C4 diagrams of the connector, from the outside in, in [Mermaid's C4 syntax](https://mermaid.js.org/syntax/c4.html)
(GitHub renders them inline), then the module layering, which
[`test/architecture.test.ts`](../test/architecture.test.ts) enforces.

## Level 1: System context

```mermaid
C4Context
  title System context: LinkedIn connector for Claude

  Person(member, "LinkedIn member", "Uses Claude and owns a LinkedIn account (and optionally administers LinkedIn Pages)")

  System_Ext(claude, "Claude", "Claude Desktop, Claude Code, or Claude on the web and mobile; an MCP client")
  System(connector, "LinkedIn connector", "MCP server that exposes LinkedIn profile, posting, commenting and reaction tools")
  System_Ext(linkedin, "LinkedIn", "OAuth 2.0 / OpenID Connect (www.linkedin.com) and REST API (api.linkedin.com)")
  System_Ext(web, "Public web", "Pages linked from posts, and images or documents given by URL")

  Rel(member, claude, "Asks to read profile, publish, edit, comment, react")
  Rel(member, linkedin, "Signs in and grants access", "Browser")
  Rel(claude, connector, "Calls MCP tools", "MCP over stdio or Streamable HTTP")
  Rel(connector, linkedin, "Exchanges OAuth codes, calls REST API", "HTTPS")
  Rel(connector, web, "Fetches link-preview metadata and media", "HTTPS, public addresses only")

  UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Level 2: Containers

The same code base ships as two deployables. Local mode is a process Claude starts on the member's computer;
remote mode is a stateless HTTP server that Claude reaches as a custom connector.

```mermaid
C4Container
  title Containers: local (stdio) and remote (HTTP) modes

  Person(member, "LinkedIn member")
  System_Ext(claude, "Claude", "MCP client")
  System_Ext(linkedin, "LinkedIn", "OAuth + REST API")
  System_Ext(web, "Public web", "Link targets, media URLs")

  System_Boundary(local, "Member's computer") {
    Container(stdio, "Local MCP server", "Node.js 24, stdio", "dist/index.js stdio|login|logout|status; started by Claude Desktop / Claude Code or installed as an .mcpb extension")
    ContainerDb(tokenFile, "Token and post history", "JSON, mode 0600", "token.json and posts.json in ~/.config/claude-linkedin-connector/")
  }

  System_Boundary(server, "Hosting provider") {
    Container(http, "Remote MCP server", "Node.js 24, Express, Docker", "dist/index.js http; OAuth 2.1 authorization server plus /mcp endpoint; keeps no database")
  }

  Rel(claude, stdio, "Calls tools", "MCP over stdio")
  Rel(claude, http, "Registers, authorizes, calls tools", "OAuth 2.1 + MCP Streamable HTTP")
  Rel(member, stdio, "Completes sign-in redirect", "http://localhost:8723/callback")
  Rel(member, http, "Approves consent screen", "HTTPS")
  Rel(stdio, tokenFile, "Reads / writes LinkedIn tokens and published posts")
  Rel(stdio, linkedin, "OAuth + REST", "HTTPS")
  Rel(http, linkedin, "OAuth + REST", "HTTPS")
  Rel(stdio, web, "Fetches previews and media", "HTTPS")
  Rel(http, web, "Fetches previews, media, client metadata documents", "HTTPS")

  UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="2")
```

In remote mode the LinkedIn token never touches disk: it is sealed with `SERVER_SECRET` (AES-256-GCM) inside
the access token the server issues to Claude, so any instance holding the same secret can serve any request.
[`deployment.md`](deployment.md) covers running it in production.

## Level 3: Components of the local MCP server

```mermaid
C4Component
  title Components: local MCP server (stdio)

  System_Ext(claude, "Claude", "MCP client")
  System_Ext(linkedin, "LinkedIn", "OAuth + REST API")
  System_Ext(web, "Public web")
  ContainerDb(tokenFile, "Token and post history", "JSON")

  Container_Boundary(stdio, "Local MCP server") {
    Component(cli, "CLI / composition root", "src/index.ts", "Parses the command and wires everything together")
    Component(config, "Configuration", "src/config.ts", "Reads LINKEDIN_* environment variables")
    Component(mcp, "Connector MCP server", "src/mcp/server.ts", "Registers linkedin_* tools for the configured scopes; maps errors to tool results")
    Component(localAuth, "LocalAuth", "src/auth/local-auth.ts", "Implements LinkedInAuth: session lookup, token refresh, login, logout, status")
    Component(loopback, "LoopbackLogin", "src/auth/loopback-login.ts", "Temporary localhost listener that receives LinkedIn's redirect")
    Component(store, "TokenStore", "src/auth/token-store.ts", "Persists tokens in the per-user config directory")
    Component(history, "PostHistory", "src/auth/post-history.ts", "Remembers posts published from this computer, as LinkedIn doesn't let apps read them")
    Component(client, "LinkedIn clients", "src/linkedin/*", "REST client, OAuth, API version fallback, text escaping, URNs, media, link previews and the Connections.csv export")
    Component(safeFetch, "safeFetch", "src/net/safe-fetch.ts", "Outbound fetch that refuses private and loopback addresses")
  }

  Rel(claude, mcp, "Calls tools", "stdio")
  Rel(cli, config, "Loads")
  Rel(cli, mcp, "Creates")
  Rel(cli, localAuth, "Creates")
  Rel(cli, history, "Creates")
  Rel(mcp, localAuth, "Gets session / starts login")
  Rel(mcp, client, "Posts, comments, reacts")
  Rel(mcp, history, "Records and lists published posts")
  Rel(localAuth, loopback, "Runs sign-in")
  Rel(localAuth, store, "Loads / saves token")
  Rel(store, tokenFile, "Reads / writes")
  Rel(history, tokenFile, "Reads / writes")
  Rel(localAuth, client, "Refreshes token, reads profile")
  Rel(client, linkedin, "HTTPS")
  Rel(client, safeFetch, "Media and preview fetches")
  Rel(safeFetch, web, "HTTPS")

  UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Level 3: Components of the remote MCP server

```mermaid
C4Component
  title Components: remote MCP server (HTTP)

  Person(member, "LinkedIn member")
  System_Ext(claude, "Claude", "MCP client")
  System_Ext(linkedin, "LinkedIn", "OAuth + REST API")
  System_Ext(web, "Public web")

  Container_Boundary(http, "Remote MCP server") {
    Component(app, "Remote app", "src/remote/app.ts, Express", "Host validation, CORS, OAuth metadata, bearer auth and rate limits (src/remote/rate-limit.ts) on /mcp and OAuth endpoints, /healthz")
    Component(logger, "Logger", "src/remote/logger.ts", "Request IDs; JSON-lines request, sign-in, tool-call audit and error logs on stderr")
    Component(oauth, "OAuth authorization server", "src/remote/oauth-server.ts", "/register, /authorize, /oauth/callback, /token; PKCE, single-use codes, token verifier")
    Component(clients, "ClientRegistry + RedirectPolicy", "src/remote/clients.ts", "Dynamic client registration and client ID metadata documents; redirect URI allow-list")
    Component(crypto, "Sealer", "src/remote/crypto.ts", "Keyed by SERVER_SECRET (and SERVER_SECRET_PREVIOUS while rotating): signs client IDs and consent state; seals codes and access tokens (AES-256-GCM)")
    Component(pages, "Pages", "src/remote/pages.ts", "Consent and error pages")
    Component(connAuth, "ConnectorAuth", "src/remote/connector-auth.ts", "Implements LinkedInAuth from the verified access token's sealed LinkedIn grant")
    Component(mcp, "Connector MCP server", "src/mcp/server.ts", "Same tools as local mode except sign-in and post history, created per request")
    Component(client, "LinkedIn clients", "src/linkedin/*", "REST client, OAuth, API versions, text, URNs, media, link previews, Connections.csv")
    Component(safeFetch, "safeFetch", "src/net/safe-fetch.ts", "Outbound fetch that refuses private and loopback addresses")
  }

  Rel(claude, app, "Discovery, OAuth, MCP", "HTTPS")
  Rel(member, oauth, "Approves consent", "Browser")
  Rel(app, oauth, "Routes OAuth, verifies bearer tokens")
  Rel(app, mcp, "Creates per request")
  Rel(app, connAuth, "Creates from auth info")
  Rel(app, logger, "Requests, errors, tool-call audit")
  Rel(oauth, logger, "Sign-ins")
  Rel(oauth, clients, "Looks up / registers clients")
  Rel(oauth, crypto, "Signs and seals state, codes, tokens")
  Rel(oauth, pages, "Renders")
  Rel(oauth, client, "Exchanges code, reads member profile")
  Rel(clients, crypto, "Signs client IDs")
  Rel(clients, safeFetch, "Fetches metadata documents")
  Rel(mcp, connAuth, "Gets session")
  Rel(mcp, client, "Posts, comments, reacts")
  Rel(client, linkedin, "HTTPS")
  Rel(client, safeFetch, "Media and preview fetches")
  Rel(safeFetch, web, "HTTPS")

  UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Module layering

The code in `src/`, bottom to top; each layer may import only from layers below it.

| Layer | Modules | Notes |
|---|---|---|
| Leaf | `errors.ts`, `version.ts`, `html.ts`, `paths.ts`, `json.ts` | No project imports |
| Network | `net/` | `safeFetch` refuses private and loopback addresses; no LinkedIn or MCP knowledge |
| LinkedIn | `linkedin/` | REST client, OAuth, text escaping, media, link previews, API versions, `Connections.csv`; `client.ts` and `oauth.ts` are the only code allowed to call the global `fetch`, since the other modules fetch URLs the user gave through `safeFetch` |
| Local auth, config | `auth/`, `config.ts` | Token storage, post history and browser sign-in; environment variables |
| MCP | `mcp/` | Tools (`server.ts`); transport agnostic, so of `auth/` it loads only the hints (`hints.ts`) and the interfaces (`types.ts`), never the sign-in or token storage, even indirectly |
| Remote | `remote/` | HTTP app, OAuth authorization server, client registration, logging, rate limits; the only code allowed to use Express; never reaches local sign-in or token storage, even through `mcp/` |
| Composition root | `index.ts` | CLI (`stdio`, `http`, `login`, `logout`, `status`); imported by nothing |
