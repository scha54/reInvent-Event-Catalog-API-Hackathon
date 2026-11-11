import { describe, expect, it } from 'vitest';
import { BridgeSchema } from '@serendipity/packages-contracts';
import type { TopicRetrieval } from './retrieval.js';
import {
  ALGORITHM_VERSION,
  DEFAULT_WEIGHTS,
  effectiveWeights,
  scoreBridges,
  type ScorableSession,
} from './scoring.js';

const mk = (
  sessionId: string,
  title: string,
  abstract: string,
  track?: string,
): ScorableSession => ({ sessionId, title, abstract, track, topics: [] });

const sessions = new Map<string, ScorableSession>(
  [
    mk(
      's1',
      'Serverless at scale',
      'Lambda functions reduce energy consumption and idle cost.',
      'Compute',
    ),
    mk(
      's2',
      'Serverless event design',
      'Event driven patterns with queues and carbon aware scheduling.',
      'Compute',
    ),
    mk(
      'g1',
      'Sustainability in the cloud',
      'Measure energy consumption and carbon footprint.',
      'Sustainability',
    ),
    mk('g2', 'Green data centers', 'Carbon aware scheduling lowers emissions.', 'Sustainability'),
    mk('x1', 'Quantum basics', 'Qubits and gates.', 'Research'),
  ].map((s) => [s.sessionId, s]),
);

const retr = (topic: string, ids: [string, number][]): TopicRetrieval => ({
  topic,
  lexicalOnly: false,
  candidates: ids.map(([sessionId, relevance]) => ({
    sessionId,
    relevance,
    lexicalScore: 1,
    vectorScore: relevance,
    sources: ['vector'],
  })),
});

const A = retr('serverless', [
  ['s1', 0.9],
  ['s2', 0.8],
]);
const B = retr('sustainability', [
  ['g1', 0.85],
  ['g2', 0.7],
]);

describe('scoreBridges', () => {
  it('returns schema-valid, gated, scored bridges with algorithm version and config', () => {
    const r = scoreBridges({ catalogVersion: 'v1', retrievals: [A, B], sessions, seed: 1 });
    expect(r.noMatch).toBe(false);
    expect(r.algorithmVersion).toBe(ALGORITHM_VERSION);
    expect(r.config.scoring.weights).toEqual(DEFAULT_WEIGHTS);
    expect(r.bridges.length).toBeGreaterThan(0);
    for (const b of r.bridges) {
      expect(BridgeSchema.safeParse(b).success).toBe(true);
      if (b.sessionIds.length === 2) expect(b.evidence.length).toBeGreaterThanOrEqual(2);
      expect(b.scoreComponents.relevance).toBeGreaterThanOrEqual(r.config.scoring.minRelevance);
      expect(b.scoreComponents.bridgeStrength).toBeGreaterThanOrEqual(
        r.config.scoring.minBridgeStrength,
      );
    }
    expect(new Set(r.bridges.map((b) => b.id)).size).toBe(r.bridges.length);
  });

  it('is deterministic for fixed inputs and seed', () => {
    const run = () => scoreBridges({ catalogVersion: 'v1', retrievals: [A, B], sessions, seed: 7 });
    expect(run().bridges).toEqual(run().bridges);
  });

  it('returns noMatch when no pair shares evidence', () => {
    const C = retr('quantum', [['x1', 0.9]]);
    const r = scoreBridges({ catalogVersion: 'v1', retrievals: [A, C], sessions });
    expect(r.noMatch).toBe(true);
    expect(r.bridges).toEqual([]);
  });

  it('never returns candidates below the relevance floor, whatever the slider', () => {
    const lowA = retr('serverless', [['s1', 0.1]]);
    for (const novelty of [0, 0.5, 1]) {
      const r = scoreBridges({ catalogVersion: 'v1', retrievals: [lowA, B], sessions, novelty });
      expect(r.noMatch).toBe(true);
    }
  });

  it('applies the bridge strength gate', () => {
    const r = scoreBridges({
      catalogVersion: 'v1',
      retrievals: [A, B],
      sessions,
      config: { minBridgeStrength: 0.99 },
    });
    expect(r.noMatch).toBe(true);
  });

  it('skips retrieved sessions missing from the index', () => {
    const ghost = retr('serverless', [['ghost', 0.9]]);
    expect(scoreBridges({ catalogVersion: 'v1', retrievals: [ghost, B], sessions }).noMatch).toBe(
      true,
    );
  });

  it('respects limit', () => {
    const r = scoreBridges({ catalogVersion: 'v1', retrievals: [A, B], sessions, limit: 1 });
    expect(r.bridges).toHaveLength(1);
  });
});

describe('effectiveWeights (novelty slider)', () => {
  it('is identity at 0.5, sums to 1, and shifts weight toward novelty as slider rises', () => {
    const mid = effectiveWeights(DEFAULT_WEIGHTS, 0.5);
    expect(mid.relevance).toBeCloseTo(0.3, 10);
    const lo = effectiveWeights(DEFAULT_WEIGHTS, 0);
    const hi = effectiveWeights(DEFAULT_WEIGHTS, 1);
    for (const w of [lo, mid, hi]) {
      expect(w.relevance + w.bridgeStrength + w.novelty + w.diversity + w.quality).toBeCloseTo(
        1,
        10,
      );
    }
    expect(hi.novelty).toBeGreaterThan(lo.novelty);
    expect(hi.relevance).toBeLessThan(lo.relevance);
  });
});
