import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ExplainRequest, ExplainResponse } from '@serendipity/packages-contracts';
import type { ApiClient } from './api-client';
import {
  buildExplanationView,
  buildSessionLookup,
  describeApiError,
  type CardModel,
  type ErrorView,
} from './bridge-view';
import {
  ErrorState,
  EvidenceList,
  LoadingState,
  NoticeList,
  ScoreBreakdown,
  SessionLink,
  StatusMessage,
} from './BridgeCards';
import { FeedbackControls, FeedbackReset } from './FeedbackControls';
import { QuestPanel } from './QuestPanel';
import type { DiscoverResponse } from '@serendipity/packages-contracts';

type ExplainState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'done'; readonly response: ExplainResponse }
  | { readonly kind: 'error'; readonly error: ErrorView };

export interface BridgeDrawerProps {
  readonly card: CardModel;
  readonly discover: DiscoverResponse;
  readonly client: Pick<ApiClient, 'explain' | 'createQuest' | 'submitFeedback' | 'resetFeedback'>;
  readonly anonymousId?: string | undefined;
  readonly onAnonymousIdChange?: ((id: string | undefined) => void) | undefined;
  readonly explainRequest: ExplainRequest;
  /** Element that opened the drawer; focus returns here on close. */
  readonly returnFocusTo: HTMLElement | null;
  readonly onClose: () => void;
}

/** Modal detail drawer using the native dialog for focus trapping and Escape handling. */
export function BridgeDrawer({
  card,
  discover,
  client,
  explainRequest,
  anonymousId,
  onAnonymousIdChange,
  returnFocusTo,
  onClose,
}: BridgeDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [state, setState] = useState<ExplainState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const lookup = useMemo(() => buildSessionLookup(discover.graph), [discover.graph]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    client
      .explain(card.bridge.id, explainRequest, controller.signal)
      .then((response) => setState({ kind: 'done', response }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setState({ kind: 'error', error: describeApiError(err) });
      });
    return () => controller.abort();
  }, [client, card.bridge.id, explainRequest, attempt]);

  const close = useCallback(() => {
    onClose();
    returnFocusTo?.focus();
  }, [onClose, returnFocusTo]);

  const explanation = state.kind === 'done' ? state.response.explanation : undefined;
  const view = buildExplanationView(card.bridge, explanation);
  const fallback = state.kind === 'done' && state.response.source === 'fallback';

  return (
    <dialog
      ref={dialogRef}
      className="drawer"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) close();
      }}
    >
      <div className="drawer-body">
        <header className="drawer-header">
          <h2 id={titleId}>
            <span className="rank">#{card.rank}</span> {view.headline ?? card.relationshipLabel}
          </h2>
          <button type="button" onClick={close}>
            Close<span className="visually-hidden"> details</span>
          </button>
        </header>

        <p className="meta">
          <span className="badge">{card.relationshipLabel}</span> Overall score:{' '}
          <strong>{card.scorePercent}%</strong>
        </p>

        <section aria-labelledby={`${titleId}-sessions`}>
          <h3 id={`${titleId}-sessions`}>Sessions</h3>
          <ul className="session-list">
            {card.sessions.map((s) => (
              <li key={s.sessionId}>
                <SessionLink session={s} />
                {s.track && <span className="track"> · {s.track}</span>}
                {s.startsAt && <span className="track"> · {s.startsAt}</span>}
                {s.venue && <span className="track"> · {s.venue}</span>}
                {!s.officialUrl && <span className="track"> · Official link not available</span>}
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby={`${titleId}-scores`}>
          <h3 id={`${titleId}-scores`}>Score breakdown</h3>
          <ScoreBreakdown rows={card.scores} />
        </section>

        <section aria-labelledby={`${titleId}-observed`} className="observed">
          <h3 id={`${titleId}-observed`}>Observed evidence</h3>
          <p className="section-note">Text taken directly from the session catalog.</p>
          <EvidenceList evidence={view.observed} lookup={lookup} />
        </section>

        <section aria-labelledby={`${titleId}-inferred`} className="inferred" aria-live="polite">
          <h3 id={`${titleId}-inferred`}>Inferred connection</h3>
          <p className="section-note">An interpretation, not a statement from the catalog.</p>
          {state.kind === 'loading' && <LoadingState text="Generating explanation…" />}
          {state.kind === 'error' && (
            <ErrorState error={state.error} onRetry={() => setAttempt((n) => n + 1)} />
          )}
          {state.kind === 'done' && fallback && (
            <NoticeList
              notices={[
                {
                  kind: 'degraded',
                  label: 'Fallback explanation',
                  message:
                    state.response.fallbackReason ??
                    'The AI explanation was unavailable, so this summary is built directly from catalog fields.',
                },
              ]}
            />
          )}
          {state.kind === 'done' && view.insufficient && (
            <StatusMessage
              label="Insufficient evidence"
              message="The catalog text does not support a reliable inferred connection here."
            />
          )}
          {state.kind === 'done' &&
            view.inferred.map((text) => (
              <p key={text} className="inference">
                {text}
              </p>
            ))}
        </section>

        <section aria-labelledby={`${titleId}-uncertainty`}>
          <h3 id={`${titleId}-uncertainty`}>Uncertainty</h3>
          <p>{view.uncertainty}</p>
        </section>

        <section aria-labelledby={`${titleId}-quest`}>
          <h3 id={`${titleId}-quest`}>Quest</h3>
          <p className="section-note">
            Turn this connection into an ordered plan of real sessions.
          </p>
          <QuestPanel
            client={client}
            bridgeId={card.bridge.id}
            explainRequest={explainRequest}
            lookup={lookup}
          />
        </section>

        {onAnonymousIdChange && (
          <>
            <FeedbackControls
              client={client}
              bridgeId={card.bridge.id}
              eventId={explainRequest.eventId}
              catalogVersion={discover.catalogVersion}
              anonymousId={anonymousId}
              onAnonymousIdChange={onAnonymousIdChange}
            />
            <FeedbackReset
              client={client}
              anonymousId={anonymousId}
              onAnonymousIdChange={onAnonymousIdChange}
            />
          </>
        )}
      </div>
    </dialog>
  );
}
