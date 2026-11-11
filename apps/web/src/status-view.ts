/**
 * Pure view-model helpers for the catalog status panel and feedback controls
 * (FR-01 1.7, FR-09 9.2/9.4, FR-12 12.2). All state is conveyed with visible text.
 */
import type { CatalogStatus } from '@serendipity/packages-contracts';

export type StatusTone = 'ok' | 'warning' | 'info';

export interface StatusRow {
  readonly key: 'version' | 'freshness' | 'sync' | 'search';
  readonly term: string;
  readonly value: string;
  readonly tone: StatusTone;
  /** Extra text explaining the value, e.g. the last-known-good label. */
  readonly note?: string;
}

export function formatAge(seconds: number): string {
  if (seconds < 60) return 'less than a minute';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

export function buildStatusRows(status: CatalogStatus): readonly StatusRow[] {
  const f = status.freshness;
  const rows: StatusRow[] = [
    { key: 'version', term: 'Catalog version', value: status.catalogVersion, tone: 'info' },
  ];

  const synced = f.lastSuccessfulSyncAt
    ? `Last successful sync: ${f.lastSuccessfulSyncAt}${
        f.ageSeconds !== undefined ? ` (${formatAge(f.ageSeconds)} ago)` : ''
      }.`
    : 'No successful sync is recorded.';
  rows.push({
    key: 'freshness',
    term: 'Freshness',
    value: f.stale ? 'Stale' : 'Fresh',
    tone: f.stale ? 'warning' : 'ok',
    note: synced,
  });

  const syncValue =
    status.lastSyncStatus === 'succeeded'
      ? 'Succeeded'
      : status.lastSyncStatus === 'failed'
        ? 'Failed'
        : status.lastSyncStatus === 'running'
          ? 'In progress'
          : 'Unknown';
  const lkgNote = f.lastKnownGood
    ? (f.lastKnownGoodLabel ??
      'The latest sync did not succeed, so this is the last known good catalog snapshot.')
    : undefined;
  rows.push({
    key: 'sync',
    term: 'Sync status',
    value: f.lastKnownGood ? `${syncValue} (showing last known good)` : syncValue,
    tone: f.lastKnownGood || status.lastSyncStatus === 'failed' ? 'warning' : 'ok',
    ...(lkgNote ? { note: lkgNote } : {}),
  });

  if (status.lexicalOnly) {
    rows.push({
      key: 'search',
      term: 'Search mode',
      value: 'Keyword only',
      tone: 'warning',
      note: 'Semantic search is unavailable for this catalog version.',
    });
  }
  return rows;
}

export type FeedbackRating = 'up' | 'down';

export interface FeedbackChoice {
  readonly rating: FeedbackRating;
  readonly label: string;
  readonly icon: string;
}

export const FEEDBACK_CHOICES: readonly FeedbackChoice[] = [
  { rating: 'up', label: 'Helpful', icon: '👍' },
  { rating: 'down', label: 'Not helpful', icon: '👎' },
];

export const FEEDBACK_PRIVACY_NOTE =
  'Nothing is sent unless you choose a rating. Only the rating, result ID, and catalog version are stored under a random ID for a limited time. You can delete it at any time.';
