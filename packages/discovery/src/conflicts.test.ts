import { describe, expect, it } from 'vitest';
import { detectScheduleConflicts } from './conflicts.js';

const t = (h: number, m = 0) =>
  `2025-12-01T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;

describe('detectScheduleConflicts', () => {
  it('reports overlapping known intervals', () => {
    const r = detectScheduleConflicts([
      { sessionId: 'a', startsAt: t(9), endsAt: t(10) },
      { sessionId: 'b', startsAt: t(9, 30), endsAt: t(11) },
    ]);
    expect(r.conflicts).toEqual([['a', 'b']]);
    expect(r.unknownSchedule).toEqual([]);
  });

  it('does not treat back-to-back sessions as conflicts', () => {
    const r = detectScheduleConflicts([
      { sessionId: 'a', startsAt: t(9), endsAt: t(10) },
      { sessionId: 'b', startsAt: t(10), endsAt: t(11) },
    ]);
    expect(r.conflicts).toEqual([]);
  });

  it('marks missing, invalid, or non-positive intervals as unknown, never conflicting', () => {
    const r = detectScheduleConflicts([
      { sessionId: 'a', startsAt: t(9), endsAt: t(10) },
      { sessionId: 'b' },
      { sessionId: 'c', startsAt: t(9), endsAt: 'garbage' },
      { sessionId: 'd', startsAt: t(9), endsAt: t(9) },
    ]);
    expect(r.conflicts).toEqual([]);
    expect(r.unknownSchedule).toEqual(['b', 'c', 'd']);
  });
});
