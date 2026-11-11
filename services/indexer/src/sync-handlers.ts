/**
 * Step Functions `buildIndex` task (NFR-02 14.1/14.2, NFR-05 17.2).
 *
 * Assembles the BM25 + vector index for the candidate catalog version from the
 * staged sessions and the stored embeddings, and saves it under its versioned
 * key. It never touches the active catalog pointer, so a failure here leaves the
 * Last_Known_Good_Snapshot untouched. Sessions whose embeddings are not (yet)
 * available are indexed lexically only, and the state is flagged `lexicalOnly`.
 */
import {
  runStep,
  SyncStepError,
  type SyncDeps,
  type SyncDiffed,
  type SyncIndexed,
} from '@serendipity/services-ingestion';
import type { EmbeddingRecord } from './embedding-client.js';
import { LocalIndex, saveIndex, type IndexBlobStore, type IndexCache } from './local-index.js';
import type { EmbeddingStore } from './worker.js';

export interface BuildIndexDeps extends Pick<SyncDeps, 'artifacts' | 'metrics' | 'logger' | 'now'> {
  readonly embeddings: EmbeddingStore;
  readonly blobs: IndexBlobStore;
  readonly embeddingModelVersion: string;
  readonly cache?: IndexCache;
}

export function buildIndex(state: SyncDiffed, deps: BuildIndexDeps): Promise<SyncIndexed> {
  return runStep(deps, 'buildIndex', state, async (s) => {
    const sessions = await deps.artifacts.getSessions(s.eventId, s.catalogVersion);
    if (!sessions || sessions.length === 0) {
      throw new SyncStepError('buildIndex', 'No staged sessions to index');
    }

    const embeddings: EmbeddingRecord[] = [];
    for (const session of sessions) {
      if (session.searchableText.trim() === '') continue;
      const rec = await deps.embeddings.get({
        eventId: s.eventId,
        sessionId: session.sessionId,
        sourceHash: session.sourceHash,
        embeddingModelVersion: deps.embeddingModelVersion,
      });
      if (rec) embeddings.push(rec);
    }

    const index = LocalIndex.build({
      eventId: s.eventId,
      catalogVersion: s.catalogVersion,
      embeddingModelVersion: deps.embeddingModelVersion,
      sessions,
      embeddings,
    });
    await saveIndex(deps.blobs, index, deps.cache);

    const withText = sessions.filter((x) => x.searchableText.trim() !== '').length;
    return {
      ...s,
      embeddingModelVersion: deps.embeddingModelVersion,
      indexedSessionIds: [...index.sessionIds],
      lexicalOnly: !index.hasVectors || embeddings.length < withText,
    };
  });
}
