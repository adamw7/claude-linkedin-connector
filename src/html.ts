export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** A minimal standalone page for OAuth screens; `body` must already be escaped. */
export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --fg: #1d2226; --muted: #5e6b75; --bg: #f4f2ee; --card: #fff; --accent: #0a66c2; --border: #d9dde1; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e9edf0; --muted: #a6b0b8; --bg: #1b1f23; --card: #262b31; --accent: #70b5f9; --border: #3a4148; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { box-sizing: border-box; width: min(32rem, calc(100vw - 2rem)); padding: 2rem; background: var(--card); border: 1px solid var(--border); border-radius: 12px; }
  h1 { margin: 0 0 1rem; font-size: 1.35rem; }
  p, li { color: var(--muted); }
  strong, code { color: var(--fg); }
  code { overflow-wrap: anywhere; }
  .warning { padding: .75rem 1rem; border-radius: 8px; border: 1px solid #c37d16; color: var(--fg); }
  .actions { display: flex; gap: .75rem; justify-content: flex-end; margin-top: 1.5rem; }
  button { font: inherit; padding: .55rem 1.2rem; border-radius: 999px; cursor: pointer; border: 1px solid var(--accent); background: transparent; color: var(--accent); }
  button.primary { background: var(--accent); color: var(--card); }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}
