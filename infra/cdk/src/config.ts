export const ENVIRONMENT_NAMES = ['dev', 'demo'] as const;
export type EnvironmentName = (typeof ENVIRONMENT_NAMES)[number];

/** Per-environment settings, supplied through CDK context (cdk.json or -c flags). */
export interface EnvironmentConfig {
  readonly name: EnvironmentName;
  /** Days before noncurrent S3 object versions expire. */
  readonly noncurrentVersionRetentionDays: number;
  /** Days before raw staging objects expire. */
  readonly stagingRetentionDays: number;
  /** Days before current snapshot/index objects transition to Infrequent Access. */
  readonly snapshotInfrequentAccessAfterDays: number;
  /** Destroy data resources on stack deletion (non-production only). */
  readonly destroyOnDelete: boolean;
  readonly tags: Readonly<Record<string, string>>;
}

export const TTL_ATTRIBUTE = 'ttl';

function positiveInt(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Context "${key}" must be a positive integer`);
  }
  return value;
}

export function isEnvironmentName(value: unknown): value is EnvironmentName {
  return typeof value === 'string' && (ENVIRONMENT_NAMES as readonly string[]).includes(value);
}

/**
 * Resolve and validate environment configuration from raw CDK context.
 * `environments` context holds a map keyed by environment name.
 */
export function resolveEnvironmentConfig(name: unknown, environments: unknown): EnvironmentConfig {
  if (!isEnvironmentName(name)) {
    throw new Error(
      `Unknown environment "${String(name)}". Use -c env=${ENVIRONMENT_NAMES.join('|')}`,
    );
  }
  const raw = (environments as Record<string, Record<string, unknown>> | undefined)?.[name];
  if (raw === undefined || typeof raw !== 'object' || raw === null) {
    throw new Error(`Missing context "environments.${name}"`);
  }
  const key = (k: string): string => `environments.${name}.${k}`;
  const extraTags = raw['tags'];
  if (extraTags !== undefined && (typeof extraTags !== 'object' || extraTags === null)) {
    throw new Error(`Context "${key('tags')}" must be an object`);
  }
  return {
    name,
    noncurrentVersionRetentionDays: positiveInt(
      raw['noncurrentVersionRetentionDays'],
      key('noncurrentVersionRetentionDays'),
    ),
    stagingRetentionDays: positiveInt(raw['stagingRetentionDays'], key('stagingRetentionDays')),
    snapshotInfrequentAccessAfterDays: positiveInt(
      raw['snapshotInfrequentAccessAfterDays'],
      key('snapshotInfrequentAccessAfterDays'),
    ),
    destroyOnDelete: raw['destroyOnDelete'] === true,
    tags: { ...(extraTags as Record<string, string> | undefined) },
  };
}
