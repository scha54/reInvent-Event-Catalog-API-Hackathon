/**
 * File and store adapters for the demo seed: read raw catalog input, write and read
 * the snapshot directory, and expose a snapshot through the API's ports.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionSchema, SnapshotManifestSchema } from '@serendipity/packages-contracts';
import { indexObjectKey, type IndexBlobStore } from '@serendipity/services-indexer';
import {
  DemoPairSchema,
  SeedMetaSchema,
  assertValidSeedSnapshot,
  type DemoPair,
  type SeedSnapshot,
} from './seed.js';
import { z } from 'zod';

const fixturesRoot = fileURLToPath(new URL('..', import.meta.url));

export const DEMO_DIR = join(fixturesRoot, 'demo');
export const SAMPLE_CATALOG_PATH = join(DEMO_DIR, 'sample-catalog.json');
export const DEMO_PAIRS_PATH = join(DEMO_DIR, 'demo-pairs.json');
export const OFFLINE_SNAPSHOT_DIR = join(DEMO_DIR, 'offline-snapshot');

const SNAPSHOT_FILES = {
  meta: 'meta.json',
  sessions: 'sessions.json',
  manifest: 'manifest.json',
  index: 'index.json',
} as const;

function readJson(path: string): unknown {
  // Strip a UTF-8 BOM: some existing fixtures were written with one.
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

/** Extract `items` from a staged page or sample catalog document. */
function itemsOf(doc: unknown, path: string): unknown[] {
  const items = (doc as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new Error(`No "items" array in ${path}`);
  return items;
}

/**
 * Read raw session records from a JSON file, or from every `*.json` file in a
 * directory (sorted by name), such as staged Events API pages.
 */
export function readRawItems(inputPath: string): unknown[] {
  const abs = resolve(inputPath);
  if (statSync(abs).isDirectory()) {
    return readdirSync(abs)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .flatMap((f) => itemsOf(readJson(join(abs, f)), join(abs, f)));
  }
  return itemsOf(readJson(abs), abs);
}

export function loadDemoPairs(path = DEMO_PAIRS_PATH): DemoPair[] {
  const doc = readJson(path) as { pairs?: unknown };
  return z.array(DemoPairSchema).parse(doc.pairs);
}

export function writeSeedSnapshot(dir: string, snapshot: SeedSnapshot): void {
  mkdirSync(dir, { recursive: true });
  const write = (name: string, body: string) => writeFileSync(join(dir, name), body, 'utf8');
  write(SNAPSHOT_FILES.meta, `${JSON.stringify(snapshot.meta, null, 2)}\n`);
  write(SNAPSHOT_FILES.sessions, `${JSON.stringify(snapshot.sessions, null, 2)}\n`);
  write(SNAPSHOT_FILES.manifest, `${JSON.stringify(snapshot.manifest, null, 2)}\n`);
  write(SNAPSHOT_FILES.index, snapshot.indexJson);
}

/** Read and validate a snapshot directory written by {@link writeSeedSnapshot}. */
export function readSeedSnapshot(dir: string = OFFLINE_SNAPSHOT_DIR): SeedSnapshot {
  return assertValidSeedSnapshot({
    meta: SeedMetaSchema.parse(readJson(join(dir, SNAPSHOT_FILES.meta))),
    sessions: z.array(SessionSchema).parse(readJson(join(dir, SNAPSHOT_FILES.sessions))),
    manifest: SnapshotManifestSchema.parse(readJson(join(dir, SNAPSHOT_FILES.manifest))),
    indexJson: readFileSync(join(dir, SNAPSHOT_FILES.index), 'utf8'),
  });
}

/** In-memory ports over a snapshot so the API can serve it without AWS. */
export function seedPorts(snapshot: SeedSnapshot) {
  const { meta } = snapshot;
  const blobKey = indexObjectKey({
    eventId: meta.eventId,
    catalogVersion: meta.catalogVersion,
    embeddingModelVersion: meta.embeddingModelVersion,
  });
  const blobs: IndexBlobStore = {
    get: (key) => Promise.resolve(key === blobKey ? snapshot.indexJson : undefined),
    put: () => Promise.reject(new Error('Seed index is read-only')),
  };
  const artifacts = {
    getSessions: (eventId: string, catalogVersion: string) =>
      Promise.resolve(
        eventId === meta.eventId && catalogVersion === meta.catalogVersion
          ? [...snapshot.sessions]
          : undefined,
      ),
  };
  // The name carries the label so every status view shows what this data is.
  const state = {
    eventId: meta.eventId,
    name: meta.label,
    activeCatalogVersion: meta.catalogVersion,
    embeddingModelVersion: meta.embeddingModelVersion,
    sessionCount: meta.sessionCount,
    lastSuccessfulSyncAt: meta.builtAt,
    lexicalOnly: true,
  };
  return { blobs, artifacts, state };
}
