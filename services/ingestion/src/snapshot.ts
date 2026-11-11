/**
 * Snapshot manifest and snapshot diffing (FR-02 2.1, 2.3; NFR-04 16.1).
 *
 * - `buildManifest` creates an immutable (deeply frozen) manifest for a snapshot.
 * - `diffSnapshots` compares a snapshot against the previous manifest and
 *   classifies sessions as added, modified, unchanged, or tombstoned. Only the
 *   changed (added + modified) sessions are returned for embedding, which keeps
 *   embedding cost proportional to catalog churn.
 */

import { SnapshotManifestSchema } from '@serendipity/packages-contracts';
import type { Session, SnapshotManifest } from '@serendipity/packages-contracts';

export const SNAPSHOT_SCHEMA_VERSION = '1';

export interface BuildManifestOptions {
  readonly eventId: string;
  readonly catalogVersion: string;
  /** Defaults to {@link SNAPSHOT_SCHEMA_VERSION}. */
  readonly schemaVersion?: string;
  /** ISO timestamp; injected for determinism. */
  readonly createdAt: string;
  readonly embeddingModelVersion?: string;
}

/** Dedupe by sessionId (last record wins) and sort for a deterministic result. */
function uniqueSessions(sessions: readonly Session[]): Session[] {
  const byId = new Map<string, Session>();
  for (const s of sessions) byId.set(s.sessionId, s);
  return [...byId.values()].sort((a, b) =>
    a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0,
  );
}

/** Build an immutable, schema-valid manifest from a snapshot's sessions. */
export function buildManifest(
  sessions: readonly Session[],
  opts: BuildManifestOptions,
): Readonly<SnapshotManifest> {
  const unique = uniqueSessions(sessions);
  const sessionHashes: Record<string, string> = {};
  for (const s of unique) sessionHashes[s.sessionId] = s.sourceHash;

  const manifest = SnapshotManifestSchema.parse({
    eventId: opts.eventId,
    catalogVersion: opts.catalogVersion,
    schemaVersion: opts.schemaVersion ?? SNAPSHOT_SCHEMA_VERSION,
    recordCount: unique.length,
    sessionHashes,
    createdAt: opts.createdAt,
    ...(opts.embeddingModelVersion !== undefined
      ? { embeddingModelVersion: opts.embeddingModelVersion }
      : {}),
  });
  Object.freeze(manifest.sessionHashes);
  return Object.freeze(manifest);
}

export interface SnapshotDiff {
  /** Sessions absent from the previous snapshot. */
  readonly added: Session[];
  /** Sessions present before with a different content hash. */
  readonly modified: Session[];
  /** Sessions present before with an identical content hash. */
  readonly unchanged: Session[];
  /** Session IDs present in the previous snapshot but missing from the current one. */
  readonly tombstoned: string[];
  /** added + modified: the only sessions that need (re-)embedding. */
  readonly changed: Session[];
}

/**
 * Diff the current sessions against the previous manifest. With no previous
 * manifest (first sync) every session is added.
 */
export function diffSnapshots(
  previous: Pick<SnapshotManifest, 'sessionHashes'> | undefined,
  currentSessions: readonly Session[],
): SnapshotDiff {
  const prev = previous?.sessionHashes ?? {};
  const current = uniqueSessions(currentSessions);
  const added: Session[] = [];
  const modified: Session[] = [];
  const unchanged: Session[] = [];
  const seen = new Set<string>();

  for (const s of current) {
    seen.add(s.sessionId);
    const prevHash = Object.hasOwn(prev, s.sessionId) ? prev[s.sessionId] : undefined;
    if (prevHash === undefined) added.push(s);
    else if (prevHash !== s.sourceHash) modified.push(s);
    else unchanged.push(s);
  }

  const tombstoned = Object.keys(prev)
    .filter((id) => !seen.has(id))
    .sort();

  return { added, modified, unchanged, tombstoned, changed: [...added, ...modified] };
}
