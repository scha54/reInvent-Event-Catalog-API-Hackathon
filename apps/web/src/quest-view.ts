/**
 * Pure view-model helpers for the quest stepper (FR-07). Session details come only from
 * the discover graph; schedule state is taken from the server and never inferred here.
 */
import type {
  Evidence,
  ExplainRequest,
  QuestRequest,
  QuestResponse,
  ScheduleStatus,
} from '@serendipity/packages-contracts';
import { safeHttpUrl, sessionOrFallback, type SessionInfo } from './bridge-view';

export const DEFAULT_QUEST_STEPS = 3;

/** The server re-derives the bridge from the same discovery inputs, so reuse them. */
export function buildQuestRequest(explain: ExplainRequest, bridgeId: string): QuestRequest {
  return { ...explain, bridgeId, steps: DEFAULT_QUEST_STEPS };
}

export interface ScheduleBadge {
  readonly status: ScheduleStatus;
  /** Visible text so status never depends on color or icon alone. */
  readonly label: string;
  readonly description: string;
}

export const SCHEDULE_BADGES: Readonly<Record<ScheduleStatus, ScheduleBadge>> = {
  scheduled: {
    status: 'scheduled',
    label: 'Scheduled',
    description: 'Has a known time with no detected overlap.',
  },
  unknown: {
    status: 'unknown',
    label: 'Schedule unknown',
    description: 'Start or end time is missing, so overlaps cannot be ruled out.',
  },
  conflict: {
    status: 'conflict',
    label: 'Schedule conflict',
    description: 'Overlaps in time with another step in this quest.',
  },
};

export interface QuestStepModel {
  readonly number: number;
  readonly session: SessionInfo;
  readonly reason: string;
  readonly evidence: readonly Evidence[];
  readonly badge: ScheduleBadge;
  /** Sessions this step overlaps with (titles), when conflicting. */
  readonly conflictsWith: readonly SessionInfo[];
  readonly conflictReasons: readonly string[];
  readonly alternatives: readonly SessionInfo[];
}

export interface QuestModel {
  readonly steps: readonly QuestStepModel[];
  readonly conflictCount: number;
  readonly unknownCount: number;
}

export function buildQuestModel(
  quest: QuestResponse,
  lookup: ReadonlyMap<string, SessionInfo>,
): QuestModel {
  const unknownIds = new Set(quest.unknownSchedule);
  const steps = quest.steps.map<QuestStepModel>((step, i) => {
    const session = sessionOrFallback(lookup, step.sessionId);
    const officialUrl = safeHttpUrl(step.officialUrl) ?? session.officialUrl;
    const related = quest.conflicts.filter((c) => c.sessionIds.includes(step.sessionId));
    // A step listed as unknown is never presented as conflict-free, whatever its own status says.
    const status: ScheduleStatus =
      related.length > 0
        ? 'conflict'
        : unknownIds.has(step.sessionId)
          ? 'unknown'
          : step.scheduleStatus;
    return {
      number: i + 1,
      session: { ...session, ...(officialUrl ? { officialUrl } : {}) },
      reason: step.reason,
      evidence: step.evidence,
      badge: SCHEDULE_BADGES[status],
      conflictsWith: related.map((c) =>
        sessionOrFallback(
          lookup,
          c.sessionIds[0] === step.sessionId ? c.sessionIds[1] : c.sessionIds[0],
        ),
      ),
      conflictReasons: related.flatMap((c) => (c.reason ? [c.reason] : [])),
      alternatives: (quest.alternatives[step.sessionId] ?? []).map((id) =>
        sessionOrFallback(lookup, id),
      ),
    };
  });
  return {
    steps,
    conflictCount: quest.conflicts.length,
    unknownCount: steps.filter((s) => s.badge.status === 'unknown').length,
  };
}
