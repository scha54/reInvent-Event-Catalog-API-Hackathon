/**
 * Completeness checks and the atomic publish gate (FR-02 2.3, 2.4; NFR-02 14.2; FR-10 10.3).
 *
 * `publishSnapshot` activates a candidate catalog version only when every check
 * passes (completeness, referential integrity, sample retrieval) and a conditional
 * write against the currently active version succeeds. On ANY failure the active
 * version is left untouched, so the Last_Known_Good_Snapshot keeps being served.
 * The previous version is recorded on a successful publish for rollback.
 */

import type { Session, SnapshotManifest } from '@serendipity/packages-contracts';

export type PublishFailureCode =
  | 'INCOMPLETE_SNAPSHOT'
  | 'INTEGRITY_FAILED'
  | 'RETRIEVAL_CHECK_FAILED'
  | 'VERSION_CONFLICT'
  | 'STORE_ERROR';

export interface CheckIssue {
  readonly check: 'completeness' | 'integrity' | 'retrieval';
  readonly message: string;
}

/** Everything the gate needs to know about a candidate snapshot. */
export interface SnapshotCandidate {
  readonly manifest: Pick<
    SnapshotManifest,
    'eventId' | 'catalogVersion' | 'recordCount' | 'sessionHashes'
  >;
  /** All normalized sessions staged for this snapshot (tombstoned sessions excluded). */
  readonly sessions: readonly Session[];
  /** Session IDs present in the built vector index for this snapshot. */
  readonly indexedSessionIds: readonly string[];
  /** True only when every source page was fetched (no missing pages / truncated sync). */
  readonly allPagesFetched: boolean;
  /** Total record count the source reported/fetched, when known. */
  readonly expectedRecordCount?: number;
}

export interface CheckResult {
  readonly ok: boolean;
  readonly issues: readonly CheckIssue[];
}

/** Completeness: every page fetched and the record count matches expectations. */
export function checkCompleteness(candidate: SnapshotCandidate): CheckResult {
  const issues: CheckIssue[] = [];
  const { manifest, sessions } = candidate;
  const uniqueIds = new Set(sessions.map((s) => s.sessionId));

  if (!candidate.allPagesFetched) {
    issues.push({ check: 'completeness', message: 'Source pages are missing (sync incomplete)' });
  }
  if (sessions.length === 0) {
    issues.push({ check: 'completeness', message: 'Snapshot contains no sessions' });
  }
  if (manifest.recordCount !== uniqueIds.size) {
    issues.push({
      check: 'completeness',
      message: `Manifest recordCount ${manifest.recordCount} != staged sessions ${uniqueIds.size}`,
    });
  }
  if (
    candidate.expectedRecordCount !== undefined &&
    candidate.expectedRecordCount !== uniqueIds.size
  ) {
    issues.push({
      check: 'completeness',
      message: `Expected ${candidate.expectedRecordCount} records but staged ${uniqueIds.size}`,
    });
  }
  return { ok: issues.length === 0, issues };
}

/** Referential integrity: manifest, sessions and index agree with each other. */
export function checkReferentialIntegrity(candidate: SnapshotCandidate): CheckResult {
  const issues: CheckIssue[] = [];
  const { manifest, sessions } = candidate;
  const hashes = manifest.sessionHashes;
  const sessionIds = new Set<string>();

  for (const s of sessions) {
    sessionIds.add(s.sessionId);
    if (s.catalogVersion !== manifest.catalogVersion) {
      issues.push({
        check: 'integrity',
        message: `Session ${s.sessionId} has catalogVersion ${s.catalogVersion}, expected ${manifest.catalogVersion}`,
      });
    }
    if (s.eventId !== manifest.eventId) {
      issues.push({
        check: 'integrity',
        message: `Session ${s.sessionId} has a different eventId`,
      });
    }
    if (!Object.hasOwn(hashes, s.sessionId)) {
      issues.push({ check: 'integrity', message: `Session ${s.sessionId} missing from manifest` });
    } else if (hashes[s.sessionId] !== s.sourceHash) {
      issues.push({ check: 'integrity', message: `Session ${s.sessionId} hash mismatch` });
    }
  }
  for (const id of Object.keys(hashes)) {
    if (!sessionIds.has(id)) {
      issues.push({ check: 'integrity', message: `Manifest session ${id} has no staged record` });
    }
  }

  const indexed = new Set(candidate.indexedSessionIds);
  for (const id of sessionIds) {
    if (!indexed.has(id)) {
      issues.push({ check: 'integrity', message: `Session ${id} is not in the index` });
    }
  }
  for (const id of indexed) {
    if (!sessionIds.has(id)) {
      issues.push({ check: 'integrity', message: `Indexed session ${id} has no staged record` });
    }
  }
  return { ok: issues.length === 0, issues };
}

/** Sample retrieval hook: resolves true/{ok:true} when sample queries return sane results. */
export type RetrievalCheck = (
  candidate: SnapshotCandidate,
) => Promise<boolean | { ok: boolean; message?: string }>;

/**
 * Persistence port for the active catalog version. Implementations MUST perform
 * `compareAndSet` as one atomic conditional write (see {@link buildActiveVersionUpdate}).
 */
export interface ActiveVersionStore {
  /**
   * Set `activeCatalogVersion` to `next` (recording `expected` as the previous
   * version) only if the current value equals `expected` (`undefined` = no active
   * version yet). Returns false when the condition fails.
   */
  compareAndSet(expected: string | undefined, next: string): Promise<boolean>;
}

export interface PublishInput {
  readonly candidate: SnapshotCandidate;
  /** Active version observed when the sync began (`undefined` on first publish). */
  readonly expectedActiveVersion: string | undefined;
  readonly store: ActiveVersionStore;
  readonly retrievalCheck: RetrievalCheck;
}

export type PublishResult =
  | {
      readonly published: true;
      readonly status: 200;
      readonly activeCatalogVersion: string;
      readonly previousCatalogVersion: string | undefined;
    }
  | {
      readonly published: false;
      /** 409 for version conflicts, 422 for failed validation, 500 for store errors. */
      readonly status: 409 | 422 | 500;
      readonly code: PublishFailureCode;
      readonly issues: readonly CheckIssue[];
      /** Unchanged: the version that remains active. */
      readonly activeCatalogVersion: string | undefined;
    };

function fail(
  status: 409 | 422 | 500,
  code: PublishFailureCode,
  issues: readonly CheckIssue[],
  active: string | undefined,
): PublishResult {
  return { published: false, status, code, issues, activeCatalogVersion: active };
}

/**
 * Validate and atomically publish a candidate. Never throws for expected
 * failures; the active version is only changed by a successful conditional write.
 */
export async function publishSnapshot(input: PublishInput): Promise<PublishResult> {
  const { candidate, expectedActiveVersion, store } = input;
  const active = expectedActiveVersion;
  const next = candidate.manifest.catalogVersion;

  const completeness = checkCompleteness(candidate);
  if (!completeness.ok) return fail(422, 'INCOMPLETE_SNAPSHOT', completeness.issues, active);

  const integrity = checkReferentialIntegrity(candidate);
  if (!integrity.ok) return fail(422, 'INTEGRITY_FAILED', integrity.issues, active);

  if (next === active) {
    return fail(
      409,
      'VERSION_CONFLICT',
      [{ check: 'integrity', message: `Version ${next} is already active` }],
      active,
    );
  }

  try {
    const r = await input.retrievalCheck(candidate);
    const ok = typeof r === 'boolean' ? r : r.ok;
    if (!ok) {
      const message =
        typeof r === 'boolean'
          ? 'Sample retrieval check failed'
          : (r.message ?? 'Sample retrieval check failed');
      return fail(422, 'RETRIEVAL_CHECK_FAILED', [{ check: 'retrieval', message }], active);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sample retrieval check threw';
    return fail(422, 'RETRIEVAL_CHECK_FAILED', [{ check: 'retrieval', message }], active);
  }

  try {
    const swapped = await store.compareAndSet(active, next);
    if (!swapped) {
      return fail(
        409,
        'VERSION_CONFLICT',
        [{ check: 'integrity', message: 'Active catalog version changed during publish' }],
        active,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Active version store failed';
    return fail(500, 'STORE_ERROR', [{ check: 'integrity', message }], active);
  }

  return {
    published: true,
    status: 200,
    activeCatalogVersion: next,
    previousCatalogVersion: active,
  };
}

/* ------------------------------------------------------------------ */
/* DynamoDB conditional write                                          */
/* ------------------------------------------------------------------ */

export interface ActiveVersionUpdate {
  readonly TableName: string;
  readonly Key: Record<string, { S: string }>;
  readonly UpdateExpression: string;
  readonly ConditionExpression: string;
  readonly ExpressionAttributeNames: Record<string, string>;
  readonly ExpressionAttributeValues: Record<string, { S: string }>;
}

/**
 * Build the DynamoDB UpdateItem input for the atomic publish. The condition
 * guarantees the write only succeeds if the active version is still `expected`;
 * otherwise DynamoDB raises ConditionalCheckFailedException (mapped to 409).
 */
export function buildActiveVersionUpdate(params: {
  readonly tableName: string;
  readonly key: Record<string, string>;
  readonly expected: string | undefined;
  readonly next: string;
}): ActiveVersionUpdate {
  const Key = Object.fromEntries(Object.entries(params.key).map(([k, v]) => [k, { S: v }]));
  const names: Record<string, string> = {
    '#active': 'activeCatalogVersion',
    '#prev': 'previousCatalogVersion',
  };
  const values: Record<string, { S: string }> = { ':next': { S: params.next } };
  let update = 'SET #active = :next';
  let condition: string;
  if (params.expected === undefined) {
    condition = 'attribute_not_exists(#active)';
  } else {
    condition = '#active = :expected';
    values[':expected'] = { S: params.expected };
    update += ', #prev = :expected';
  }
  return {
    TableName: params.tableName,
    Key,
    UpdateExpression: update,
    ConditionExpression: condition,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

/** Minimal DynamoDB client surface (satisfied by an adapter over the AWS SDK). */
export interface ConditionalUpdateClient {
  updateItem(input: ActiveVersionUpdate): Promise<unknown>;
}

/** DynamoDB-backed {@link ActiveVersionStore}. */
export function createDynamoActiveVersionStore(
  client: ConditionalUpdateClient,
  table: { readonly tableName: string; readonly key: Record<string, string> },
): ActiveVersionStore {
  return {
    async compareAndSet(expected, next) {
      try {
        await client.updateItem(buildActiveVersionUpdate({ ...table, expected, next }));
        return true;
      } catch (err) {
        if (err instanceof Error && err.name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },
  };
}
