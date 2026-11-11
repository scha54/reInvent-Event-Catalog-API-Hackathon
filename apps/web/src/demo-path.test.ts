import { describe, expect, it } from 'vitest';
import { DEMO_EXAMPLES } from './demo-examples';
import {
  DEMO_BUDGET_SECONDS,
  DEMO_STEPS,
  clampStep,
  formatDuration,
  totalDemoSeconds,
} from './demo-path';
import { buildQuestRequest } from './quest-view';

describe('demo path', () => {
  it('fits in under three minutes', () => {
    expect(totalDemoSeconds()).toBeLessThan(DEMO_BUDGET_SECONDS);
  });

  it('covers discovery, evidence, graph, and quest', () => {
    const ids = DEMO_STEPS.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['discover', 'evidence', 'graph', 'quest']));
  });

  it('runs all three prevalidated pairs, including one no-match', () => {
    const run = DEMO_STEPS.flatMap((s) => (s.example ? [s.example] : []));
    expect(run).toHaveLength(3);
    expect(new Set(run.map((e) => e.id))).toEqual(new Set(DEMO_EXAMPLES.map((e) => e.id)));
    expect(run.filter((e) => e.expectation === 'no-match')).toHaveLength(1);
  });

  it('formats durations and clamps step indexes', () => {
    expect(formatDuration(170)).toBe('2:50');
    expect(clampStep(-3)).toBe(0);
    expect(clampStep(99)).toBe(DEMO_STEPS.length - 1);
    expect(clampStep(Number.NaN)).toBe(0);
  });
});

describe('buildQuestRequest', () => {
  it('reuses discovery inputs and the catalog version', () => {
    const req = buildQuestRequest(
      { eventId: 'e1', catalogVersion: 'v1', topics: ['a b', 'c d'], novelty: 0.5 },
      'b1',
    );
    expect(req).toMatchObject({
      eventId: 'e1',
      catalogVersion: 'v1',
      bridgeId: 'b1',
      topics: ['a b', 'c d'],
      steps: 3,
    });
  });
});
