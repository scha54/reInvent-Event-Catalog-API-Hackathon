import { CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { DEFAULT_THROTTLE, ROUTE_POLICIES, type RoutePolicy } from '@serendipity/services-api';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from './config.js';
import type { DataStack } from './data-stack.js';
import type { IngestionStack } from './ingestion-stack.js';

export const DEFAULT_TEXT_MODEL_ID = 'anthropic.claude-3-5-haiku-20241022-v1:0';
export const API_TIMEOUT = Duration.seconds(29);
/** Methods and headers exposed to browsers; mirrors `ALLOWED_HEADERS` in the API framework. */
export const CORS_ALLOWED_HEADERS = ['content-type', 'x-request-id', 'authorization'];

export interface ApiStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly data: DataStack;
  /** Source of the sync state machine started by the admin route. */
  readonly ingestion: IngestionStack;
  /**
   * Exact browser origins allowed by CORS (e.g. the CloudFront domain). Required: there is
   * no permissive default. Wildcards, paths and non-HTTPS origins (except localhost) are rejected.
   */
  readonly allowedOrigins: readonly string[];
  /** IAM principal ARNs permitted to call admin routes (trailing `*` matches a prefix). */
  readonly operatorPrincipals?: readonly string[];
  /** Bedrock configuration (all overridable). */
  readonly textModelId?: string;
  readonly embeddingModelId?: string;
  readonly embeddingDimensions?: number;
  readonly bedrockRegion?: string;
  /** Built API bundle. Defaults to a stub that fails loudly. */
  readonly apiCode?: lambda.Code;
}

const UNBUILT_STUB = lambda.Code.fromInline(
  "exports.handler = async () => { throw new Error('Lambda bundle not provided: pass apiCode to ApiStack'); };",
);

const ORIGIN_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/;
const LOCAL_ORIGIN_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/** Throws unless every origin is an exact, non-wildcard origin. */
export function validateAllowedOrigins(origins: readonly string[]): void {
  if (origins.length === 0) throw new Error('allowedOrigins must contain at least one origin');
  for (const origin of origins) {
    if (
      origin.includes('*') ||
      !(ORIGIN_PATTERN.test(origin) || LOCAL_ORIGIN_PATTERN.test(origin))
    ) {
      throw new Error(`Invalid CORS origin "${origin}": use an exact https origin (no wildcards)`);
    }
  }
}

/** Splits a route-policy key ("POST /api/v1/x") into HTTP method and path. */
export function parseRouteKey(key: string): { method: apigwv2.HttpMethod; path: string } {
  const [method, path] = key.split(' ');
  const resolved = method
    ? apigwv2.HttpMethod[method as keyof typeof apigwv2.HttpMethod]
    : undefined;
  if (!resolved || !path) throw new Error(`Invalid route key: ${key}`);
  return { method: resolved, path };
}

/**
 * Foundation model ARNs for a model ID. Cross-region inference profile IDs
 * (e.g. `us.anthropic...`) additionally need the profile ARN and the underlying model in any region.
 */
export function bedrockModelArns(stack: Stack, modelId: string, region: string): string[] {
  const profile = /^([a-z]{2,4})\.(.+)$/.exec(modelId);
  if (!profile || !/^(us|eu|apac|us-gov|global)$/.test(profile[1] ?? '')) {
    return [`arn:${stack.partition}:bedrock:${region}::foundation-model/${modelId}`];
  }
  return [
    `arn:${stack.partition}:bedrock:${region}:${stack.account}:inference-profile/${modelId}`,
    `arn:${stack.partition}:bedrock:*::foundation-model/${profile[2] ?? modelId}`,
  ];
}

/** Public API: HTTP API + a single router Lambda with least-privilege access. */
export class ApiStack extends Stack {
  public readonly api: apigwv2.HttpApi;
  public readonly apiFunction: lambda.Function;
  public readonly apiRole: iam.Role;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config } = props;
    validateAllowedOrigins(props.allowedOrigins);
    const removalPolicy = config.destroyOnDelete ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;

    // Import by ARN/name so grants land on identity policies only (see IngestionStack).
    const key = kms.Key.fromKeyArn(this, 'DataKey', props.data.key.keyArn);
    const table = dynamodb.Table.fromTableAttributes(this, 'Table', {
      tableArn: props.data.table.tableArn,
      encryptionKey: key,
    });
    const importBucket = (
      bid: string,
      b: Pick<s3.Bucket, 'bucketArn' | 'bucketName'>,
    ): s3.IBucket =>
      s3.Bucket.fromBucketAttributes(this, bid, {
        bucketArn: b.bucketArn,
        bucketName: b.bucketName,
        encryptionKey: key,
      });
    const snapshotsBucket = importBucket('SnapshotsBucket', props.data.snapshotsBucket);
    const indexBucket = importBucket('IndexBucket', props.data.indexBucket);

    const bedrockRegion = props.bedrockRegion ?? this.region;
    const textModelId = props.textModelId ?? DEFAULT_TEXT_MODEL_ID;
    const embeddingModelId = props.embeddingModelId ?? 'amazon.titan-embed-text-v2:0';
    const embeddingDimensions = props.embeddingDimensions ?? 1024;
    const operatorPrincipals = props.operatorPrincipals ?? [];

    /* -------------------------------- role -------------------------------- */
    // Log group is left on default CloudWatch encryption: a CMK would need a key-policy
    // grant for the logs service, and logs carry no catalog data (prompts are redacted).
    const logGroup = new logs.LogGroup(this, 'ApiLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy,
    });
    this.apiRole = new iam.Role(this, 'ApiRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'API Lambda: read catalog/index, feedback + cache writes, Bedrock, start sync',
    });
    this.apiRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ApiLogs',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:*`],
      }),
    );
    // Feedback (TTL) and explanation cache items live in the table; no Scan/admin actions.
    table.grantReadWriteData(this.apiRole);
    snapshotsBucket.grantRead(this.apiRole);
    indexBucket.grantRead(this.apiRole);
    this.apiRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeConfiguredModels',
        actions: ['bedrock:InvokeModel'],
        resources: [
          ...bedrockModelArns(this, textModelId, bedrockRegion),
          ...bedrockModelArns(this, embeddingModelId, bedrockRegion),
        ],
      }),
    );
    // Admin sync may only start the catalog sync workflow, nothing else.
    this.apiRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'StartCatalogSync',
        actions: ['states:StartExecution'],
        resources: [props.ingestion.stateMachine.stateMachineArn],
      }),
    );
    // No Secrets Manager access: the API holds no third-party credentials. The Events API
    // credential stays with the ingestion role only.

    /* ------------------------------- function ------------------------------ */
    this.apiFunction = new lambda.Function(this, 'ApiFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      tracing: lambda.Tracing.ACTIVE,
      code: props.apiCode ?? UNBUILT_STUB,
      role: this.apiRole,
      logGroup,
      memorySize: 1024,
      timeout: API_TIMEOUT,
      environment: {
        TABLE_NAME: table.tableName,
        SNAPSHOTS_BUCKET: snapshotsBucket.bucketName,
        INDEX_BUCKET: indexBucket.bucketName,
        SYNC_STATE_MACHINE_ARN: props.ingestion.stateMachine.stateMachineArn,
        ALLOWED_ORIGINS: props.allowedOrigins.join(','),
        OPERATOR_PRINCIPALS: operatorPrincipals.join(','),
        BEDROCK_TEXT_MODEL_ID: textModelId,
        BEDROCK_EMBEDDING_MODEL_ID: embeddingModelId,
        BEDROCK_EMBEDDING_DIMENSIONS: String(embeddingDimensions),
        BEDROCK_REGION: bedrockRegion,
      },
    });

    /* --------------------------------- API --------------------------------- */
    // HTTP APIs have no gateway-side schema validator. Validation is layered instead: only the
    // routes in ROUTE_POLICIES exist (no $default catch-all), and the handler framework enforces
    // Zod schemas and body size limits on every route (see services/api framework).
    this.api = new apigwv2.HttpApi(this, 'HttpApi', {
      description: `Serendipity Engine ${config.name} API`,
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: [...props.allowedOrigins],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: CORS_ALLOWED_HEADERS,
        allowCredentials: false,
        maxAge: Duration.hours(1),
      },
    });

    const integration = new HttpLambdaIntegration('ApiIntegration', this.apiFunction, {
      timeout: API_TIMEOUT,
    });
    const iamAuthorizer = new HttpIamAuthorizer();
    const policies: Readonly<Record<string, RoutePolicy>> = ROUTE_POLICIES;
    for (const [routeKey, policy] of Object.entries(policies)) {
      const { method, path } = parseRouteKey(routeKey);
      new apigwv2.HttpRoute(this, `Route${method}${path.replace(/[^A-Za-z0-9]/g, '')}`, {
        httpApi: this.api,
        routeKey: apigwv2.HttpRouteKey.with(path, method),
        integration,
        ...(policy.authorization === 'AWS_IAM' ? { authorizer: iamAuthorizer } : {}),
      });
    }

    const accessLogs = new logs.LogGroup(this, 'AccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy,
    });
    const stage = new apigwv2.HttpStage(this, 'DefaultStage', {
      httpApi: this.api,
      stageName: '$default',
      autoDeploy: true,
      throttle: {
        rateLimit: DEFAULT_THROTTLE.rateLimit,
        burstLimit: DEFAULT_THROTTLE.burstLimit,
      },
    });
    const cfnStage = stage.node.defaultChild as apigwv2.CfnStage;
    cfnStage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      // No IPs, headers or bodies: request ID, route, status and latency only.
      format: JSON.stringify({
        requestId: '$context.requestId',
        routeKey: '$context.routeKey',
        status: '$context.status',
        responseLatency: '$context.responseLatency',
        integrationError: '$context.integrationErrorMessage',
        authorizerError: '$context.authorizer.error',
      }),
    };
    // Per-route throttling from the shared route table.
    cfnStage.routeSettings = Object.fromEntries(
      Object.entries(policies).map(([routeKey, policy]) => [
        routeKey,
        {
          // Raw CloudFormation property names (routeSettings is an untyped JSON map).
          ThrottlingRateLimit: policy.throttle.rateLimit,
          ThrottlingBurstLimit: policy.throttle.burstLimit,
        },
      ]),
    );
    // WAF note: AWS WAF cannot be associated with HTTP APIs (REST API/ALB/CloudFront only). Abuse
    // controls here are per-route throttling, strict CORS, schema validation, body limits and IAM.

    Tags.of(this).add('Project', 'serendipity-engine');
    Tags.of(this).add('Environment', config.name);
    Tags.of(this).add('ManagedBy', 'cdk');
    for (const [k, v] of Object.entries(config.tags)) Tags.of(this).add(k, v);

    new CfnOutput(this, 'ApiUrl', { value: this.api.apiEndpoint });
    new CfnOutput(this, 'AdminInvokeArnPattern', {
      description: 'Resource ARN pattern for operator IAM policies (execute-api:Invoke)',
      value: `arn:${this.partition}:execute-api:${this.region}:${this.account}:${this.api.apiId}/*/POST/api/v1/admin/*`,
    });
  }
}
