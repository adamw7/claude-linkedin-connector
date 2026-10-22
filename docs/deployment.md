# Deploying the remote server

How to run the connector as a remote MCP server (a Claude custom connector) in production. The
[README](../README.md#remote-server) explains what remote mode is and how to add it to
Claude. Every setting is listed in its [configuration table](../README.md#configuration).

You need:

- a LinkedIn app with your server's callback URL, `https://<your-domain>/oauth/callback`, among its authorized
  redirect URLs (see the [quick start](../README.md#quick-start));
- a domain name, served over HTTPS;
- somewhere to run a container: a VM with Docker, Kubernetes, or a container platform.

## Checklist

| | Why |
|---|---|
| `PUBLIC_URL` is the `https://` origin Claude connects to | Tokens are issued for `<PUBLIC_URL>/mcp`; nothing else is accepted |
| `SERVER_SECRET` is set to at least 32 random characters, the same on every replica, and stored as a secret | It seals every token. The server refuses to start without it unless `PUBLIC_URL` is localhost |
| `LINKEDIN_ALLOWED_MEMBERS` lists who may connect | Anyone who finds the URL could otherwise post through your LinkedIn app |
| `ALLOWED_HOSTS` is your domain | Rejects requests for other host names (DNS rebinding) |
| `TRUST_PROXY` is the number of proxies in front | Rate limits and logs then see real client addresses instead of the proxy's |
| `KEEP_ALIVE_TIMEOUT` is above your proxy's upstream idle timeout | Otherwise the proxy reuses connections the server is closing and some requests fail with 502 |
| Health checks use `GET /healthz` | Answers `{"status":"ok"}` whatever the `Host` header |
| The orchestrator's stop grace period is above `SHUTDOWN_TIMEOUT` (8 s) | Uploads in flight get to finish |
| stderr is collected | Logs are JSON lines, including the audit trail of tool calls |

## The image

Each release after 0.1.0 publishes an image for `linux/amd64` and `linux/arm64`, with an SBOM and build provenance
attached:

```
ghcr.io/adamw7/claude-linkedin-connector:<version>   # e.g. 0.4.0; pin this in production
ghcr.io/adamw7/claude-linkedin-connector:<major.minor>
ghcr.io/adamw7/claude-linkedin-connector:latest
```

It runs `node dist/index.js http` as the unprivileged user 1000, listens on port 3000 (`PORT`), writes nothing to
disk (so a read-only root file system works) and has a Docker `HEALTHCHECK`. To build it yourself instead:
`docker build -t claude-linkedin-connector .` in a clone.

## Docker Compose with automatic HTTPS

[`deploy/`](../deploy) runs the connector behind [Caddy](https://caddyserver.com), which obtains and renews its
HTTPS certificate automatically. On a machine with Docker, ports 80 and 443 open to the internet, and DNS for your
domain pointing at it:

```sh
git clone https://github.com/adamw7/claude-linkedin-connector.git
cd claude-linkedin-connector/deploy
cp .env.example .env && chmod 600 .env
# Fill in .env: DOMAIN, LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, SERVER_SECRET, LINKEDIN_ALLOWED_MEMBERS
docker compose up -d
docker compose logs -f connector
```

Then add `https://<DOMAIN>/mcp` to Claude. Caddy accepts TLS 1.3 only. Only Caddy is published on the host; the connector runs read-only,
without capabilities, and Caddy waits for it to report healthy. To update, set `CONNECTOR_IMAGE` to the new
version (or keep `latest`) and run `docker compose pull && docker compose up -d`. To run your own build instead
of a published image, run `docker build -t claude-linkedin-connector ..` in `deploy/` and set
`CONNECTOR_IMAGE=claude-linkedin-connector` in `.env`.

Behind a different proxy, keep its upstream keep-alive below the connector's `KEEP_ALIVE_TIMEOUT` (65 s by
default), pass the original `Host` header through, and set `X-Forwarded-For`. nginx's defaults (60 s) and AWS
load balancers' (60 s) are fine; Caddy's (2 minutes) and Google Cloud load balancers' (10 minutes) are not, so
the Caddyfile lowers Caddy's, and on Google Cloud you'd set `KEEP_ALIVE_TIMEOUT=620`. Configure the proxy to accept
TLS 1.3 only, to match the connector's own outbound connections.

## Kubernetes

A Deployment with two replicas behind an Ingress that terminates TLS. Adjust the image version, domain and
member list:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: linkedin-connector
type: Opaque
stringData:
  LINKEDIN_CLIENT_SECRET: your-client-secret
  SERVER_SECRET: your-generated-secret # openssl rand -base64 32
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: linkedin-connector
spec:
  replicas: 2
  selector:
    matchLabels:
      app: linkedin-connector
  template:
    metadata:
      labels:
        app: linkedin-connector
    spec:
      terminationGracePeriodSeconds: 15 # above SHUTDOWN_TIMEOUT
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: connector
          image: ghcr.io/adamw7/claude-linkedin-connector:0.4.0 # the release you deploy
          ports:
            - name: http
              containerPort: 3000
          env:
            - name: PUBLIC_URL
              value: https://linkedin-mcp.example.com
            - name: ALLOWED_HOSTS
              value: linkedin-mcp.example.com
            - name: LINKEDIN_CLIENT_ID
              value: your-client-id
            - name: LINKEDIN_ALLOWED_MEMBERS
              value: you@example.com
            - name: TRUST_PROXY
              value: '1' # the ingress controller
          envFrom:
            - secretRef:
                name: linkedin-connector
          readinessProbe:
            httpGet:
              path: /healthz
              port: http
          livenessProbe:
            httpGet:
              path: /healthz
              port: http
          resources:
            requests:
              cpu: 50m
              memory: 128Mi
            limits:
              memory: 512Mi
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities:
              drop: [ALL]
---
apiVersion: v1
kind: Service
metadata:
  name: linkedin-connector
spec:
  selector:
    app: linkedin-connector
  ports:
    - name: http
      port: 80
      targetPort: http
```

Point an Ingress for your domain at the Service on port 80. Request bodies can be up to 30 MB (images sent
inline), so raise the ingress's body limit if it has one, e.g. `nginx.ingress.kubernetes.io/proxy-body-size: 30m`
for ingress-nginx, whose default is 1 MB. To accept TLS 1.3 only, set `ssl-protocols: "TLSv1.3"` in the
ingress-nginx controller's ConfigMap; it applies to every Ingress that controller serves.

Memory is mostly taken by media uploads in flight; 512 MiB leaves room for several at once.

## Other platforms

Any platform that runs a container and gives it an HTTPS URL works (Fly.io, Render, Railway, Cloud Run, Azure
Container Apps and the like): set the variables from the checklist, store the secrets in the platform's secret
store, use `/healthz` as the health check, and set `PORT` if the platform expects a port other than 3000. The
server keeps no state, so scaling to zero and back is fine.

## Secrets

`LINKEDIN_CLIENT_SECRET`, `SERVER_SECRET` and `SERVER_SECRET_PREVIOUS` can also be read from files: set
`LINKEDIN_CLIENT_SECRET_FILE` (and so on) to the path instead, as Docker and Kubernetes secrets and systemd
credentials are mounted. A trailing newline is ignored.

### Rotating `SERVER_SECRET`

`SERVER_SECRET` encrypts every access token and signs every client registration, so changing it outright
disconnects everyone, which is what you want if it leaked. For a routine rotation without disconnecting anyone:

1. Set `SERVER_SECRET_PREVIOUS` to the current secret and `SERVER_SECRET` to a new one
   (`openssl rand -base64 32`), and deploy that to every replica.
2. New tokens and registrations use the new secret; those issued before keep working.
3. After 60 days, the longest an access token lives, remove `SERVER_SECRET_PREVIOUS`. Clients that registered
   before the rotation and have not registered again since are then unknown. In Claude, reconnecting such a connector
   shows "Unknown application"; removing and adding the connector again fixes it.

## How sign-in works

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

## Rate limits

The OAuth endpoints allow `RATE_LIMIT_OAUTH` requests per minute per client IP, and `/mcp` allows
`RATE_LIMIT_MCP` per connected LinkedIn account; over the limit the server answers `429` with `Retry-After`.
Behind a proxy, set `TRUST_PROXY`, or every client shares the proxy's address and limit.

## Updating

Pull the new version and restart; rolling updates are fine because every replica shares `SERVER_SECRET`. On
`SIGTERM` the server stops accepting connections and lets requests in flight finish for up to `SHUTDOWN_TIMEOUT`
seconds. Read the [changelog](../CHANGELOG.md) for changes that need action.

## Monitoring

The server writes one JSON object per line to stderr, with `time`, `level` (`info`, `warn`, `error`) and `event`:

| Event | Level | Meaning |
|---|---|---|
| `listening` / `listen_failed` | info / error | Started, with the MCP URL and the LinkedIn redirect URL to register; or the port couldn't be opened |
| `warning` | warn | Something to look at, e.g. LinkedIn retired the configured API version and the server switched to a newer one |
| `http_request` | info, error for 5xx | One per request except health checks: method, path, status, duration, client IP, request ID |
| `member_authorized` / `member_not_allowed` | info / warn | Someone finished connecting, or was refused by `LINKEDIN_ALLOWED_MEMBERS` |
| `tool_call` | info, warn if it failed | Audit trail: tool, member, client, duration, request ID, and for a failure its kind with LinkedIn's HTTP status and error code (e.g. `LinkedInApiError: HTTP 403 ACCESS_DENIED`); never the arguments, nor the error message, which can quote them |
| `linkedin_token_exchange_failed` | warn | LinkedIn rejected a sign-in, often a wrong client secret or redirect URL |
| `linkedin_scope_not_authorized` | warn | LinkedIn refused a scope the server asks for because the app lacks the product that grants it, e.g. `LINKEDIN_COMMENTS` without the Community Management API: add the product or turn the feature off |
| `mcp_error` | warn | A malformed or unsupported MCP request |
| `unhandled_error`, `uncaught_exception`, `unhandled_rejection` | error | Bugs; please [report them](https://github.com/adamw7/claude-linkedin-connector/issues) |
| `shutting_down`, `shutdown_timeout` | info, warn | Stopping; requests still running after `SHUTDOWN_TIMEOUT` were cancelled |

Every response carries an `X-Request-Id` header, which also appears in that request's `http_request` and
`tool_call` entries. If your proxy sends `X-Request-Id`, its ID is kept, so proxy and connector logs line up.

Worth alerting on: any `error`; a rise in failed `tool_call`s, which often means LinkedIn changed something or
the app lost a product; `429` responses; and `member_not_allowed`, someone trying to connect who isn't on the list.

`/healthz` says the process is serving; it doesn't call LinkedIn, so an outage there won't restart your containers.

## Scaling

Run as many replicas as you like behind a load balancer, without sticky sessions, as long as they share
`SERVER_SECRET`. Two things are counted per replica: rate limits (each replica allows the full limit), and
authorization codes, which are single-use per replica. A stolen code still can't be used without the PKCE
verifier only the client has, and it expires after 5 minutes.
