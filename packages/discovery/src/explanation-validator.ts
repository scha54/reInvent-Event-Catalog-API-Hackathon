/**
 * Explanation_Validator and deterministic template fallback
 * (FR-05 5.2-5.5, FR-10 10.2).
 *
 * Model output is never trusted: JSON shape, cited session IDs, per-field excerpt
 * substrings, citation count, and the uncertainty statement are all checked
 * server-side against the supplied catalog records.
 */
import {
  ExplanationSchema,
  type Evidence,
  type EvidenceField,
  type Explanation,
  type Session,
} from '@serendipity/packages-contracts';

export interface ValidationContext {
  /** Canonical records supplied to the model; the evidence set for citations. */
  readonly sessions: readonly Session[];
  /** True when the bridge legitimately involves a single session (e.g. topic-match). */
  readonly singleSessionRelationship?: boolean;
}

export type ValidationIssueCode =
  | 'invalid_json'
  | 'schema'
  | 'unknown_session'
  | 'excerpt_mismatch'
  | 'insufficient_citations'
  | 'missing_uncertainty';

export interface ValidationIssue {
  readonly code: ValidationIssueCode;
  readonly message: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly explanation: Explanation }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/** Text of an evidence field for a session, or undefined when absent. */
function fieldTexts(session: Session, field: EvidenceField): string[] {
  switch (field) {
    case 'title':
      return [session.title];
    case 'abstract':
      return [session.abstract];
    case 'track':
      return session.track === undefined ? [] : [session.track];
    case 'topics':
      return [...session.topics, session.topics.join(', ')];
    case 'level':
      return session.level === undefined ? [] : [session.level];
    case 'format':
      return session.format === undefined ? [] : [session.format];
    case 'venue':
      return session.venue === undefined ? [] : [session.venue];
    case 'searchableText':
      return [session.searchableText];
  }
}

/** Exact, case-sensitive substring check of an excerpt against the cited field. */
export function excerptMatchesField(session: Session, evidence: Evidence): boolean {
  return fieldTexts(session, evidence.field).some((text) => text.includes(evidence.excerpt));
}

/**
 * Validate a model response (raw JSON text or an already-parsed object).
 * Accepts only schema-valid, fully grounded output. A schema-valid
 * `insufficient_evidence` response is an honest answer and is accepted.
 */
export function validateExplanation(raw: unknown, context: ValidationContext): ValidationResult {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        issues: [{ code: 'invalid_json', message: 'Response is not valid JSON' }],
      };
    }
  }

  const parsed = ExplanationSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: [{ code: 'schema', message: parsed.error.issues.map((i) => i.message).join('; ') }],
    };
  }
  const explanation = parsed.data;
  if (explanation.status === 'insufficient_evidence') return { ok: true, explanation };

  const issues: ValidationIssue[] = [];
  const byId = new Map(context.sessions.map((s) => [s.sessionId, s]));

  for (const ev of explanation.observedEvidence) {
    const session = byId.get(ev.sessionId);
    if (session === undefined) {
      issues.push({ code: 'unknown_session', message: `Unknown session ID: ${ev.sessionId}` });
    } else if (!excerptMatchesField(session, ev)) {
      issues.push({
        code: 'excerpt_mismatch',
        message: `Excerpt is not a substring of ${ev.field} for session ${ev.sessionId}`,
      });
    }
  }

  const cited = new Set(explanation.observedEvidence.map((e) => e.sessionId));
  const required = context.singleSessionRelationship === true ? 1 : 2;
  if (cited.size < required) {
    issues.push({
      code: 'insufficient_citations',
      message: `At least ${required} distinct session ID(s) must be cited`,
    });
  }

  if (explanation.uncertainty.trim() === '') {
    issues.push({ code: 'missing_uncertainty', message: 'Uncertainty statement is required' });
  }

  return issues.length === 0 ? { ok: true, explanation } : { ok: false, issues };
}

const FALLBACK_UNCERTAINTY =
  'This is a thematic inference from session titles and abstracts, not an official claim by the event.';

const MAX_EXCERPT_CHARS = 160;

/** First sentence-ish prefix of `text`, trimmed and capped; an exact substring of `text`. */
function leadingExcerpt(text: string): string {
  const trimmed = text.trim();
  const stop = trimmed.search(/[.!?](\s|$)/);
  const end = stop === -1 ? trimmed.length : stop + 1;
  return trimmed.slice(0, Math.min(end, MAX_EXCERPT_CHARS)).trim();
}

/**
 * Deterministic, evidence-based explanation built only from catalog fields.
 * Same input always yields the same output, and the result passes
 * `validateExplanation` for the same context. Returns `insufficient_evidence`
 * when the records cannot support a grounded claim.
 */
export function buildFallbackExplanation(context: ValidationContext): Explanation {
  const required = context.singleSessionRelationship === true ? 1 : 2;
  const observedEvidence: Evidence[] = [];
  const seen = new Set<string>();

  for (const s of context.sessions) {
    if (seen.has(s.sessionId)) continue;
    const title = s.title.trim();
    const abstract = leadingExcerpt(s.abstract);
    if (title !== '') {
      observedEvidence.push({ sessionId: s.sessionId, field: 'title', excerpt: title });
    } else if (abstract !== '') {
      observedEvidence.push({ sessionId: s.sessionId, field: 'abstract', excerpt: abstract });
    } else {
      continue;
    }
    seen.add(s.sessionId);
    if (title !== '' && abstract !== '') {
      observedEvidence.push({ sessionId: s.sessionId, field: 'abstract', excerpt: abstract });
    }
  }

  if (seen.size < required) {
    return {
      status: 'insufficient_evidence',
      reason: 'Not enough catalog evidence to explain a connection.',
      uncertainty: FALLBACK_UNCERTAINTY,
    };
  }

  const titles = context.sessions
    .filter((s) => seen.has(s.sessionId))
    .map((s) => (s.title.trim() !== '' ? s.title.trim() : s.sessionId));

  return {
    status: 'supported',
    headline: titles.join(' + '),
    connection: `A possible connection is between: ${titles.join('; ')}.`,
    observedEvidence,
    inference:
      'These sessions share thematic context in their catalog titles and abstracts, so together they may offer complementary perspectives.',
    uncertainty: FALLBACK_UNCERTAINTY,
  };
}
