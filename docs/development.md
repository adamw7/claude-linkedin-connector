# Development

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

See [`architecture.md`](architecture.md) for C4 diagrams (context, containers, components).

Tests run against an in-memory fake of LinkedIn, including an end-to-end OAuth flow driven by the
official MCP client SDK. `test/architecture.test.ts` uses [ArchUnitTS](https://github.com/LukasNiessen/ArchUnitTS)
to keep the module layering in place: no import cycles, `linkedin/` and `net/` know nothing of MCP
or sign-in, `mcp/` doesn't depend on the HTTP transport, and remote mode never touches local token storage.
CI reports coverage on every push and pull request; mutation tests run
nightly (and on demand) in the `Mutation tests` workflow.

## Releasing

1. Set the new version in `package.json` (`npm version --no-git-tag-version <version>` also updates
   `package-lock.json`), `mcpb/manifest.json` and `src/version.ts`; a test fails if they disagree.
2. Move the `Unreleased` notes in [`CHANGELOG.md`](../CHANGELOG.md) under a `## [<version>] - <date>` heading.
3. Merge to `main`, then tag and push: `git tag v<version> && git push origin v<version>`.

The `Release` workflow checks the tag against the version, runs the tests, builds the `.mcpb` and publishes
a GitHub release with it attached and the changelog entry as notes. It then smoke tests the Docker image
(`scripts/smoke-test-image.sh`, which CI also runs) and pushes it for amd64 and arm64 to
`ghcr.io/adamw7/claude-linkedin-connector` as `<version>`, `<major.minor>` and `latest`. After the first push,
make the package public in its settings on GitHub (packages start out private), so `docker pull` works without
signing in.

Last, it publishes the package to npm with provenance, using the `NPM_TOKEN` repository secret (an npm
automation or granular access token allowed to publish `claude-linkedin-connector`). Pre-release versions such
as `1.2.0-rc.1` get the `next` dist-tag, so `npm install` keeps getting the latest release. The job then installs
the version it published from the registry, checks that `--version` and `--help` work and runs
`npm audit signatures`. A tag can only be published once: to fix a broken npm release, release a new version
(and `npm deprecate claude-linkedin-connector@<version> "<reason>"` the broken one) rather than re-running the
job.

Renovate proposes dependency, GitHub Actions and base image updates weekly. Report vulnerabilities as described
in [`SECURITY.md`](../SECURITY.md).
