import { describe, expect, it } from 'vitest';
import type { Bridge, DiscoverResponse } from '@serendipity/packages-contracts';
import { ApiError } from './api-client';
import {
  buildCards,
  buildExplanationView,
  buildSessionLookup,
  catalogNotices,
  describeApiError,
  safeHttpUrl,
  toPercent,
} from './bridge-view';

const comps = { relevance: 0.9, bridgeStrength: 0.5, novelty: 0.25, diversity: 0, quality: 1 };
const bridge = (id: string, score: number, sessionIds = ['s1']): Bridge => ({
  id,
  sessionIds,
  relationship: 'shared-concept',
  score,
  scoreComponents: comps,
  evidence: [{ sessionId: 's1', field: 'title', excerpt: 'Serverless at scale' }],
});
const response = (over: Partial<DiscoverResponse> = {}): DiscoverResponse => ({
  catalogVersion: 'v1',
  bridges: [],
  noMatch: false,
  ...over,
});

describe('bridge-view', () => {
  it('ranks cards by score and tolerates a missing graph', () => {
    const cards = buildCards(response({ bridges: [bridge('a', 0.4), bridge('b', 0.8)] }));
    expect(cards.map((c) => c.bridge.id)).toEqual(['b', 'a']);
    expect(cards[0]?.sessions[0]?.title).toBe('Session s1');
    expect(cards[0]?.scores.map((s) => s.percent)).toEqual([90, 50, 25, 0, 100]);
  });

  it('reads optional session fields from graph metadata and rejects unsafe URLs', () => {
    const lookup = buildSessionLookup({
      nodes: [
        {
          id: 'n1',
          type: 'session',
          label: 'Talk',
          catalogVersion: 'v1',
          metadata: { sessionId: 's1', officialUrl: 'javascript:alert(1)' },
        },
        {
          id: 'n2',
          type: 'session',
          label: 'Other',
          catalogVersion: 'v1',
          metadata: { sessionId: 's2', officialUrl: 'https://example.com/s2', track: 'AI' },
        },
      ],
      edges: [],
    });
    expect(lookup.get('s1')?.officialUrl).toBeUndefined();
    expect(lookup.get('s2')).toMatchObject({ track: 'AI', officialUrl: 'https://example.com/s2' });
    expect(safeHttpUrl('not a url')).toBeUndefined();
    expect(toPercent(2)).toBe(100);
  });

  it('separates observed evidence from inference', () => {
    const b = bridge('a', 0.5);
    expect(buildExplanationView(b, undefined)).toMatchObject({
      observed: b.evidence,
      inferred: [],
    });
    const supported = buildExplanationView(b, {
      status: 'supported',
      headline: 'H',
      connection: 'C',
      observedEvidence: b.evidence,
      inference: 'I',
      uncertainty: 'U',
    });
    expect(supported.inferred).toEqual(['C', 'I']);
    expect(supported.uncertainty).toBe('U');
    const insufficient = buildExplanationView(b, { status: 'insufficient_evidence' });
    expect(insufficient.insufficient).toBe(true);
    expect(insufficient.inferred).toEqual([]);
    expect(insufficient.uncertainty.length).toBeGreaterThan(0);
  });

  it('derives stale, last-known-good and degraded notices', () => {
    const notices = catalogNotices(
      response({
        degraded: true,
        freshness: { stale: true, lastKnownGood: true },
      }),
    );
    expect(notices.map((n) => n.kind)).toEqual(['last-known-good', 'stale', 'degraded']);
    expect(catalogNotices(response())).toEqual([]);
  });

  it('maps API errors to distinct views', () => {
    expect(describeApiError(new ApiError('THROTTLED', 'x', 429)).kind).toBe('throttled');
    expect(describeApiError(new ApiError('VERSION_CONFLICT', 'x', 409)).retryable).toBe(false);
    expect(describeApiError(new Error('boom')).kind).toBe('generic');
  });
});
