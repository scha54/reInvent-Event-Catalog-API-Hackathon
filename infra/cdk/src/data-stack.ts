import { CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { TTL_ATTRIBUTE, type EnvironmentConfig } from './config.js';

export interface DataStackProps extends StackProps {
  readonly config: EnvironmentConfig;
}

/** Stateful data layer: KMS key, S3 buckets (snapshots, staging, index) and DynamoDB table. */
export class DataStack extends Stack {
  public readonly key: kms.Key;
  public readonly snapshotsBucket: s3.Bucket;
  public readonly stagingBucket: s3.Bucket;
  public readonly indexBucket: s3.Bucket;
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config } = props;
    const removalPolicy = config.destroyOnDelete ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;

    this.key = new kms.Key(this, 'DataKey', {
      alias: `alias/serendipity-${config.name}-data`,
      description: `Serendipity Engine ${config.name} data encryption key`,
      enableKeyRotation: true,
      removalPolicy,
    });

    const bucket = (logicalId: string, lifecycleRules: s3.LifecycleRule[]): s3.Bucket =>
      new s3.Bucket(this, logicalId, {
        encryption: s3.BucketEncryption.KMS,
        encryptionKey: this.key,
        bucketKeyEnabled: true,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        versioned: true,
        objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
        removalPolicy,
        autoDeleteObjects: config.destroyOnDelete,
        lifecycleRules: [
          { id: 'AbortIncompleteUploads', abortIncompleteMultipartUploadAfter: Duration.days(7) },
          ...lifecycleRules,
        ],
      });

    const noncurrent = {
      id: 'ExpireNoncurrentVersions',
      noncurrentVersionExpiration: Duration.days(config.noncurrentVersionRetentionDays),
      noncurrentVersionsToRetain: 3,
    };
    const tierDown = {
      id: 'TransitionToInfrequentAccess',
      transitions: [
        {
          storageClass: s3.StorageClass.INFREQUENT_ACCESS,
          transitionAfter: Duration.days(config.snapshotInfrequentAccessAfterDays),
        },
      ],
    };

    this.snapshotsBucket = bucket('SnapshotsBucket', [noncurrent, tierDown]);
    this.indexBucket = bucket('IndexBucket', [noncurrent, tierDown]);
    this.stagingBucket = bucket('StagingBucket', [
      { id: 'ExpireStaging', expiration: Duration.days(config.stagingRetentionDays) },
      { id: 'ExpireNoncurrentStaging', noncurrentVersionExpiration: Duration.days(1) },
    ]);

    // Single-table design (PK/SK). On-demand billing; TTL for cache/feedback items.
    // Conditional writes (e.g. atomic activeCatalogVersion publish) are a native
    // PutItem/UpdateItem capability and need no table-level configuration.
    this.table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: TTL_ATTRIBUTE,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.key,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: !config.destroyOnDelete,
      removalPolicy,
    });

    Tags.of(this).add('Project', 'serendipity-engine');
    Tags.of(this).add('Environment', config.name);
    Tags.of(this).add('ManagedBy', 'cdk');
    Tags.of(this).add('DataClassification', 'public-catalog');
    for (const [k, v] of Object.entries(config.tags)) Tags.of(this).add(k, v);

    new CfnOutput(this, 'TableName', { value: this.table.tableName });
    new CfnOutput(this, 'SnapshotsBucketName', { value: this.snapshotsBucket.bucketName });
    new CfnOutput(this, 'StagingBucketName', { value: this.stagingBucket.bucketName });
    new CfnOutput(this, 'IndexBucketName', { value: this.indexBucket.bucketName });
    new CfnOutput(this, 'KmsKeyArn', { value: this.key.keyArn });
  }
}
