/**
 * Explanation orchestrator (FR-05 5.1/5.3, FR-10 10.2, AI 20.7, NFR-04 16.1, NFR-05 17.2).
 *
 * - Lazy: the model is only called when a caller asks to explain a specific bridge.
 * - Grounded: every model answer passes `validateExplanation`; at most one retry
 *   after a validation failure, then the deterministic template.
 * - Resilient: model outages, throttles and timeouts resolve to the template too, so
 *   `explain` always resolves to a valid `Explanation` (it never throws for model
 *   problems). Repeated failures open a cooldown that skips the model entirely.
 * - Cost-bounded: validated model answers are cached by
 *   (catalogVersion, bridgeId, promptVersion, modelId) with a TTL; concurrent
 *   requests for the same key share one generation. Fallbacks are not cached so the
 *   model can recover.
 */
import type { Explanation, Relationship, Session } from '@serendipity/packages-contracts';
import { TextModelError, type TextGeneration } from './bedrock-text-client.js';
import {
  buildExplanationPrompt,
  PROMPT_VERSION,
  type BuiltPrompt,
  type PromptEvidence,
  type PromptLimits,
} from './explanation-prompt.js';
import {
  buildFallbackExplanation,
  validateExplanation,
  type ValidationContext,
} from './explanation-validator.js';

export const METRIC_GROUNDING_FAILURES = 'GroundingValidationFailures';
export const METRIC_BEDROCK_THROTTLES = 'BedrockThrottles';

export interface ExplanationMetric {
  readonly name: string;
  readonly value: number;
  readonly dimensions?: Readonly<Record<string, string>>;
}

/** Structurally compatible with the ingestion `MetricsSink`. */
export interface ExplanationMetricsSink {
  put(metric: ExplanationMetric): void | Promise<void>;
}

/** Anything that turns a built prompt into raw model text (e.g. `BedrockTextClient`). */
export interface TextGenerator {
  readonly config: { readonly modelId: string };
  generate(prompt: BuiltPrompt): Promise<TextGeneration>;
}

export interface ExplainRequest {
  readonly bridgeId: string;
  readonly catalogVersion: string;
  readonly topics: readonly string[];
  readonly relationship: Relationship;
  readonly sessions: readonly Session[];
  readonly evidence: readonly PromptEvidence[];
}

export type ExplanationSource = 'model' | 'cache' | 'fallback';

export type FallbackReason =
  'validation_failed' | 'throttled' | 'timeout' | 'unavailable' | 'empty_response' | 'cooldown';

export interface ExplainResult {
  readonly explanation: Explanation;
  readonly source: ExplanationSource;
  /** Set only when `source === 'fallback'`. */
  readonly fallbackReason?: FallbackReason;
  readonly promptVersion: string;
  readonly modelId: string;
}

export interface OrchestratorOptions {
  readonly generator: TextGenerator;
  readonly metrics?: ExplanationMetricsSink;
  readonly promptLimits?: PromptLimits;
  /** Cache TTL in ms. Default 1 hour. */
  readonly cacheTtlMs?: number;
  /** Max cached entries (oldest evicted). Default 500. */
  readonly maxCacheEntries?: number;
  /** Consecutive failed explanations before the cooldown opens. Default 3. */
  readonly failureThreshold?: number;
  /** How long the model is skipped once the cooldown opens. Default 60s. */
  readonly cooldownMs?: number;
  /** Injected clock (ms epoch). */
  readonly now?: () => number;
}

export const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_MAX_CACHE_ENTRIES = 500;
export const DEFAULT_FAILURE_THRESHOLD = 3;
export const DEFAULT_COOLDOWN_MS = 60_000;

/** Cache key; includes everything that can change the generated text. */
export function explanationCacheKey(
  catalogVersion: string,
  bridgeId: string,
  promptVersion: string,
  modelId: string,
): string {
  return JSON.stringify([catalogVersion, bridgeId, promptVersion, modelId]);
}

interface CacheEntry {
  readonly explanation: Explanation;
  readonly expiresAt: number;
}

export class ExplanationOrchestrator {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<ExplainResult>>();
  private consecutiveFailures = 0;
  private cooldownUntil = 0;

  private readonly ttl: number;
  private readonly maxEntries: number;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: OrchestratorOptions) {
    this.ttl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.maxEntries = opts.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.threshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = opts.now ?? Date.now;
  }

  /** True while the model is being skipped because of repeated failures. */
  get inCooldown(): boolean {
    return this.now() < this.cooldownUntil;
  }

  /** Always resolves to a valid explanation. */
  explain(req: ExplainRequest): Promise<ExplainResult> {
    const modelId = this.opts.generator.config.modelId;
    const key = explanationCacheKey(req.catalogVersion, req.bridgeId, PROMPT_VERSION, modelId);

    const hit = this.cache.get(key);
    if (hit !== undefined) {
      if (hit.expiresAt > this.now()) {
        return Promise.resolve({
          explanation: hit.explanation,
          source: 'cache',
          promptVersion: PROMPT_VERSION,
          modelId,
        });
      }
      this.cache.delete(key);
    }

    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending;

    const run = this.generate(req, key, modelId).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  }

  private async generate(
    req: ExplainRequest,
    key: string,
    modelId: string,
  ): Promise<ExplainResult> {
    const context: ValidationContext = {
      sessions: req.sessions,
      singleSessionRelationship: req.relationship === 'topic-match',
    };
    const fallback = (reason: FallbackReason): ExplainResult => ({
      explanation: buildFallbackExplanation(context),
      source: 'fallback',
      fallbackReason: reason,
      promptVersion: PROMPT_VERSION,
      modelId,
    });

    if (this.inCooldown) return fallback('cooldown');

    const prompt = buildExplanationPrompt(
      {
        topics: req.topics,
        relationship: req.relationship,
        catalogVersion: req.catalogVersion,
        sessions: req.sessions,
        evidence: req.evidence,
      },
      this.opts.promptLimits,
    );
    // The validator's evidence set is exactly what the model was shown.
    const included = new Set(prompt.includedSessionIds);
    const validationContext: ValidationContext = {
      ...context,
      sessions: req.sessions.filter((s) => included.has(s.sessionId)),
    };

    // Attempt 0 plus at most one retry, and only for validation failures.
    for (let attempt = 0; attempt < 2; attempt++) {
      let text: string;
      try {
        text = (await this.opts.generator.generate(prompt)).text;
      } catch (err) {
        const kind = err instanceof TextModelError ? err.kind : 'unavailable';
        if (kind === 'throttled') await this.emit(METRIC_BEDROCK_THROTTLES);
        this.recordFailure();
        return fallback(kind);
      }

      const result = validateExplanation(text, validationContext);
      if (result.ok) {
        this.consecutiveFailures = 0;
        this.store(key, result.explanation);
        return {
          explanation: result.explanation,
          source: 'model',
          promptVersion: PROMPT_VERSION,
          modelId,
        };
      }
      await this.emit(METRIC_GROUNDING_FAILURES);
    }

    this.recordFailure();
    return fallback('validation_failed');
  }

  private store(key: string, explanation: Explanation): void {
    this.cache.delete(key);
    this.cache.set(key, { explanation, expiresAt: this.now() + this.ttl });
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      this.cache.delete(oldest.value);
    }
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.threshold) {
      this.cooldownUntil = this.now() + this.cooldownMs;
      this.consecutiveFailures = 0;
    }
  }

  /** Metrics must never break explanation delivery. */
  private async emit(name: string): Promise<void> {
    try {
      await this.opts.metrics?.put({ name, value: 1 });
    } catch {
      // ignore
    }
  }
}
