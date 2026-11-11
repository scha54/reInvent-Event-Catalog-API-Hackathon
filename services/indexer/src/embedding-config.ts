/**
 * Embedding configuration (FR-04 4.1, NFR-03 15.3, AI 20.4).
 *
 * Model ID, dimensions, and region come exclusively from configuration; nothing
 * is hardcoded.
 */
export interface EmbeddingConfig {
  readonly modelId: string;
  readonly dimensions: number;
  readonly region: string;
  /**
   * Identifies the embedding model + shape for cache keys and reproducibility.
   * Defaults to `<modelId>@<dimensions>`; override to pin a provider revision.
   */
  readonly modelVersion: string;
  /** Max concurrent InvokeModel calls. */
  readonly concurrency: number;
}

export class EmbeddingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingConfigError';
  }
}

export const DEFAULT_EMBEDDING_CONCURRENCY = 4;
const MAX_DIMENSIONS = 8192;

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === '') {
    throw new EmbeddingConfigError(`Missing required configuration: ${name}`);
  }
  return value;
}

function positiveInt(name: string, raw: string, max: number): number {
  if (!/^\d+$/.test(raw)) throw new EmbeddingConfigError(`${name} must be a positive integer`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) {
    throw new EmbeddingConfigError(`${name} must be between 1 and ${max}`);
  }
  return n;
}

/**
 * Load embedding configuration from environment variables:
 * `BEDROCK_EMBEDDING_MODEL_ID`, `BEDROCK_EMBEDDING_DIMENSIONS`, `BEDROCK_REGION`,
 * and optional `BEDROCK_EMBEDDING_MODEL_VERSION`, `BEDROCK_EMBEDDING_CONCURRENCY`.
 */
export function loadEmbeddingConfig(env: Env = process.env): EmbeddingConfig {
  const modelId = required(env, 'BEDROCK_EMBEDDING_MODEL_ID');
  const dimensions = positiveInt(
    'BEDROCK_EMBEDDING_DIMENSIONS',
    required(env, 'BEDROCK_EMBEDDING_DIMENSIONS'),
    MAX_DIMENSIONS,
  );
  const region = required(env, 'BEDROCK_REGION');
  const versionOverride = env['BEDROCK_EMBEDDING_MODEL_VERSION']?.trim();
  const concurrencyRaw = env['BEDROCK_EMBEDDING_CONCURRENCY']?.trim();
  return {
    modelId,
    dimensions,
    region,
    modelVersion:
      versionOverride !== undefined && versionOverride !== ''
        ? versionOverride
        : `${modelId}@${dimensions}`,
    concurrency:
      concurrencyRaw !== undefined && concurrencyRaw !== ''
        ? positiveInt('BEDROCK_EMBEDDING_CONCURRENCY', concurrencyRaw, 64)
        : DEFAULT_EMBEDDING_CONCURRENCY,
  };
}
