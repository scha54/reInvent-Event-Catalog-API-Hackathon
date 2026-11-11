import { useEffect, useRef, useState } from 'react';
import type { ExplainRequest, QuestResponse } from '@serendipity/packages-contracts';
import type { ApiClient } from './api-client';
import { describeApiError, type ErrorView, type SessionInfo } from './bridge-view';
import { ErrorState, LoadingState } from './BridgeCards';
import { QuestStepper } from './QuestStepper';
import { buildQuestRequest } from './quest-view';

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'done'; readonly quest: QuestResponse }
  | { readonly kind: 'error'; readonly error: ErrorView };

export interface QuestPanelProps {
  readonly client: Pick<ApiClient, 'createQuest'>;
  readonly bridgeId: string;
  readonly explainRequest: ExplainRequest;
  readonly lookup: ReadonlyMap<string, SessionInfo>;
}

/** Requests a quest only after an explicit click, then renders the stepper. */
export function QuestPanel({ client, bridgeId, explainRequest, lookup }: QuestPanelProps) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  function plan() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ kind: 'loading' });
    client
      .createQuest(buildQuestRequest(explainRequest, bridgeId), controller.signal)
      .then((quest) => setState({ kind: 'done', quest }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setState({ kind: 'error', error: describeApiError(err) });
      });
  }

  return (
    <div aria-live="polite" aria-busy={state.kind === 'loading'}>
      {state.kind !== 'done' && (
        <button type="button" onClick={plan} disabled={state.kind === 'loading'}>
          Plan a quest
        </button>
      )}
      {state.kind === 'loading' && <LoadingState text="Planning your quest…" />}
      {state.kind === 'error' && <ErrorState error={state.error} onRetry={plan} />}
      {state.kind === 'done' && <QuestStepper quest={state.quest} lookup={lookup} />}
    </div>
  );
}
