import type { DiscoverResponse, Evidence } from '@serendipity/packages-contracts';
import {
  buildCards,
  catalogNotices,
  type CardModel,
  type ErrorView,
  type Notice,
  type ScoreRow,
  type SessionInfo,
} from './bridge-view';

export function StatusMessage({
  label,
  message,
  urgent,
  onRetry,
}: {
  readonly label: string;
  readonly message: string;
  readonly urgent?: boolean;
  readonly onRetry?: (() => void) | undefined;
}) {
  return (
    <div className="status-box" role={urgent ? 'alert' : 'status'}>
      <p>
        <strong>{label}:</strong> {message}
      </p>
      {onRetry && (
        <button type="button" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
}: {
  readonly error: ErrorView;
  readonly onRetry?: (() => void) | undefined;
}) {
  return (
    <StatusMessage
      urgent
      label={error.label}
      message={error.message}
      onRetry={error.retryable ? onRetry : undefined}
    />
  );
}

export function LoadingState({ text }: { readonly text: string }) {
  return (
    <p className="loading" role="status">
      <span aria-hidden="true">⏳ </span>
      {text}
    </p>
  );
}

export function NoticeList({ notices }: { readonly notices: readonly Notice[] }) {
  if (notices.length === 0) return null;
  return (
    <ul className="notices">
      {notices.map((n) => (
        <li key={n.kind} className={`notice notice-${n.kind}`}>
          <strong>
            <span aria-hidden="true">⚠ </span>
            {n.label}:
          </strong>{' '}
          {n.message}
        </li>
      ))}
    </ul>
  );
}

export function ScoreBreakdown({ rows }: { readonly rows: readonly ScoreRow[] }) {
  return (
    <dl className="scores">
      {rows.map((row) => (
        <div key={row.key} className="score-row">
          <dt>{row.label}</dt>
          <dd>
            <span className="bar" aria-hidden="true">
              <span className="bar-fill" style={{ width: `${row.percent}%` }} />
            </span>
            <span className="score-value">{row.percent}%</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function SessionLink({ session }: { readonly session: SessionInfo }) {
  return (
    <>
      {session.officialUrl ? (
        <a href={session.officialUrl} target="_blank" rel="noopener noreferrer">
          {session.title}
          <span className="visually-hidden"> (official source, opens in a new tab)</span>
        </a>
      ) : (
        <span>{session.title}</span>
      )}
    </>
  );
}

export function EvidenceList({
  evidence,
  lookup,
}: {
  readonly evidence: readonly Evidence[];
  readonly lookup: ReadonlyMap<string, SessionInfo>;
}) {
  if (evidence.length === 0) {
    return <p>No source excerpts are available for this connection.</p>;
  }
  return (
    <ul className="evidence">
      {evidence.map((e, i) => {
        const title = lookup.get(e.sessionId)?.title ?? `Session ${e.sessionId}`;
        return (
          <li key={`${e.sessionId}-${e.field}-${i}`}>
            <blockquote>{e.excerpt}</blockquote>
            <p className="evidence-source">
              From {title} · {e.field}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

export function BridgeCardItem({
  card,
  onOpen,
}: {
  readonly card: CardModel;
  readonly onOpen: (card: CardModel, trigger: HTMLElement) => void;
}) {
  const headingId = `bridge-${card.bridge.id}-title`;
  return (
    <li>
      <article className="card" aria-labelledby={headingId}>
        <h3 id={headingId}>
          <span className="rank">#{card.rank}</span> {card.sessions.map((s) => s.title).join(' + ')}
        </h3>
        <p className="meta">
          <span className="badge">{card.relationshipLabel}</span> Overall score:{' '}
          <strong>{card.scorePercent}%</strong>
        </p>
        <ul className="session-list">
          {card.sessions.map((s) => (
            <li key={s.sessionId}>
              <SessionLink session={s} />
              {s.track && <span className="track"> · {s.track}</span>}
            </li>
          ))}
        </ul>
        {card.previewEvidence && (
          <p className="preview">
            <span className="label">Observed:</span> “{card.previewEvidence.excerpt}”
          </p>
        )}
        <details className="score-details">
          <summary>Score breakdown</summary>
          <ScoreBreakdown rows={card.scores} />
        </details>
        <button type="button" aria-haspopup="dialog" onClick={(e) => onOpen(card, e.currentTarget)}>
          View evidence and explanation
          <span className="visually-hidden"> for result {card.rank}</span>
        </button>
      </article>
    </li>
  );
}

export function BridgeCards({
  response,
  onOpen,
}: {
  readonly response: DiscoverResponse;
  readonly onOpen: (card: CardModel, trigger: HTMLElement) => void;
}) {
  if (response.noMatch || response.bridges.length === 0) {
    return (
      <>
        <NoticeList notices={catalogNotices(response)} />
        <StatusMessage
          label="No match"
          message="No well-supported connection was found between these topics in this catalog. Try broader wording or a different topic. We do not invent links when the catalog has no evidence."
        />
      </>
    );
  }
  const cards = buildCards(response);
  return (
    <>
      <NoticeList notices={catalogNotices(response)} />
      <p>
        {cards.length} connection{cards.length === 1 ? '' : 's'} found in catalog{' '}
        {response.catalogVersion}, ranked by score.
      </p>
      <ol className="cards">
        {cards.map((card) => (
          <BridgeCardItem key={card.bridge.id} card={card} onOpen={onOpen} />
        ))}
      </ol>
    </>
  );
}
