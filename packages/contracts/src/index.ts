import { z } from 'zod';

export * from './logger';

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

const nonEmpty = z.string().min(1);
const unit = z.number().min(0).max(1);

/* ------------------------------------------------------------------ */
/* Catalog models                                                      */
/* ------------------------------------------------------------------ */

/** Event metadata; only identity is required, all catalog metadata is optional. */
export const EventMetaSchema = z.object({
  eventId: nonEmpty,
  name: z.string().optional(),
  description: z.string().optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  location: z.string().optional(),
  officialUrl: z.string().optional(),
});
export type EventMeta = z.infer<typeof EventMetaSchema>;

/** Canonical normalized session. Absent optional fields are never fabricated. */
export const SessionSchema = z.object({
  eventId: nonEmpty,
  sessionId: nonEmpty,
  catalogVersion: nonEmpty,
  title: z.string(),
  abstract: z.string(),
  track: z.string().optional(),
  topics: z.array(z.string()),
  level: z.string().optional(),
  format: z.string().optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  venue: z.string().optional(),
  officialUrl: z.string().optional(),
  sourceHash: nonEmpty,
  ingestedAt: z.string(),
  searchableText: z.string(),
});
export type Session = z.infer<typeof SessionSchema>;

/* ------------------------------------------------------------------ */
/* Evidence, scoring, bridges                                          */
/* ------------------------------------------------------------------ */

export const EvidenceFieldSchema = z.enum([
  'title',
  'abstract',
  'track',
  'topics',
  'level',
  'format',
  'venue',
  'searchableText',
]);
export type EvidenceField = z.infer<typeof EvidenceFieldSchema>;

export const EvidenceSchema = z.object({
  sessionId: nonEmpty,
  field: EvidenceFieldSchema,
  excerpt: nonEmpty,
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/** All components normalized to [0,1]. */
export const ScoreComponentsSchema = z.object({
  relevance: unit,
  bridgeStrength: unit,
  novelty: unit,
  diversity: unit,
  quality: unit,
});
export type ScoreComponents = z.infer<typeof ScoreComponentsSchema>;

export const RelationshipSchema = z.enum(['topic-match', 'shared-concept', 'inferred-bridge']);
export type Relationship = z.infer<typeof RelationshipSchema>;

export const BridgeSchema = z.object({
  id: nonEmpty,
  sessionIds: z.array(nonEmpty).min(1),
  relationship: RelationshipSchema,
  score: unit,
  scoreComponents: ScoreComponentsSchema,
  evidence: z.array(EvidenceSchema),
});
export type Bridge = z.infer<typeof BridgeSchema>;

/* ------------------------------------------------------------------ */
/* Graph                                                               */
/* ------------------------------------------------------------------ */

export const GraphNodeSchema = z.object({
  id: nonEmpty,
  type: z.enum(['topic', 'session']),
  label: z.string(),
  catalogVersion: nonEmpty,
  metadata: z.record(z.string(), z.string()).optional(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  id: nonEmpty,
  source: nonEmpty,
  target: nonEmpty,
  type: RelationshipSchema,
  weight: unit,
  supportingSessionIds: z.array(nonEmpty),
  evidence: z.array(EvidenceSchema).optional(),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const GraphSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
});
export type Graph = z.infer<typeof GraphSchema>;

/* ------------------------------------------------------------------ */
/* Quest                                                               */
/* ------------------------------------------------------------------ */

export const ScheduleStatusSchema = z.enum(['scheduled', 'unknown', 'conflict']);
export type ScheduleStatus = z.infer<typeof ScheduleStatusSchema>;

export const QuestStepSchema = z.object({
  sessionId: nonEmpty,
  reason: nonEmpty,
  evidence: z.array(EvidenceSchema),
  scheduleStatus: ScheduleStatusSchema,
  officialUrl: z.string().optional(),
});
export type QuestStep = z.infer<typeof QuestStepSchema>;

export const QuestConflictSchema = z.object({
  sessionIds: z.tuple([nonEmpty, nonEmpty]),
  reason: z.string().optional(),
});
export type QuestConflict = z.infer<typeof QuestConflictSchema>;

export const QuestSchema = z.object({
  steps: z.array(QuestStepSchema).min(2).max(4),
  conflicts: z.array(QuestConflictSchema),
  unknownSchedule: z.array(nonEmpty),
});
export type Quest = z.infer<typeof QuestSchema>;

/* ------------------------------------------------------------------ */
/* Explanation                                                         */
/* ------------------------------------------------------------------ */

const ExplanationSupportedSchema = z.object({
  status: z.literal('supported'),
  headline: nonEmpty,
  connection: nonEmpty,
  observedEvidence: z.array(EvidenceSchema).min(1),
  inference: nonEmpty,
  uncertainty: nonEmpty,
});

const ExplanationInsufficientSchema = z.object({
  status: z.literal('insufficient_evidence'),
  reason: z.string().optional(),
  uncertainty: z.string().optional(),
});

export const ExplanationSchema = z.discriminatedUnion('status', [
  ExplanationSupportedSchema,
  ExplanationInsufficientSchema,
]);
export type Explanation = z.infer<typeof ExplanationSchema>;

/* ------------------------------------------------------------------ */
/* Ingestion: snapshot manifest and quarantine                         */
/* ------------------------------------------------------------------ */

export const SnapshotManifestSchema = z.object({
  eventId: nonEmpty,
  catalogVersion: nonEmpty,
  schemaVersion: nonEmpty,
  recordCount: z.number().int().nonnegative(),
  /** sessionId -> content hash */
  sessionHashes: z.record(z.string(), nonEmpty),
  createdAt: z.string(),
  embeddingModelVersion: z.string().optional(),
});
export type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>;

export const QuarantineRecordSchema = z.object({
  rawRef: nonEmpty,
  reason: nonEmpty,
  timestamp: z.string(),
  eventId: z.string().optional(),
});
export type QuarantineRecord = z.infer<typeof QuarantineRecordSchema>;

/* ------------------------------------------------------------------ */
/* Feedback                                                            */
/* ------------------------------------------------------------------ */

export const FeedbackRequestSchema = z.object({
  bridgeId: nonEmpty,
  eventId: nonEmpty,
  catalogVersion: nonEmpty,
  rating: z.enum(['up', 'down']),
  anonymousId: z.string().optional(),
});
export type FeedbackRequest = z.infer<typeof FeedbackRequestSchema>;

/** `POST /api/v1/feedback` response: the rotating anonymous ID to use for later calls. */
export const FeedbackResponseSchema = z.object({
  anonymousId: nonEmpty,
  recorded: z.boolean(),
});
export type FeedbackResponse = z.infer<typeof FeedbackResponseSchema>;

/** `DELETE /api/v1/feedback/{anonymousId}` response. */
export const FeedbackResetResponseSchema = z.object({
  deleted: z.number().int().nonnegative(),
});
export type FeedbackResetResponse = z.infer<typeof FeedbackResetResponseSchema>;

/* ------------------------------------------------------------------ */
/* Discover request / response                                         */
/* ------------------------------------------------------------------ */

export const TOPIC_MIN_LENGTH = 2;
export const TOPIC_MAX_LENGTH = 100;

export const DiscoverRequestSchema = z.object({
  eventId: nonEmpty,
  topics: z.array(z.string().trim().min(TOPIC_MIN_LENGTH).max(TOPIC_MAX_LENGTH)).min(1).max(2),
  novelty: unit.optional(),
  limit: z.number().int().min(1).max(50).optional(),
  seed: z.number().int().optional(),
});
export type DiscoverRequest = z.infer<typeof DiscoverRequestSchema>;

/** Catalog freshness, including the labeled last-known-good indicator (FR-10 10.3). */
export const CatalogFreshnessSchema = z.object({
  lastSuccessfulSyncAt: z.string().optional(),
  ageSeconds: z.number().nonnegative().optional(),
  /** True when the catalog is older than the configured freshness window or never synced. */
  stale: z.boolean(),
  /** True when the latest sync did not succeed and the last known good snapshot is served. */
  lastKnownGood: z.boolean(),
  /** Human-readable label shown when `lastKnownGood` is true. */
  lastKnownGoodLabel: z.string().optional(),
});
export type CatalogFreshness = z.infer<typeof CatalogFreshnessSchema>;

export const DiscoverResponseSchema = z.object({
  catalogVersion: nonEmpty,
  bridges: z.array(BridgeSchema),
  noMatch: z.boolean(),
  graph: GraphSchema.optional(),
  degraded: z.boolean().optional(),
  freshness: CatalogFreshnessSchema.optional(),
  algorithmVersion: z.string().optional(),
});
export type DiscoverResponse = z.infer<typeof DiscoverResponseSchema>;

/* ------------------------------------------------------------------ */
/* Explain request / response                                          */
/* ------------------------------------------------------------------ */

/**
 * The bridge is identified by the path parameter; the server re-derives it from the
 * same discovery inputs so no client-supplied evidence is trusted.
 */
export const ExplainRequestSchema = z.object({
  eventId: nonEmpty,
  /** Required: the catalog version the bridge was discovered against. */
  catalogVersion: nonEmpty,
  topics: z.array(z.string().trim().min(TOPIC_MIN_LENGTH).max(TOPIC_MAX_LENGTH)).min(1).max(2),
  novelty: unit.optional(),
  seed: z.number().int().optional(),
});
export type ExplainRequest = z.infer<typeof ExplainRequestSchema>;

export const ExplainResponseSchema = z.object({
  catalogVersion: nonEmpty,
  bridgeId: nonEmpty,
  explanation: ExplanationSchema,
  source: z.enum(['model', 'cache', 'fallback']),
  fallbackReason: z.string().optional(),
});
export type ExplainResponse = z.infer<typeof ExplainResponseSchema>;

/* ------------------------------------------------------------------ */
/* Quest request / response                                            */
/* ------------------------------------------------------------------ */

/**
 * The bridge is identified by `bridgeId` and re-derived server-side from the same
 * discovery inputs; the catalog version is required so stale requests get 409.
 */
export const QuestRequestSchema = z.object({
  eventId: nonEmpty,
  catalogVersion: nonEmpty,
  bridgeId: nonEmpty.max(512),
  topics: z.array(z.string().trim().min(TOPIC_MIN_LENGTH).max(TOPIC_MAX_LENGTH)).min(1).max(2),
  novelty: unit.optional(),
  seed: z.number().int().optional(),
  /** Desired number of steps (2-4). */
  steps: z.number().int().min(2).max(4).optional(),
});
export type QuestRequest = z.infer<typeof QuestRequestSchema>;

export const QuestResponseSchema = z.object({
  catalogVersion: nonEmpty,
  bridgeId: nonEmpty,
  steps: QuestSchema.shape.steps,
  conflicts: QuestSchema.shape.conflicts,
  unknownSchedule: QuestSchema.shape.unknownSchedule,
  /** For each conflicting session ID, non-overlapping alternative session IDs. */
  alternatives: z.record(z.string(), z.array(z.string())),
});
export type QuestResponse = z.infer<typeof QuestResponseSchema>;

/* ------------------------------------------------------------------ */
/* Events list and catalog status                                      */
/* ------------------------------------------------------------------ */

export const CatalogStatusSchema = z.object({
  eventId: nonEmpty,
  name: z.string().optional(),
  catalogVersion: nonEmpty,
  sessionCount: z.number().int().nonnegative().optional(),
  lastSyncStatus: z.enum(['succeeded', 'failed', 'running']).optional(),
  /** True when only lexical search is available for this catalog version. */
  lexicalOnly: z.boolean(),
  freshness: CatalogFreshnessSchema,
});
export type CatalogStatus = z.infer<typeof CatalogStatusSchema>;

export const EventsListResponseSchema = z.object({
  events: z.array(CatalogStatusSchema),
});
export type EventsListResponse = z.infer<typeof EventsListResponseSchema>;

/* ------------------------------------------------------------------ */
/* Error envelope                                                      */
/* ------------------------------------------------------------------ */

export const ErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'THROTTLED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    requestId: z.string(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
