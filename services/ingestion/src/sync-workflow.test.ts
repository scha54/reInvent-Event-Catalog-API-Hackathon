import { describe, expect, it } from 'vitest';
import { createLogger, type Session, type SnapshotManifest } from '@serendipity/packages-contracts';
import type { EventsApiAdapter, RawSessionPage } from './events-api-adapter.js';
import { InMemoryStores } from './ingest.js';
import type { ActiveVersionStore } from './publish.js';
import {
  diffAndEnqueue,
  fetchAndStage,
  normalizeStaged,
  publish,
  runChecks,
  startSync,
  type MetricDatum,
  type SyncDeps,
  type SyncIndexed,
  type SyncWorkItem,
} from './sync-workflow.js';

const EVENT = 'evt';

export function makePage(n: number, ids: string[], last: boolean, total?: number): RawSessionPage {
  return {
    eventId: EVENT,
    pageNumber: n,
    correlationId: 'c',
    ...(last ? {} : { nextToken: `t${n + 1}` }),
    ...(total !== undefined ? { totalCount: total } : {}),
    items: ids.map((id) => ({ sessionId: id, title: `Title ${id}`, abstract: `About ${id}` })),
    malformedItems: [],
  } as unknown as RawSessionPage;
}

interface Harness {
  deps: SyncDeps;
  active: { version: string | undefined };
  metrics: MetricDatum[];
  queue: SyncWorkItem[];
  manifests: Map<string, SnapshotManifest>;
  sessionSets: Map<string, Session[]>;
  casCalls: number;
}

function harness(opts: {
  pages: () => AsyncIterable<RawSessionPage>;
  active?: string | undefined;
  retrieval?: () => Promise<boolean>;
}): Harness {
  const mem = new InMemoryStores();
  const metrics: MetricDatum[] = [];
  const queue: SyncWorkItem[] = [];
  const manifests = new Map<string, SnapshotManifest>();
  const sessionSets = new Map<string, Session[]>();
  const active = { version: opts.active };
  const h = { casCalls: 0 } as Harness;
  const store: ActiveVersionStore = {
    compareAndSet: (expected, next) => {
      h.casCalls += 1;
      if (active.version !== expected) return Promise.resolve(false);
      active.version = next;
      return Promise.resolve(true);
    },
  };
  const adapter: EventsApiAdapter = {
    getEvent: () => Promise.reject(new Error('unused')),
    listAllSessions: () => opts.pages(),
  };
  h.deps = {
    adapter,
    staging: {
      putRawPage: (k, b) => mem.staging.putRawPage(k, b),
      listPageKeys: (p) => Promise.resolve([...mem.rawPages.keys()].filter((k) => k.startsWith(p))),
      getRawPage: (k) => Promise.resolve(mem.rawPages.get(k)),
    },
    sessions: mem.sessions,
    quarantine: mem.quarantine,
    artifacts: {
      putSessions: (e, v, s) => (sessionSets.set(`${e}/${v}`, [...s]), Promise.resolve()),
      getSessions: (e, v) => Promise.resolve(sessionSets.get(`${e}/${v}`)),
      putManifest: (m) => (manifests.set(`${m.eventId}/${m.catalogVersion}`, m), Promise.resolve()),
      getManifest: (e, v) => Promise.resolve(manifests.get(`${e}/${v}`)),
    },
    registry: { getActiveVersion: () => Promise.resolve(active.version) },
    queue: { sendBatch: (items) => (queue.push(...items), Promise.resolve()) },
    activeVersionStore: store,
    retrievalCheck: opts.retrieval ?? (() => Promise.resolve(true)),
    metrics: { put: (m) => void metrics.push(m) },
    logger: createLogger({ sink: () => {} }),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  };
  return Object.assign(h, { active, metrics, queue, manifests, sessionSets });
}

async function* pagesOf(...pages: RawSessionPage[]): AsyncGenerator<RawSessionPage> {
  for (const p of pages) yield p;
}

const input = { eventId: EVENT, executionId: 'exec-12345678' };

async function runThroughIndex(h: Harness): Promise<SyncIndexed> {
  const s1 = await startSync(input, h.deps);
  const s2 = await fetchAndStage(s1, h.deps);
  const s3 = await normalizeStaged(s2, h.deps);
  const s4 = await diffAndEnqueue(s3, h.deps);
  const sessions = h.sessionSets.get(`${EVENT}/${s4.catalogVersion}`) ?? [];
  return {
    ...s4,
    embeddingModelVersion: 'm1',
    indexedSessionIds: sessions.map((x) => x.sessionId),
    lexicalOnly: false,
  };
}

const failures = (h: Harness): MetricDatum[] =>
  h.metrics.filter((m) => m.name === 'CatalogSyncFailures' && m.value > 0);

describe('sync workflow happy path', () => {
  it('publishes a new version, enqueues changed sessions and emits metrics', async () => {
    const h = harness({
      pages: () => pagesOf(makePage(0, ['a', 'b'], false, 3), makePage(1, ['c'], true, 3)),
      active: undefined,
    });
    const indexed = await runThroughIndex(h);
    expect(h.queue.map((q) => q.sessionId).sort()).toEqual(['a', 'b', 'c']);
    await runChecks(indexed, h.deps);
    const out = await publish(indexed, h.deps);
    expect(h.active.version).toBe(out.catalogVersion);
    expect(failures(h)).toHaveLength(0);
    expect(h.metrics.some((m) => m.name === 'InvalidSessionCount' && m.value === 0)).toBe(true);
    expect(h.metrics.some((m) => m.name === 'CatalogSyncAge' && m.value === 0)).toBe(true);
  });

  it('enqueues only changed sessions on the next sync', async () => {
    const h = harness({ pages: () => pagesOf(makePage(0, ['a', 'b'], true, 2)) });
    const first = await runThroughIndex(h);
    await publish(first, h.deps);
    h.queue.length = 0;
    const second = await runThroughIndex(h);
    expect(second.expectedActiveVersion).toBe(first.catalogVersion);
    expect(second.enqueuedCount).toBe(0);
  });

  it('quarantines malformed records and counts them', async () => {
    const page = makePage(0, ['a'], true, 2);
    const withBad = {
      ...page,
      items: [...page.items, { notASession: true }],
    } as unknown as RawSessionPage;
    const h = harness({ pages: () => pagesOf(withBad) });
    const s = await normalizeStaged(
      await fetchAndStage(await startSync(input, h.deps), h.deps),
      h.deps,
    );
    expect(s.sessionCount).toBe(1);
    expect(s.quarantinedCount).toBe(1);
    expect(h.metrics.some((m) => m.name === 'InvalidSessionCount' && m.value === 1)).toBe(true);
  });
});

describe('failure leaves the active catalog unchanged', () => {
  it('fetch failure mid-walk: no publish attempted, failure metric emitted', async () => {
    async function* broken(): AsyncGenerator<RawSessionPage> {
      yield makePage(0, ['a'], false);
      throw new Error('Events API down');
    }
    const h = harness({ pages: broken, active: 'v-good' });
    const s1 = await startSync(input, h.deps);
    await expect(fetchAndStage(s1, h.deps)).rejects.toThrow('Events API down');
    expect(h.active.version).toBe('v-good');
    expect(h.casCalls).toBe(0);
    expect(failures(h)).toEqual([
      { name: 'CatalogSyncFailures', value: 1, dimensions: { Step: 'fetchAndStage' } },
    ]);
  });

  it('empty sync (no valid sessions) fails in normalize', async () => {
    const h = harness({ pages: () => pagesOf({ ...makePage(0, [], true) }), active: 'v-good' });
    const s2 = await fetchAndStage(await startSync(input, h.deps), h.deps);
    await expect(normalizeStaged(s2, h.deps)).rejects.toThrow(/No valid sessions/);
    expect(h.active.version).toBe('v-good');
    expect(failures(h)[0]?.dimensions).toEqual({ Step: 'normalizeStaged' });
  });

  it('missing indexed sessions fail runChecks and publish never flips the pointer', async () => {
    const h = harness({ pages: () => pagesOf(makePage(0, ['a', 'b'], true, 2)), active: 'v-good' });
    const indexed = await runThroughIndex(h);
    const partial = { ...indexed, indexedSessionIds: ['a'] };
    await expect(runChecks(partial, h.deps)).rejects.toThrow(/checks failed/);
    await expect(publish(partial, h.deps)).rejects.toThrow(/Publish refused/);
    expect(h.active.version).toBe('v-good');
    expect(h.casCalls).toBe(0);
    expect(failures(h).map((m) => m.dimensions?.['Step'])).toEqual(['runChecks', 'publish']);
  });

  it('failing sample retrieval check blocks publish', async () => {
    const h = harness({
      pages: () => pagesOf(makePage(0, ['a'], true, 1)),
      active: 'v-good',
      retrieval: () => Promise.resolve(false),
    });
    const indexed = await runThroughIndex(h);
    await expect(runChecks(indexed, h.deps)).rejects.toThrow();
    await expect(publish(indexed, h.deps)).rejects.toThrow(/RETRIEVAL_CHECK_FAILED/);
    expect(h.active.version).toBe('v-good');
  });

  it('truncated source (totalCount mismatch) is refused', async () => {
    const h = harness({ pages: () => pagesOf(makePage(0, ['a'], true, 5)), active: 'v-good' });
    const indexed = await runThroughIndex(h);
    await expect(publish(indexed, h.deps)).rejects.toThrow(/INCOMPLETE_SNAPSHOT/);
    expect(h.active.version).toBe('v-good');
  });

  it("concurrent version change yields a conflict and keeps the other writer's version", async () => {
    const h = harness({ pages: () => pagesOf(makePage(0, ['a'], true, 1)), active: 'v-old' });
    const indexed = await runThroughIndex(h);
    h.active.version = 'v-other'; // someone else published meanwhile
    await expect(publish(indexed, h.deps)).rejects.toThrow(/VERSION_CONFLICT/);
    expect(h.active.version).toBe('v-other');
  });
});
