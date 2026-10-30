import { describe, expect, it } from 'vitest';
import { ApiVersion, DEFAULT_API_VERSION, isValidApiVersion, recentApiVersions } from '../src/linkedin/versions.js';

const rejected = () => new Response('{"code":"NONEXISTENT_VERSION"}', { status: 426 });
const accepted = () => new Response('{}', { status: 200 });

describe('LinkedIn API versions', () => {
  it('validates version strings', () => {
    expect(isValidApiVersion(DEFAULT_API_VERSION)).toBe(true);
    expect(isValidApiVersion('202401.01')).toBe(true);
    expect(isValidApiVersion('2024-01')).toBe(false);
    expect(isValidApiVersion('20240101')).toBe(false);
  });

  it('lists recent months newest first, across a year boundary', () => {
    expect(recentApiVersions(new Date('2026-02-10T00:00:00Z'), 4)).toEqual(['202602', '202601', '202512', '202511']);
  });

  it('switches to the newest live version when the configured one is rejected', async () => {
    const logs: string[] = [];
    const version = new ApiVersion('202409', () => new Date('2026-10-17T00:00:00Z'), (m) => logs.push(m));
    const tried: string[] = [];
    const response = await version.recover('202409', async (candidate) => {
      tried.push(candidate);
      return candidate === '202609' ? accepted() : rejected();
    });
    expect(response?.status).toBe(200);
    expect(tried).toEqual(['202610', '202609']);
    expect(version.value).toBe('202609');
    expect(logs[0]).toContain('switched to 202609');
  });

  it('switches once when several requests sent with the rejected version recover', async () => {
    const logs: string[] = [];
    const version = new ApiVersion('202409', () => new Date('2026-10-17T00:00:00Z'), (m) => logs.push(m));
    const live = async (candidate: string) => (candidate === '202610' ? accepted() : rejected());
    await version.recover('202409', live);
    // A second request, sent before the first recovered, comes back rejected too.
    expect((await version.recover('202409', live))?.status).toBe(200);
    expect(version.value).toBe('202610');
    expect(logs).toEqual(['LinkedIn API version 202409 is not active; switched to 202610.']);
  });

  it('gives up when no recent version is accepted', async () => {
    const version = new ApiVersion('202609', () => new Date('2026-10-17T00:00:00Z'));
    const tried: string[] = [];
    expect(
      await version.recover('202609', async (candidate) => {
        tried.push(candidate);
        return rejected();
      }),
    ).toBeUndefined();
    expect(version.value).toBe('202609');
    // The 13 months back from now, but not the version LinkedIn just rejected.
    expect(tried).toEqual(['202610', '202608', '202607', '202606', '202605', '202604', '202603', '202602', '202601', '202512', '202511', '202510']);
  });
});
