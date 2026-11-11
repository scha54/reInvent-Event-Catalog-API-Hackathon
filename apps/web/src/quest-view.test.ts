import { describe, expect, it } from 'vitest';
import type { QuestResponse } from '@serendipity/packages-contracts';
import { buildQuestModel } from './quest-view';
import type { SessionInfo } from './bridge-view';

const lookup = new Map<string, SessionInfo>([
  ['s1', { sessionId: 's1', title: 'Lambda', officialUrl: 'https://example.com/s1' }],
  ['s2', { sessionId: 's2', title: 'Jazz' }],
  ['s3', { sessionId: 's3', title: 'Edge' }],
]);

const quest: QuestResponse = {
  catalogVersion: 'v1',
  bridgeId: 'b1',
  steps: [
    { sessionId: 's1', reason: 'Start', evidence: [], scheduleStatus: 'scheduled' },
    {
      sessionId: 's2',
      reason: 'Next',
      evidence: [],
      scheduleStatus: 'scheduled',
      officialUrl: 'javascript:x',
    },
    { sessionId: 's3', reason: 'End', evidence: [], scheduleStatus: 'scheduled' },
  ],
  conflicts: [{ sessionIds: ['s1', 's2'], reason: 'Same hour' }],
  unknownSchedule: ['s3'],
  alternatives: { s2: ['s3'] },
};

describe('buildQuestModel', () => {
  it('orders steps and derives badges, never marking unknown as scheduled', () => {
    const m = buildQuestModel(quest, lookup);
    expect(m.steps.map((s) => [s.number, s.badge.status])).toEqual([
      [1, 'conflict'],
      [2, 'conflict'],
      [3, 'unknown'],
    ]);
    expect(m.conflictCount).toBe(1);
    expect(m.unknownCount).toBe(1);
  });

  it('links conflicts, alternatives, and drops unsafe URLs', () => {
    const m = buildQuestModel(quest, lookup);
    expect(m.steps[0]?.conflictsWith[0]?.title).toBe('Jazz');
    expect(m.steps[1]?.alternatives[0]?.title).toBe('Edge');
    expect(m.steps[0]?.session.officialUrl).toBe('https://example.com/s1');
    expect(m.steps[1]?.session.officialUrl).toBeUndefined();
  });
});
