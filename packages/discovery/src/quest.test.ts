import { QuestSchema, type Bridge, type Session } from '@serendipity/packages-contracts';
import { describe, expect, it } from 'vitest';
import { planQuest } from './quest.js';

const t = (h: number, m = 0) =>
  `2025-12-01T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;

function session(id: string, extra: Partial<Session> = {}): Session {
  return {
    eventId: 'e',
    sessionId: id,
    catalogVersion: 'v1',
    title: `Title ${id}`,
    abstract: 'abs',
    topics: [`topic${id}`],
    sourceHash: 'h',
    ingestedAt: '2025-01-01T00:00:00Z',
    searchableText: `Title ${id}`,
    ...extra,
  };
}

const bridge = (ids: string[]): Bridge => ({
  id: 'b1',
  sessionIds: ids,
  relationship: 'shared-concept',
  score: 0.8,
  scoreComponents: {
    relevance: 0.8,
    bridgeStrength: 0.8,
    novelty: 0.8,
    diversity: 0.8,
    quality: 0.8,
  },
  evidence: [{ sessionId: ids[0]!, field: 'title', excerpt: `Title ${ids[0]}` }],
});

const catalogOf = (...ss: Session[]) => new Map(ss.map((s) => [s.sessionId, s]));

describe('planQuest', () => {
  it('builds a valid quest with distinct catalog sessions and rationale', () => {
    const cat = catalogOf(session('a'), session('b'), session('c', { officialUrl: 'https://x/c' }));
    const plan = planQuest({
      bridge: bridge(['a', 'b']),
      catalog: cat,
      adjacentSessionIds: ['c', 'a', 'ghost'],
      steps: 3,
    })!;
    expect(QuestSchema.safeParse(plan.quest).success).toBe(true);
    const ids = plan.quest.steps.map((s) => s.sessionId);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => cat.has(id))).toBe(true);
    expect(plan.quest.steps.find((s) => s.sessionId === 'c')?.officialUrl).toBe('https://x/c');
    expect(plan.quest.steps.every((s) => s.reason.length > 0 && s.evidence.length > 0)).toBe(true);
  });

  it('marks missing times unknown and reports overlaps without altering sessions', () => {
    const a = session('a', { startsAt: t(9), endsAt: t(10) });
    const b = session('b', { startsAt: t(9, 30), endsAt: t(11) });
    const c = session('c');
    const d = session('d', { startsAt: t(13), endsAt: t(14) });
    const snapshot = JSON.stringify([a, b, c, d]);
    const plan = planQuest({
      bridge: bridge(['a', 'b']),
      catalog: catalogOf(a, b, c, d),
      adjacentSessionIds: ['c'],
      steps: 3,
    })!;
    expect(plan.quest.conflicts.length).toBeGreaterThan(0);
    expect(plan.quest.unknownSchedule).toContain('c');
    expect(plan.quest.steps.find((s) => s.sessionId === 'c')?.scheduleStatus).toBe('unknown');
    expect(JSON.stringify([a, b, c, d])).toBe(snapshot);
  });

  it('clamps step count and returns null with fewer than two resolvable sessions', () => {
    const cat = catalogOf(session('a'), session('b'), session('c'), session('d'), session('e'));
    const plan = planQuest({
      bridge: bridge(['a', 'b']),
      catalog: cat,
      adjacentSessionIds: ['c', 'd', 'e'],
      steps: 10,
    })!;
    expect(plan.quest.steps).toHaveLength(4);
    expect(planQuest({ bridge: bridge(['a', 'x']), catalog: catalogOf(session('a')) })).toBeNull();
  });
});
