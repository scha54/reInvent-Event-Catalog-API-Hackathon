import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { resolveEnvironmentConfig } from '../src/config.js';
import { DataStack } from '../src/data-stack.js';

const environments = {
  dev: {
    noncurrentVersionRetentionDays: 7,
    stagingRetentionDays: 7,
    snapshotInfrequentAccessAfterDays: 30,
    destroyOnDelete: true,
  },
  demo: {
    noncurrentVersionRetentionDays: 30,
    stagingRetentionDays: 14,
    snapshotInfrequentAccessAfterDays: 30,
    destroyOnDelete: false,
    tags: { CostCenter: 'hackathon' },
  },
};

function synth(name: string): Template {
  const app = new App();
  const stack = new DataStack(app, 'T', { config: resolveEnvironmentConfig(name, environments) });
  return Template.fromStack(stack);
}

describe('DataStack', () => {
  it.each(['dev', 'demo'])(
    '%s: encrypted, versioned, private buckets with SSL enforced',
    (n) => {
      const t = synth(n);
      t.resourceCountIs('AWS::S3::Bucket', 3);
      t.allResourcesProperties('AWS::S3::Bucket', {
        VersioningConfiguration: { Status: 'Enabled' },
        PublicAccessBlockConfiguration: Match.objectLike({
          BlockPublicAcls: true,
          RestrictPublicBuckets: true,
        }),
        BucketEncryption: Match.objectLike({
          ServerSideEncryptionConfiguration: [
            Match.objectLike({
              ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'aws:kms' }),
            }),
          ],
        }),
        LifecycleConfiguration: Match.objectLike({ Rules: Match.anyValue() }),
      });
      t.resourceCountIs('AWS::S3::BucketPolicy', 3);
    },
    60_000,
  );

  it('creates on-demand table with TTL and a rotating KMS key', () => {
    const t = synth('demo');
    t.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    });
  });

  it('rejects unknown environments and missing config', () => {
    expect(() => resolveEnvironmentConfig('prod', environments)).toThrow(/Unknown environment/);
    expect(() => resolveEnvironmentConfig('dev', {})).toThrow(/Missing context/);
  });
});
