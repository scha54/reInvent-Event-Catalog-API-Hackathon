import { useEffect, useId, useRef, useState } from 'react';
import type { ApiClient } from './api-client';
import { describeApiError } from './bridge-view';
import { FEEDBACK_CHOICES, FEEDBACK_PRIVACY_NOTE, type FeedbackRating } from './status-view';

type Client = Pick<ApiClient, 'submitFeedback' | 'resetFeedback'>;

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'message'; readonly text: string; readonly urgent: boolean };

function useMountedGuard() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

export interface FeedbackControlsProps {
  readonly client: Client;
  readonly bridgeId: string;
  readonly eventId: string;
  readonly catalogVersion: string;
  /** Rotating anonymous ID held in memory only; undefined until the first rating. */
  readonly anonymousId: string | undefined;
  readonly onAnonymousIdChange: (id: string | undefined) => void;
}

/** Thumbs up/down. Nothing is sent until the user activates a button (FR-09 9.2). */
export function FeedbackControls({
  client,
  bridgeId,
  eventId,
  catalogVersion,
  anonymousId,
  onAnonymousIdChange,
}: FeedbackControlsProps) {
  const headingId = useId();
  const mounted = useMountedGuard();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [chosen, setChosen] = useState<FeedbackRating | undefined>();

  // A new result or a reset elsewhere clears any prior selection.
  useEffect(() => {
    setChosen(undefined);
    setPhase({ kind: 'idle' });
  }, [bridgeId]);
  useEffect(() => {
    if (anonymousId === undefined) setChosen(undefined);
  }, [anonymousId]);

  async function rate(rating: FeedbackRating) {
    setPhase({ kind: 'busy' });
    try {
      const res = await client.submitFeedback({
        bridgeId,
        eventId,
        catalogVersion,
        rating,
        ...(anonymousId ? { anonymousId } : {}),
      });
      if (!mounted.current) return;
      onAnonymousIdChange(res.anonymousId);
      setChosen(rating);
      setPhase({ kind: 'message', text: 'Thanks, your feedback was saved.', urgent: false });
    } catch (err) {
      if (!mounted.current) return;
      const view = describeApiError(err);
      setPhase({ kind: 'message', text: `${view.label}: ${view.message}`, urgent: true });
    }
  }

  const busy = phase.kind === 'busy';
  return (
    <section className="feedback" aria-labelledby={headingId}>
      <h3 id={headingId}>Was this connection useful?</h3>
      <div className="feedback-buttons" role="group" aria-labelledby={headingId}>
        {FEEDBACK_CHOICES.map((c) => (
          <button
            key={c.rating}
            type="button"
            aria-pressed={chosen === c.rating}
            disabled={busy}
            onClick={() => void rate(c.rating)}
          >
            <span aria-hidden="true">{c.icon} </span>
            {c.label}
            {chosen === c.rating && <span className="visually-hidden"> (selected)</span>}
          </button>
        ))}
      </div>
      <p className="section-note">{FEEDBACK_PRIVACY_NOTE}</p>
      <p
        role={phase.kind === 'message' && phase.urgent ? 'alert' : 'status'}
        className="feedback-message"
      >
        {phase.kind === 'message' ? phase.text : busy ? 'Saving…' : ''}
      </p>
    </section>
  );
}

export interface FeedbackResetProps {
  readonly client: Pick<ApiClient, 'resetFeedback'>;
  readonly anonymousId: string | undefined;
  readonly onAnonymousIdChange: (id: string | undefined) => void;
}

/** Delete/reset all saved feedback for this anonymous ID (FR-09 9.4). */
export function FeedbackReset({ client, anonymousId, onAnonymousIdChange }: FeedbackResetProps) {
  const mounted = useMountedGuard();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  async function reset() {
    if (!anonymousId) return;
    setPhase({ kind: 'busy' });
    try {
      const { deleted } = await client.resetFeedback(anonymousId);
      if (!mounted.current) return;
      onAnonymousIdChange(undefined);
      setPhase({
        kind: 'message',
        text: `Saved feedback deleted (${deleted} record${deleted === 1 ? '' : 's'}).`,
        urgent: false,
      });
    } catch (err) {
      if (!mounted.current) return;
      const view = describeApiError(err);
      setPhase({ kind: 'message', text: `${view.label}: ${view.message}`, urgent: true });
    }
  }

  return (
    <div className="feedback-reset">
      {anonymousId && (
        <button type="button" onClick={() => void reset()} disabled={phase.kind === 'busy'}>
          Delete my saved feedback
        </button>
      )}
      <p
        role={phase.kind === 'message' && phase.urgent ? 'alert' : 'status'}
        className="section-note"
      >
        {phase.kind === 'message' ? phase.text : ''}
      </p>
    </div>
  );
}
