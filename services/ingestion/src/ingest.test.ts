import { describe, expect, it } from 'vitest';
import type { RawSessionPage } from './events-api-adapter.js';
import { InMemoryStores, ingestPage, ingestPages, sessionKey } from './ingest.js';
import { computeContentHash, normalizeSession } from './normalize.js';

const ctx = {
  eventId: 'evt',
  catalogVersion: 'v1',
  executionId: 'exec-1',
  ingestedAt: '2026-01-01T00:00:00.000Z',
};

function page(
  items: Array<Record<string, unknown>>,
  malformed: RawSessionPage['malformedItems'] = [],
): RawSessionPage {
  return {
    eventId: 'evt',
    pageNumber: 0,
    correlationId: 'c',
    items: items as unknown as RawSessionPage['items'],
    malformedItems: malformed,
  };
}

describe('content hash', () => {
  it('ignores markup noise, ingestedAt and catalogVersion', () => {
    const a = normalizeSession(
      { sessionId: 's1', title: '<b>Hello</b>  world' },
      { eventId: 'evt', catalogVersion: 'v1', ingestedAt: 'a' },
    );
    const b = normalizeSession(
      { sessionId: 's1', title: 'Hello world' },
      { eventId: 'evt', catalogVersion: 'v2', ingestedAt: 'b' },
    );
    expect(a.ok && b.ok && a.session.sourceHash === b.session.sourceHash).toBe(true);
  });

  it('changes when content changes', () => {
    expect(computeContentHash({ title: 'a' })).not.toBe(computeContentHash({ title: 'b' }));
  });
});

describe('ingestPage', () => {
  it('stages the raw page, quarantines malformed records and continues', async () => {
    const stores = new InMemoryStores();
    const r = await ingestPage(
      page(
        [
          { sessionId: 's1', title: 'Good' },
          { sessionId: 's2', title: '<p> </p>' },
        ],
        [{ index: 2, reason: 'bad shape', raw: { nope: 1 } }],
      ),
      ctx,
      stores,
    );
    expect(r.sessions.map((s) => s.sessionId)).toEqual(['s1']);
    expect(r.quarantined).toHaveLength(2);
    expect(r.sessions.length + r.quarantined.length).toBe(r.inputCount);
    expect(r.quarantined.every((q) => q.reason && q.timestamp === ctx.ingestedAt)).toBe(true);
    expect([...stores.rawPages.keys()][0]).toMatch(/^staging\/evt\/exec-1\/page-000000\.json$/);
  });

  it('is idempotent: re-ingesting identical content yields the same stored result', async () => {
    const stores = new InMemoryStores();
    const p = page([{ sessionId: 's1', title: 'Good' }], [{ index: 1, reason: 'x', raw: 1 }]);
    const first = await ingestPage(p, ctx, stores);
    const snapshot = [stores.sessionMap.size, stores.quarantineMap.size];
    const second = await ingestPage(p, { ...ctx, ingestedAt: '2027-01-01T00:00:00.000Z' }, stores);
    expect(first.written).toBe(1);
    expect(second.written).toBe(0);
    expect([stores.sessionMap.size, stores.quarantineMap.size]).toEqual(snapshot);
  });

  it('stores a changed session under a new content hash', async () => {
    const stores = new InMemoryStores();
    await ingestPage(page([{ sessionId: 's1', title: 'v1' }]), ctx, stores);
    await ingestPage(page([{ sessionId: 's1', title: 'v2' }]), ctx, stores);
    expect(stores.sessionMap.size).toBe(2);
  });

  it('ingestPages aggregates across pages', async () => {
    const stores = new InMemoryStores();
    async function* gen(): AsyncIterable<RawSessionPage> {
      yield page([{ sessionId: 'a', title: 'A' }]);
      yield { ...page([{ sessionId: 'b', title: 'B' }]), pageNumber: 1 };
    }
    const r = await ingestPages(gen(), ctx, stores);
    expect(r.sessions).toHaveLength(2);
    expect(stores.rawPages.size).toBe(2);
    expect(sessionKey('e', 's/1', 'h')).toBe('e/s%2F1/h');
  });
});
