/**
 * Pure view-model helpers for bridge result cards and the detail drawer.
 * Session details come only from the response graph; missing optional fields are
 * simply omitted and never fabricated.
 */
import type {
  Bridge,
  DiscoverResponse,
  Evidence,
  Explanation,
  Graph,
  ScoreComponents,
} from '@serendipity/packages-contracts';
import { ApiError } from './api-client';

export interface SessionInfo {
  readonly sessionId: string;
  readonly title: string;
  readonly track?: string;
  readonly startsAt?: string;
  readonly venue?: string;
  readonly officialUrl?: string;
}

/** Return the URL only when it is a well-formed http(s) URL, otherwise undefined. */
export function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Index session nodes of the (optional) graph by session ID. */
export function buildSessionLookup(graph: Graph | undefined): ReadonlyMap<string, SessionInfo> {
  const map = new Map<string, SessionInfo>();
  for (const node of graph?.nodes ?? []) {
    if (node.type !== 'session') continue;
    const md = node.metadata ?? {};
    const sessionId = md['sessionId'];
    if (!sessionId) continue;
    const officialUrl = safeHttpUrl(md['officialUrl']);
    map.set(sessionId, {
      sessionId,
      title: node.label || sessionId,
      ...(md['track'] ? { track: md['track'] } : {}),
      ...(md['startsAt'] ? { startsAt: md['startsAt'] } : {}),
      ...(md['venue'] ? { venue: md['venue'] } : {}),
      ...(officialUrl ? { officialUrl } : {}),
    });
  }
  return map;
}

export function sessionOrFallback(
  lookup: ReadonlyMap<string, SessionInfo>,
  sessionId: string,
): SessionInfo {
  return lookup.get(sessionId) ?? { sessionId, title: `Session ${sessionId}` };
}

export const SCORE_LABELS: Readonly<Record<keyof ScoreComponents, string>> = {
  relevance: 'Relevance',
  bridgeStrength: 'Bridge strength',
  novelty: 'Novelty',
  diversity: 'Diversity',
  quality: 'Quality',
};

export interface ScoreRow {
  readonly key: keyof ScoreComponents;
  readonly label: string;
  readonly percent: number;
}

export function toPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}

export function scoreRows(components: ScoreComponents): readonly ScoreRow[] {
  return (Object.keys(SCORE_LABELS) as (keyof ScoreComponents)[]).map((key) => ({
    key,
    label: SCORE_LABELS[key],
    percent: toPercent(components[key]),
  }));
}

export const RELATIONSHIP_LABELS: Readonly<Record<Bridge['relationship'], string>> = {
  'topic-match': 'Direct topic match',
  'shared-concept': 'Shared concept',
  'inferred-bridge': 'Inferred bridge',
};

export interface CardModel {
  readonly bridge: Bridge;
  readonly rank: number;
  readonly scorePercent: number;
  readonly relationshipLabel: string;
  readonly sessions: readonly SessionInfo[];
  readonly scores: readonly ScoreRow[];
  /** Short observed excerpt for the card summary, when any evidence exists. */
  readonly previewEvidence?: Evidence;
}

/** Cards are ranked by score (descending), ties broken by ID for stable ordering. */
export function buildCards(response: DiscoverResponse): readonly CardModel[] {
  const lookup = buildSessionLookup(response.graph);
  const sorted = [...response.bridges].sort(
    (a, b) => b.score - a.score || a.id.localeCompare(b.id),
  );
  return sorted.map((bridge, i) => {
    const preview = bridge.evidence[0];
    return {
      bridge,
      rank: i + 1,
      scorePercent: toPercent(bridge.score),
      relationshipLabel: RELATIONSHIP_LABELS[bridge.relationship],
      sessions: bridge.sessionIds.map((id) => sessionOrFallback(lookup, id)),
      scores: scoreRows(bridge.scoreComponents),
      ...(preview ? { previewEvidence: preview } : {}),
    };
  });
}

export type NoticeKind = 'stale' | 'last-known-good' | 'degraded';

export interface Notice {
  readonly kind: NoticeKind;
  /** Visible text prefix so status never relies on color alone. */
  readonly label: string;
  readonly message: string;
}

/** Catalog and degradation notices derived from the discover response (FR-10 10.2/10.3). */
export function catalogNotices(response: DiscoverResponse): readonly Notice[] {
  const notices: Notice[] = [];
  const f = response.freshness;
  if (f?.lastKnownGood) {
    notices.push({
      kind: 'last-known-good',
      label: 'Last known good catalog',
      message:
        f.lastKnownGoodLabel ??
        'The latest catalog sync did not succeed, so results come from the last successful snapshot.',
    });
  }
  if (f?.stale) {
    const when = f.lastSuccessfulSyncAt
      ? ` Last successful sync: ${f.lastSuccessfulSyncAt}.`
      : ' No successful sync is recorded.';
    notices.push({
      kind: 'stale',
      label: 'Catalog may be out of date',
      message: `Sessions may have changed since this catalog was built.${when}`,
    });
  }
  if (response.degraded) {
    notices.push({
      kind: 'degraded',
      label: 'Fallback search mode',
      message:
        'Semantic search is unavailable, so results use keyword matching only and may be less surprising.',
    });
  }
  return notices;
}

export type ErrorKind = 'throttled' | 'unavailable' | 'conflict' | 'network' | 'generic';

export interface ErrorView {
  readonly kind: ErrorKind;
  readonly label: string;
  readonly message: string;
  readonly retryable: boolean;
}

export function describeApiError(err: unknown): ErrorView {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'THROTTLED':
        return {
          kind: 'throttled',
          label: 'Rate limited',
          message: 'Too many requests right now. Wait a few seconds, then try again.',
          retryable: true,
        };
      case 'SERVICE_UNAVAILABLE':
        return {
          kind: 'unavailable',
          label: 'Service unavailable',
          message: 'The service is temporarily unavailable. Try again shortly.',
          retryable: true,
        };
      case 'VERSION_CONFLICT':
        return {
          kind: 'conflict',
          label: 'Catalog updated',
          message: 'The catalog changed since these results were produced. Run the search again.',
          retryable: false,
        };
      case 'NETWORK_ERROR':
        return {
          kind: 'network',
          label: 'Connection problem',
          message: 'Could not reach the service. Check your connection and try again.',
          retryable: true,
        };
      case 'VALIDATION_ERROR':
        return {
          kind: 'generic',
          label: 'Invalid request',
          message: err.message,
          retryable: false,
        };
      default:
    }
  }
  return {
    kind: 'generic',
    label: 'Something went wrong',
    message: 'Something went wrong. Please try again.',
    retryable: true,
  };
}

export interface ExplanationView {
  /** Source-fact excerpts, shown under "Observed evidence". */
  readonly observed: readonly Evidence[];
  /** Interpretation text, shown under "Inferred connection". */
  readonly inferred: readonly string[];
  readonly headline?: string;
  readonly uncertainty: string;
  readonly insufficient: boolean;
}

export const DEFAULT_UNCERTAINTY =
  'This connection is an interpretation of session titles and abstracts. It may not reflect what is actually presented.';

/**
 * Merge a bridge with its (optional) explanation. Observed evidence always comes from
 * catalog data; inference is shown only when the explanation supports it.
 */
export function buildExplanationView(
  bridge: Bridge,
  explanation: Explanation | undefined,
): ExplanationView {
  if (!explanation) {
    return {
      observed: bridge.evidence,
      inferred: [],
      uncertainty: DEFAULT_UNCERTAINTY,
      insufficient: false,
    };
  }
  if (explanation.status === 'insufficient_evidence') {
    return {
      observed: bridge.evidence,
      inferred: [],
      uncertainty: explanation.uncertainty ?? DEFAULT_UNCERTAINTY,
      insufficient: true,
    };
  }
  return {
    observed: explanation.observedEvidence,
    inferred: [explanation.connection, explanation.inference],
    headline: explanation.headline,
    uncertainty: explanation.uncertainty,
    insufficient: false,
  };
}
