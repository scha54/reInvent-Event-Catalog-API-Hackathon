/**
 * Structured JSON logger with default redaction of prompts, tokens and
 * credential-like fields (Requirements 17.1, 17.3).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const REDACTED = '[REDACTED]';

/** Standard correlation fields emitted on every log line when known. */
export interface LogContext {
  requestId?: string | undefined;
  eventId?: string | undefined;
  catalogVersion?: string | undefined;
  operation?: string | undefined;
  latencyMs?: number | undefined;
  status?: string | number | undefined;
}

export type LogFields = LogContext & Record<string, unknown>;

/** Receives one serialized JSON line per log call. */
export type LogSink = (line: string, level: LogLevel) => void;

export interface LoggerOptions {
  sink?: LogSink;
  /** Base context merged into every entry (e.g. requestId). */
  context?: LogContext;
  /** Extra key patterns to redact in addition to the defaults. */
  redactKeys?: RegExp[];
  now?: () => Date;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger whose entries include the extra context. */
  child(context: LogContext): Logger;
}

/** Keys whose values are never logged (case-insensitive substring/pattern match). */
export const DEFAULT_REDACT_PATTERNS: readonly RegExp[] = [
  /prompt/i,
  /token/i,
  /secret/i,
  /password|passwd|pwd/i,
  /credential/i,
  /authorization/i,
  /api[-_]?key/i,
  /access[-_]?key/i,
  /private[-_]?key/i,
  /cookie/i,
  /session[-_]?key/i,
  /bearer/i,
  /signature/i,
];

const MAX_DEPTH = 6;

/** Heuristic value patterns for credentials embedded in free-form strings. */
const VALUE_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, // JWT
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key id
];

function redactString(value: string): string {
  let out = value;
  for (const re of VALUE_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/** Deep-copies `value`, replacing sensitive keys' values and credential-looking strings. */
export function redact(
  value: unknown,
  patterns: readonly RegExp[] = DEFAULT_REDACT_PATTERNS,
): unknown {
  return redactInner(value, patterns, 0, new WeakSet());
}

function redactInner(
  value: unknown,
  patterns: readonly RegExp[],
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? value.toString() : value;
  }
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  seen.add(value);
  try {
    if (value instanceof Error) {
      // Message may echo sensitive input; keep name and redacted message only.
      return { name: value.name, message: redactString(value.message) };
    }
    if (Array.isArray(value)) {
      return value.map((v) => redactInner(v, patterns, depth + 1, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = patterns.some((p) => p.test(k))
        ? REDACTED
        : redactInner(v, patterns, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

const defaultSink: LogSink = (line, level) => {
  console[level](line);
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());
  const patterns = [...DEFAULT_REDACT_PATTERNS, ...(options.redactKeys ?? [])];
  const base: LogContext = options.context ?? {};

  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    const merged: Record<string, unknown> = { ...base, ...(fields ?? {}) };
    const safe = redact(merged, patterns) as Record<string, unknown>;
    const entry = {
      timestamp: now().toISOString(),
      level,
      message: redactString(message),
      ...safe,
    };
    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({ timestamp: entry.timestamp, level, message: entry.message });
    }
    sink(line, level);
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (context) => createLogger({ ...options, sink, context: { ...base, ...context } }),
  };
}
