import { describe, expect, it } from 'vitest';
import { retrieveForTopic, type RetrievalIndex } from './retrieval.js';

function fakeIndex(
  lexical: [string, number][],
  vector: [string, number][],
  hasVectors = true,
): RetrievalIndex {
  return {
    hasVectors,
    searchLexical: () => lexical.map(([sessionId, score]) => ({ sessionId, score })),
    searchVector: () => vector.map(([sessionId, score]) => ({ sessionId, score })),
  };
}

describe('retrieveForTopic', () => {
  it('merges and deduplicates by session ID across retrievers', () => {
    const index = fakeIndex(
      [
        ['a', 9],
        ['b', 6],
      ],
      [
        ['b', 0.8],
        ['c', 0.7],
      ],
    );
    const r = retrieveForTopic({ index, topic: 'serverless', queryEmbedding: [1, 0] });
    const ids = r.candidates.map((c) => c.sessionId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(['a', 'b', 'c']);
    expect(r.candidates.find((c) => c.sessionId === 'b')?.sources).toEqual(['lexical', 'vector']);
    expect(r.lexicalOnly).toBe(false);
  });

  it('drops candidates below the relevance threshold', () => {
    const index = fakeIndex(
      [['weak', 0.1]],
      [
        ['low', 0.2],
        ['ok', 0.5],
      ],
    );
    const r = retrieveForTopic({
      index,
      topic: 'x topic',
      queryEmbedding: [1],
      config: { minRelevance: 0.3 },
    });
    expect(r.candidates.map((c) => c.sessionId)).toEqual(['ok']);
  });

  it('falls back to lexical only without a query embedding', () => {
    const index = fakeIndex([['a', 9]], [['v', 0.9]]);
    const r = retrieveForTopic({ index, topic: 'security' });
    expect(r.lexicalOnly).toBe(true);
    expect(r.candidates.map((c) => c.sessionId)).toEqual(['a']);
  });

  it('returns empty for unmatched topics', () => {
    const r = retrieveForTopic({ index: fakeIndex([], []), topic: 'nothing' });
    expect(r.candidates).toEqual([]);
  });
});
