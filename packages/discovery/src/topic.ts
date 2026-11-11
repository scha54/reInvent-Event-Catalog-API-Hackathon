/**
 * Topic validation and normalization (FR-03, criteria 3.2 and 3.3).
 *
 * Topics must be 2-100 characters after normalization. Empty, oversized, or
 * malicious-looking input is rejected with a VALIDATION_ERROR failure.
 */
import type { ErrorCode } from '@serendipity/packages-contracts';

export const TOPIC_MIN_LENGTH = 2;
export const TOPIC_MAX_LENGTH = 100;

export type TopicValidationReason = 'EMPTY' | 'TOO_SHORT' | 'TOO_LONG' | 'UNSAFE' | 'NOT_STRING';

export interface TopicValidationError {
  readonly code: Extract<ErrorCode, 'VALIDATION_ERROR'>;
  readonly reason: TopicValidationReason;
  readonly message: string;
}

export type TopicValidationResult =
  | { readonly ok: true; readonly topic: string }
  | { readonly ok: false; readonly error: TopicValidationError };

/** Characters that never belong in a topic: control chars (incl. NUL). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
/** Zero-width and bidi-override characters are stripped during normalization. */
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** Markup, script, template, shell, path-traversal, and SQL-comment patterns. */
const UNSAFE_PATTERNS: readonly RegExp[] = [
  /[<>]/,
  /javascript\s*:/i,
  /\bon[a-z]+\s*=/i,
  /\$\{|\{\{|\}\}|`/,
  /\.\.[\\/]/,
  /;\s*--|\/\*|\*\//,
  /\b(?:union\s+select|drop\s+table|insert\s+into|delete\s+from)\b/i,
];

function fail(reason: TopicValidationReason, message: string): TopicValidationResult {
  return { ok: false, error: { code: 'VALIDATION_ERROR', reason, message } };
}

/** Normalize: NFKC, strip invisible chars, collapse whitespace, trim. */
export function normalizeTopic(raw: string): string {
  return raw.normalize('NFKC').replace(INVISIBLE_CHARS, '').replace(/\s+/g, ' ').trim();
}

/** Validate and normalize one topic. Never throws. */
export function validateTopic(raw: unknown): TopicValidationResult {
  if (typeof raw !== 'string') {
    return fail('NOT_STRING', 'Topic must be a string.');
  }
  // Control characters are checked on the raw input, before whitespace collapse.
  if (CONTROL_CHARS.test(raw.replace(/[\t\n\r]/g, ' '))) {
    return fail('UNSAFE', 'Topic contains unsupported characters.');
  }
  const topic = normalizeTopic(raw);
  const length = Array.from(topic).length;
  if (length === 0) {
    return fail('EMPTY', 'Topic must not be empty.');
  }
  if (length < TOPIC_MIN_LENGTH) {
    return fail('TOO_SHORT', `Topic must be at least ${TOPIC_MIN_LENGTH} characters.`);
  }
  if (length > TOPIC_MAX_LENGTH) {
    return fail('TOO_LONG', `Topic must be at most ${TOPIC_MAX_LENGTH} characters.`);
  }
  if (UNSAFE_PATTERNS.some((p) => p.test(topic))) {
    return fail('UNSAFE', 'Topic contains unsupported or potentially unsafe content.');
  }
  return { ok: true, topic };
}

/** Validate one or two topics; returns the first failure encountered. */
export function validateTopics(
  raw: unknown,
):
  | { readonly ok: true; readonly topics: readonly string[] }
  | { readonly ok: false; readonly error: TopicValidationError } {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2) {
    return {
      ok: false,
      error: { code: 'VALIDATION_ERROR', reason: 'EMPTY', message: 'Provide one or two topics.' },
    };
  }
  const topics: string[] = [];
  for (const item of raw as unknown[]) {
    const result = validateTopic(item);
    if (!result.ok) return result;
    topics.push(result.topic);
  }
  return { ok: true, topics };
}
