import { CfnOutput, Duration, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import type { ApiStack } from './api-stack.js';
import { DEFAULT_TEXT_MODEL_ID } from './api-stack.js';
import type { EnvironmentConfig } from './config.js';
import type { IngestionStack } from './ingestion-stack.js';

/** Namespace used by the EMF metrics sinks in services/ingestion and packages/discovery. */
export const METRICS_NAMESPACE = 'SerendipityEngine';
/** Sync workflow steps that emit `CatalogSyncFailures` with a `Step` dimension. */
export const SYNC_STEPS = [
  'startSync',
  'fetchAndStage',
  'normalizeStaged',
  'diffAndEnqueue',
  'buildIndex',
  'runChecks',
  'publish',
] as const;

export const DEFAULT_MAX_SYNC_AGE = Duration.hours(3);
export const DEFAULT_API_LATENCY_P95_MS = 3000;
export const DEFAULT_MONTHLY_BUDGET_USD = 50;
export const DEFAULT_BEDROCK_DAILY_INVOCATION_QUOTA = 5000;

export interface ObservabilityStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly ingestion: IngestionStack;
  readonly api: ApiStack;
  /** Email for alarm and budget notifications. When absent, alarms still exist without a subscriber. */
  readonly alertEmail?: string;
  /** Alarm when the active catalog is older than this. Default 3h (hourly schedule). */
  readonly maxSyncAge?: Duration;
  /** API p95 latency alarm threshold in ms. */
  readonly apiLatencyP95Ms?: number;
  /** Monthly cost budget (USD) for resources tagged with this project. */
  readonly monthlyBudgetUsd?: number;
  /** Application-level quota: Bedrock invocations per day before alerting. */
  readonly bedrockDailyInvocationQuota?: number;
  /** Bedrock model IDs whose invocations count against the quota. */
  readonly bedrockModelIds?: readonly string[];
}

/** Dashboards, alarms, and budgets for the whole system (NFR-05, NFR-04, NFR-02). */
export class ObservabilityStack extends Stack {
  public readonly alarmTopic: sns.Topic;
  public readonly dashboard: cloudwatch.Dashboard;
  public readonly alarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);
    const { config, ingestion, api } = props;
    const period = Duration.minutes(5);

    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: `Serendipity ${config.name} alerts`,
      enforceSSL: true,
    });
    if (props.alertEmail) {
      this.alarmTopic.addSubscription(new subscriptions.EmailSubscription(props.alertEmail));
    }
    const action = new cwActions.SnsAction(this.alarmTopic);
    const addAlarm = (alarm: cloudwatch.Alarm): cloudwatch.Alarm => {
      alarm.addAlarmAction(action);
      this.alarms.push(alarm);
      return alarm;
    };

    /* ------------------------------- metrics ------------------------------ */
    const custom = (
      metricName: string,
      statistic: string,
      dimensionsMap?: Record<string, string>,
    ): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: METRICS_NAMESPACE,
        metricName,
        statistic,
        period,
        ...(dimensionsMap ? { dimensionsMap } : {}),
      });

    const syncAge = custom('CatalogSyncAge', 'Maximum');
    // CatalogSyncFailures carries a Step dimension, so sum across the known steps.
    const syncFailureUsing: Record<string, cloudwatch.IMetric> = {};
    SYNC_STEPS.forEach((step, i) => {
      syncFailureUsing[`f${i}`] = custom('CatalogSyncFailures', 'Sum', { Step: step });
    });
    const syncFailures = new cloudwatch.MathExpression({
      expression: SYNC_STEPS.map((_, i) => `FILL(f${i}, 0)`).join(' + '),
      usingMetrics: syncFailureUsing,
      label: 'CatalogSyncFailures',
      period,
    });
    const grounding = custom('GroundingValidationFailures', 'Sum');
    const throttles = custom('BedrockThrottles', 'Sum');

    const apiDims = { ApiId: api.api.apiId };
    const apiMetric = (metricName: string, statistic: string): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName,
        statistic,
        period,
        dimensionsMap: apiDims,
      });
    const api5xx = apiMetric('5xx', 'Sum');
    const apiRequests = apiMetric('Count', 'Sum');
    const apiLatencyP95 = apiMetric('Latency', 'p95');
    const lambdaErrors = api.apiFunction.metricErrors({ period });
    const lambdaThrottles = api.apiFunction.metricThrottles({ period });

    const dlqDepth = ingestion.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
      period,
      statistic: 'Maximum',
    });
    const queueDepth = ingestion.queue.metricApproximateNumberOfMessagesVisible({
      period,
      statistic: 'Maximum',
    });

    /* -------------------------------- alarms ------------------------------ */
    // Sync age is only emitted when a sync runs; a silent pipeline in demo must still alarm.
    addAlarm(
      new cloudwatch.Alarm(this, 'CatalogSyncAgeAlarm', {
        alarmName: `serendipity-${config.name}-catalog-sync-age`,
        alarmDescription: 'Active catalog is older than the allowed freshness window',
        metric: syncAge,
        threshold: (props.maxSyncAge ?? DEFAULT_MAX_SYNC_AGE).toSeconds(),
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: config.destroyOnDelete
          ? cloudwatch.TreatMissingData.NOT_BREACHING
          : cloudwatch.TreatMissingData.BREACHING,
      }),
    );
    addAlarm(
      new cloudwatch.Alarm(this, 'CatalogSyncFailuresAlarm', {
        alarmName: `serendipity-${config.name}-catalog-sync-failures`,
        alarmDescription: 'A catalog sync step failed; the active catalog is unchanged',
        metric: syncFailures,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    addAlarm(
      new cloudwatch.Alarm(this, 'SyncExecutionsFailedAlarm', {
        alarmName: `serendipity-${config.name}-sync-executions-failed`,
        alarmDescription: 'Step Functions catalog sync execution failed or timed out',
        metric: ingestion.stateMachine.metricFailed({ period }).with({ statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    addAlarm(
      new cloudwatch.Alarm(this, 'ApiServerErrorsAlarm', {
        alarmName: `serendipity-${config.name}-api-5xx`,
        alarmDescription: 'API is returning server errors',
        metric: api5xx,
        threshold: 5,
        evaluationPeriods: 2,
        datapointsToAlarm: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    addAlarm(
      new cloudwatch.Alarm(this, 'ApiLambdaErrorsAlarm', {
        alarmName: `serendipity-${config.name}-api-lambda-errors`,
        alarmDescription: 'API Lambda invocations are failing',
        metric: lambdaErrors,
        threshold: 3,
        evaluationPeriods: 2,
        datapointsToAlarm: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    addAlarm(
      new cloudwatch.Alarm(this, 'ApiLatencyP95Alarm', {
        alarmName: `serendipity-${config.name}-api-latency-p95`,
        alarmDescription: 'API p95 latency exceeds the target',
        metric: apiLatencyP95,
        threshold: props.apiLatencyP95Ms ?? DEFAULT_API_LATENCY_P95_MS,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    addAlarm(
      new cloudwatch.Alarm(this, 'GroundingValidationFailuresAlarm', {
        alarmName: `serendipity-${config.name}-grounding-validation-failures`,
        alarmDescription: 'Model explanations are failing evidence grounding validation',
        metric: grounding,
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    addAlarm(
      new cloudwatch.Alarm(this, 'BedrockThrottlesAlarm', {
        alarmName: `serendipity-${config.name}-bedrock-throttles`,
        alarmDescription: 'Bedrock is throttling requests; explanations are falling back',
        metric: throttles,
        threshold: 3,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    addAlarm(
      new cloudwatch.Alarm(this, 'DlqDepthAlarm', {
        alarmName: `serendipity-${config.name}-embedding-dlq-depth`,
        alarmDescription: 'Embedding work items are in the dead-letter queue',
        metric: dlqDepth,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    // Application-level quota: daily Bedrock invocations across the configured models.
    const modelIds = props.bedrockModelIds ?? [DEFAULT_TEXT_MODEL_ID];
    const quota = props.bedrockDailyInvocationQuota ?? DEFAULT_BEDROCK_DAILY_INVOCATION_QUOTA;
    const invocationUsing: Record<string, cloudwatch.IMetric> = {};
    modelIds.forEach((modelId, i) => {
      invocationUsing[`i${i}`] = new cloudwatch.Metric({
        namespace: 'AWS/Bedrock',
        metricName: 'Invocations',
        statistic: 'Sum',
        period: Duration.days(1),
        dimensionsMap: { ModelId: modelId },
      });
    });
    const bedrockInvocations = new cloudwatch.MathExpression({
      expression: modelIds.map((_, i) => `FILL(i${i}, 0)`).join(' + '),
      usingMetrics: invocationUsing,
      label: 'BedrockInvocationsPerDay',
      period: Duration.days(1),
    });
    addAlarm(
      new cloudwatch.Alarm(this, 'BedrockDailyQuotaAlarm', {
        alarmName: `serendipity-${config.name}-bedrock-daily-quota`,
        alarmDescription: `Bedrock invocations exceeded the daily application quota (${quota})`,
        metric: bedrockInvocations,
        threshold: quota,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    /* ------------------------------ dashboard ----------------------------- */
    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `serendipity-${config.name}`,
    });
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Catalog sync age (s)',
        left: [syncAge],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Catalog sync failures',
        left: [syncFailures],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Sync executions',
        left: [
          ingestion.stateMachine.metricSucceeded({ period }),
          ingestion.stateMachine.metricFailed({ period }),
        ],
        width: 8,
      }),
    );
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API requests and 5xx',
        left: [apiRequests, api5xx],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'API latency p95 (ms)',
        left: [apiLatencyP95],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'API Lambda errors and throttles',
        left: [lambdaErrors, lambdaThrottles],
        width: 8,
      }),
    );
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Grounding failures and Bedrock throttles',
        left: [grounding, throttles],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Queue and DLQ depth',
        left: [queueDepth, dlqDepth],
        width: 8,
      }),
      new cloudwatch.GraphWidget({
        title: 'Bedrock invocations per day',
        left: [bedrockInvocations],
        width: 8,
      }),
    );
    this.dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({
        title: 'Alarms',
        alarms: this.alarms,
        width: 24,
      }),
    );

    /* ------------------------------- budgets ------------------------------ */
    const monthly = props.monthlyBudgetUsd ?? DEFAULT_MONTHLY_BUDGET_USD;
    const subscribers = props.alertEmail
      ? [{ subscriptionType: 'EMAIL', address: props.alertEmail }]
      : [];
    if (subscribers.length > 0) {
      const notification = (
        notificationType: 'ACTUAL' | 'FORECASTED',
        threshold: number,
      ): budgets.CfnBudget.NotificationWithSubscribersProperty => ({
        notification: {
          notificationType,
          comparisonOperator: 'GREATER_THAN',
          threshold,
          thresholdType: 'PERCENTAGE',
        },
        subscribers,
      });
      new budgets.CfnBudget(this, 'MonthlyCostBudget', {
        budget: {
          budgetName: `serendipity-${config.name}-monthly`,
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: monthly, unit: 'USD' },
          // Scope to this project's resources via the cost allocation tag (activate it in Billing).
          costFilters: { TagKeyValue: [`user:Project$serendipity-engine`] },
        },
        notificationsWithSubscribers: [
          notification('ACTUAL', 50),
          notification('ACTUAL', 80),
          notification('ACTUAL', 100),
          notification('FORECASTED', 100),
        ],
      });
    }

    Tags.of(this).add('Project', 'serendipity-engine');
    Tags.of(this).add('Environment', config.name);
    Tags.of(this).add('ManagedBy', 'cdk');
    for (const [k, v] of Object.entries(config.tags)) Tags.of(this).add(k, v);

    new CfnOutput(this, 'AlarmTopicArn', { value: this.alarmTopic.topicArn });
    new CfnOutput(this, 'DashboardName', { value: this.dashboard.dashboardName });
  }
}
