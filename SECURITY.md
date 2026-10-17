# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/adamw7/claude-linkedin-connector/security/advisories/new),
not in a public issue or pull request. Include what an attacker can do, the steps or a proof of concept to reproduce
it, and the version or commit you tested.

Fixes are released as a new version, with the advisory published once users can update.

## Supported versions

Only the latest release receives security fixes. Remote servers should run the newest image
(`ghcr.io/adamw7/claude-linkedin-connector`) and local installations the newest release.

## Scope

In scope is this repository's code, for example:

- the remote server's OAuth authorization server, token sealing and member allowlist;
- fetching link previews, media and client metadata documents without reaching private networks;
- local mode reading only files from the allowed folders, and storing the LinkedIn token;
- anything that lets a prompt injection make the connector act beyond what the user approved.

Out of scope are LinkedIn's own API and sign-in, Claude itself, and weaknesses that need a deployment to be
configured against the documentation (for example `LINKEDIN_ALLOWED_MEMBERS=*` on a public server, or a leaked
`SERVER_SECRET`).
