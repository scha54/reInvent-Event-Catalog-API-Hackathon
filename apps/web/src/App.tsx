import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import type {
  DiscoverRequest,
  DiscoverResponse,
  ExplainRequest,
} from '@serendipity/packages-contracts';
import { createApiClient } from './api-client';
import { BridgeCards, ErrorState, LoadingState, StatusMessage } from './BridgeCards';
import { BridgeDrawer } from './BridgeDrawer';
import { CatalogStatusPanel } from './CatalogStatusPanel';
import { DemoGuide } from './DemoGuide';
import { FeedbackReset } from './FeedbackControls';
import { GraphView } from './GraphView';
import { buildCards, describeApiError, type CardModel, type ErrorView } from './bridge-view';
import { readConfig } from './config';
import { DEMO_EXAMPLES, type DemoExample } from './demo-examples';
import {
  DEFAULT_NOVELTY,
  buildDiscoverRequest,
  type DiscoverFormState,
  type FormErrors,
  type TopicMode,
} from './discover-form';

type Status =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'done'; readonly response: DiscoverResponse }
  | { readonly kind: 'error'; readonly error: ErrorView };

interface OpenDrawer {
  readonly card: CardModel;
  readonly trigger: HTMLElement;
}

export function App() {
  const config = useMemo(() => readConfig(), []);
  const client = useMemo(() => createApiClient({ baseUrl: config.apiBaseUrl }), [config]);

  const [form, setForm] = useState<DiscoverFormState>({
    mode: 'pair',
    topicA: '',
    topicB: '',
    novelty: DEFAULT_NOVELTY,
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [lastRequest, setLastRequest] = useState<DiscoverRequest | undefined>();
  const [openDrawer, setOpenDrawer] = useState<OpenDrawer | undefined>();
  const [graphNotice, setGraphNotice] = useState<string | undefined>();
  // Rotating anonymous feedback ID: memory only, never persisted client-side.
  const [anonymousId, setAnonymousId] = useState<string | undefined>();
  const abortRef = useRef<AbortController | null>(null);

  const ids = {
    topicA: useId(),
    topicB: useId(),
    novelty: useId(),
    errA: useId(),
    errB: useId(),
  };

  const explainRequest = useMemo<ExplainRequest | undefined>(() => {
    if (status.kind !== 'done' || !lastRequest) return undefined;
    return {
      eventId: lastRequest.eventId,
      catalogVersion: status.response.catalogVersion,
      topics: lastRequest.topics,
      ...(lastRequest.novelty !== undefined ? { novelty: lastRequest.novelty } : {}),
      ...(lastRequest.seed !== undefined ? { seed: lastRequest.seed } : {}),
    };
  }, [status, lastRequest]);

  async function run(next: DiscoverFormState) {
    const built = buildDiscoverRequest(next, config.eventId);
    if (!built.ok) {
      setErrors(built.errors);
      setStatus({ kind: 'idle' });
      return;
    }
    setErrors({});
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus({ kind: 'loading' });
    try {
      const response = await client.discover(built.request, controller.signal);
      setLastRequest(built.request);
      setOpenDrawer(undefined);
      setGraphNotice(undefined);
      setStatus({ kind: 'done', response });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setStatus({ kind: 'error', error: describeApiError(err) });
    }
  }

  function openSession(sessionId: string, trigger: HTMLElement) {
    if (status.kind !== 'done') return;
    const card = buildCards(status.response).find((c) => c.bridge.sessionIds.includes(sessionId));
    if (card) {
      setGraphNotice(undefined);
      setOpenDrawer({ card, trigger });
    } else {
      setGraphNotice(
        'This session is not part of any ranked connection, so no details are available.',
      );
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void run(form);
  }

  function applyExample(example: DemoExample) {
    const next: DiscoverFormState = {
      mode: 'pair',
      topicA: example.topicA,
      topicB: example.topicB,
      novelty: form.novelty,
    };
    setForm(next);
    void run(next);
  }

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="site-header">
        <h1>Serendipity Engine</h1>
        <p>Find unexpected, evidence-backed connections between conference topics.</p>
      </header>
      <main id="main">
        <CatalogStatusPanel client={client} eventId={config.eventId} />

        <form onSubmit={onSubmit} noValidate aria-labelledby="form-heading">
          <h2 id="form-heading">Explore topics</h2>

          <fieldset>
            <legend>Number of topics</legend>
            {(['pair', 'single'] as const satisfies readonly TopicMode[]).map((mode) => (
              <label key={mode} className="inline">
                <input
                  type="radio"
                  name="mode"
                  value={mode}
                  checked={form.mode === mode}
                  onChange={() => {
                    setForm({ ...form, mode });
                    setErrors({});
                  }}
                />
                {mode === 'pair' ? 'Two topics' : 'One topic'}
              </label>
            ))}
          </fieldset>

          <div className="field">
            <label htmlFor={ids.topicA}>{form.mode === 'pair' ? 'First topic' : 'Topic'}</label>
            <input
              id={ids.topicA}
              type="text"
              autoComplete="off"
              maxLength={200}
              value={form.topicA}
              onChange={(e) => setForm({ ...form, topicA: e.target.value })}
              aria-invalid={errors.topicA !== undefined}
              aria-describedby={errors.topicA ? ids.errA : undefined}
            />
            {errors.topicA && (
              <p id={ids.errA} className="field-error" role="alert">
                {errors.topicA}
              </p>
            )}
          </div>

          {form.mode === 'pair' && (
            <div className="field">
              <label htmlFor={ids.topicB}>Second topic</label>
              <input
                id={ids.topicB}
                type="text"
                autoComplete="off"
                maxLength={200}
                value={form.topicB}
                onChange={(e) => setForm({ ...form, topicB: e.target.value })}
                aria-invalid={errors.topicB !== undefined}
                aria-describedby={errors.topicB ? ids.errB : undefined}
              />
              {errors.topicB && (
                <p id={ids.errB} className="field-error" role="alert">
                  {errors.topicB}
                </p>
              )}
            </div>
          )}

          <div className="field">
            <label htmlFor={ids.novelty}>
              Novelty: {form.novelty.toFixed(2)} (0 = familiar, 1 = surprising)
            </label>
            <input
              id={ids.novelty}
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={form.novelty}
              onChange={(e) => setForm({ ...form, novelty: Number(e.target.value) })}
            />
          </div>

          <button type="submit" disabled={status.kind === 'loading'}>
            Find connections
          </button>
        </form>

        <DemoGuide busy={status.kind === 'loading'} onRunExample={applyExample} />

        <section aria-labelledby="examples-heading">
          <h2 id="examples-heading">Try an example</h2>
          <ul className="examples">
            {DEMO_EXAMPLES.map((example) => (
              <li key={example.id}>
                <button
                  type="button"
                  onClick={() => applyExample(example)}
                  disabled={status.kind === 'loading'}
                >
                  {example.label}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section
          aria-labelledby="results-heading"
          aria-live="polite"
          aria-busy={status.kind === 'loading'}
        >
          <h2 id="results-heading">Results</h2>
          <ResultSummary
            status={status}
            onRetry={() => void run(form)}
            onOpen={(card, trigger) => setOpenDrawer({ card, trigger })}
          />
          {status.kind === 'done' && status.response.bridges.length > 0 && (
            <>
              <GraphView graph={status.response.graph} onOpenSession={openSession} />
              {graphNotice && <StatusMessage label="Note" message={graphNotice} />}
            </>
          )}
          {status.kind === 'done' && openDrawer && explainRequest && (
            <BridgeDrawer
              card={openDrawer.card}
              discover={status.response}
              client={client}
              explainRequest={explainRequest}
              anonymousId={anonymousId}
              onAnonymousIdChange={setAnonymousId}
              returnFocusTo={openDrawer.trigger}
              onClose={() => setOpenDrawer(undefined)}
            />
          )}
        </section>

        {anonymousId && (
          <FeedbackReset
            client={client}
            anonymousId={anonymousId}
            onAnonymousIdChange={setAnonymousId}
          />
        )}
      </main>
    </>
  );
}

function ResultSummary({
  status,
  onRetry,
  onOpen,
}: {
  readonly status: Status;
  readonly onRetry: () => void;
  readonly onOpen: (card: CardModel, trigger: HTMLElement) => void;
}) {
  switch (status.kind) {
    case 'idle':
      return <p>Enter topics or pick an example to begin.</p>;
    case 'loading':
      return <LoadingState text="Searching the catalog…" />;
    case 'error':
      return <ErrorState error={status.error} onRetry={onRetry} />;
    case 'done':
      return <BridgeCards response={status.response} onOpen={onOpen} />;
  }
}
