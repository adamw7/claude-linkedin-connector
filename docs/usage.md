# Using the LinkedIn connector

A walkthrough from installing the connector to everyday requests. It assumes you've created a LinkedIn app
as described in [the README](../README.md#1-create-a-linkedin-app); the screenshots use Claude Code, but the
requests work the same in Claude Desktop and Claude on the web.

## 1. Install it

From a clone of this repository, run `npm run setup`. It asks for your app's Client ID and Client Secret,
builds the connector and registers it with Claude Code. `claude mcp list` then shows it as connected:

![Output of npm run setup, then claude mcp list showing the linkedin server connected](images/setup.png)

In Claude Desktop, install the `.mcpb` extension from the
[latest release](https://github.com/adamw7/claude-linkedin-connector/releases/latest) instead. For Claude on
the web or mobile, see [remote setup](../README.md#2b-remote-setup-claude-custom-connector).

## 2. Sign in to LinkedIn

Ask Claude:

> Connect my LinkedIn account

Claude replies with a sign-in link. Open it, approve access on LinkedIn, and the browser lands on this page:

![Browser page reading "Connected to LinkedIn as Ada Lovelace. You can close this tab and return to Claude."](images/signed-in.png)

Tell Claude you're done. "Am I connected to LinkedIn?" shows who you're signed in as and when the sign-in
expires (after 60 days).

With a remote server, the connector instead shows its own consent screen when you click **Connect** in
Claude's connector settings, listing what Claude will be able to do, before sending you to LinkedIn:

![Consent screen titled "Connect LinkedIn to Claude", listing the permissions, with Cancel and Continue to LinkedIn buttons](images/consent.png)

## 3. Ask Claude

Talk to Claude normally; it picks the right tool. For example, with the `Connections.csv` from LinkedIn's
data export (**Settings → Data privacy → Get a copy of your data → Connections**):

![Claude Code calling linkedin_read_connections for two companies and listing the five matching connections](images/claude-code-connections.png)

*Drawn from a real Claude Code session with the connector, using a sample `Connections.csv` with made-up
people.*

More things to try:

| Ask | Tool used |
|---|---|
| "What's my LinkedIn profile?" | `linkedin_get_profile` |
| "How many of my connections work at each company? Top 10." | `linkedin_read_connections` |
| "Who did I connect with this year?" | `linkedin_read_connections` |
| "Draft a LinkedIn post announcing our 2.0 release, then publish it once I approve." | `linkedin_create_post` |
| "Share https://example.com/blog/launch on LinkedIn with a two-line intro." | `linkedin_create_post` (link preview) |
| "Post these three photos with the caption …" | `linkedin_create_post` (images) |
| "Publish slides.pdf as a LinkedIn carousel titled 'Q3 results'." | `linkedin_create_post` (document) |
| "Fix the typo in the post you just published." | `linkedin_edit_post` |
| "Delete that post." | `linkedin_delete_post` |
| "Comment 'Congratulations!' on <post URL>" / "Like <post URL>" | `linkedin_comment_on_post` / `linkedin_react_to_post` (need extra LinkedIn access) |
| "Sign me out of LinkedIn." | `linkedin_logout` |

## What to expect when posting

- **You approve every post.** Claude shows you the exact text, and any image, link or document, and waits
  for your OK before publishing, editing, commenting or deleting. Claude also asks you to allow each tool
  call unless you've allowed it permanently.
- **Write plain text.** LinkedIn doesn't render Markdown. Line breaks, emoji and `#hashtags` work, and the
  connector escapes characters such as `( ) * _` so LinkedIn doesn't cut the post short.
- **Claude gets the post's URL back**, so you can say "edit that post" or "delete it" right afterwards.
- **One kind of attachment per post**: a link preview, 1–20 images, or one document.
- **Claude can't read your feed or past posts.** LinkedIn only gives that to partner apps. Keep the URL
  Claude gives you after publishing if you may want to edit or delete the post later.

If something goes wrong, see [Troubleshooting](../README.md#troubleshooting).
