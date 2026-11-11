import { useId, useMemo, useState } from 'react';
import type { QuestResponse } from '@serendipity/packages-contracts';
import { buildQuestModel, type QuestStepModel } from './quest-view';
import type { SessionInfo } from './bridge-view';
import { EvidenceList, SessionLink, StatusMessage } from './BridgeCards';

export interface QuestStepperProps {
  readonly quest: QuestResponse;
  readonly lookup: ReadonlyMap<string, SessionInfo>;
  /** Save/share controls render only when the matching handler is supplied (i.e. supported). */
  readonly onSave?: (() => void) | undefined;
  readonly onShare?: (() => void) | undefined;
}

function StepItem({
  step,
  lookup,
}: {
  readonly step: QuestStepModel;
  readonly lookup: ReadonlyMap<string, SessionInfo>;
}) {
  const id = useId();
  const { session, badge } = step;
  return (
    <li className={`quest-step quest-step-${badge.status}`} aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>
        <span className="rank">Step {step.number}:</span> <SessionLink session={session} />
      </h3>
      <p className="meta">
        <span className={`badge badge-${badge.status}`} title={badge.description}>
          <span aria-hidden="true">{badge.status === 'scheduled' ? '✓ ' : '⚠ '}</span>
          {badge.label}
        </span>
        {session.startsAt && <span className="track"> · {session.startsAt}</span>}
        {session.venue && <span className="track"> · {session.venue}</span>}
        {session.track && <span className="track"> · {session.track}</span>}
        {!session.officialUrl && <span className="track"> · Official link not available</span>}
      </p>
      <p className="quest-reason">
        <span className="label">Why this step:</span> {step.reason}
      </p>
      {badge.status !== 'scheduled' && <p className="section-note">{badge.description}</p>}
      {step.conflictsWith.length > 0 && (
        <p className="quest-conflict">
          Overlaps with: {step.conflictsWith.map((s) => s.title).join(', ')}.{' '}
          {step.conflictReasons.join(' ')}
        </p>
      )}
      {step.alternatives.length > 0 && (
        <div>
          <p className="label">Non-overlapping alternatives:</p>
          <ul className="session-list">
            {step.alternatives.map((alt) => (
              <li key={alt.sessionId}>
                <SessionLink session={alt} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {step.evidence.length > 0 && (
        <details className="score-details">
          <summary>Observed evidence for this step</summary>
          <EvidenceList evidence={step.evidence} lookup={lookup} />
        </details>
      )}
    </li>
  );
}

/** Ordered quest timeline with step rationale, schedule badges, and official links. */
export function QuestStepper({ quest, lookup, onSave, onShare }: QuestStepperProps) {
  const headingId = useId();
  const [message, setMessage] = useState('');
  const model = useMemo(() => buildQuestModel(quest, lookup), [quest, lookup]);

  const run = (action: () => void, done: string) => () => {
    action();
    setMessage(done);
  };

  return (
    <section className="quest" aria-labelledby={headingId}>
      <h2 id={headingId}>Your quest ({model.steps.length} steps)</h2>
      {model.conflictCount > 0 && (
        <StatusMessage
          label="Schedule conflict"
          message={`${model.conflictCount} pair${model.conflictCount === 1 ? '' : 's'} of steps overlap in time. Source data is unchanged; see alternatives below.`}
        />
      )}
      {model.unknownCount > 0 && (
        <StatusMessage
          label="Schedule unknown"
          message={`${model.unknownCount} step${model.unknownCount === 1 ? ' has' : 's have'} no known time, so conflicts cannot be ruled out. Check the official listing.`}
        />
      )}
      <ol className="quest-steps">
        {model.steps.map((step) => (
          <StepItem key={step.session.sessionId} step={step} lookup={lookup} />
        ))}
      </ol>
      {(onSave || onShare) && (
        <div className="quest-actions">
          {onSave && (
            <button type="button" onClick={run(onSave, 'Quest saved.')}>
              Save quest
            </button>
          )}
          {onShare && (
            <button type="button" onClick={run(onShare, 'Share link created.')}>
              Share quest
            </button>
          )}
          <p role="status" className="section-note">
            {message}
          </p>
        </div>
      )}
    </section>
  );
}
