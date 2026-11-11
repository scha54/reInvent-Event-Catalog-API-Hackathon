import { describe, expect, it } from 'vitest';
import { createLogger, type Session } from '@serendipity/packages-contracts';
import type { SyncDiffed, MetricDatum } from '@serendipity/services-ingestion';
import { IndexCache, LocalIndex, indexObjectKey } from './local-index.js';
import { buildIndex, type BuildIndexDeps } from './sync-handlers.js';
import type { EmbeddingStore } from './worker.js';

const session = (id: string, text: string): Session =>
  ({
    eventId: 'evt',
    sessionId: id,
    catalogVersion: 'v2',
    title: id,
    searchableText: text,
    sourceHash: `h-${id}`,
  }) as unknown as Session;

const state = {
  eventId: 'evt',
  executionId: 'x',
  catalogVersion: 'v2',
  startedAt: 'now',
} as unknown as SyncDiffed;

function deps(sessions: Session[] | undefined, embedded: string[]) {
  const metrics: MetricDatum[] = [];
  const blobs = new Map<string, string>();
  const embeddings: EmbeddingStore = {
    get: (k) =>
      Promise.resolve(
        embedded.includes(k.sessionId)
          ? {
              eventId: k.eventId,
              catalogVersion: 'v2',
              sessionId: k.sessionId,
              embeddingModelVersion: k.embeddingModelVersion,
              sourceHash: k.sourceHash,
              vector: [1, 0],
            }
          : undefined,
      ),
    put: () => Promise.resolve(),
  };
  const d: BuildIndexDeps = {
    artifacts: {
      getSessions: () => Promise.resolve(sessions),
      putSessions: () => Promise.resolve(),
      putManifest: () => Promise.resolve(),
      getManifest: () => Promise.resolve(undefined),
    },
    metrics: { put: (m) => void metrics.push(m) },
    logger: createLogger({ sink: () => {} }),
    embeddings,
    blobs: {
      get: (k) => Promise.resolve(blobs.get(k)),
      put: (k, b) => (blobs.set(k, b), Promise.resolve()),
    },
    embeddingModelVersion: 'm1',
    cache: new IndexCache(),
  };
  return { d, metrics, blobs };
}

describe('buildIndex', () => {
  it('saves a versioned index and reports indexed session ids', async () => {
    const { d, blobs } = deps([session('a', 'serverless'), session('b', 'security')], ['a', 'b']);
    const out = await buildIndex(state, d);
    expect(out.indexedSessionIds.sort()).toEqual(['a', 'b']);
    expect(out.lexicalOnly).toBe(false);
    const raw = blobs.get(
      indexObjectKey({ eventId: 'evt', catalogVersion: 'v2', embeddingModelVersion: 'm1' }),
    );
    expect(LocalIndex.deserialize(raw as string).sessionIds).toHaveLength(2);
  });

  it('flags lexical-only when embeddings are missing', async () => {
    const { d } = deps([session('a', 'serverless'), session('b', 'security')], ['a']);
    expect((await buildIndex(state, d)).lexicalOnly).toBe(true);
  });

  it('fails with a failure metric and saves nothing when sessions are missing', async () => {
    const { d, metrics, blobs } = deps(undefined, []);
    await expect(buildIndex(state, d)).rejects.toThrow(/No staged sessions/);
    expect(blobs.size).toBe(0);
    expect(metrics).toEqual([
      { name: 'CatalogSyncFailures', value: 1, dimensions: { Step: 'buildIndex' } },
    ]);
  });
});
