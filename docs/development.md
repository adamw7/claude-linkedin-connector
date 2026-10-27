# Development

```sh
npm ci
npm run check          # typecheck + tests
npm run test:coverage  # tests with a coverage report in coverage/
npm run test:mutation  # Stryker mutation tests, report in reports/mutation/ (slow)
npm run bench          # benchmarks, about a minute; see below
npm run build          # dist/
npm run bundle         # single-file build for the .mcpb
node scripts/smoke-test-package.mjs  # packs, installs and runs the npm package
node scripts/live-test.mjs  # runs dist/ against the real LinkedIn API; changes nothing there without options
```

[`architecture.md`](architecture.md) has the code layout, its module layering and C4 diagrams.

Tests run against an in-memory fake of LinkedIn, including an end-to-end OAuth flow driven by the official MCP
client SDK. `test/architecture.test.ts` keeps the layering in place with
[ArchUnitTS](https://github.com/LukasNiessen/ArchUnitTS). CI reports coverage on every push and pull request;
mutation tests run nightly (and on demand) in the `Mutation tests` workflow.

The tests run `src/`, so they can't tell whether the npm package works. `scripts/smoke-test-package.mjs`, which CI
runs, packs it, installs the tarball with production dependencies only and runs the installed command against a
fake LinkedIn: signing in from the terminal, publishing a post with an image over stdio, and starting and stopping
the remote server. It fails on a file left out of `files`, a runtime dependency listed under `devDependencies` or a
broken `bin`. To test a release instead: `node scripts/smoke-test-package.mjs claude-linkedin-connector@<version>`.

## Benchmarks

`npm run bench` times the connector against the fake LinkedIn, so the numbers are what the connector adds to
LinkedIn's own response times; `npx vitest bench --run --reporter=default bench/remote.bench.ts` runs one file.

- `bench/tools.bench.ts` calls every tool in local mode through the MCP client SDK, with the connector composed as
  `stdio` composes it (token and post history on disk), including posts with a 1 MB image, a 1 MB PDF and a link
  preview.
- `bench/remote.bench.ts` runs the remote server over loopback HTTP: connecting Claude (registration, consent, LinkedIn
  sign-in and token) and tool calls, each authenticated and served by a connector server of its own.
- `bench/connections.bench.ts` reads up to 30,000 connections, LinkedIn's limit, with each kind of filter and from an
  export archive.

Each is also a test: it first checks what the calls return and which LinkedIn requests they make, and fails if a call
fails. `connections.bench.ts` also fails when parsing or searching ten times the connections takes more than 25 times
as long, as a step that grows quadratically would. CI runs them on every push; to see whether a change makes the
connector slower, compare their tables before and after it on the same machine.

## Testing against the real LinkedIn API

The fake LinkedIn is built from LinkedIn's documentation. `scripts/live-test.mjs` runs the built connector against
the real API, to catch what the fake can't: LinkedIn retiring the API version the connector sends, or answering
differently than documented. Run it with your own LinkedIn app, for example before a release:

```sh
npm run build
LINKEDIN_ACCESS_TOKEN=<token> node scripts/live-test.mjs  # or after claude-linkedin-connector login
node scripts/live-test.mjs --login --upload --publish --remote
```

Without options it changes nothing on LinkedIn. It checks how LinkedIn refuses made-up credentials and, signed in,
reads your profile, checks that LinkedIn accepts the API version the connector sends, and that the connector moves
to a live version when one is retired. Get a token from the OAuth 2.0 tools on your app's page in the developer
portal (with the `openid profile email w_member_social` scopes), or sign in with `--login`, which keeps the token
apart from yours. The `Live test` workflow runs it without options every Monday, and when the script,
`src/linkedin/` or `src/mcp/errors.ts` changes. It has no sign-in, so it checks only how LinkedIn refuses made-up
credentials: LinkedIn checks the token before the version.

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

The `Automerge` workflow squash-merges a pull request once the latest runs of `CI` and `Audit` on its head have
passed, and of `Setup script` and `Live test` when their paths changed. It runs whenever one of them finishes and
checks them all, so the last to finish merges and a later push is never merged unchecked. Pull requests from forks,
drafts and pull requests labelled `no-automerge` are left to a person.

It merges with the `AUTOMERGE_TOKEN` repository secret if set (a token allowed to merge pull requests and change
workflows), else with `GITHUB_TOKEN`. That one can't merge changes to `.github/workflows/`, such as Renovate's GitHub
Actions updates, which then wait for a person, and its merges start no workflow, so `Automerge` dispatches `CI` on
`main` itself. The workflow runs `main`'s copy of itself, so a change to it applies from the next pull request on.

## Releasing

1. Set the new version in `package.json` (`npm version --no-git-tag-version <version>` also updates
   `package-lock.json`), `mcpb/manifest.json` and `src/version.ts`; a test fails if they disagree.
2. Move the `Unreleased` notes in [`CHANGELOG.md`](../CHANGELOG.md) under a `## [<version>] - <date>` heading.
3. Merge to `main`, then tag and push: `git tag v<version> && git push origin v<version>`.

The `Release` workflow checks the tag against the version, audits the dependencies that ship (as `Audit` does), runs
the tests, builds the `.mcpb` and publishes a GitHub release with it attached and the changelog entry as notes. Then,
in parallel, it:

- smoke tests the Docker image (`scripts/smoke-test-image.sh`, as CI does) and pushes it for amd64 and arm64 to
  `ghcr.io/adamw7/claude-linkedin-connector` as `<version>`, `<major.minor>` and `latest`. Packages start out
  private: after the first push the job fails until you make the package public in its settings on GitHub, so
  `docker pull` works without signing in; then re-run only that job.
- smoke tests the npm package as CI does, so a broken one is never published, and publishes it with provenance using
  the `NPM_TOKEN` repository secret (an npm automation or granular access token allowed to publish
  `claude-linkedin-connector`). Pre-releases such
  as `1.2.0-rc.1` get the `next` dist-tag, so `npm install` keeps getting the latest release. It then installs the
  published version, checks `--version` and `--help` and runs `npm audit signatures`. A version can only be
  published once: to fix a broken release, release a new version (and `npm deprecate
  claude-linkedin-connector@<version> "<reason>"` the broken one) rather than re-running the job.

## Dependencies

Dependabot proposes npm and base image updates weekly, and Renovate GitHub Actions updates. Renovate is meant to
propose all three, but so far detects only GitHub Actions
([#43](https://github.com/adamw7/claude-linkedin-connector/issues/43)); once it detects the rest, delete
`.github/dependabot.yml`. Their pull requests merge on green like any other.

The `Audit` workflow runs `npm audit --omit=dev --audit-level=high` on every push to `main`, every pull request and
every day, so an advisory published since the last push shows up without one. It fails when a dependency that ships
in the npm package, the `.mcpb` or the Docker image has a known high or critical vulnerability; development tools
ship in none of them, so their advisories wait for their own releases. A failure usually needs only a lockfile
update (`npm audit fix`), then a new release so the npm package and the image carry the fix.

Report vulnerabilities as described in [`SECURITY.md`](../SECURITY.md).
