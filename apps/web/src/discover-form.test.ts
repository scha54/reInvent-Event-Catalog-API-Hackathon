import { describe, expect, it } from 'vitest';
import { DEMO_EXAMPLES } from './demo-examples';
import { buildDiscoverRequest, clampNovelty, type DiscoverFormState } from './discover-form';

const base: DiscoverFormState = { mode: 'pair', topicA: 'serverless', topicB: 'AI', novelty: 0.5 };

describe('buildDiscoverRequest', () => {
  it('trims and builds a two-topic request', () => {
    const r = buildDiscoverRequest({ ...base, topicA: '  serverless  ' }, 'evt');
    expect(r).toEqual({
      ok: true,
      request: { eventId: 'evt', topics: ['serverless', 'AI'], novelty: 0.5 },
    });
  });

  it('builds a one-topic request and ignores the second field', () => {
    const r = buildDiscoverRequest({ ...base, mode: 'single', topicB: '' }, 'evt');
    expect(r.ok && r.request.topics).toEqual(['serverless']);
  });

  it.each([
    ['empty', ''],
    ['one char', 'a'],
    ['oversized', 'x'.repeat(101)],
    ['unsafe', '<script>alert(1)</script>'],
  ])('rejects %s topic', (_name, value) => {
    const r = buildDiscoverRequest({ ...base, topicB: value }, 'evt');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.topicB).toBeTruthy();
  });

  it('clamps novelty into [0,1]', () => {
    expect(clampNovelty(5)).toBe(1);
    expect(clampNovelty(-1)).toBe(0);
    expect(clampNovelty(Number.NaN)).toBe(0.5);
  });
});

describe('demo examples', () => {
  it('has three valid pairs, one intentionally unsupported', () => {
    expect(DEMO_EXAMPLES).toHaveLength(3);
    expect(DEMO_EXAMPLES.filter((e) => e.expectation === 'no-match')).toHaveLength(1);
    for (const e of DEMO_EXAMPLES) {
      expect(buildDiscoverRequest({ ...base, topicA: e.topicA, topicB: e.topicB }, 'evt').ok).toBe(
        true,
      );
    }
  });
});
