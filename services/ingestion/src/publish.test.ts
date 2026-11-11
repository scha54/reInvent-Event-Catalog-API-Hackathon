import { describe, expect, it } from 'vitest';
import type { Session } from '@serendipity/packages-contracts';
import { buildManifest } from './snapshot.js';
import {
  buildActiveVersionUpdate,
  createDynamoActiveVersionStore,
  publishSnapshot,
  type ActiveVersionStore,
  type SnapshotCandidate,
} from './publish.js';

function s(id: string, hash = `h-${id}`): Session {
  return {
    eventId: 'evt',
    sessionId: id,
    catalogVersion: 'v2',
    title: id,
    abstract: '',
    topics: [],
    sourceHash: hash,
    ingestedAt: '2026-01-01T00:00:00.000Z',
    searchableText: id,
  };
}

function candidate(overrides: Partial<SnapshotCandidate> = {}): SnapshotCandidate {
  const sessions = [s('a'), s('b')];
  const manifest = buildManifest(sessions, {
    eventId: 'evt',
    catalogVersion: 'v2',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  return { manifest, sessions, indexedSessionIds: ['a', 'b'], allPagesFetched: true, ...overrides };
}

function memoryStore(initial: string | undefined) {
  const state = { active: initial, previous: undefined as string | undefined, writes: 0 };
  const store: ActiveVersionStore = {
    compareAndSet(expected, next) {
      if (state.active !== expected) return Promise.resolve(false);
      state.previous = state.active;
      state.active = next;
      state.writes++;
      return Promise.resolve(true);
    },
  };
  return { state, store };
}

const okCheck = () => Promise.resolve(true);

describe('publishSnapshot', () => {
  it('publishes a complete, valid candidate and keeps the previous version', async () => {
    const { state, store } = memoryStore('v1');
    const r = await publishSnapshot({
      candidate: candidate(),
      expectedActiveVersion: 'v1',
      store,
      retrievalCheck: okCheck,
    });
    expect(r).toMatchObject({
      published: true,
      status: 200,
      activeCatalogVersion: 'v2',
      previousCatalogVersion: 'v1',
    });
    expect(state).toMatchObject({ active: 'v2', previous: 'v1' });
  });

  const failures: [string, Partial<SnapshotCandidate>, string][] = [
    ['missing pages', { allPagesFetched: false }, 'INCOMPLETE_SNAPSHOT'],
    ['record count shortfall', { expectedRecordCount: 3 }, 'INCOMPLETE_SNAPSHOT'],
    ['unindexed session', { indexedSessionIds: ['a'] }, 'INTEGRITY_FAILED'],
    ['orphan indexed session', { indexedSessionIds: ['a', 'b', 'z'] }, 'INTEGRITY_FAILED'],
    ['hash mismatch', { sessions: [s('a', 'changed'), s('b')] }, 'INTEGRITY_FAILED'],
  ];
  it.each(failures)('keeps the active version on %s', async (_n, override, code) => {
    const { state, store } = memoryStore('v1');
    const r = await publishSnapshot({
      candidate: candidate(override),
      expectedActiveVersion: 'v1',
      store,
      retrievalCheck: okCheck,
    });
    expect(r).toMatchObject({ published: false, code, activeCatalogVersion: 'v1' });
    expect(state).toMatchObject({ active: 'v1', writes: 0 });
  });

  it('keeps the active version when the retrieval check fails or throws', async () => {
    for (const check of [
      () => Promise.resolve({ ok: false, message: 'no hits' }),
      () => Promise.reject(new Error('boom')),
    ]) {
      const { state, store } = memoryStore('v1');
      const r = await publishSnapshot({
        candidate: candidate(),
        expectedActiveVersion: 'v1',
        store,
        retrievalCheck: check,
      });
      expect(r).toMatchObject({ published: false, code: 'RETRIEVAL_CHECK_FAILED', status: 422 });
      expect(state.active).toBe('v1');
    }
  });

  it('returns 409 on version conflict and leaves the concurrent version active', async () => {
    const { state, store } = memoryStore('v-other');
    const r = await publishSnapshot({
      candidate: candidate(),
      expectedActiveVersion: 'v1',
      store,
      retrievalCheck: okCheck,
    });
    expect(r).toMatchObject({ published: false, status: 409, code: 'VERSION_CONFLICT' });
    expect(state.active).toBe('v-other');
  });

  it('reports store errors without activating', async () => {
    const r = await publishSnapshot({
      candidate: candidate(),
      expectedActiveVersion: 'v1',
      store: { compareAndSet: () => Promise.reject(new Error('ddb down')) },
      retrievalCheck: okCheck,
    });
    expect(r).toMatchObject({ published: false, status: 500, code: 'STORE_ERROR' });
  });

  it('supports the first publish when no version is active', async () => {
    const { state, store } = memoryStore(undefined);
    const r = await publishSnapshot({
      candidate: candidate(),
      expectedActiveVersion: undefined,
      store,
      retrievalCheck: okCheck,
    });
    expect(r.published).toBe(true);
    expect(state.active).toBe('v2');
  });
});

describe('DynamoDB conditional update', () => {
  it('builds a conditional update on the expected version', () => {
    const u = buildActiveVersionUpdate({
      tableName: 't',
      key: { pk: 'CATALOG' },
      expected: 'v1',
      next: 'v2',
    });
    expect(u.ConditionExpression).toBe('#active = :expected');
    expect(u.ExpressionAttributeValues).toEqual({ ':next': { S: 'v2' }, ':expected': { S: 'v1' } });
    expect(
      buildActiveVersionUpdate({
        tableName: 't',
        key: { pk: 'C' },
        expected: undefined,
        next: 'v2',
      }).ConditionExpression,
    ).toBe('attribute_not_exists(#active)');
  });

  it('maps ConditionalCheckFailedException to false and rethrows others', async () => {
    const table = { tableName: 't', key: { pk: 'C' } };
    const failing = (name: string) =>
      createDynamoActiveVersionStore(
        { updateItem: () => Promise.reject(Object.assign(new Error('x'), { name })) },
        table,
      );
    await expect(
      failing('ConditionalCheckFailedException').compareAndSet('v1', 'v2'),
    ).resolves.toBe(false);
    await expect(failing('Other').compareAndSet('v1', 'v2')).rejects.toThrow();
  });
});
