/**
 * Session normalization (task 3.1).
 *
 * Maps a raw Events API session to the canonical `Session` (design.md, "Canonical
 * Normalized Session"). Rules:
 * - `sessionId` is preserved exactly as received.
 * - Absent optional fields stay absent; nothing is fabricated. `abstract` and
 *   `topics` are required by the canonical schema, so they become "" / [] when absent.
 * - There is no URL field in the source (SPIKE.md), so `officialUrl` is never set.
 * - `searchableText` has labeled Title / Abstract / Tags lines; empty ones are omitted.
 * - Markup is stripped as text processing only; nothing is ever evaluated.
 * - `normalizeSession` never throws: it returns a Session or a quarantine record.
 *
 * Tag mapping (open decision 5 in SPIKE.md): `topics` = topics, areasOfInterest,
 * focusAreas, services (deduplicated, in that order). Tracks feed `track` and the
 * Tags line. Audience-style arrays (roles, industries, ...) are not used.
 */
import { createHash } from 'node:crypto';
import {
  SessionSchema,
  type QuarantineRecord,
  type Session,
} from '@serendipity/packages-contracts';
import { RawSessionSchema, type RawSession } from './events-api-adapter.js';

export interface NormalizeContext {
  readonly eventId: string;
  readonly catalogVersion: string;
  /** ISO timestamp of ingestion; injected for determinism. */
  readonly ingestedAt: string;
  /** Reference to the raw record for quarantine (e.g. S3 key + index). Defaults to the session ID. */
  readonly rawRef?: string;
}

export type NormalizeResult =
  | { readonly ok: true; readonly session: Session }
  | { readonly ok: false; readonly quarantine: QuarantineRecord };

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (
        !Number.isInteger(code) ||
        code < 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      )
        return ' ';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function removeTags(text: string): string {
  let out = text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<\/?[a-z!?][^>]*(?:>|$)/gi, ' ');
  // Lone "<" followed by a letter that never closed is handled above via `$`.
  out = out.replace(/<(?=[a-z/!?])/gi, ' ');
  return out;
}

/** Strip markup, decode entities, drop control characters and collapse whitespace. */
export function stripMarkup(input: string): string {
  let text = removeTags(input);
  text = decodeEntities(text);
  // Entities may have decoded into markup (e.g. &lt;b&gt;); strip once more.
  text = removeTags(text);
  return (
    text
      // eslint-disable-next-line no-control-regex -- intentionally removing control characters
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function cleanList(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const cleaned = stripMarkup(v);
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned);
      out.push(cleaned);
    }
  }
  return out;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Deterministic SHA-256 of the raw record (key order independent). */
export function computeSourceHash(raw: unknown): string {
  return createHash('sha256').update(stableStringify(raw)).digest('hex');
}

/**
 * Deterministic hash over normalized content. Volatile fields (`ingestedAt`,
 * `catalogVersion`, `sourceHash`) are excluded so identical content always
 * hashes identically across runs and snapshots.
 */
export function computeContentHash(session: object): string {
  const {
    ingestedAt: _i,
    catalogVersion: _c,
    sourceHash: _s,
    ...content
  } = session as Record<string, unknown>;
  void _i;
  void _c;
  void _s;
  return computeSourceHash(content);
}

/* ---------------------------- schedule helpers --------------------------- */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

function formatWall(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Offset in minutes of `timeZone` at the given wall-clock-as-UTC instant; undefined if the zone is unknown. */
function zoneOffsetMinutes(wallAsUtcMs: number, timeZone: string): number | undefined {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts: Record<string, number> = {};
    for (const p of fmt.formatToParts(new Date(wallAsUtcMs))) {
      if (p.type !== 'literal') parts[p.type] = Number(p.value);
    }
    const asUtc = Date.UTC(
      parts.year!,
      parts.month! - 1,
      parts.day!,
      parts.hour!,
      parts.minute!,
      parts.second!,
    );
    return Math.round((asUtc - wallAsUtcMs) / 60000);
  } catch {
    return undefined;
  }
}

function withOffset(wallMs: number, timeZone: string | undefined): string {
  const wall = formatWall(wallMs);
  if (!timeZone) return wall;
  const off = zoneOffsetMinutes(wallMs, timeZone);
  if (off === undefined) return wall;
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return `${wall}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function deriveSchedule(raw: RawSession): { startsAt?: string; endsAt?: string } {
  const st = raw.sessionTime;
  if (!st?.date || !st.time) return {};
  const d = DATE_RE.exec(st.date.trim());
  const t = TIME_RE.exec(st.time.trim());
  if (!d || !t) return {};
  const startMs = Date.UTC(
    Number(d[1]),
    Number(d[2]) - 1,
    Number(d[3]),
    Number(t[1]),
    Number(t[2]),
  );
  if (!Number.isFinite(startMs) || formatWall(startMs).slice(0, 10) !== st.date.trim()) return {};
  const tz = st.timezone?.trim() || undefined;
  const result: { startsAt?: string; endsAt?: string } = { startsAt: withOffset(startMs, tz) };
  const lenStr = st.length?.trim();
  if (lenStr && /^\d+$/.test(lenStr)) {
    const minutes = Number(lenStr);
    if (minutes > 0 && minutes <= 7 * 24 * 60)
      result.endsAt = withOffset(startMs + minutes * 60000, tz);
  }
  return result;
}

/* ------------------------------ normalization ---------------------------- */

function quarantine(
  ctx: NormalizeContext,
  raw: unknown,
  reason: string,
  now: string,
): NormalizeResult {
  let ref = ctx.rawRef;
  if (!ref) {
    const id = (raw as { sessionId?: unknown } | null | undefined)?.sessionId;
    ref = typeof id === 'string' && id.length > 0 ? id : 'unknown';
  }
  return {
    ok: false,
    quarantine: {
      rawRef: ref,
      reason,
      timestamp: now,
      ...(ctx.eventId ? { eventId: ctx.eventId } : {}),
    },
  };
}

export function buildSearchableText(parts: {
  title: string;
  abstract: string;
  tags: readonly string[];
}): string {
  const lines: string[] = [];
  if (parts.title) lines.push(`Title: ${parts.title}`);
  if (parts.abstract) lines.push(`Abstract: ${parts.abstract}`);
  if (parts.tags.length > 0) lines.push(`Tags: ${parts.tags.join('; ')}`);
  return lines.join('\n');
}

/** Normalize one raw record. Never throws. */
export function normalizeSession(raw: unknown, ctx: NormalizeContext): NormalizeResult {
  try {
    const parsed = RawSessionSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const where = first?.path.length ? first.path.join('.') : 'record';
      return quarantine(
        ctx,
        raw,
        `Invalid source record: ${where}: ${first?.message ?? 'schema violation'}`,
        ctx.ingestedAt,
      );
    }
    const src = parsed.data;
    if (src.sessionId.trim().length === 0)
      return quarantine(ctx, raw, 'Invalid source record: blank sessionId', ctx.ingestedAt);
    if (!ctx.eventId || !ctx.catalogVersion) {
      return quarantine(
        ctx,
        raw,
        'Missing eventId or catalogVersion in normalization context',
        ctx.ingestedAt,
      );
    }

    const title = stripMarkup(src.title);
    if (!title) return quarantine(ctx, raw, 'Invalid source record: empty title', ctx.ingestedAt);
    const abstract = stripMarkup(src.abstract ?? '');

    const tracks = cleanList(src.tracks);
    const topics = cleanList([
      ...(src.topics ?? []),
      ...(src.areasOfInterest ?? []),
      ...(src.focusAreas ?? []),
      ...(src.services ?? []),
    ]);
    const tags = cleanList([...tracks, ...topics]);

    const level = src.level ? stripMarkup(src.level) : '';
    const format = src.type ? stripMarkup(src.type) : '';
    const venueName = src.venue ? stripMarkup(src.venue) : '';
    const room = src.room ? stripMarkup(src.room) : '';
    const venue = [venueName, room].filter(Boolean).join(', ');
    const schedule = deriveSchedule(src);

    const content = {
      eventId: ctx.eventId,
      sessionId: src.sessionId,
      title,
      abstract,
      ...(tracks.length > 0 ? { track: tracks.join(', ') } : {}),
      topics,
      ...(level ? { level } : {}),
      ...(format ? { format } : {}),
      ...(schedule.startsAt ? { startsAt: schedule.startsAt } : {}),
      ...(schedule.endsAt ? { endsAt: schedule.endsAt } : {}),
      ...(venue ? { venue } : {}),
      searchableText: buildSearchableText({ title, abstract, tags }),
    };
    const candidate: Session = {
      ...content,
      catalogVersion: ctx.catalogVersion,
      sourceHash: computeContentHash(content),
      ingestedAt: ctx.ingestedAt,
    };
    const checked = SessionSchema.safeParse(candidate);
    if (!checked.success) {
      return quarantine(
        ctx,
        raw,
        `Normalized session failed schema: ${checked.error.issues[0]?.message ?? 'invalid'}`,
        ctx.ingestedAt,
      );
    }
    return { ok: true, session: checked.data };
  } catch (err) {
    return quarantine(
      ctx,
      raw,
      `Unexpected normalization error: ${err instanceof Error ? err.message : 'unknown'}`,
      ctx.ingestedAt,
    );
  }
}
