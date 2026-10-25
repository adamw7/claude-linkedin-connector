# Development

```sh
npm ci
npm run check          # typecheck + tests
npm run test:coverage  # tests with a coverage report in coverage/
npm run test:mutation  # Stryker mutation tests, report in reports/mutation/ (slow)
npm run build          # dist/
npm run bundle         # single-file build for the .mcpb
node scripts/smoke-test-package.mjs  # packs, installs and runs the npm package
node scripts/live-test.mjs  # runs dist/ against the real LinkedIn API; changes nothing there without options
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

See [`architecture.md`](architecture.md) for C4 diagrams (context, containers, components).

Tests run against an in-memory fake of LinkedIn, including an end-to-end OAuth flow driven by the
official MCP client SDK. `test/architecture.test.ts` uses [ArchUnitTS](https://github.com/LukasNiessen/ArchUnitTS)
to keep the module layering in place: no import cycles, `linkedin/` and `net/` know nothing of MCP
or sign-in, `mcp/` doesn't depend on the HTTP transport, and remote mode never touches local token storage.
CI reports coverage on every push and pull request; mutation tests run
nightly (and on demand) in the `Mutation tests` workflow.

The tests run `src/`, so they can't tell whether the npm package works. `scripts/smoke-test-package.mjs`, which CI
runs, packs it, installs the tarball with production dependencies only and runs the installed command against a
fake LinkedIn: signing in from the terminal, publishing a post with an image over stdio, and starting and stopping the
remote server. It fails on a file left out of `files`, a runtime dependency listed under `devDependencies` or a
broken `bin`. Give it a version to test a release instead: `node scripts/smoke-test-package.mjs
claude-linkedin-connector@<version>`.

## Testing against the real LinkedIn API

Everything above runs against a fake LinkedIn, built from LinkedIn's documentation. `scripts/live-test.mjs` runs the
built connector against the real API, to catch what the fake can't: LinkedIn retiring the API version the connector
sends, or answering differently than documented. Run it with your own LinkedIn app, for example before a release:

```sh
npm run build
LINKEDIN_ACCESS_TOKEN=<token> node scripts/live-test.mjs  # or after claude-linkedin-connector login
node scripts/live-test.mjs --login --upload --publish --remote
```

Without options it changes nothing on LinkedIn. It checks how LinkedIn refuses made-up credentials, and, signed in,
reads your profile, checks that LinkedIn accepts the API version the connector sends, and that the connector moves to a
live version when one is retired. The `Live test` workflow runs it without options and without a sign-in every Monday,
and when the script, `src/linkedin/` or `src/mcp/errors.ts` changes, so it checks only how LinkedIn refuses made-up
credentials: the version checks need a sign-in, because LinkedIn checks the token before the version. Get a token from the OAuth 2.0 tools on your app's page in the developer portal (with
the `openid profile email w_member_social` scopes), or sign in with `--login`, which keeps the token apart from yours.

- `--upload` uploads an image and a document without posting them, which nobody sees, and waits for LinkedIn to
  process them.
- `--publish` publishes test posts visible to your connections (text with every character LinkedIn treats as markup,
  one image, two images, a PDF and a link), edits one and deletes them all. `--comments` and `--page <id>` add a
  comment and a reaction, and a post as a Page; both need the Community Management API. `--keep` leaves the posts up
  to check how they look.
- `--remote` connects to the remote server the way Claude does, through its consent screen and LinkedIn's in your
  browser. Add `http://localhost:3000/oauth/callback` to your app's redirect URLs first.

Behind a proxy, set `NODE_USE_ENV_PROXY=1`: Node doesn't use `HTTPS_PROXY` otherwise.

## Merging

The `Automerge` workflow (`.github/workflows/automerge.yml`) squash-merges a pull request once the latest run of
`CI` and `Audit` on its head has passed, and of `Setup script` and `Live test` too when their paths changed. It wakes
whenever one of them finishes and checks them all, so whichever finishes last merges; a push after those runs is never
merged unchecked. Pull requests from forks, drafts and pull requests labelled `no-automerge` are left to a person.

It merges with the `AUTOMERGE_TOKEN` repository secret when set (a token allowed to merge pull requests and change
workflows), otherwise with `GITHUB_TOKEN`. That token cannot merge a change to `.github/workflows/`, such as
Renovate's GitHub Actions updates, so without the secret those wait for a person. A merge made with `GITHUB_TOKEN`
starts no workflow either, so `Automerge` then dispatches `CI` on `main` itself. The workflow runs `main`'s copy of
itself, so a change to it applies from the pull request after the one that makes it.

## Releasing

1. Set the new version in `package.json` (`npm version --no-git-tag-version <version>` also updates
   `package-lock.json`), `mcpb/manifest.json` and `src/version.ts`; a test fails if they disagree.
2. Move the `Unreleased` notes in [`CHANGELOG.md`](../CHANGELOG.md) under a `## [<version>] - <date>` heading.
3. Merge to `main`, then tag and push: `git tag v<version> && git push origin v<version>`.

The `Release` workflow checks the tag against the version, checks the dependencies that ship for known
vulnerabilities (as the `Audit` workflow does, below), runs the tests, builds the `.mcpb` and publishes
a GitHub release with it attached and the changelog entry as notes. It then smoke tests the Docker image
(`scripts/smoke-test-image.sh`, which CI also runs) and pushes it for amd64 and arm64 to
`ghcr.io/adamw7/claude-linkedin-connector` as `<version>`, `<major.minor>` and `latest`. After the first push,
make the package public in its settings on GitHub (packages start out private), so `docker pull` works without
signing in. Until it is, the image job fails after pushing; re-run only that job once the package is public.

Alongside the image, it smoke tests the npm package as CI does, then publishes it to npm with provenance, using the
`NPM_TOKEN` repository secret (an npm automation or granular access token allowed to publish
`claude-linkedin-connector`).
A broken package fails the smoke test and is never published. Pre-release versions such
as `1.2.0-rc.1` get the `next` dist-tag, so `npm install` keeps getting the latest release. The job then installs
the version it published from the registry, checks that `--version` and `--help` work and runs
`npm audit signatures`. A tag can only be published once: to fix a broken npm release, release a new version
(and `npm deprecate claude-linkedin-connector@<version> "<reason>"` the broken one) rather than re-running the
job.

## Dependencies

Dependabot proposes npm and base image updates weekly, and Renovate GitHub Actions updates. Renovate is meant to
propose all three, but so far detects only GitHub Actions
([#43](https://github.com/adamw7/claude-linkedin-connector/issues/43)); once it detects the rest, delete
`.github/dependabot.yml`. Their pull requests merge on green like any other (see [Merging](#merging)).

The `Audit` workflow runs `npm audit --omit=dev --audit-level=high`, which fails when a dependency that ships in the
npm package, the `.mcpb` or the Docker image has a known high or critical vulnerability. It runs on every push to
`main` and pull request, and every day, so an advisory published since the last push shows up without one. A failure
usually needs only a lockfile update (`npm audit fix`); then release a new version so the npm package and
the image carry the fix. Development tools are left out: none of them ships, and their advisories wait for their
own releases.

Report vulnerabilities as described in [`SECURITY.md`](../SECURITY.md).
