import { spawn } from 'node:child_process';

/** How long an opener may run before the page counts as open: some run for as long as the browser they started. */
const OPENED_AFTER_MS = 3_000;

/**
 * Opens a URL in the user's default browser, best effort: callers show the URL as well, in case nothing opens.
 * Resolves false when it surely didn't open: there is no opener (no xdg-open, as in WSL and on servers), or it found
 * no browser to use. Nobody can then approve a sign-in until they open the URL themselves.
 */
export function openBrowser(url: string, openedAfterMs = OPENED_AFTER_MS): Promise<boolean> {
  const [command, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
      child.unref();
      setTimeout(() => resolve(true), openedAfterMs).unref();
    } catch {
      // The URL is shown as well, so the user can open it manually.
      resolve(false);
    }
  });
}
