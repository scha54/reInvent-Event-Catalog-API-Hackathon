/**
 * Demo seed CLI.
 *
 *   npm run seed -w @serendipity/fixtures -- --input <file|dir> --event-id <id> [--out <dir>]
 *       Build a versioned snapshot and index from a real imported catalog (staged Events API pages).
 *
 *   npm run seed:offline -w @serendipity/fixtures
 *       Rebuild the committed offline fallback snapshot from the sanitized sample catalog.
 *
 * A live import fails if no valid sessions are found. Demo pairs that do not behave as
 * expected on a live catalog are reported as warnings; the offline sample must satisfy all.
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  DEMO_DIR,
  OFFLINE_SNAPSHOT_DIR,
  SAMPLE_CATALOG_PATH,
  loadDemoPairs,
  readRawItems,
  writeSeedSnapshot,
} from './seed-io.js';
import {
  OFFLINE_SAMPLE_BUILT_AT,
  OFFLINE_SAMPLE_EVENT_ID,
  buildSeedSnapshot,
  type SeedSnapshot,
} from './seed.js';

function report(s: SeedSnapshot): void {
  const { meta } = s;
  console.log(`${meta.label}`);
  console.log(
    `catalogVersion=${meta.catalogVersion} sessions=${meta.sessionCount} quarantined=${meta.quarantinedCount}`,
  );
  for (const p of meta.demoPairs) {
    console.log(
      `  demo pair ${p.id}: ${p.ok ? 'ok' : 'UNEXPECTED'} (expected ${p.expectation}, bridges=${p.bridgeCount})`,
    );
  }
}

function main(): void {
  const { values } = parseArgs({
    options: {
      offline: { type: 'boolean', default: false },
      input: { type: 'string' },
      'event-id': { type: 'string' },
      out: { type: 'string' },
    },
  });
  const demoPairs = loadDemoPairs();

  if (values.offline) {
    const snapshot = buildSeedSnapshot({
      items: readRawItems(SAMPLE_CATALOG_PATH),
      eventId: OFFLINE_SAMPLE_EVENT_ID,
      origin: 'offline-sample',
      builtAt: OFFLINE_SAMPLE_BUILT_AT,
      source: 'fixtures/demo/sample-catalog.json',
      demoPairs,
    });
    if (snapshot.meta.demoPairs.some((p) => !p.ok)) {
      report(snapshot);
      throw new Error('Offline sample does not satisfy the prevalidated demo pairs');
    }
    writeSeedSnapshot(values.out ?? OFFLINE_SNAPSHOT_DIR, snapshot);
    report(snapshot);
    return;
  }

  if (!values.input || !values['event-id']) {
    throw new Error('Usage: --input <file|dir> --event-id <id> [--out <dir>]  (or --offline)');
  }
  const snapshot = buildSeedSnapshot({
    items: readRawItems(values.input),
    eventId: values['event-id'],
    origin: 'live-import',
    builtAt: new Date().toISOString(),
    source: values.input,
    demoPairs,
  });
  const out = values.out ?? join(DEMO_DIR, 'seed-output', snapshot.meta.catalogVersion);
  writeSeedSnapshot(out, snapshot);
  report(snapshot);
  console.log(`written to ${out}`);
}

main();
