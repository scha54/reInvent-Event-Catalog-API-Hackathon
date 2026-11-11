/**
 * Bedrock text client for grounded explanations (FR-05 5.1, NFR-01 13.4,
 * NFR-04 16.1, AI 20.1, 20.4).
 *
 * - Model ID and region come from configuration; nothing is hardcoded.
 * - Each call has a request timeout (AbortSignal).
 * - Throttling and timeouts surface as typed errors; the orchestrator (task 6.3)
 *   decides on its single retry and the template fallback.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { DEFAULT_PROMPT_LIMITS, type BuiltPrompt } from './explanation-prompt.js';

export interface TextModelConfig {
  readonly modelId: string;
  readonly region: string;
  readonly timeoutMs: number;
}

export const DEFAULT_TEXT_TIMEOUT_MS = 15_000;

export class TextModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextModelConfigError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Load from `BEDROCK_TEXT_MODEL_ID`, `BEDROCK_REGION`, and optional
 * `BEDROCK_TEXT_TIMEOUT_MS`.
 */
export function loadTextModelConfig(env: Env = process.env): TextModelConfig {
  const get = (name: string): string | undefined => {
    const v = env[name]?.trim();
    return v === undefined || v === '' ? undefined : v;
  };
  const modelId = get('BEDROCK_TEXT_MODEL_ID');
  const region = get('BEDROCK_REGION');
  if (modelId === undefined) throw new TextModelConfigError('Missing BEDROCK_TEXT_MODEL_ID');
  if (region === undefined) throw new TextModelConfigError('Missing BEDROCK_REGION');
  const rawTimeout = get('BEDROCK_TEXT_TIMEOUT_MS');
  let timeoutMs = DEFAULT_TEXT_TIMEOUT_MS;
  if (rawTimeout !== undefined) {
    timeoutMs = Number(rawTimeout);
    if (!/^\d+$/.test(rawTimeout) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new TextModelConfigError('BEDROCK_TEXT_TIMEOUT_MS must be between 1 and 120000');
    }
  }
  return { modelId, region, timeoutMs };
}

export type TextModelErrorKind = 'throttled' | 'timeout' | 'unavailable' | 'empty_response';

/** Typed failure from the text model; `kind === 'throttled'` feeds BedrockThrottles. */
export class TextModelError extends Error {
  constructor(
    readonly kind: TextModelErrorKind,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'TextModelError';
  }
}

export interface TextGeneration {
  readonly text: string;
  readonly modelId: string;
  readonly promptVersion: string;
}

/** Low-level converse call; replaceable in tests. */
export type ConverseFn = (
  input: {
    modelId: string;
    system: string;
    user: string;
    maxTokens: number;
  },
  signal: AbortSignal,
) => Promise<string>;

interface SdkErrorLike {
  name?: string;
  $metadata?: { httpStatusCode?: number };
}

export function createBedrockConverse(
  config: Pick<TextModelConfig, 'region'>,
  client: Pick<BedrockRuntimeClient, 'send'> = new BedrockRuntimeClient({
    region: config.region,
    maxAttempts: 1,
  }),
): ConverseFn {
  return async (input, signal) => {
    const out: ConverseCommandOutput = await client.send(
      new ConverseCommand({
        modelId: input.modelId,
        system: [{ text: input.system }],
        messages: [{ role: 'user', content: [{ text: input.user }] }],
        inferenceConfig: { maxTokens: input.maxTokens, temperature: 0 },
      }),
      { abortSignal: signal },
    );
    const blocks = out.output?.message?.content ?? [];
    return blocks.map((b) => b.text ?? '').join('');
  };
}

function classify(err: unknown, aborted: boolean): TextModelError {
  if (err instanceof TextModelError) return err;
  const e = err as SdkErrorLike;
  if (aborted || e?.name === 'AbortError' || e?.name === 'ModelTimeoutException') {
    return new TextModelError('timeout', 'Text model request timed out', err);
  }
  if (
    e?.name === 'ThrottlingException' ||
    e?.name === 'TooManyRequestsException' ||
    e?.$metadata?.httpStatusCode === 429
  ) {
    return new TextModelError('throttled', 'Text model request was throttled', err);
  }
  return new TextModelError('unavailable', 'Text model unavailable', err);
}

export interface BedrockTextClientOptions {
  readonly converse?: ConverseFn;
}

export class BedrockTextClient {
  private readonly converse: ConverseFn;

  constructor(
    readonly config: TextModelConfig,
    options: BedrockTextClientOptions = {},
  ) {
    this.converse = options.converse ?? createBedrockConverse(config);
  }

  /**
   * Send a built prompt and return the raw model text (JSON validation belongs to
   * the validator). Throws {@link TextModelError} on throttle, timeout, outage, or
   * empty output. Does not retry.
   */
  async generate(prompt: BuiltPrompt): Promise<TextGeneration> {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new TextModelError('timeout', 'Text model request timed out'));
      }, this.config.timeoutMs);
    });
    try {
      const text = await Promise.race([
        this.converse(
          {
            modelId: this.config.modelId,
            system: prompt.system,
            user: prompt.user,
            maxTokens: prompt.maxOutputTokens || DEFAULT_PROMPT_LIMITS.maxOutputTokens,
          },
          controller.signal,
        ),
        timeout,
      ]);
      if (text.trim() === '') throw new TextModelError('empty_response', 'Empty model response');
      return { text, modelId: this.config.modelId, promptVersion: prompt.promptVersion };
    } catch (err) {
      throw classify(err, timedOut);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
