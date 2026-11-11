import { useEffect, useId, useState } from 'react';
import type { CatalogStatus } from '@serendipity/packages-contracts';
import type { ApiClient } from './api-client';
import { describeApiError, type ErrorView } from './bridge-view';
import { ErrorState, LoadingState } from './BridgeCards';
import { buildStatusRows, type StatusTone } from './status-view';

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'done'; readonly status: CatalogStatus }
  | { readonly kind: 'error'; readonly error: ErrorView };

const TONE_PREFIX: Record<StatusTone, string> = { ok: '✓ ', warning: '⚠ ', info: '' };

export function CatalogStatusPanel({
  client,
  eventId,
}: {
  readonly client: Pick<ApiClient, 'getStatus'>;
  readonly eventId: string;
}) {
  const headingId = useId();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    client
      .getStatus(eventId, controller.signal)
      .then((status) => setState({ kind: 'done', status }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setState({ kind: 'error', error: describeApiError(err) });
      });
    return () => controller.abort();
  }, [client, eventId, attempt]);

  return (
    <section className="catalog-status" aria-labelledby={headingId}>
      <h2 id={headingId}>Catalog status</h2>
      {state.kind === 'loading' && <LoadingState text="Checking catalog status…" />}
      {state.kind === 'error' && (
        <ErrorState error={state.error} onRetry={() => setAttempt((n) => n + 1)} />
      )}
      {state.kind === 'done' && (
        <dl className="status-list">
          {buildStatusRows(state.status).map((row) => (
            <div key={row.key} className={`status-row status-${row.tone}`}>
              <dt>{row.term}</dt>
              <dd>
                <strong>
                  <span aria-hidden="true">{TONE_PREFIX[row.tone]}</span>
                  {row.value}
                </strong>
                {row.note && <span className="section-note"> {row.note}</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
