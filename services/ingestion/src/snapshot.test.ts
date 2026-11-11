import { describe, expect, it } from 'vitest';
import type { Session } from '@serendipity/packages-contracts';
import { buildManifest, diffSnapshots, SNAPSHOT_SCHEMA_VERSION } from './snapshot.js';

function s(id: string, hash: string): Session {
  return {
    eventId: 'evt',
    sessionId: id,
    catalogVersion: 'v1',
    title: id,
    abstract: '',
    topics: [],
    sourceHash: hash,
    ingestedAt: '2026-01-01T00:00:00.000Z',
    searchableText: id,
  };
}

const opts = { eventId: 'evt', catalogVersion: 'v1', createdAt: '2026-01-01T00:00:00.000Z' };

describe('buildManifest', () => {
  it('records count, hashes, versions and timestamp, and is immutable', () => {
    const m = buildManifest([s('b', 'h2'), s('a', 'h1')], {
      ...opts,
      embeddingModelVersion: 'emb-1',
    });
    expect(m.recordCount).toBe(2);
    expect(m.sessionHashes).toEqual({ a: 'h1', b: 'h2' });
    expect(m.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(m.catalogVersion).toBe('v1');
    expect(m.createdAt).toBe(opts.createdAt);
    expect(m.embeddingModelVersion).toBe('emb-1');
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m.sessionHashes)).toBe(true);
  });

  it('dedupes by session ID', () => {
    expect(buildManifest([s('a', 'h1'), s('a', 'h1')], opts).recordCount).toBe(1);
  });
});

describe('diffSnapshots', () => {
  it('treats everything as added on the first sync', () => {
    const d = diffSnapshots(undefined, [s('a', 'h1')]);
    expect(d.added.map((x) => x.sessionId)).toEqual(['a']);
    expect(d.changed).toHaveLength(1);
    expect(d.tombstoned).toEqual([]);
  });

  it('classifies added, modified, unchanged and tombstoned; changed excludes unchanged', () => {
    const prev = buildManifest([s('keep', 'h1'), s('edit', 'h2'), s('gone', 'h3')], opts);
    const d = diffSnapshots(prev, [s('keep', 'h1'), s('edit', 'h2b'), s('new', 'h4')]);
    expect(d.unchanged.map((x) => x.sessionId)).toEqual(['keep']);
    expect(d.modified.map((x) => x.sessionId)).toEqual(['edit']);
    expect(d.added.map((x) => x.sessionId)).toEqual(['new']);
    expect(d.tombstoned).toEqual(['gone']);
    expect(d.changed.map((x) => x.sessionId)).toEqual(['new', 'edit']);
  });

  it('returns no changes for an identical snapshot', () => {
    const list = [s('a', 'h1'), s('b', 'h2')];
    const d = diffSnapshots(buildManifest(list, opts), list);
    expect(d.changed).toEqual([]);
    expect(d.tombstoned).toEqual([]);
    expect(d.unchanged).toHaveLength(2);
  });

  it('is safe for IDs that collide with Object prototype keys', () => {
    const d = diffSnapshots(buildManifest([], opts), [s('constructor', 'h1')]);
    expect(d.added).toHaveLength(1);
  });
});
