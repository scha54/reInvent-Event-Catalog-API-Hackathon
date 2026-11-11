import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CORRELATION_HEADER,
  DisallowedHostError,
  PaginationError,
  createEventsApiAdapter,
} from './events-api-adapter.js';

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../../fixtures/events-api/${name}`, import.meta.url), 'utf8').replace(
      /^\uFEFF/,
      '',
    ),
  );

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('events api adapter', () => {
  it('follows nextToken across short pages until absent, sending tokens unchanged', async () => {
    const pages = ['sessions.page-1.json', 'sessions.page-2.json', 'sessions.page-3.json'].map(
      fixture,
    ) as Array<{ nextToken?: string; items: unknown[] }>;
    const urls: URL[] = [];
    const headers: Array<Headers> = [];
    let i = 0;
    const adapter = createEventsApiAdapter({
      getAccessToken: () => 'secret-token',
      fetch: (async (url: URL, init: RequestInit) => {
        urls.push(url);
        headers.push(new Headers(init.headers));
        return json(pages[i++]);
      }) as typeof fetch,
    });
    const got: string[] = [];
    for await (const page of adapter.listAllSessions('evt')) {
      got.push(...page.items.map((s) => s.sessionId));
    }
    expect(i).toBe(pages.length);
    expect(got.length).toBeGreaterThan(0);
    expect(urls[1]?.searchParams.get('nextToken')).toBe(pages[0]?.nextToken);
    expect(urls.every((u) => u.hostname === 'api.awsevents.com')).toBe(true);
    expect(headers[0]?.get('authorization')).toBe('Bearer secret-token');
    expect(headers[0]?.get(CORRELATION_HEADER)).toBeTruthy();
    expect(urls.some((u) => u.href.includes('secret-token'))).toBe(false);
  });

  it('detects repeated tokens and enforces the max-page guard', async () => {
    const loop = createEventsApiAdapter({
      fetch: (async () => json({ items: [], nextToken: 'same' })) as typeof fetch,
    });
    await expect(async () => {
      for await (const page of loop.listAllSessions('evt')) void page;
    }).rejects.toMatchObject({ kind: 'repeated-token' });

    let n = 0;
    const endless = createEventsApiAdapter({
      fetch: (async () => json({ items: [], nextToken: `t${n++}` })) as typeof fetch,
    });
    await expect(async () => {
      for await (const page of endless.listAllSessions('evt', { maxPages: 3 })) void page;
    }).rejects.toBeInstanceOf(PaginationError);
    expect(n).toBe(3);
  });

  it('maps getEvent to EventMeta and rejects non-allowlisted hosts', async () => {
    const adapter = createEventsApiAdapter({
      fetch: (async () => json(fixture('event.live-observed.json'))) as typeof fetch,
    });
    const meta = await adapter.getEvent('reinvent2026');
    expect(meta).toMatchObject({ eventId: 'reinvent2026', location: 'Las Vegas' });
    expect(() => createEventsApiAdapter({ baseUrl: 'https://evil.example.com' })).toThrow(
      DisallowedHostError,
    );
  });
});
