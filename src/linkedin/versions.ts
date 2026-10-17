/**
 * Newest LinkedIn API version (YYYYMM) verified when this release was cut.
 * LinkedIn supports each monthly version for about a year, after which it
 * answers `426 NONEXISTENT_VERSION`; {@link ApiVersion.recover} handles that.
 */
export const DEFAULT_API_VERSION = '202609';

const VERSION_FORMAT = /^\d{6}(\.\d{2})?$/;

export function isValidApiVersion(version: string): boolean {
  return VERSION_FORMAT.test(version);
}

/** Monthly versions from `now`'s month backwards, newest first. */
export function recentApiVersions(now: Date, count = 13): string[] {
  const months = now.getUTCFullYear() * 12 + now.getUTCMonth();
  return Array.from({ length: count }, (_, i) => {
    const m = months - i;
    return `${Math.floor(m / 12)}${String((m % 12) + 1).padStart(2, '0')}`;
  });
}

/** The LinkedIn-Version header value, shared by every client in the process. */
export class ApiVersion {
  private current: string;

  constructor(
    initial: string = DEFAULT_API_VERSION,
    private readonly now: () => Date = () => new Date(),
    private readonly log: (message: string) => void = () => {},
  ) {
    this.current = initial;
  }

  get value(): string {
    return this.current;
  }

  /**
   * LinkedIn rejects both sunset and not-yet-released versions with 426, so
   * walk back from the current month to the newest live version. `attempt`
   * re-sends the rejected request (which LinkedIn did not process) with a
   * candidate version. Returns the first non-426 response, or undefined when
   * every candidate was rejected.
   */
  async recover(failed: string, attempt: (version: string) => Promise<Response>): Promise<Response | undefined> {
    for (const candidate of recentApiVersions(this.now())) {
      if (candidate === failed) continue;
      const response = await attempt(candidate);
      if (response.status === 426) {
        await response.body?.cancel();
        continue;
      }
      if (this.current === failed) {
        this.log(`LinkedIn API version ${failed} is not active; switched to ${candidate}.`);
        this.current = candidate;
      }
      return response;
    }
    return undefined;
  }
}
