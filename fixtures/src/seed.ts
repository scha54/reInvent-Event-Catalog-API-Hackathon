/**
 * Demo seed (FR-12 12.1/12.2, FR-10 10.3, NFR-02 14.3).
 *
 * Builds a versioned snapshot (sessions + manifest) and a local search index from
 * raw Events API session records, reusing the production normalization, manifest
 * and index code. The same builder serves two origins:
 *
 * - `live-import`: records come from a real imported catalog (staged API pages).
 * - `offline-sample`: records come from the sanitized, fictional sample in
 *   `fixtures/demo/sample-catalog.json`. This is the offline fallback and is always
 *   labeled as such. It is never presented as live data.
 *
 * Nothing here invents sessions: every session in a snapshot comes from the input
 * records, and the origin and label travel with the snapshot.
 */
import {
  SessionSchema,
  SnapshotManifestSchema,
  type Session,
  type SnapshotManifest,
} from '@serendipity/packages-contracts';
import {
  retrieveForTopics,
  scoreBridges,
  validateTopics,
  type ScorableSession,
} from '@serendipity/packages-discovery';
import { LocalIndex } from '@serendipity/services-indexer';
import { buildManifest, normalizeSession } from '@serendipity/services-ingestion';
import { z } from 'zod';

export const SEED_FORMAT_VERSION = 1;
/** Embedding model marker for seeds: no embeddings are generated, retrieval is lexical-only. */
export const SEED_EMBEDDING_MODEL_VERSION = 'lexical-only';
export const OFFLINE_SAMPLE_EVENT_ID = 'sample-event';
/** Fixed build time so the committed offline snapshot is reproducible. */
export const OFFLINE_SAMPLE_BUILT_AT = '2026-01-01T00:00:00.000Z';

export const OFFLINE_SAMPLE_LABEL =
  'OFFLINE SAMPLE DATA: sanitized, fictional sessions used when no live catalog is available. These are not live catalog results.';

export const SeedOriginSchema = z.enum(['live-import', 'offline-sample']);
export type SeedOrigin = z.infer<typeof SeedOriginSchema>;

export const DemoPairSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  topicA: z.string().min(1),
  topicB: z.string().min(1),
  expectation: z.enum(['match', 'no-match']),
});
export type DemoPair = z.infer<typeof DemoPairSchema>;

export const DemoPairResultSchema = z.object({
  id: z.string(),
  expectation: z.enum(['match', 'no-match']),
  noMatch: z.boolean(),
  bridgeCount: z.number().int().nonnegative(),
  ok: z.boolean(),
});
export type DemoPairResult = z.infer<typeof DemoPairResultSchema>;

export const SeedMetaSchema = z.object({
  formatVersion: z.literal(SEED_FORMAT_VERSION),
  origin: SeedOriginSchema,
  /** Human-readable label that UIs must show with this data. */
  label: z.string().min(1),
  /** False for offline samples: results must never be presented as live. */
  live: z.boolean(),
  eventId: z.string().min(1),
  catalogVersion: z.string().min(1),
  builtAt: z.string().min(1),
  embeddingModelVersion: z.string().min(1),
  lexicalOnly: z.literal(true),
  sessionCount: z.number().int().nonnegative(),
  quarantinedCount: z.number().int().nonnegative(),
  source: z.string().min(1),
  demoPairs: z.array(DemoPairResultSchema),
});
export type SeedMeta = z.infer<typeof SeedMetaSchema>;

export interface SeedSnapshot {
  readonly meta: SeedMeta;
  readonly sessions: readonly Session[];
  readonly manifest: SnapshotManifest;
  /** Serialized `LocalIndex` document. */
  readonly indexJson: string;
}

export interface BuildSeedInput {
  /** Raw Events API session records (unvalidated). */
  readonly items: readonly unknown[];
  readonly eventId: string;
  readonly origin: SeedOrigin;
  /** ISO timestamp; injected for determinism. */
  readonly builtAt: string;
  /** Description of where the records came from (path, API event, ...). */
  readonly source: string;
  readonly demoPairs?: readonly DemoPair[];
  /** Override the generated catalog version. */
  readonly catalogVersion?: string;
}

export function defaultCatalogVersion(origin: SeedOrigin, builtAt: string): string {
  const stamp = builtAt.replace(/[-:.]/g, '');
  return `${origin === 'offline-sample' ? 'offline-sample' : 'seed'}-${stamp}`;
}

export function seedLabel(origin: SeedOrigin, builtAt: string): string {
  return origin === 'offline-sample'
    ? OFFLINE_SAMPLE_LABEL
    : `Seeded snapshot imported from a real catalog at ${builtAt}. It is not refreshed automatically.`;
}

/** Run the prevalidated demo pairs through the real retrieval and scoring code. */
export function validateDemoPairs(
  sessions: readonly Session[],
  indexJson: string,
  catalogVersion: string,
  pairs: readonly DemoPair[],
): DemoPairResult[] {
  const index = LocalIndex.deserialize(indexJson);
  const byId = new Map<string, ScorableSession>(sessions.map((s) => [s.sessionId, s]));
  return pairs.map((p) => {
    const validated = validateTopics([p.topicA, p.topicB]);
    if (!validated.ok) {
      return { id: p.id, expectation: p.expectation, noMatch: true, bridgeCount: 0, ok: false };
    }
    const retrievals = retrieveForTopics(
      index,
      validated.topics.map((topic) => ({ topic })),
    );
    const scored = scoreBridges({ catalogVersion, retrievals, sessions: byId, seed: 0 });
    const ok = p.expectation === 'match' ? !scored.noMatch : scored.noMatch;
    return {
      id: p.id,
      expectation: p.expectation,
      noMatch: scored.noMatch,
      bridgeCount: scored.bridges.length,
      ok,
    };
  });
}

/** Build the versioned snapshot and index from raw records. Throws if nothing valid remains. */
export function buildSeedSnapshot(input: BuildSeedInput): SeedSnapshot {
  const catalogVersion = input.catalogVersion ?? defaultCatalogVersion(input.origin, input.builtAt);
  const byId = new Map<string, Session>();
  let quarantinedCount = 0;
  input.items.forEach((raw, i) => {
    const r = normalizeSession(raw, {
      eventId: input.eventId,
      catalogVersion,
      ingestedAt: input.builtAt,
      rawRef: `${input.source}#${i}`,
    });
    if (r.ok) byId.set(r.session.sessionId, r.session);
    else quarantinedCount += 1;
  });
  if (byId.size === 0) throw new Error('Seed input has no valid sessions');

  const sessions = [...byId.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const manifest = {
    ...buildManifest(sessions, {
      eventId: input.eventId,
      catalogVersion,
      createdAt: input.builtAt,
      embeddingModelVersion: SEED_EMBEDDING_MODEL_VERSION,
    }),
  } as SnapshotManifest;
  const indexJson = LocalIndex.build({
    eventId: input.eventId,
    catalogVersion,
    embeddingModelVersion: SEED_EMBEDDING_MODEL_VERSION,
    sessions,
    embeddings: [],
  }).serialize();

  const demoPairs = validateDemoPairs(sessions, indexJson, catalogVersion, input.demoPairs ?? []);
  const meta: SeedMeta = {
    formatVersion: SEED_FORMAT_VERSION,
    origin: input.origin,
    label: seedLabel(input.origin, input.builtAt),
    live: input.origin === 'live-import',
    eventId: input.eventId,
    catalogVersion,
    builtAt: input.builtAt,
    embeddingModelVersion: SEED_EMBEDDING_MODEL_VERSION,
    lexicalOnly: true,
    sessionCount: sessions.length,
    quarantinedCount,
    source: input.source,
    demoPairs,
  };
  return { meta, sessions, manifest, indexJson };
}

/** Schema-check a snapshot read from disk or built in memory. Throws on any inconsistency. */
export function assertValidSeedSnapshot(snapshot: SeedSnapshot): SeedSnapshot {
  SeedMetaSchema.parse(snapshot.meta);
  const manifest = SnapshotManifestSchema.parse(snapshot.manifest);
  const sessions = snapshot.sessions.map((s) => SessionSchema.parse(s));
  if (snapshot.meta.origin === 'offline-sample' && snapshot.meta.live) {
    throw new Error('An offline sample must never be marked live');
  }
  if (
    manifest.catalogVersion !== snapshot.meta.catalogVersion ||
    manifest.recordCount !== sessions.length ||
    sessions.some((s) => s.catalogVersion !== snapshot.meta.catalogVersion)
  ) {
    throw new Error('Seed snapshot is inconsistent: manifest, sessions and meta disagree');
  }
  const index = LocalIndex.deserialize(snapshot.indexJson);
  if (index.key.catalogVersion !== snapshot.meta.catalogVersion) {
    throw new Error('Seed index does not match the snapshot catalog version');
  }
  return snapshot;
}
