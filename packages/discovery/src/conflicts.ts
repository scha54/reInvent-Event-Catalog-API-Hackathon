/** Minimal step shape needed for schedule analysis. */
export interface ScheduledStep {
  sessionId: string;
  startsAt?: string | undefined;
  endsAt?: string | undefined;
}

export interface ScheduleAnalysis {
  /** Pairs of session IDs whose known intervals overlap. */
  conflicts: Array<[string, string]>;
  /** Session IDs with missing or unusable times; never treated as conflict-free. */
  unknownSchedule: string[];
}

interface Interval {
  sessionId: string;
  start: number;
  end: number;
}

function parseInterval(step: ScheduledStep): Interval | null {
  if (!step.startsAt || !step.endsAt) return null;
  const start = Date.parse(step.startsAt);
  const end = Date.parse(step.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { sessionId: step.sessionId, start, end };
}

/**
 * Detect schedule conflicts among quest steps. Half-open intervals: back-to-back
 * sessions (end == start) do not overlap. Steps without a valid interval are
 * reported in `unknownSchedule` and never participate in conflicts.
 */
export function detectScheduleConflicts(steps: readonly ScheduledStep[]): ScheduleAnalysis {
  const known: Interval[] = [];
  const unknownSchedule: string[] = [];
  for (const step of steps) {
    const interval = parseInterval(step);
    if (interval) known.push(interval);
    else unknownSchedule.push(step.sessionId);
  }

  const conflicts: Array<[string, string]> = [];
  for (let i = 0; i < known.length; i++) {
    for (let j = i + 1; j < known.length; j++) {
      const a = known[i]!;
      const b = known[j]!;
      if (a.start < b.end && b.start < a.end) conflicts.push([a.sessionId, b.sessionId]);
    }
  }
  return { conflicts, unknownSchedule };
}
