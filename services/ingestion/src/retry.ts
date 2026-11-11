/**
 * Retry and backoff utility for the Events API adapter.
 *
 * - Bounded exponential backoff with full jitter.
 * - Honors `Retry-After` (seconds or HTTP-date).
 * - Max-attempt cap and per-request timeouts.
 * - Retries only 429 and 5xx; permanent 4xx fail fast.
 */

/** Source of randomness returning a value in [0, 1). Injectable for tests. */
export type RandomSource = () => number;

export interface DelayInput {
  /** 1-based number of the attempt that just failed. */
  readonly attempt: number;
  /** Base delay in ms for the first retry. */
  readonly baseMs: number;
  /** Upper bound in ms for computed (jittered) delays. */
  readonly capMs: number;
  /** Parsed Retry-After value in ms, if the server supplied one. */
  readonly retryAfterMs?: number | undefined;
  readonly random: RandomSource;
}

const sanitize = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

/**
 * Pure delay computation.
 *
 * With a Retry-After value the server's instruction is honored exactly (never
 * below zero). Otherwise full jitter is used:
 * `delay = random * min(cap, base * 2^(attempt - 1))`, which lies in [0, cap].
 */
export function computeDelayMs(input: DelayInput): number {
  if (input.retryAfterMs !== undefined && Number.isFinite(input.retryAfterMs)) {
    return sanitize(input.retryAfterMs);
  }
  const cap = sanitize(input.capMs);
  const base = sanitize(input.baseMs);
  const exponent = Math.min(Math.max(Math.floor(input.attempt) - 1, 0), 30);
  const ceiling = Math.min(cap, base * 2 ** exponent);
  const r = Math.min(Math.max(input.random(), 0), 1);
  // Guard against r === 1 or rounding pushing above the ceiling.
  return Math.min(ceiling, r * ceiling);
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms. */
export function parseRetryAfter(
  header: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (header === null || header === undefined) return undefined;
  const value = header.trim();
  if (value === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) {
    return Math.round(Number(value) * 1000);
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - nowMs);
}

/** True for statuses that are worth retrying: 429 and 5xx. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export interface RetryPolicy {
  /** Total attempts including the first one. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Per-attempt timeout in ms. */
  readonly timeoutMs: number;
  /** Retry-After values above this are not honored; the failure is surfaced. */
  readonly maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
  timeoutMs: 15_000,
  maxRetryAfterMs: 60_000,
};

/** Minimal response shape so this module needs no DOM/fetch typings. */
export interface RetryableResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
}

export class HttpStatusError<R extends RetryableResponse = RetryableResponse> extends Error {
  constructor(
    readonly status: number,
    readonly attempts: number,
    readonly response: R,
    message?: string,
  ) {
    super(message ?? `Request failed with HTTP ${status} after ${attempts} attempt(s)`);
    this.name = 'HttpStatusError';
  }
}

export class RequestTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly attempts: number,
  ) {
    super(`Request timed out after ${timeoutMs}ms (attempt ${attempts})`);
    this.name = 'RequestTimeoutError';
  }
}

export class RetriesExhaustedError extends Error {
  constructor(
    readonly attempts: number,
    override readonly cause: unknown,
  ) {
    super(`Gave up after ${attempts} attempt(s)`);
    this.name = 'RetriesExhaustedError';
  }
}

export interface RetryOptions {
  readonly policy?: Partial<RetryPolicy>;
  readonly random?: RandomSource;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Observability hook invoked before each wait. */
  readonly onRetry?: (info: {
    attempt: number;
    delayMs: number;
    status?: number;
    error?: unknown;
  }) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `operation` with retries. The operation receives an AbortSignal that
 * fires when the per-attempt timeout elapses.
 *
 * - Resolves with the response on any non-error status (< 400, or 3xx/2xx).
 * - Throws HttpStatusError immediately on permanent 4xx (not 429).
 * - Throws HttpStatusError after maxAttempts for 429/5xx.
 * - Network errors and timeouts are retried; the last one is thrown wrapped in
 *   RetriesExhaustedError (or RequestTimeoutError on a final timeout).
 */
export async function withRetry<R extends RetryableResponse>(
  operation: (signal: AbortSignal, attempt: number) => Promise<R>,
  options: RetryOptions = {},
): Promise<R> {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.policy };
  const maxAttempts = Math.max(1, Math.floor(policy.maxAttempts));
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  for (let attempt = 1; ; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, policy.timeoutMs);

    let retryAfterMs: number | undefined;
    let status: number | undefined;
    let failure: unknown;

    try {
      const response = await operation(controller.signal, attempt);
      if (response.status < 400) return response;
      status = response.status;
      if (!isRetryableStatus(status)) {
        throw new HttpStatusError(status, attempt, response);
      }
      retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now());
      failure = new HttpStatusError(status, attempt, response);
    } catch (err) {
      if (err instanceof HttpStatusError && !isRetryableStatus(err.status)) throw err;
      failure = timedOut ? new RequestTimeoutError(policy.timeoutMs, attempt) : err;
      if (!timedOut && err instanceof HttpStatusError) failure = err;
    } finally {
      clearTimeout(timer);
    }

    if (attempt >= maxAttempts) {
      if (failure instanceof HttpStatusError || failure instanceof RequestTimeoutError) {
        throw failure;
      }
      throw new RetriesExhaustedError(attempt, failure);
    }
    if (retryAfterMs !== undefined && retryAfterMs > policy.maxRetryAfterMs) {
      // Server asks us to wait longer than we are willing to; surface now.
      throw failure;
    }

    const delayMs = computeDelayMs({
      attempt,
      baseMs: policy.baseDelayMs,
      capMs: policy.maxDelayMs,
      retryAfterMs,
      random,
    });
    options.onRetry?.({
      attempt,
      delayMs,
      ...(status !== undefined ? { status } : {}),
      error: failure,
    });
    await sleep(delayMs);
  }
}
