import { useId, useState } from 'react';
import type { DemoExample } from './demo-examples';
import {
  DEMO_BUDGET_SECONDS,
  DEMO_STEPS,
  clampStep,
  formatDuration,
  totalDemoSeconds,
} from './demo-path';

export interface DemoGuideProps {
  readonly busy: boolean;
  readonly onRunExample: (example: DemoExample) => void;
}

/**
 * Scripted walkthrough (FR-12). It only runs the prevalidated pairs through the normal
 * live search and points at real UI; it never injects results.
 */
export function DemoGuide({ busy, onRunExample }: DemoGuideProps) {
  const headingId = useId();
  const [active, setActive] = useState<number | undefined>();
  const total = totalDemoSeconds();
  const stepExample = active === undefined ? undefined : DEMO_STEPS[clampStep(active)]?.example;
  const step = active === undefined ? undefined : DEMO_STEPS[clampStep(active)];

  return (
    <section className="demo-guide" aria-labelledby={headingId}>
      <h2 id={headingId}>Guided demo</h2>
      <p className="section-note">
        {DEMO_STEPS.length} steps, about {formatDuration(total)} (under{' '}
        {formatDuration(DEMO_BUDGET_SECONDS)}). Results always come from the live catalog.
      </p>
      {step === undefined || active === undefined ? (
        <button type="button" onClick={() => setActive(0)}>
          Start guided demo
        </button>
      ) : (
        <div>
          <p role="status">
            <strong>
              Step {active + 1} of {DEMO_STEPS.length}: {step.title}
            </strong>{' '}
            <span className="track">(about {step.seconds}s)</span>
          </p>
          <p>{step.instruction}</p>
          <div className="quest-actions">
            {stepExample && (
              <button type="button" disabled={busy} onClick={() => onRunExample(stepExample)}>
                Run {stepExample.label}
              </button>
            )}
            <button type="button" disabled={active === 0} onClick={() => setActive(active - 1)}>
              Back
            </button>
            {active < DEMO_STEPS.length - 1 ? (
              <button type="button" onClick={() => setActive(active + 1)}>
                Next step
              </button>
            ) : (
              <button type="button" onClick={() => setActive(undefined)}>
                Finish demo
              </button>
            )}
            <button type="button" onClick={() => setActive(undefined)}>
              Exit demo
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
