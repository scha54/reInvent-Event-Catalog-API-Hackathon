import { CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from './config.js';
import type { DataStack } from './data-stack.js';

/** The only external host the ingestion path may call (mirrors `ALLOWED_HOST` in the adapter). */
export const EVENTS_API_HOST = 'api.awsevents.com';
/** SQS worker execution budget (Lambda timeout). */
export const WORKER_TIMEOUT = Duration.minutes(2);
/** AWS guidance for Lambda SQS sources: visibility timeout >= 6x function timeout. */
export const QUEUE_VISIBILITY_TIMEOUT = Duration.seconds(WORKER_TIMEOUT.toSeconds() * 6);
export const MAX_RECEIVE_COUNT = 3;

export interface IngestionStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly data: DataStack;
  /** Event to sync on schedule. Never hardcoded; when absent the schedule is created disabled. */
  readonly eventId?: string;
  /** Scheduler expression. Default: hourly. */
  readonly scheduleExpression?: string;
  /** Bedrock embedding configuration (all overridable). */
  readonly embeddingModelId?: string;
  readonly embeddingDimensions?: number;
  readonly bedrockRegion?: string;
  /**
   * Built bundles. Defaults to a stub that fails loudly so an unbuilt deployment
   * can never silently run. Handlers dispatch on `{ step }` (workflow) or SQS records.
   */
  readonly ingestionCode?: lambda.Code;
  readonly indexerCode?: lambda.Code;
}

const UNBUILT_STUB = lambda.Code.fromInline(
  "exports.handler = async () => { throw new Error('Lambda bundle not provided: pass ingestionCode/indexerCode to IngestionStack'); };",
);

/** Catalog sync pipeline: Scheduler -> Step Functions -> Lambdas -> SQS -> indexer worker. */
export class IngestionStack extends Stack {
  public readonly queue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;
  public readonly ingestionFunction: lambda.Function;
  public readonly indexerFunction: lambda.Function;
  public readonly stateMachine: sfn.StateMachine;
  public readonly credentialsSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: IngestionStackProps) {
    super(scope, id, props);
    const { config } = props;
    // Import by ARN/name so grants land on identity policies only (the key policy delegates to IAM).
    // Passing the DataStack constructs directly would edit their resource policies and create a stack cycle.
    const key = kms.Key.fromKeyArn(this, 'DataKey', props.data.key.keyArn);
    const importBucket = (id: string, b: Pick<s3.Bucket, 'bucketArn' | 'bucketName'>): s3.IBucket =>
      s3.Bucket.fromBucketAttributes(this, id, {
        bucketArn: b.bucketArn,
        bucketName: b.bucketName,
        encryptionKey: key,
      });
    const data = {
      key,
      table: dynamodb.Table.fromTableAttributes(this, 'Table', {
        tableArn: props.data.table.tableArn,
        encryptionKey: key,
      }),
      stagingBucket: importBucket('StagingBucket', props.data.stagingBucket),
      snapshotsBucket: importBucket('SnapshotsBucket', props.data.snapshotsBucket),
      indexBucket: importBucket('IndexBucket', props.data.indexBucket),
    };
    const removalPolicy = config.destroyOnDelete ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;
    const bedrockRegion = props.bedrockRegion ?? this.region;
    const modelId = props.embeddingModelId ?? 'amazon.titan-embed-text-v2:0';
    const dimensions = props.embeddingDimensions ?? 1024;

    /* ------------------------------- queues ------------------------------- */
    this.deadLetterQueue = new sqs.Queue(this, 'EmbeddingDlq', {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: data.key,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy,
    });
    this.queue = new sqs.Queue(this, 'EmbeddingQueue', {
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: data.key,
      enforceSSL: true,
      visibilityTimeout: QUEUE_VISIBILITY_TIMEOUT,
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: MAX_RECEIVE_COUNT },
      removalPolicy,
    });
    /* ------------------------------ secrets ------------------------------- */
    // Server-side Events API credential; value is set by an operator, never in code.
    this.credentialsSecret = new secretsmanager.Secret(this, 'EventsApiCredentials', {
      description: 'Server-side credentials for the official Events API (api.awsevents.com)',
      encryptionKey: data.key,
      removalPolicy,
    });

    /* ------------------------------- roles -------------------------------- */
    const basicLogs = (fnName: string, logGroup: logs.LogGroup): iam.PolicyStatement =>
      new iam.PolicyStatement({
        sid: `${fnName}Logs`,
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:*`],
      });

    const ingestionLogs = new logs.LogGroup(this, 'IngestionLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey: data.key,
      removalPolicy,
    });
    const indexerLogs = new logs.LogGroup(this, 'IndexerLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey: data.key,
      removalPolicy,
    });

    const ingestionRole = new iam.Role(this, 'IngestionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Ingestion Lambda: Events API fetch, staging, normalize, diff, checks, publish',
    });
    ingestionRole.addToPolicy(basicLogs('Ingestion', ingestionLogs));
    // Publish gate: conditional write to the table + reads of the active pointer.
    data.table.grantReadWriteData(ingestionRole);
    data.stagingBucket.grantReadWrite(ingestionRole);
    data.snapshotsBucket.grantReadWrite(ingestionRole);
    data.indexBucket.grantRead(ingestionRole);
    this.queue.grantSendMessages(ingestionRole);
    this.credentialsSecret.grantRead(ingestionRole);

    const indexerRole = new iam.Role(this, 'IndexerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Indexer Lambda: embeddings, index build, SQS worker',
    });
    indexerRole.addToPolicy(basicLogs('Indexer', indexerLogs));
    data.table.grantReadWriteData(indexerRole);
    data.snapshotsBucket.grantRead(indexerRole);
    data.indexBucket.grantReadWrite(indexerRole);
    this.queue.grantConsumeMessages(indexerRole);
    indexerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeConfiguredEmbeddingModel',
        actions: ['bedrock:InvokeModel'],
        resources: [`arn:${this.partition}:bedrock:${bedrockRegion}::foundation-model/${modelId}`],
      }),
    );

    /* ------------------------------ functions ----------------------------- */
    const common = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      tracing: lambda.Tracing.ACTIVE,
    } as const;

    this.ingestionFunction = new lambda.Function(this, 'IngestionFunction', {
      ...common,
      code: props.ingestionCode ?? UNBUILT_STUB,
      role: ingestionRole,
      logGroup: ingestionLogs,
      memorySize: 1024,
      timeout: Duration.minutes(10),
      environment: {
        TABLE_NAME: data.table.tableName,
        STAGING_BUCKET: data.stagingBucket.bucketName,
        SNAPSHOTS_BUCKET: data.snapshotsBucket.bucketName,
        INDEX_BUCKET: data.indexBucket.bucketName,
        WORK_QUEUE_URL: this.queue.queueUrl,
        // Application-level egress allowlist; the adapter rejects any other host.
        EVENTS_API_BASE_URL: `https://${EVENTS_API_HOST}`,
        EVENTS_API_ALLOWED_HOST: EVENTS_API_HOST,
        EVENTS_API_CREDENTIALS_SECRET_ARN: this.credentialsSecret.secretArn,
      },
    });

    this.indexerFunction = new lambda.Function(this, 'IndexerFunction', {
      ...common,
      code: props.indexerCode ?? UNBUILT_STUB,
      role: indexerRole,
      logGroup: indexerLogs,
      memorySize: 2048,
      timeout: WORKER_TIMEOUT,
      environment: {
        TABLE_NAME: data.table.tableName,
        SNAPSHOTS_BUCKET: data.snapshotsBucket.bucketName,
        INDEX_BUCKET: data.indexBucket.bucketName,
        BEDROCK_EMBEDDING_MODEL_ID: modelId,
        BEDROCK_EMBEDDING_DIMENSIONS: String(dimensions),
        BEDROCK_REGION: bedrockRegion,
      },
      // Indexer has no Events API access: no host or credentials configured.
    });
    this.indexerFunction.addEventSource(
      new SqsEventSource(this.queue, {
        batchSize: 10,
        maxBatchingWindow: Duration.seconds(5),
        reportBatchItemFailures: true,
        maxConcurrency: 5,
      }),
    );

    /* --------------------------- state machine ---------------------------- */
    const invoke = (
      stateId: string,
      fn: lambda.IFunction,
      step: string,
      input: Record<string, unknown> | string,
    ): tasks.LambdaInvoke => {
      const task = new tasks.LambdaInvoke(this, stateId, {
        lambdaFunction: fn,
        payload: sfn.TaskInput.fromObject({ step, input }),
        payloadResponseOnly: true,
        taskTimeout: sfn.Timeout.duration(
          fn === this.ingestionFunction ? Duration.minutes(10) : Duration.minutes(5),
        ),
      });
      task.addRetry({
        errors: [
          'Lambda.ServiceException',
          'Lambda.AWSLambdaException',
          'Lambda.SdkClientException',
          'Lambda.TooManyRequestsException',
        ],
        interval: Duration.seconds(2),
        maxAttempts: 3,
        backoffRate: 2,
        jitterStrategy: sfn.JitterType.FULL,
      });
      return task;
    };

    const failed = new sfn.Fail(this, 'SyncFailed', {
      error: 'CatalogSyncFailed',
      cause: 'A sync step failed; the active catalog is unchanged.',
    });
    const done = new sfn.Succeed(this, 'SyncSucceeded');
    const guard = (t: tasks.LambdaInvoke): tasks.LambdaInvoke => {
      t.addCatch(failed, { resultPath: '$.error' });
      return t;
    };
    const start = guard(
      invoke('StartSync', this.ingestionFunction, 'startSync', {
        eventId: sfn.JsonPath.stringAt('$.eventId'),
        executionId: sfn.JsonPath.stringAt('$$.Execution.Name'),
      }),
    );
    const chain = sfn.Chain.start(start)
      .next(
        guard(
          invoke(
            'FetchAndStage',
            this.ingestionFunction,
            'fetchAndStage',
            sfn.JsonPath.stringAt('$'),
          ),
        ),
      )
      .next(
        guard(
          invoke(
            'NormalizeStaged',
            this.ingestionFunction,
            'normalizeStaged',
            sfn.JsonPath.stringAt('$'),
          ),
        ),
      )
      .next(
        guard(
          invoke(
            'DiffAndEnqueue',
            this.ingestionFunction,
            'diffAndEnqueue',
            sfn.JsonPath.stringAt('$'),
          ),
        ),
      )
      .next(
        guard(invoke('BuildIndex', this.indexerFunction, 'buildIndex', sfn.JsonPath.stringAt('$'))),
      )
      .next(
        guard(invoke('RunChecks', this.ingestionFunction, 'runChecks', sfn.JsonPath.stringAt('$'))),
      )
      .next(guard(invoke('Publish', this.ingestionFunction, 'publish', sfn.JsonPath.stringAt('$'))))
      .next(done);

    const stateMachineLogs = new logs.LogGroup(this, 'StateMachineLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey: data.key,
      removalPolicy,
    });
    this.stateMachine = new sfn.StateMachine(this, 'SyncStateMachine', {
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(chain),
      timeout: Duration.hours(1),
      tracingEnabled: true,
      logs: {
        destination: stateMachineLogs,
        level: sfn.LogLevel.ERROR,
        includeExecutionData: false,
      },
    });

    /* ------------------------------ scheduler ----------------------------- */
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Lets EventBridge Scheduler start the catalog sync only',
    });
    this.stateMachine.grantStartExecution(schedulerRole);

    new scheduler.CfnSchedule(this, 'SyncSchedule', {
      description: 'Periodic catalog sync',
      scheduleExpression: props.scheduleExpression ?? 'rate(1 hour)',
      flexibleTimeWindow: { mode: 'OFF' },
      state: props.eventId ? 'ENABLED' : 'DISABLED',
      target: {
        arn: this.stateMachine.stateMachineArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ eventId: props.eventId ?? 'unconfigured' }),
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 3600 },
      },
    });

    /* ------------------------------ DLQ alarm ----------------------------- */
    new cloudwatch.Alarm(this, 'DlqNotEmpty', {
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Embedding work items are failing and landing in the DLQ',
    });

    Tags.of(this).add('Project', 'serendipity-engine');
    Tags.of(this).add('Environment', config.name);
    Tags.of(this).add('ManagedBy', 'cdk');
    for (const [k, v] of Object.entries(config.tags)) Tags.of(this).add(k, v);

    new CfnOutput(this, 'StateMachineArn', { value: this.stateMachine.stateMachineArn });
    new CfnOutput(this, 'QueueUrl', { value: this.queue.queueUrl });
    new CfnOutput(this, 'DlqUrl', { value: this.deadLetterQueue.queueUrl });
    new CfnOutput(this, 'CredentialsSecretArn', { value: this.credentialsSecret.secretArn });
  }
}
