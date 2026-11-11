import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDiscoveryService } from '../../services/api/src/catalog-handlers';
import { DEMO_EXAMPLES } from '../../apps/web/src/demo-examples';
import {
  OFFLINE_SNAPSHOT_DIR,
  SAMPLE_CATALOG_PATH,
  loadDemoPairs,
  readRawItems,
  readSeedSnapshot,
  seedPorts,
} from './seed-io';
import {
  OFFLINE_SAMPLE_BUILT_AT,
  OFFLINE_SAMPLE_EVENT_ID,
  OFFLINE_SAMPLE_LABEL,
  buildSeedSnapshot,
} from './seed';

const EVENTS_API_DIR = new URL('../events-api/', import.meta.url);
const pairs = loadDemoPairs();
const rebuild = () =>
  buildSeedSnapshot({
    items: readRawItems(SAMPLE_CATALOG_PATH),
    eventId: OFFLINE_SAMPLE_EVENT_ID,
    origin: 'offline-sample',
    builtAt: OFFLINE_SAMPLE_BUILT_AT,
    source: 'fixtures/demo/sample-catalog.json',
    demoPairs: pairs,
  });

describe('offline fallback snapshot', () => {
  const committed = readSeedSnapshot(OFFLINE_SNAPSHOT_DIR);

  it('is labeled as sample/offline data and never live', () => {
    expect(committed.meta.origin).toBe('offline-sample');
    expect(committed.meta.live).toBe(false);
    expect(committed.meta.label).toBe(OFFLINE_SAMPLE_LABEL);
    expect(committed.meta.label).toMatch(/not live/i);
  });

  it('only contains sessions from the sanitized sample catalog', () => {
    const ids = new Set(
      readRawItems(SAMPLE_CATALOG_PATH).map((r) => (r as { sessionId: string }).sessionId),
    );
    expect(committed.sessions.length).toBe(ids.size);
    for (const s of committed.sessions) {
      expect(ids.has(s.sessionId)).toBe(true);
      expect(s.title.startsWith('Sample:')).toBe(true);
    }
  });

  it('matches a fresh rebuild from the sample catalog', () => {
    const fresh = rebuild();
    expect(committed.meta).toEqual(fresh.meta);
    expect(committed.manifest).toEqual(fresh.manifest);
    expect(committed.sessions).toEqual(fresh.sessions);
    expect(committed.indexJson).toBe(fresh.indexJson);
  });

  it('passes all three prevalidated demo pairs', () => {
    expect(committed.meta.demoPairs.map((p) => [p.id, p.ok])).toEqual([
      ['serverless-sustainability', true],
      ['security-ai', true],
      ['unsupported-pairing', true],
    ]);
    expect(committed.meta.demoPairs[2]?.noMatch).toBe(true);
  });

  it('serves discovery through the API ports and exposes the offline label', async () => {
    const ports = seedPorts(committed);
    const svc = createDiscoveryService({
      state: {
        get: async (id) => (id === ports.state.eventId ? ports.state : undefined),
        list: async () => [ports.state],
      },
      artifacts: ports.artifacts,
      blobs: ports.blobs,
    });
    const ctx = { annotate: () => {}, logger: console } as never;
    const ok = await svc.run(ctx, {
      eventId: OFFLINE_SAMPLE_EVENT_ID,
      topics: ['serverless', 'sustainability'],
    });
    expect(ok.scored.noMatch).toBe(false);
    expect(ok.version).toBe(committed.meta.catalogVersion);
    expect(ports.state.name).toBe(OFFLINE_SAMPLE_LABEL);
    const none = await svc.run(ctx, {
      eventId: OFFLINE_SAMPLE_EVENT_ID,
      topics: ['medieval falconry', 'quantum knitting'],
    });
    expect(none.scored.noMatch).toBe(true);
  });
});

describe('demo pairs', () => {
  it('mirror the web demo examples', () => {
    expect(pairs).toEqual(DEMO_EXAMPLES.map((e) => ({ ...e })));
  });
});

describe('buildSeedSnapshot', () => {
  it('builds a live-import snapshot from staged API pages without the offline label', () => {
    const items = ['sessions.page-1.json', 'sessions.page-2.json', 'sessions.page-3.json'].flatMap(
      (f) => readRawItems(fileURLToPath(new URL(f, EVENTS_API_DIR))),
    );
    const snap = buildSeedSnapshot({
      items,
      eventId: 'evt-1',
      origin: 'live-import',
      builtAt: '2026-02-01T00:00:00.000Z',
      source: 'fixtures/events-api',
    });
    expect(snap.meta.live).toBe(true);
    expect(snap.meta.label).not.toMatch(/OFFLINE SAMPLE/);
    expect(snap.sessions.length).toBe(5);
    expect(snap.manifest.recordCount).toBe(5);
  });

  it('quarantines malformed records and rejects input with no valid sessions', () => {
    const base = {
      eventId: 'e',
      origin: 'live-import' as const,
      builtAt: '2026-02-01T00:00:00.000Z',
      source: 'x',
    };
    const mixed = buildSeedSnapshot({
      ...base,
      items: [{ sessionId: 'A', title: 'Ok' }, { nope: 1 }],
    });
    expect(mixed.meta.sessionCount).toBe(1);
    expect(mixed.meta.quarantinedCount).toBe(1);
    expect(() => buildSeedSnapshot({ ...base, items: [{ nope: 1 }] })).toThrow(/no valid sessions/);
  });
});
