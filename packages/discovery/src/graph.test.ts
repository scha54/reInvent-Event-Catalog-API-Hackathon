import { describe, expect, it } from 'vitest';
import { GraphSchema, type Bridge } from '@serendipity/packages-contracts';
import { buildGraph, type GraphSession } from './graph.js';
import type { TopicRetrieval } from './retrieval.js';

const sessions = new Map<string, GraphSession>(
  ['s1', 's2', 's3', 's4'].map((id) => [id, { sessionId: id, title: `Title ${id}`, track: 'T' }]),
);

const pair = (a: string, b: string): Bridge => ({
  id: `bridge:${a}|${b}`,
  sessionIds: [a, b],
  relationship: 'shared-concept',
  score: 0.7,
  scoreComponents: {
    relevance: 0.7,
    bridgeStrength: 0.7,
    novelty: 0.7,
    diversity: 1,
    quality: 0.5,
  },
  evidence: [
    { sessionId: a, field: 'title', excerpt: 'x' },
    { sessionId: b, field: 'abstract', excerpt: 'y' },
  ],
});

const retrievals: TopicRetrieval[] = [
  { topic: 'serverless', candidates: [{ sessionId: 's1', relevance: 0.8 }] },
  { topic: 'carbon', candidates: [{ sessionId: 's2', relevance: 0.6 }] },
] as unknown as TopicRetrieval[];

describe('buildGraph', () => {
  it('builds valid, referentially intact graph with typed edges', () => {
    const g = buildGraph({
      catalogVersion: 'v1',
      topics: ['serverless', 'carbon'],
      bridges: [pair('s1', 's2')],
      sessions,
      retrievals,
    });
    expect(GraphSchema.safeParse(g).success).toBe(true);
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(g.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
    expect(g.edges.map((e) => e.type).sort()).toEqual([
      'shared-concept',
      'topic-match',
      'topic-match',
    ]);
  });

  it('skips bridges with sessions missing from the catalog', () => {
    const g = buildGraph({
      catalogVersion: 'v1',
      topics: ['a'],
      bridges: [pair('s1', 'ghost')],
      sessions,
    });
    expect(g.nodes.map((n) => n.type)).toEqual(['topic']);
    expect(g.edges).toHaveLength(0);
  });

  it('enforces caps atomically', () => {
    const g = buildGraph({
      catalogVersion: 'v1',
      topics: ['a'],
      bridges: [pair('s1', 's2'), pair('s3', 's4')],
      sessions,
      maxNodes: 3,
    });
    expect(g.nodes.length).toBeLessThanOrEqual(3);
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(g.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
  });
});
