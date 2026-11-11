import { App } from 'aws-cdk-lib';
import { resolveEnvironmentConfig } from './config.js';
import { ApiStack } from './api-stack.js';
import { DataStack } from './data-stack.js';
import { IngestionStack } from './ingestion-stack.js';
import { ObservabilityStack } from './observability-stack.js';
import { WebStack } from './web-stack.js';

/** Accepts a positive number or numeric string from CDK context (-c flags arrive as strings). */
function contextNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (n === undefined) return undefined;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    throw new Error(`Context value "${String(value)}" must be a positive number`);
  }
  return n;
}

/** Accepts a JSON array or a comma-separated string from CDK context. */
function contextList(value: unknown): string[] | undefined {
  const items = Array.isArray(value)
    ? value.map(String)
    : typeof value === 'string'
      ? value.split(',')
      : undefined;
  const cleaned = items?.map((s) => s.trim()).filter((s) => s !== '');
  return cleaned && cleaned.length > 0 ? cleaned : undefined;
}

/** Build the CDK app. Select the environment with -c env=dev|demo (default: dev). */
export function createApp(): App {
  const app = new App();
  const envName: unknown = app.node.tryGetContext('env') ?? 'dev';
  const config = resolveEnvironmentConfig(envName, app.node.tryGetContext('environments'));
  // Account/region come from the CLI credentials, never hardcoded.
  const env = {
    ...(process.env['CDK_DEFAULT_ACCOUNT'] ? { account: process.env['CDK_DEFAULT_ACCOUNT'] } : {}),
    ...(process.env['CDK_DEFAULT_REGION'] ? { region: process.env['CDK_DEFAULT_REGION'] } : {}),
  };
  const data = new DataStack(app, `Serendipity-${config.name}-Data`, { config, env });
  // The event to sync is configuration (-c eventId=...), never hardcoded.
  const eventId: unknown = app.node.tryGetContext('eventId');
  const ingestion = new IngestionStack(app, `Serendipity-${config.name}-Ingestion`, {
    config,
    data,
    env,
    ...(typeof eventId === 'string' && eventId !== '' ? { eventId } : {}),
  });
  // CORS origins and operator principals are configuration (-c allowedOrigins=a,b); no wildcard default.
  const allowedOrigins = contextList(app.node.tryGetContext('allowedOrigins')) ?? [
    'http://localhost:5173',
  ];
  const operatorPrincipals = contextList(app.node.tryGetContext('operatorPrincipals')) ?? [];
  const apiStack = new ApiStack(app, `Serendipity-${config.name}-Api`, {
    config,
    data,
    ingestion,
    env,
    allowedOrigins,
    operatorPrincipals,
  });
  // Web hosting; CSP connect-src is set only when the API URL is supplied (-c apiUrl=https://...).
  const apiUrl: unknown = app.node.tryGetContext('apiUrl');
  const web = new WebStack(app, `Serendipity-${config.name}-Web`, {
    config,
    env,
    ...(typeof apiUrl === 'string' && apiUrl !== '' ? { apiUrl } : {}),
  });
  web.addDependency(apiStack);

  // Alarms, dashboard and budgets. Notification email and limits are configuration:
  // -c alertEmail=ops@example.com -c monthlyBudgetUsd=50 -c bedrockDailyInvocationQuota=5000
  const alertEmail: unknown = app.node.tryGetContext('alertEmail');
  const monthlyBudgetUsd = contextNumber(app.node.tryGetContext('monthlyBudgetUsd'));
  const bedrockDailyInvocationQuota = contextNumber(
    app.node.tryGetContext('bedrockDailyInvocationQuota'),
  );
  new ObservabilityStack(app, `Serendipity-${config.name}-Observability`, {
    config,
    env,
    ingestion,
    api: apiStack,
    ...(typeof alertEmail === 'string' && alertEmail !== '' ? { alertEmail } : {}),
    ...(monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd } : {}),
    ...(bedrockDailyInvocationQuota !== undefined ? { bedrockDailyInvocationQuota } : {}),
  });
  return app;
}
