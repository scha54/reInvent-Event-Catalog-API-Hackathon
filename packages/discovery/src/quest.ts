import type {
  Bridge,
  Evidence,
  Quest,
  QuestConflict,
  QuestStep,
  ScheduleStatus,
  Session,
} from '@serendipity/packages-contracts';

import { detectScheduleConflicts } from './conflicts.js';

export const QUEST_MIN_STEPS = 2;
export const QUEST_MAX_STEPS = 4;

export interface QuestPlannerInput {
  bridge: Bridge;
  /** Sessions that resolve in the active catalog, keyed by session ID. */
  catalog: ReadonlyMap<string, Session>;
  /** Adjacent-concept session IDs (e.g. index neighbors); unresolvable IDs are ignored. */
  adjacentSessionIds?: readonly string[];
  /** Desired step count; clamped to 2-4 and to the number of available candidates. */
  steps?: number;
}

export interface QuestPlan {
  quest: Quest;
  /** For each conflicting session ID, non-selected candidates that do not overlap any other step. */
  alternatives: Record<string, string[]>;
}

const WEIGHTS = { progression: 0.4, novelty: 0.3, diversity: 0.3 } as const;

function tokens(s: Session): Set<string> {
  const raw = [...s.topics, s.track ?? '', s.title].join(' ').toLowerCase();
  return new Set(raw.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function overlaps(a: Session, b: Session): boolean {
  return detectScheduleConflicts([a, b]).conflicts.length > 0;
}

function evidenceFor(session: Session, bridge: Bridge): Evidence[] {
  const fromBridge = bridge.evidence.filter((e) => e.sessionId === session.sessionId);
  if (fromBridge.length > 0) return fromBridge;
  // Fall back to the session's own catalog text (never fabricated).
  if (session.title.trim()) {
    return [{ sessionId: session.sessionId, field: 'title', excerpt: session.title }];
  }
  if (session.abstract.trim()) {
    return [
      { sessionId: session.sessionId, field: 'abstract', excerpt: session.abstract.slice(0, 200) },
    ];
  }
  return [];
}

function reasonFor(session: Session, inBridge: boolean, bridge: Bridge, index: number): string {
  const label = session.title.trim() || session.sessionId;
  if (inBridge) {
    return `Part of the ${bridge.relationship} bridge connecting these topics: "${label}" is step ${index + 1} of the progression.`;
  }
  return `Adjacent concept that extends the bridge with a different perspective: "${label}".`;
}

/**
 * Plan a 2-4 step quest from a bridge chain and adjacent concepts. Greedy selection
 * maximizes progression (bridge membership), novelty (topical distance from chosen
 * steps) and diversity (new track), preferring non-overlapping schedules. Source
 * sessions are never modified. Returns null when fewer than two distinct catalog
 * sessions are available.
 */
export function planQuest(input: QuestPlannerInput): QuestPlan | null {
  const { bridge, catalog } = input;
  const bridgeIds = new Set(bridge.sessionIds);

  const seen = new Set<string>();
  const pool: Session[] = [];
  for (const id of [...bridge.sessionIds, ...(input.adjacentSessionIds ?? [])]) {
    if (seen.has(id)) continue;
    seen.add(id);
    const s = catalog.get(id);
    if (s) pool.push(s);
  }

  const requested = Math.trunc(input.steps ?? 3);
  const target = Math.min(
    pool.length,
    Math.max(
      QUEST_MIN_STEPS,
      Math.min(QUEST_MAX_STEPS, Number.isFinite(requested) ? requested : 3),
    ),
  );
  if (pool.length < QUEST_MIN_STEPS) return null;

  const tok = new Map(pool.map((s) => [s.sessionId, tokens(s)]));
  const chosen: Session[] = [];
  const remaining = [...pool];

  while (chosen.length < target) {
    let best: Session | undefined;
    let bestScore = -Infinity;
    for (const c of remaining) {
      const progression = bridgeIds.has(c.sessionId) ? 1 : 0.5;
      const novelty =
        chosen.length === 0
          ? 1
          : 1 -
            Math.max(...chosen.map((s) => jaccard(tok.get(c.sessionId)!, tok.get(s.sessionId)!)));
      const diversity =
        chosen.length === 0 || chosen.every((s) => (s.track ?? '') !== (c.track ?? '')) ? 1 : 0;
      let score =
        WEIGHTS.progression * progression +
        WEIGHTS.novelty * novelty +
        WEIGHTS.diversity * diversity;
      // Prefer feasible nonoverlapping sequences.
      if (chosen.some((s) => overlaps(s, c))) score -= 1;
      if (score > bestScore || (score === bestScore && best && c.sessionId < best.sessionId)) {
        best = c;
        bestScore = score;
      }
    }
    if (!best) break;
    chosen.push(best);
    remaining.splice(remaining.indexOf(best), 1);
  }

  // Order: known start times first (chronological), then unknown in selection order.
  const startOf = (s: Session): number => {
    const t = s.startsAt ? Date.parse(s.startsAt) : NaN;
    return Number.isFinite(t) ? t : NaN;
  };
  const indexed = chosen.map((s, i) => ({ s, i }));
  const ordered = indexed
    .sort((x, y) => {
      const a = startOf(x.s);
      const b = startOf(y.s);
      if (!Number.isNaN(a) && !Number.isNaN(b) && a !== b) return a - b;
      return x.i - y.i;
    })
    .map((x) => x.s);

  const analysis = detectScheduleConflicts(ordered);
  const conflictIds = new Set(analysis.conflicts.flat());
  const unknownIds = new Set(analysis.unknownSchedule);

  const steps: QuestStep[] = ordered.map((s, i) => {
    const scheduleStatus: ScheduleStatus = conflictIds.has(s.sessionId)
      ? 'conflict'
      : unknownIds.has(s.sessionId)
        ? 'unknown'
        : 'scheduled';
    const step: QuestStep = {
      sessionId: s.sessionId,
      reason: reasonFor(s, bridgeIds.has(s.sessionId), bridge, i),
      evidence: evidenceFor(s, bridge),
      scheduleStatus,
    };
    if (s.officialUrl) step.officialUrl = s.officialUrl;
    return step;
  });

  const conflicts: QuestConflict[] = analysis.conflicts.map(([a, b]) => ({
    sessionIds: [a, b],
    reason: 'Scheduled times overlap',
  }));

  const alternatives: Record<string, string[]> = {};
  for (const id of conflictIds) {
    const others = ordered.filter((s) => s.sessionId !== id);
    alternatives[id] = remaining
      .filter((c) => !others.some((o) => overlaps(o, c)))
      .map((c) => c.sessionId)
      .sort();
  }

  return {
    quest: { steps, conflicts, unknownSchedule: analysis.unknownSchedule },
    alternatives,
  };
}
