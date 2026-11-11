/**
 * Landing-page form model: client-side topic validation (reusing the discovery
 * package's rules so client and server agree) and request building.
 */
import type { DiscoverRequest } from '@serendipity/packages-contracts';
import { validateTopic } from '@serendipity/packages-discovery/topic';

export type TopicMode = 'pair' | 'single';

export interface DiscoverFormState {
  readonly mode: TopicMode;
  readonly topicA: string;
  readonly topicB: string;
  /** Novelty in [0,1]; higher favors more surprising bridges. */
  readonly novelty: number;
}

export interface FormErrors {
  readonly topicA?: string;
  readonly topicB?: string;
}

export type BuildResult =
  | { readonly ok: true; readonly request: DiscoverRequest }
  | { readonly ok: false; readonly errors: FormErrors };

export const DEFAULT_NOVELTY = 0.5;

export function clampNovelty(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_NOVELTY;
  return Math.min(1, Math.max(0, value));
}

export function buildDiscoverRequest(form: DiscoverFormState, eventId: string): BuildResult {
  let topicA: string | undefined;
  let topicB: string | undefined;
  let errorA: string | undefined;
  let errorB: string | undefined;

  const a = validateTopic(form.topicA);
  if (a.ok) topicA = a.topic;
  else errorA = a.error.message;

  if (form.mode === 'pair') {
    const b = validateTopic(form.topicB);
    if (b.ok) topicB = b.topic;
    else errorB = b.error.message;
  }

  if (topicA === undefined || (form.mode === 'pair' && topicB === undefined)) {
    const errors: { topicA?: string; topicB?: string } = {};
    if (errorA !== undefined) errors.topicA = errorA;
    if (errorB !== undefined) errors.topicB = errorB;
    return { ok: false, errors };
  }

  const topics = form.mode === 'pair' && topicB !== undefined ? [topicA, topicB] : [topicA];
  return {
    ok: true,
    request: { eventId, topics, novelty: clampNovelty(form.novelty) },
  };
}
