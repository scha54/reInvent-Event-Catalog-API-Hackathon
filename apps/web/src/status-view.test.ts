import { describe, expect, it } from 'vitest';
import type { CatalogStatus } from '@serendipity/packages-contracts';
import { createApiClient } from './api-client';
import { buildStatusRows, formatAge } from './status-view';

const base: CatalogStatus = {
  eventId: 'e',
  catalogVersion: 'v7',
  lastSyncStatus: 'succeeded',
  lexicalOnly: false,
  freshness: {
    stale: false,
    lastKnownGood: false,
    lastSuccessfulSyncAt: '2025-01-01T00:00:00Z',
    ageSeconds: 7200,
  },
};

describe('buildStatusRows', () => {
  it('shows version, freshness, and sync with text labels', () => {
    const rows = buildStatusRows(base);
    expect(rows.map((r) => r.key)).toEqual(['version', 'freshness', 'sync']);
    expect(rows[0]?.value).toBe('v7');
    expect(rows[1]).toMatchObject({ value: 'Fresh', tone: 'ok' });
    expect(rows[1]?.note).toContain('2 hours ago');
  });

  it('labels last-known-good, stale, and lexical-only states', () => {
    const rows = buildStatusRows({
      ...base,
      lastSyncStatus: 'failed',
      lexicalOnly: true,
      freshness: { stale: true, lastKnownGood: true },
    });
    expect(rows[1]).toMatchObject({ value: 'Stale', tone: 'warning' });
    expect(rows[1]?.note).toBe('No successful sync is recorded.');
    expect(rows[2]?.value).toBe('Failed (showing last known good)');
    expect(rows[2]?.note).toBeTruthy();
    expect(rows[3]?.key).toBe('search');
  });

  it('formats ages', () => {
    expect(formatAge(5)).toBe('less than a minute');
    expect(formatAge(60)).toBe('1 minute');
    expect(formatAge(86400 * 3)).toBe('3 days');
  });
});

describe('feedback client calls', () => {
  it('posts a rating and deletes by anonymous ID', async () => {
    const seen: { url: string; method: string | undefined; body: unknown }[] = [];
    const client = createApiClient({
      baseUrl: 'https://api.example',
      fetchImpl: async (url, init) => {
        seen.push({
          url: String(url),
          method: init?.method,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        });
        const body =
          init?.method === 'DELETE'
            ? { deleted: 2 }
            : { anonymousId: 'a'.repeat(32), recorded: true };
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });
    const rec = await client.submitFeedback({
      bridgeId: 'b1',
      eventId: 'e',
      catalogVersion: 'v7',
      rating: 'up',
    });
    expect(rec.recorded).toBe(true);
    const del = await client.resetFeedback(rec.anonymousId);
    expect(del.deleted).toBe(2);
    expect(seen[0]).toMatchObject({ url: 'https://api.example/api/v1/feedback', method: 'POST' });
    expect(seen[1]).toMatchObject({
      url: `https://api.example/api/v1/feedback/${'a'.repeat(32)}`,
      method: 'DELETE',
    });
  });
});
